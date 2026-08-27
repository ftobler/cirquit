//! Transformer companion model, shared by the basic (`T`), tapped (`169`)
//! and custom (`406`) transformers.
//!
//! All three are the same electrical family: a set of magnetically coupled
//! windings stamped as a mutual-inductance Norton companion, with no
//! voltage-source unknowns. The general rule (CustomTransformerElm.java:358-367,
//! TransformerElm.java:241-243, TappedTransformerElm.java:192-208):
//!
//! * build the mutual-inductance matrix `M`: diagonal `n_i²·L`, off-diagonal
//!   `k·L·n_i·n_j` (equivalent to `k·sqrt(Li·Lj)·pi·pj`, with the sign of the
//!   turns carrying the polarity),
//! * invert densely and scale by `ts` (`dt` for backward Euler, `dt/2` for
//!   trapezoidal) to get the companion coefficients `a = M⁻¹·ts`,
//! * stamp the diagonal as conductance, off-diagonals as VCCS,
//! * stamp a per-winding current source each step: trapezoidal adds
//!   `Σ aᵢⱼ·vdⱼ` to the previous current, backward Euler uses the previous
//!   current alone (TransformerElm.java:272-281),
//! * recover the winding currents post-solve from the node voltages and the
//!   source values (TransformerElm.java:294-299).
//!
//! The DC operating point stamps each winding as a `1 / DC_SHORT` near-short
//! with the mutual terms dropped, the same steady-state shape the inductor
//! takes: coupling carries nothing at steady state, and the single-solve port
//! cannot integrate upstream's frame of frozen-source steps, so the exact
//! short finds each loop's steady-state current in one pass. Floating
//! detection uses the winding pairs as the DC connectivity (upstream's
//! `getConnection`), so a secondary with no external ground path is pinned
//! with GMIN exactly as upstream pins unconnected nodes with a 1e8 resistor;
//! its common mode is otherwise undefined and the matrix would go singular.

use crate::element::{Base, Element, SimCtx};
use crate::elements::inductor::DC_SHORT;
use crate::spec::ElementSpec;
use crate::stamp::Stamper;

const FLAG_BACK_EULER: i64 = 2; // Inductor.java:23, same bit as the inductor

/// Ceiling on the coupling coefficient used inside the mutual-inductance
/// matrix math. At `k = 1` every winding's self term is `n_i²·L` and each
/// off-diagonal is `k·L·n_i·n_j`, so row `j = (n_j/n_i)·row i`: the matrix
/// is singular and its dense inverse divides by a zero pivot, scattering NaN
/// through the companion. Clamp the value used in the matrix strictly below 1
/// by `1e-6` so the `1 - k²` term stays positive and the inverse is finite.
/// Upstream only caps the coefficient at 0.999 in the dialog; the port uses a
/// tighter, physically indistinguishable guard that a loaded netlist cannot
/// exceed.
const MAX_COUPLING: f64 = 1.0 - 1e-6;

/// Port policy ceiling on a custom transformer's coil count; upstream defines
/// no numeric limit anywhere (its dialog checks only the coupling
/// coefficient), so the value is this port's own. Real designs top out near
/// 4-6 windings and no bundled circuit uses more than one pair, while the
/// cost at the cap stays trivial: the n x n mutual matrix and its O(n^3)
/// inversion run once per build inside the synchronous set_circuit call.
/// The TypeScript twin for its own derived geometry lives in
/// web/src/model/registry/elements/transformer.ts.
const MAX_CUSTOM_COILS: usize = 32;

/// Dense Gauss-Jordan inverse of the row-major `n×n` matrix `a`.
fn invert(a: &[f64], n: usize) -> Vec<f64> {
    let mut m = a.to_vec();
    let mut inv = vec![0.0; n * n];
    for i in 0..n {
        inv[i * n + i] = 1.0;
    }
    for col in 0..n {
        let mut piv = col;
        for r in (col + 1)..n {
            if m[r * n + col].abs() > m[piv * n + col].abs() {
                piv = r;
            }
        }
        if piv != col {
            for k in 0..n {
                m.swap(col * n + k, piv * n + k);
                inv.swap(col * n + k, piv * n + k);
            }
        }
        let d = m[col * n + col];
        for k in 0..n {
            m[col * n + k] /= d;
            inv[col * n + k] /= d;
        }
        for r in 0..n {
            if r == col {
                continue;
            }
            let f = m[r * n + col];
            if f == 0.0 {
                continue;
            }
            for k in 0..n {
                m[r * n + k] -= f * m[col * n + k];
                inv[r * n + k] -= f * inv[col * n + k];
            }
        }
    }
    inv
}

