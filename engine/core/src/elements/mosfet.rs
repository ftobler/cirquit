//! Quadratic MOSFET model with a body diode.

use std::collections::HashMap;

use crate::element::{Base, Element, SimCtx};
use crate::elements::diode::Diode;
use crate::elements::junction::CONVERGENCE_V;
use crate::spec::ElementSpec;
use crate::stamp::Stamper;

/// Conductance of an off channel, keeping the drain/source pair from floating
/// (MosfetElm.java:610). The saturation branch clamps its own Gds to the same
/// floor because lambda is 0 in this model, so this is the minimum
/// drain-source conductance everywhere.
const MIN_CHANNEL_G: f64 = 1e-8;
/// Largest source/drain voltage move per Newton iteration, the same
/// anti-divergence role the BJT's junction limiting plays (MosfetElm.java:573-580).
const MAX_STEP_V: f64 = 0.5;

/// Quadratic MOSFET, upstream's default model: `vt = 1.5`, `beta = 0.02`,
/// `lambda = 0`, no gate caps, body diode simulated and tied to one of the
/// channel terminals.
///
/// Posts are gate, source and drain for an N-channel; the P-channel swaps the
/// source/drain *labels*, but the engine never needs to know which physical
/// post is which: it picks the source as the lower-voltage terminal for an
/// N-channel and the higher-voltage one for a P-channel, so `vds >= 0` in the
/// device frame, exactly like upstream (MosfetElm.java:588).
pub struct Mosfet {
    base: Base,
    /// `1.0` for an N-channel, `-1.0` for a P-channel. Folding the type into a
    /// sign keeps one set of equations for both, like the BJT's `polarity`.
    polarity: f64,
    /// Threshold voltage `vt`, in volts.
    vt: f64,
    /// Transconductance parameter `beta`, in A/V^2.
    beta: f64,
    /// The body diode, anode at post 1 and cathode at post 2 for both channel
    /// types, matching upstream's `diodeB1.stamp(nodes[1], nodes[2])`
    /// (MosfetElm.java:504-515). Post 1 is the source post for an N-channel
    /// and the drain post for a P-channel, so the diode blocks while the
    /// channel conducts in the normal direction and conducts when that
    /// terminal is raised above the other, which is exactly the parasitic
    /// body diode. One diode suffices because the body is tied to one of the
    /// channel terminals, so only one junction can ever be forward biased;
    /// the other junction is shorted by the tie.
    diode: Diode,
    /// Current through the body diode, positive anode to cathode, for the
    /// per-node current report.
    diode_current: f64,
    /// Limited source/drain voltages from the previous iteration, feeding the
    /// per-iteration clamp and the convergence report.
    last_v0: f64,
    last_v1: f64,
    last_v2: f64,
    /// Reported drain-source current, folded back through the swap
    /// (MosfetElm.java:642-644).
    ids: f64,
}

impl Mosfet {
    pub fn new(spec: &ElementSpec) -> Self {
        // The file sign is the type: +1 is N-channel, -1 is P-channel, and any
        // non-negative token (including the absent one) reads as N
        // (MosfetElm.java:91). The body diode is upstream's default model too.
        let diode = Diode::new(&ElementSpec {
            id: 0,
            kind: "diode".into(),
            posts: Vec::new(),
            params: HashMap::new(),
            label: None,
            model: None,
            flags: 0,
        });
        Self {
            base: Base::with_posts(3),
            polarity: if spec.param("pnp", 1.0) < 0.0 {
                -1.0
            } else {
                1.0
            },
            vt: spec.param("threshold", 1.5),
            beta: spec.param("beta", 0.02).max(1e-6),
            diode,
            diode_current: 0.0,
            last_v0: 0.0,
            last_v1: 0.0,
            last_v2: 0.0,
            ids: 0.0,
        }
    }