/// Splits a custom-transformer description on the three separators `,` `:`
/// `+`, keeping the separators, exactly as upstream's
/// `new StringTokenizer(desc, ",:+", true)` does (CustomTransformerElm.java:
/// 128). `-` is not a separator, so a negative turns token stays one token.
fn description_tokens(desc: &str) -> Vec<String> {
    let mut toks = Vec::new();
    let mut cur = String::new();
    for ch in desc.chars() {
        if matches!(ch, ',' | ':' | '+') {
            if !cur.is_empty() {
                toks.push(std::mem::take(&mut cur));
            }
            toks.push(ch.to_string());
        } else {
            cur.push(ch);
        }
    }
    if !cur.is_empty() {
        toks.push(cur);
    }
    toks
}

pub struct Transformer {
    base: Base,
    kind: &'static str,
    inductance: f64,
    /// Coupling coefficient between every pair of windings, `0 < k < 1`.
    coupling: f64,
    /// Winding current at which the core's effective inductance halves,
    /// 0 for a linear core. Only the basic transformer carries the token
    /// (TransformerElm.java:27); the tapped and custom rows keep this 0 and
    /// their constant companions.
    saturation_current: f64,
    /// `(post 0, post 1)` node slots per winding, in file order.
    windings: Vec<(usize, usize)>,
    /// Signed turns ratio `n_i` per winding; a negative `n` means the coil is
    /// wound against the others, which negates its mutual inductances.
    turns: Vec<f64>,
    /// `M⁻¹·ts` companion coefficients, row-major `n×n`, computed in `stamp`.
    a: Vec<f64>,
    /// Winding currents, the state carried across steps. Seeded from the file
    /// tokens so a loaded circuit continues from its saved state.
    currents: Vec<f64>,
    /// Companion current-source values, recomputed each `start_iteration`.
    source_values: Vec<f64>,
    backward_euler: bool,
}

impl Transformer {
    /// The shared spec-value guard: every winding's self-inductance is
    /// `n_i^2 * L`, so a non-positive base inductance stamps each winding as
    /// an active negative resistance or nothing at all, exactly the failure
    /// class the plain capacitor and inductor reject. The kind comes from
    /// `spec.kind` so the message names the element the file line carried.
    fn check_inductance(spec: &ElementSpec) -> Result<(), String> {
        let inductance = spec.param("inductance", 4.0);
        if !inductance.is_finite() || inductance <= 0.0 {
            return Err(format!(
                "{} (id {}) inductance must be positive, got {}",
                spec.kind, spec.id, inductance
            ));
        }
        Ok(())
    }

    pub fn new_basic(spec: &ElementSpec) -> Result<Self, String> {
        // Node wiring per TransformerElm.setPoints: the primary spans posts
        // 0-2, the secondary posts 1-3. The secondary has `ratio` turns, so
        // its self-inductance is `ratio²·L` (TransformerElm.java:241-243).
        let ratio = spec.param("ratio", 1.0);
        if !ratio.is_finite() {
            return Err(format!(
                "transformer (id {}) ratio must be finite, got {}",
                spec.id, ratio
            ));
        }
        Self::check_inductance(spec)?;
        let n = 2;
        Ok(Self {
            base: Base::with_posts(4),
            kind: "transformer",
            inductance: spec.param("inductance", 4.0),
            coupling: spec.param("couplingCoef", 0.999),
            saturation_current: spec.param("saturationCurrent", 0.0),
            windings: vec![(0, 2), (1, 3)],
            turns: vec![1.0, ratio],
            a: vec![0.0; n * n],
            currents: vec![spec.param("current0", 0.0), spec.param("current1", 0.0)],
            source_values: vec![0.0; n],
            backward_euler: spec.flag(FLAG_BACK_EULER),
        })
    }