    /// The three branches of the quadratic model, evaluated in the
    /// polarity-scaled frame (`pvgs = p*vgs`), so the same equations serve
    /// both channel types (MosfetElm.java:607-629). Returns `(ids, gm, Gds)`.
    fn branch(&self, pvgs: f64, pvds: f64) -> (f64, f64, f64) {
        if pvgs < self.vt {
            // Off: a large resistor, so the drain/source pair stays pinned
            // instead of presenting an open circuit.
            (pvds * MIN_CHANNEL_G, 0.0, MIN_CHANNEL_G)
        } else if pvds < pvgs - self.vt {
            // Triode (linear): ids = beta*((vgs-vt)*vds - vds^2/2).
            let ids = self.beta * ((pvgs - self.vt) * pvds - 0.5 * pvds * pvds);
            (ids, self.beta * pvds, self.beta * (pvgs - pvds - self.vt))
        } else {
            // Saturation: ids = 0.5*beta*(vgs-vt)^2. With lambda = 0 the
            // channel-length-modulation term vanishes and Gds clamps to the
            // same floor as the off state.
            let vgs_vt = pvgs - self.vt;
            (
                0.5 * self.beta * vgs_vt * vgs_vt,
                self.beta * vgs_vt,
                MIN_CHANNEL_G,
            )
        }
    }

    /// Which terminal pair are source and drain, so `vds >= 0` in the device
    /// frame: the lower-voltage terminal for an N-channel, the higher one for
    /// a P-channel (MosfetElm.java:588).
    fn source_drain(&self, v1: f64, v2: f64) -> (usize, usize) {
        if self.polarity * v1 > self.polarity * v2 {
            (2, 1)
        } else {
            (1, 2)
        }
    }

    /// True when the swap moved the source off its nominal post, which flips
    /// the sign of the reported current (MosfetElm.java:642-644).
    fn folded_sign(&self, source: usize, p: f64) -> bool {
        (source == 2 && p == 1.0) || (source == 1 && p == -1.0)
    }

    /// Stamps the body diode between its anode and cathode posts, using the
    /// mosfet's own node assignments and the current node voltages. The
    /// embedded `Diode` carries its own `Base` that the circuit never sees, so
    /// every call has to point it at the channel terminals.
    fn stamp_body_diode(&mut self, ctx: &SimCtx, s: &mut Stamper) {
        // Anode at post 1, cathode at post 2, identical for both channel
        // types (MosfetElm.java:504-515).
        let (n1, n2) = (self.base.nodes[1], self.base.nodes[2]);
        {
            let d = self.diode.base_mut();
            d.nodes[0] = n1;
            d.nodes[1] = n2;
            d.volts[0] = self.base.volts[1];
            d.volts[1] = self.base.volts[2];
        }
        self.diode.do_step(ctx, s);
    }

    /// Upstream's tolerance ladder for one terminal's move between
    /// iterations (MosfetElm.java:517-533). True means Newton has not
    /// converged on this terminal yet. Four stages: a plain 10 mV absolute
    /// bar; a x100 difference multiplier when beta exceeds 1, because a
    /// high-beta part turns millivolt wobble into ampere-scale current
    /// error; a relative pass past subiteration 10 (under 0.1% of the
    /// terminal's
    /// own value), so a settled large signal is not chased forever; and a
    /// linear loosening past subiteration 100 for closures that genuinely
    /// struggle. The multiplier applies before every branch, so it rides
    /// the relative and loosened tests too. A high-beta part therefore
    /// settles to a tenth of the bar a default part asks for.
    fn non_convergence(&self, ctx: &SimCtx, last: f64, now: f64) -> bool {
        let mut diff = (last - now).abs();
        if self.beta > 1.0 {
            diff *= 100.0;
        }
        if diff < CONVERGENCE_V {
            return false;
        }
        if ctx.subiter > 10 && diff < now.abs() * 0.001 {
            return false;
        }
        if ctx.subiter > 100 && diff < CONVERGENCE_V + (ctx.subiter as f64 - 100.0) * 1e-4 {
            return false;
        }
        true
    }
}

impl Element for Mosfet {
    fn kind(&self) -> &'static str {
        "mosfet"
    }
    fn base(&self) -> &Base {
        &self.base
    }
    fn base_mut(&mut self) -> &mut Base {
        &mut self.base
    }
    fn post_count(&self) -> usize {
        3
    }
    fn nonlinear(&self) -> bool {
        true
    }

    fn do_step(&mut self, ctx: &SimCtx, s: &mut Stamper) {
        let p = self.polarity;
        let (vg, v1, v2) = (self.base.volts[0], self.base.volts[1], self.base.volts[2]);

        // Clamp the source/drain move to 0.5 V per iteration so Newton cannot
        // leap across the whole characteristic (MosfetElm.java:573-580). The
        // gate is not clamped; upstream limits only nodes 1 and 2.
        let sv1 = v1
            .max(self.last_v1 - MAX_STEP_V)
            .min(self.last_v1 + MAX_STEP_V);
        let sv2 = v2
            .max(self.last_v2 - MAX_STEP_V)
            .min(self.last_v2 + MAX_STEP_V);

        // The gate is not clamped; upstream limits only nodes 1 and 2, and
        // its convergence row compares the clamped values against lastv
        // through nonConvergence (MosfetElm.java:595).
        if self.non_convergence(ctx, self.last_v1, sv1)
            || self.non_convergence(ctx, self.last_v2, sv2)
            || self.non_convergence(ctx, self.last_v0, vg)
        {
            s.not_converged();
        }
        self.last_v0 = vg;
        self.last_v1 = sv1;
        self.last_v2 = sv2;

        let (source, drain) = self.source_drain(sv1, sv2);
        let vs = if source == 1 { sv1 } else { sv2 };
        let vd = if drain == 1 { sv1 } else { sv2 };
        let vgs = vg - vs;
        let vds = vd - vs;

        let (ids0, gm, gds) = self.branch(p * vgs, p * vds);
        self.ids = if self.folded_sign(source, p) {
            -ids0
        } else {
            ids0
        };

        // The 3x3 drain/source/gate pattern and its right-hand side
        // (MosfetElm.java:649-659). Each channel row holds
        // `Gds*(Vd-Vs) + gm*(Vg-Vs)`, and `rs` supplies the constant part so
        // the physical channel current `p*ids0` leaves the drain.
        let rs = -p * ids0 + gds * vds + gm * vgs;
        let (ng, ns, nd) = (
            self.base.nodes[0],
            self.base.nodes[source],
            self.base.nodes[drain],
        );
        s.node_pair(nd, nd, gds);
        s.node_pair(nd, ns, -gds - gm);
        s.node_pair(nd, ng, gm);
        s.node_pair(ns, nd, -gds);
        s.node_pair(ns, ns, gds + gm);
        s.node_pair(ns, ng, -gm);
        s.node_rhs(nd, rs);
        s.node_rhs(ns, -rs);

        self.stamp_body_diode(ctx, s);
    }

    fn calculate_current(&mut self, ctx: &SimCtx) {
        // Recompute the reported current from the solved, unclamped voltages,
        // matching upstream's `calculate(true)` in stepFinished.
        let p = self.polarity;
        let (vg, v1, v2) = (self.base.volts[0], self.base.volts[1], self.base.volts[2]);
        let (source, drain) = self.source_drain(v1, v2);
        let vs = if source == 1 { v1 } else { v2 };
        let vd = if drain == 1 { v1 } else { v2 };
        let (ids0, _, _) = self.branch(p * (vg - vs), p * (vd - vs));
        self.ids = if self.folded_sign(source, p) {
            -ids0
        } else {
            ids0
        };
        self.base.current = self.ids;

        // The body diode's own current at the solved voltages, for the
        // per-node report.
        {
            let d = self.diode.base_mut();
            d.volts[0] = self.base.volts[1];
            d.volts[1] = self.base.volts[2];
        }
        self.diode.calculate_current(ctx);
        self.diode_current = self.diode.base().current;
    }

    fn current_into_node(&self, post: usize) -> f64 {
        // `ids` flows from drain to source; the body diode always conducts
        // post 1 to post 2 (MosfetElm.java:800-820), so node 1 receives
        // `-diode_current` and node 2 `+diode_current`. The gate carries
        // nothing without gate caps.
        let d1 = -self.diode_current;
        match post {
            0 => 0.0,
            1 => self.ids + d1,
            2 => -self.ids - d1,
            _ => 0.0,
        }
    }

    fn voltage_diff(&self) -> f64 {
        // Upstream's MOSFET plots volts[2] - volts[1] (MosfetElm.java:710).
        self.base.volts[2] - self.base.volts[1]
    }

    fn connects(&self, a: usize, b: usize) -> bool {
        // The gate is isolated from the channel without gate caps
        // (MosfetElm.java:711-715), so a gate-only circuit reads as floating
        // instead of pinning the gate onto the source/drain.
        a != 0 && b != 0
    }

    /// The gate column stamps into the channel rows, so the gate must share
    /// the channel's closure (MosfetElm.java:716).
    fn matrix_connects(&self, _a: usize, _b: usize) -> bool {
        true
    }

    fn set_param(&mut self, name: &str, value: f64) -> bool {
        match name {
            "beta" if value > 0.0 => self.beta = value,
            "threshold" if value > 0.0 => self.vt = value,
            // The channel type decides which node is the source, so the UI
            // falls back to a full rebuild rather than patching in place.
            "pnp" => return false,
            _ => return false,
        }
        true
    }

    fn reset(&mut self) {
        self.base.reset();
        self.diode_current = 0.0;
        self.last_v0 = 0.0;
        self.last_v1 = 0.0;
        self.last_v2 = 0.0;
        self.ids = 0.0;
        self.diode.reset();
    }

    /// Re-anchors the clamped source/drain move from the restored node
    /// voltages, so a rejected step cannot leave `last_v1`/`last_v2` stuck
    /// mid-iteration on the retry.
    fn restore_iteration(&mut self) {
        self.last_v0 = self.base.volts[0];
        self.last_v1 = self.base.volts[1];
        self.last_v2 = self.base.volts[2];
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mosfet_with_beta(beta: f64) -> Mosfet {
        Mosfet::new(&ElementSpec {
            id: 0,
            kind: "mosfet".into(),
            posts: Vec::new(),
            params: [("beta", beta)]
                .into_iter()
                .map(|(k, v)| (k.to_string(), v))
                .collect(),
            label: None,
            model: None,
            flags: 0,
        })
    }

    fn ctx_at(subiter: usize) -> SimCtx {
        SimCtx {
            subiter,
            ..Default::default()
        }
    }

    /// The tolerance ladder against upstream's table of cases
    /// (MosfetElm.java:517-533): the absolute bar, the beta multiplier that
    /// rides every later branch too, the relative pass past subiteration 10,
    /// and the linear loosening past 100.
    #[test]
    fn non_convergence_tolerance_table() {
        let low = mosfet_with_beta(0.02);
        let high = mosfet_with_beta(10.0);

        // A plain 20 mV move on a 50 V signal: over the absolute bar, and the
        // relative pass needs more than ten iterations behind it.
        assert!(low.non_convergence(&ctx_at(5), 49.98, 50.0));
        // Same move at subiteration 50 passes relatively: 20 mV is far under
        // 0.1% of 50 V.
        assert!(!low.non_convergence(&ctx_at(50), 49.98, 50.0));

        // The same 20 mV move near ground gets no relative rescue (it is not
        // below 0.1% of a small signal), so only the loosening helps, and it
        // helps gradually: 15 mV at 150, 25 mV at 250.
        assert!(low.non_convergence(&ctx_at(5), 0.0, 0.02));
        assert!(low.non_convergence(&ctx_at(50), 0.0, 0.02));
        assert!(low.non_convergence(&ctx_at(150), 0.0, 0.02));
        assert!(!low.non_convergence(&ctx_at(250), 0.0, 0.02));

        // The absolute bar itself, strict inequality like upstream's `<`.
        assert!(!low.non_convergence(&ctx_at(5), 0.0, 0.0095));
        assert!(low.non_convergence(&ctx_at(5), 0.0, 0.01));

        // Beta above 1 multiplies the difference by 100 before any branch:
        // the same 9.5 mV move that a default part accepts fails here, while
        // one under 0.1 mV still passes.
        assert!(high.non_convergence(&ctx_at(5), 0.0, 0.0095));
        assert!(!high.non_convergence(&ctx_at(5), 0.0, 0.00005));
        // The multiplier reaches into the relative branch too (upstream
        // compares the scaled diff there), so a high-beta part on a large
        // node still refuses a move its default sibling would accept.
        assert!(high.non_convergence(&ctx_at(150), 49.998, 50.0));
        assert!(!high.non_convergence(&ctx_at(150), 50.0, 50.00004));

        // A settled terminal never reports motion, whatever the budget.
        assert!(!high.non_convergence(&ctx_at(150), 50.0, 50.0));
    }
}