    pub fn new_tapped(spec: &ElementSpec) -> Result<Self, String> {
        // Node wiring per TappedTransformerElm.setPoints: the primary spans
        // posts 0-1, the secondary runs posts 2-3-4 with the tap at post 3.
        // Each secondary half has half the turns, so its self-inductance is
        // `(ratio/2)²·L` (TappedTransformerElm.java:192-195).
        let ratio = spec.param("ratio", 1.0);
        if !ratio.is_finite() {
            return Err(format!(
                "tappedTransformer (id {}) ratio must be finite, got {}",
                spec.id, ratio
            ));
        }
        Self::check_inductance(spec)?;
        let n = 3;
        Ok(Self {
            base: Base::with_posts(5),
            kind: "tappedTransformer",
            inductance: spec.param("inductance", 4.0),
            coupling: spec.param("couplingCoef", 0.99),
            saturation_current: spec.param("saturationCurrent", 0.0),
            windings: vec![(0, 1), (2, 3), (3, 4)],
            turns: vec![1.0, ratio / 2.0, ratio / 2.0],
            a: vec![0.0; n * n],
            currents: vec![
                spec.param("current0", 0.0),
                spec.param("current1", 0.0),
                spec.param("current2", 0.0),
            ],
            source_values: vec![0.0; n],
            backward_euler: spec.flag(FLAG_BACK_EULER),
        })
    }

    /// Rejects a well-formed description with more than [`MAX_CUSTOM_COILS`]
    /// coils: the n x n allocation and the O(n^3) inversion of the first
    /// stamp both sit inside the synchronous build, so an unbounded coil
    /// count is an unbounded synchronous cost. The check runs on the parsed
    /// coil count, not the file's `coilCount` token, so a lying token cannot
    /// bypass it. A malformed description keeps the `"1,1:1"` fallback, which
    /// keeps this side in step with whatever post count the frontend derives.
    pub fn new_custom(spec: &ElementSpec) -> Result<Self, String> {
        Self::check_inductance(spec)?;
        let mut t = Self {
            base: Base::with_posts(0),
            kind: "customTransformer",
            inductance: spec.param("inductance", 4.0),
            coupling: spec.param("couplingCoef", 0.999),
            saturation_current: spec.param("saturationCurrent", 0.0),
            windings: Vec::new(),
            turns: Vec::new(),
            a: Vec::new(),
            currents: Vec::new(),
            source_values: Vec::new(),
            backward_euler: spec.flag(FLAG_BACK_EULER),
        };
        let desc = spec.label.clone().unwrap_or_else(|| "1,1:1".into());
        // A malformed description falls back to the constructor default, so
        // the post count the frontend derives from the same description stays
        // in step with the engine's.
        if !t.parse_description(&desc) {
            t.parse_description("1,1:1");
        }
        if t.windings.len() > MAX_CUSTOM_COILS {
            return Err(format!(
                "custom transformer (id {}) has {} coils, above the limit of {MAX_CUSTOM_COILS}",
                spec.id,
                t.windings.len()
            ));
        }
        let n = t.windings.len();
        t.currents = (0..n)
            .map(|i| spec.param(&format!("coilCurrent{i}"), 0.0))
            .collect();
        t.source_values = vec![0.0; n];
        t.a = vec![0.0; n * n];
        Ok(t)
    }

    /// Parses a custom description into winding node pairs and signed turns,
    /// per CustomTransformerElm.parseDescription (:118-222). A number is a
    /// coil (the turns ratio to the base inductance coil, negative = reversed
    /// polarity), `:` splits primary from secondary, `,` starts a new
    /// unconnected coil and `+` shares the previous coil's far node (tapped).
    fn parse_description(&mut self, desc: &str) -> bool {
        let toks = description_tokens(desc);
        let mut coils: Vec<(usize, f64)> = Vec::new();
        let mut node_num = 0usize;
        let mut secondary = false;
        let mut i = 0;
        while i < toks.len() {
            // parseDouble ignores surrounding whitespace (Java), so a user who
            // types "1, 1:1" still gets valid coils; the TypeScript side must
            // agree, and `Number()` there trims the same way.
            let n: f64 = match toks[i].trim().parse() {
                Ok(v) => v,
                Err(_) => return false,
            };
            // Zero is not the only poisoned turn count: Rust's float parser
            // accepts "NaN" and "Infinity", and either would put non-finite
            // terms into the mutual matrix. Both count as a malformed
            // description, taking the same fallback route.
            if !n.is_finite() || n == 0.0 {
                return false;
            }
            coils.push((node_num, n));
            node_num += 2;
            i += 1;
            if i >= toks.len() {
                break;
            }
            match toks[i].as_str() {
                "," => {}
                "+" => node_num -= 1,
                ":" => {
                    if secondary {
                        return false;
                    }
                    secondary = true;
                }
                _ => return false,
            }
            i += 1;
        }
        if coils.is_empty() {
            return false;
        }
        self.windings = coils.iter().map(|&(s, _)| (s, s + 1)).collect();
        self.turns = coils.iter().map(|&(_, n)| n).collect();
        self.base = Base::with_posts(node_num);
        true
    }

    /// Node indices of winding `w`, resolved from its post pair. Only stamping
    /// needs these; the winding voltage uses post indices, because `base.volts`
    /// is indexed by post (write_back stores `volts[i] = V(nodes[i])`).
    fn winding_node_pair(&self, w: usize) -> (usize, usize) {
        let (a, b) = self.windings[w];
        (self.base.nodes[a], self.base.nodes[b])
    }

    /// Voltage across winding `w`, `V(first post) - V(second post)`.
    fn winding_voltage(&self, w: usize) -> f64 {
        let (a, b) = self.windings[w];
        self.base.volts[a] - self.base.volts[b]
    }

    /// The current-dependent self-inductance `L0/(1 + (I/Isat)^2)` of a
    /// winding, the same smooth rolloff the saturating inductor uses
    /// (`calcEffectiveInductance`, TransformerElm.java:195-200): `L0/2` at
    /// `|I| = Isat`, `L0/10` at `|I| = 3*Isat`. `isat <= 0` keeps the winding
    /// linear.
    fn effective_inductance(l0: f64, i: f64, isat: f64) -> f64 {
        if isat <= 0.0 {
            return l0;
        }
        let ratio = i / isat;
        l0 / (1.0 + ratio * ratio)
    }

    fn compute_coefficients(&mut self, dt: f64) {
        let n = self.windings.len();
        // The clamp keeps the mutual matrix strictly non-singular even when the
        // spec requests k = 1, which would otherwise make invert divide by a
        // zero pivot and scatter NaN (MAX_COUPLING).
        let k = self.coupling.min(MAX_COUPLING);
        let mut m = vec![0.0; n * n];
        if self.saturation_current <= 0.0 {
            // Linear core: the constant mutual-inductance matrix.
            for i in 0..n {
                for j in 0..n {
                    m[i * n + j] = if i == j {
                        self.turns[i] * self.turns[i] * self.inductance
                    } else {
                        k * self.inductance * self.turns[i] * self.turns[j]
                    };
                }
            }
        } else {
            // Saturated core: each winding's self inductance rolls off with
            // its own current (L0_i = n_i^2*L, Isat_i = isat*|n_i|), and the
            // mutuals follow as k*sqrt(Li*Lj) with the turns pair's sign
            // carrying the polarity, exactly as k*L*n_i*n_j does unsaturated
            // (TransformerElm.java:266-270).
            let l_eff: Vec<f64> = (0..n)
                .map(|i| {
                    let l0 = self.turns[i] * self.turns[i] * self.inductance;
                    let isat = self.saturation_current * self.turns[i].abs();
                    Self::effective_inductance(l0, self.currents[i], isat)
                })
                .collect();
            for i in 0..n {
                for j in 0..n {
                    m[i * n + j] = if i == j {
                        l_eff[i]
                    } else {
                        k * (self.turns[i] * self.turns[j]).signum() * (l_eff[i] * l_eff[j]).sqrt()
                    };
                }
            }
        }
        let ts = if self.backward_euler { dt } else { dt / 2.0 };
        self.a = invert(&m, n).iter().map(|v| v * ts).collect();
    }

    /// Stamps the Norton companion from the current `a` coefficients: the
    /// diagonal self terms as conductances, the off-diagonal mutual terms as
    /// VCCSes. `stamp` calls it once for the linear and DC passes; a
    /// saturating transient re-stamps it every Newton iteration from
    /// `do_step`.
    fn stamp_companion(&self, s: &mut Stamper) {
        let n = self.windings.len();
        for i in 0..n {
            let (na, nb) = self.winding_node_pair(i);
            s.conductance(na, nb, self.a[i * n + i]);
            for j in 0..n {
                if i == j {
                    continue;
                }
                let (ma, mb) = self.winding_node_pair(j);
                s.vccs(na, nb, ma, mb, self.a[i * n + j]);
            }
        }
    }
}

impl Element for Transformer {
    fn kind(&self) -> &'static str {
        self.kind
    }
    fn base(&self) -> &Base {
        &self.base
    }
    fn base_mut(&mut self) -> &mut Base {
        &mut self.base
    }
    fn post_count(&self) -> usize {
        self.base.nodes.len()
    }

    fn connects(&self, a: usize, b: usize) -> bool {
        // The winding pairs are the DC connectivity, upstream's `getConnection`
        // (TransformerElm.java:318-324), and the pairs the port's
        // floating-subcircuit detection must treat as one component. Upstream
        // has a second method, `getMatrixConnection`, that returns true for
        // everything, but that only groups all transformer nodes into one
        // closure for its per-closure matrices, a concept the port does not
        // have. Reporting it here too would stop the floating detection from
        // pinning a secondary with no ground path, whose common mode is
        // undefined, and the solve would go singular.
        self.windings
            .iter()
            .any(|&(x, y)| (a == x && b == y) || (a == y && b == x))
            || (self.kind == "tappedTransformer" && ((a == 2 && b == 4) || (a == 4 && b == 2)))
    }

    /// The mutual-inductance VCCS couples every winding pair, so all windings
    /// share one closure (TransformerElm.java:326, TappedTransformerElm.java:
    /// 289, CustomTransformerElm.java:458).
    fn matrix_connects(&self, _a: usize, _b: usize) -> bool {
        true
    }

    fn nonlinear(&self) -> bool {
        // The saturating companion is a function of the winding currents, so
        // the matrix is restored and the companion re-stamped every Newton
        // iteration (TransformerElm.java:118).
        self.saturation_current > 0.0
    }

    fn stamp(&mut self, ctx: &SimCtx, s: &mut Stamper) {
        if ctx.dc_analysis {
            // Steady state: every winding is a near-short, the inductor's DC
            // branch (inductor.rs:94-98), and the mutual VCCS terms drop out
            // because coupling carries nothing at steady state. The branch
            // sits ahead of the saturating early return, mirroring the
            // saturating inductor whose own DC branch precedes saturation
            // (inductor.rs:94 before :99).
            for i in 0..self.windings.len() {
                let (na, nb) = self.winding_node_pair(i);
                s.conductance(na, nb, 1.0 / DC_SHORT);
            }
            return;
        }
        self.compute_coefficients(ctx.dt);
        if self.saturation_current > 0.0 {
            // Saturating transient: nothing constant to stamp. The matrix is
            // restored to the snapshot every Newton iteration, so do_step
            // re-stamps the current-dependent companion there, the same
            // division of labour as the saturating inductor (inductor.rs:
            // 99-112).
            return;
        }
        self.stamp_companion(s);
    }

    fn start_iteration(&mut self, ctx: &SimCtx) {
        if ctx.dc_analysis {
            return;
        }
        if self.saturation_current > 0.0 {
            // The companion depends on the last converged winding currents,
            // which only change between timesteps, so recompute the
            // coefficients once per step like the inductor recomputes `geq`
            // from `i_prev` (inductor.rs:114-127). The coefficients then stay
            // fixed across the Newton iterations of this timestep, the
            // staggered scheme upstream's `startIteration` uses
            // (TransformerElm.java:263-271).
            self.compute_coefficients(ctx.dt);
        }
        let n = self.windings.len();
        let mut vd = vec![0.0; n];
        for (i, v) in vd.iter_mut().enumerate() {
            *v = self.winding_voltage(i);
        }
        for i in 0..n {
            let mut val = self.currents[i];
            if !self.backward_euler {
                for (j, &v) in vd.iter().enumerate() {
                    val += self.a[i * n + j] * v;
                }
            }
            self.source_values[i] = val;
        }
    }

    fn do_step(&mut self, ctx: &SimCtx, s: &mut Stamper) {
        if ctx.dc_analysis {
            return;
        }
        if self.saturation_current > 0.0 {
            // Re-stamp the companion every Newton iteration with the
            // coefficients `start_iteration` fixed for the step; the matrix
            // was restored to the snapshot, so this does not double the
            // constant pass (TransformerElm.java:283-290).
            self.stamp_companion(s);
        }
        for i in 0..self.windings.len() {
            let (a, b) = self.winding_node_pair(i);
            s.current_source(a, b, self.source_values[i]);
        }
    }

    fn calculate_current(&mut self, ctx: &SimCtx) {
        let n = self.windings.len();
        let mut vd = vec![0.0; n];
        for (i, v) in vd.iter_mut().enumerate() {
            *v = self.winding_voltage(i);
        }
        let mut primary = 0.0;
        for i in 0..n {
            let val = if ctx.dc_analysis {
                // The winding reads as a DC_SHORT under the operating-point
                // stamp, so its reported current is v/DC_SHORT, the
                // inductor's rule (inductor.rs:146-152).
                vd[i] / DC_SHORT
            } else {
                let mut v = self.source_values[i];
                for (j, &x) in vd.iter().enumerate() {
                    v += self.a[i * n + j] * x;
                }
                v
            };
            if !ctx.dc_analysis {
                // The winding current is the state carried across steps, so the
                // DC pass must not overwrite the file-seeded values: unlike the
                // capacitor and inductor, whose `step_finished` commits the
                // operating point into their history, the transformer keeps the
                // file-seeded winding currents and the transient starts from
                // them. Upstream's `calculateCurrent()` overwrites `current[]`
                // during its DC analysis too; this is the transformer feature's
                // own scope decision, not the DC-operating-point carry fix.
                self.currents[i] = val;
            }
            if i == 0 {
                primary = val;
            }
        }
        self.base.current = primary;
    }

    fn current_into_node(&self, post: usize) -> f64 {
        // Positive winding current enters the winding's first post and leaves
        // its second, the two-terminal convention; a post shared by two
        // windings (the tapped transformer's centre tap, a `+` join in a
        // custom) sums both contributions.
        let mut sum = 0.0;
        for (i, &(a, b)) in self.windings.iter().enumerate() {
            if post == a {
                sum -= self.currents[i];
            } else if post == b {
                sum += self.currents[i];
            }
        }
        sum
    }

    fn state_tokens(&self) -> Vec<(String, f64)> {
        // The basic and tapped rows name their winding currents `current0`
        // onward; the custom row, whose coil count is not fixed by the kind,
        // names them `coilCurrent{i}` (CustomTransformerElm.java:357-360).
        let prefix = if self.kind == "customTransformer" {
            "coilCurrent"
        } else {
            "current"
        };
        self.currents
            .iter()
            .enumerate()
            .map(|(i, &c)| (format!("{prefix}{i}"), c))
            .collect()
    }

    fn reset(&mut self) {
        self.base.reset();
        self.currents.iter_mut().for_each(|c| *c = 0.0);
        self.source_values.iter_mut().for_each(|v| *v = 0.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    /// A 2-winding basic transformer at L = 4, ratio = 2, k = 0.999, with the
    /// given saturation current, winding currents seeded directly.
    fn basic(isat: f64, currents: [f64; 2]) -> Transformer {
        let mut params = HashMap::new();
        params.insert("inductance".into(), 4.0);
        params.insert("ratio".into(), 2.0);
        params.insert("couplingCoef".into(), 0.999);
        params.insert("saturationCurrent".into(), isat);
        let spec = ElementSpec {
            id: 1,
            kind: "transformer".into(),
            posts: vec![[0, 0], [100, 0], [0, 100], [100, 100]],
            params,
            label: None,
            model: None,
            flags: 0,
        };
        let mut t = Transformer::new_basic(&spec).expect("valid basic transformer");
        t.currents = currents.to_vec();
        t
    }

    #[test]
    fn effective_inductance_rolls_off_symmetrically() {
        // L_eff = L0/(1 + (I/Isat)^2): L0 below onset, L0/2 at I = Isat,
        // L0/10 at I = 3*Isat, and an even function of the current. An
        // isat <= 0 keeps the winding linear.
        assert_eq!(Transformer::effective_inductance(4.0, 1.0, 0.0), 4.0);
        assert_eq!(Transformer::effective_inductance(4.0, 1.0, -1.0), 4.0);
        assert_eq!(Transformer::effective_inductance(4.0, 0.01, 0.01), 2.0);
        assert_eq!(Transformer::effective_inductance(4.0, -0.01, 0.01), 2.0);
        assert_eq!(Transformer::effective_inductance(4.0, 0.03, 0.01), 0.4);
        assert_eq!(Transformer::effective_inductance(4.0, -0.03, 0.01), 0.4);
    }

    /// A basic transformer whose coupling coefficient is exactly 1, the
    /// singular-matrix case the review flagged: upstream's mutual build makes
    /// row j = (n_j/n_i)·row i, so the dense inverse hits a zero pivot.
    fn basic_k1() -> Transformer {
        let mut t = basic(0.0, [0.0, 0.0]);
        t.coupling = 1.0;
        t
    }

    #[test]
    fn coupling_coef_of_one_is_not_singular() {
        // k = 1 must not scatter NaN through the companion. The coefficients
        // stay finite and the matrix stays invertible, so a circuit with
        // couplingCoef = 1 solves instead of surfacing a BadStamp.
        let mut t = basic_k1();
        t.compute_coefficients(2.0);
        assert!(
            t.a.iter().all(|v| v.is_finite()),
            "a contained NaN/Inf: {:?}",
            t.a
        );
        // Sanity: a = M^-1 * ts is the inverse of a legal (clamped) matrix, so
        // M * a = ts * I. Rebuild the clamped M and check M·a ≈ ts·I.
        let k = 1.0 - 1e-6;
        let n = 2;
        let mut m = [0.0; 4];
        m[0] = 4.0;
        m[1] = k * 4.0 * 2.0;
        m[2] = k * 4.0 * 2.0;
        m[3] = 4.0 * 2.0 * 2.0;
        let ts = 1.0; // trapezoidal, dt = 2 -> ts = 1
        for i in 0..n {
            for col in 0..n {
                let got: f64 = (0..n).map(|r| m[i * n + r] * t.a[r * n + col]).sum();
                let want = if i == col { ts } else { 0.0 };
                assert!(
                    (got - want).abs() < 1e-6,
                    "M·a[{i},{col}] = {got}, expected {want}"
                );
            }
        }
    }

    #[test]
    fn zero_isat_is_the_linear_mutual_matrix() {
        // isat = 0 must reproduce the pre-saturation matrix exactly: diagonal
        // n_i^2*L, off-diagonal k*L*n_i*n_j, and `a` = M^-1*ts. Rebuild the
        // same M by hand and invert it, so the saturated path cannot hide
        // behind the linear branch agreeing with itself.
        let mut t = basic(0.0, [0.0, 0.0]);
        t.compute_coefficients(2.0); // trapezoidal: ts = dt/2 = 1.0, so a = M^-1
        let mut m = vec![0.0; 4];
        m[0] = 4.0;
        m[1] = 0.999 * 4.0 * 2.0;
        m[2] = 0.999 * 4.0 * 2.0;
        m[3] = 4.0 * 2.0 * 2.0;
        assert_eq!(t.a, invert(&m, 2));
    }

    #[test]
    fn unsaturated_start_matches_the_linear_matrix() {
        // At zero winding current L_eff = L0 exactly, so the saturated matrix
        // equals the linear one bit for bit: the sqrt and the signed product
        // coincide for these power-of-two scalings, the "unsaturated start"
        // the staggered scheme begins from.
        let mut linear = basic(0.0, [0.0, 0.0]);
        linear.compute_coefficients(2.0);
        let mut sat = basic(0.01, [0.0, 0.0]);
        sat.compute_coefficients(2.0);
        assert_eq!(linear.a, sat.a);
    }

    #[test]
    fn saturation_raises_the_primary_diagonal_coefficient() {
        // A primary at its own Isat halves L1, so M^-1 grows and with it the
        // primary diagonal companion coefficient. Compute coefficients the
        // way start_iteration would, from the running winding currents.
        let mut saturated = basic(0.01, [0.01, 0.0]);
        saturated.compute_coefficients(2.0);
        let mut unsaturated = basic(0.01, [0.0, 0.0]);
        unsaturated.compute_coefficients(2.0);
        assert!(
            saturated.a[0] > unsaturated.a[0],
            "saturated primary diagonal {} should exceed the unsaturated {}",
            saturated.a[0],
            unsaturated.a[0]
        );
    }

    /// A custom-transformer spec whose description arrives as the label, the
    /// string carrier the frontend escapes into the `406` line.
    fn custom(desc: &str) -> ElementSpec {
        ElementSpec {
            id: 9,
            kind: "customTransformer".into(),
            posts: Vec::new(),
            params: HashMap::new(),
            label: Some(desc.into()),
            model: None,
            flags: 0,
        }
    }

    /// `Transformer` carries no `Debug`, so `unwrap_err` is out; pull the
    /// error out by value instead.
    fn err_of(r: Result<Transformer, String>) -> String {
        r.err().expect("expected a rejection")
    }

    #[test]
    fn new_custom_over_the_coil_cap_is_rejected_by_name() {
        // 33 coils sits just above MAX_CUSTOM_COILS; the error must name
        // kind, id, count and cap so the banner points at the description.
        let desc = vec!["1"; 33].join(",");
        let err = err_of(Transformer::new_custom(&custom(&desc)));
        assert_eq!(
            err,
            "custom transformer (id 9) has 33 coils, above the limit of 32"
        );
    }

    #[test]
    fn new_custom_at_the_coil_cap_builds() {
        // Exactly 32 coils is legal and yields two posts per coil.
        let desc = vec!["1"; 32].join(",");
        let t = Transformer::new_custom(&custom(&desc)).expect("32 coils must build");
        assert_eq!(t.windings.len(), 32);
        assert_eq!(t.base.nodes.len(), 64);
        assert_eq!(t.a.len(), 32 * 32);
    }

    #[test]
    fn new_custom_keeps_the_malformed_fallback_below_the_cap() {
        // Only well-formed-but-oversized descriptions reject: a malformed one
        // still falls back to the constructor default "1,1:1" (two joined
        // primary coils, one secondary), keeping whatever the frontend
        // derives for the same text in step.
        let t = Transformer::new_custom(&custom("1,x:,1")).expect("fallback must build");
        assert_eq!(t.windings.len(), 3);
        assert_eq!(t.base.nodes.len(), 6);
    }

    #[test]
    fn new_custom_falls_back_on_non_finite_turns() {
        // Rust's float parser accepts "inf" and "NaN", which would otherwise
        // put non-finite terms into the mutual matrix; such a turn counts as a
        // malformed description and takes the same "1,1:1" fallback route as
        // "1,x:,1" (transformer.rs:284), keeping the post count in step with
        // whatever the frontend derives for the same text.
        for bad in ["inf,1:1", "NaN,1:1", "1,inf:1"] {
            let t = Transformer::new_custom(&custom(bad)).expect("fallback must build");
            assert_eq!(t.windings.len(), 3, "fallback for {bad} lost a winding");
            assert_eq!(t.base.nodes.len(), 6, "fallback for {bad} lost a node");
        }
    }

    #[test]
    fn new_custom_counts_plus_joined_coils_toward_the_cap() {
        // Every number in the description is a coil even when a `+` shares
        // the previous coil's far node, so tapped-style joins cannot dodge
        // the count.
        let desc = vec!["1"; 40].join("+");
        assert!(Transformer::new_custom(&custom(&desc)).is_err());
    }
}
