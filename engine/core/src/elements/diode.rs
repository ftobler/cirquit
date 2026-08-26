//! Shockley diode, optionally with a Zener breakdown branch or a varactor's
//! junction capacitance.

use crate::element::{Base, Element, SimCtx};
use crate::elements::capacitor::DC_OPEN;
use crate::elements::junction::{
    critical_voltage, junction_gmin, limit_junction, CONVERGENCE_V, MAX_EXP_ARG, VT,
};
use crate::spec::ElementSpec;
use crate::stamp::Stamper;

/// Breakdown-knee offset so 5 mA flows at the rated Zener voltage
/// (Diode.java:48-51). The breakdown branch is its own thermal exponential at
/// n = 1, so the offset uses `VT`, not the emission-scaled `vscale`.
fn zener_offset(z_voltage: f64, leakage: f64) -> f64 {
    if z_voltage <= 0.0 {
        return 0.0;
    }
    // Upstream takes log(0.005/leakage - 1) and gets NaN once leakage >= 5 mA,
    // where the rated current is unreachable because the saturation current
    // alone exceeds it. Real models are six orders of magnitude away from that,
    // but a NaN offset would poison every stamp, so clamp the argument. 1e-9
    // keeps the degraded knee near the rated voltage (the offset grows by
    // `VT*ln(1e9)` = 0.54 V) instead of pushing it 18 V out, which is what a
    // clamp at the smallest positive f64 would do.
    let arg = (0.005 / leakage - 1.0).max(1e-9);
    z_voltage - VT * arg.ln()
}

/// The varactor's voltage-dependent junction capacitance, stamped in
/// parallel with the diode junction it decorates (`VaractorElm extends
/// DiodeElm`, VaractorElm.java:6). Kept as a plain data struct rather than a
/// second `Element` impl: the two terminals, the I-V physics and the
/// junction limiting are exactly the diode's, so `Diode` grows this one
/// optional field instead of `Varactor` wrapping a whole separate `Diode`
/// with its own, redundantly-allocated `Base`.
///
/// The companion model follows [`Capacitor`](super::capacitor::Capacitor)'s
/// Norton convention (a conductance plus a current source, both stamped
/// directly across the two device posts) rather than upstream's Thevenin
/// form (a voltage source in series with a resistor through a dedicated
/// internal node, VaractorElm.java:97-120). The two are the same linear
/// two-terminal branch in different equivalent-circuit clothing, so the
/// simulated result is identical, and the Norton form needs no internal
/// node at all here, since nothing else in this port's capacitor stamps a
/// series voltage source.
struct VaractorCap {
    /// Capacitance at 0 V, upstream's `baseCapacitance`
    /// (VaractorElm.java:11, default 4e-12 F).
    base_capacitance: f64,
    /// Present capacitance, recomputed once per timestep in
    /// `start_iteration` from `v_prev`, the diode voltage at the end of the
    /// previous timestep — never mid-timestep, matching upstream's
    /// `startIteration` running once before Newton begins
    /// (VaractorElm.java:102-114).
    capacitance: f64,
    /// Diode terminal voltage after the last timestep converged
    /// (`capvoltdiff`, VaractorElm.java:30/34).
    v_prev: f64,
    /// This branch's own current from the last solve (`capCurrent`,
    /// VaractorElm.java:26/136), used as the trapezoidal history term.
    i_prev: f64,
    geq: f64,
    ieq: f64,
}

impl VaractorCap {
    fn new(spec: &ElementSpec) -> Self {
        let base_capacitance = spec.param("baseCapacitance", 4e-12);
        Self {
            base_capacitance,
            capacitance: base_capacitance,
            // The persisted transient state (VaractorElm.java:16, the
            // six-argument constructor). `capCurrent` is never dumped
            // upstream either, so it has no matching param: a freshly built
            // or loaded varactor always starts with zero branch current,
            // same as a plain `Capacitor`'s `i_prev`.
            v_prev: spec.param("capVoltDiff", 0.0),
            i_prev: 0.0,
            geq: 0.0,
            ieq: 0.0,
        }
    }
}

/// Shockley diode, optionally with a Zener breakdown branch.
pub struct Diode {
    base: Base,
    /// Saturation current.
    leakage: f64,
    /// Emission-scaled thermal voltage, `emcoef * VT`.
    vscale: f64,
    vcrit: f64,
    /// Reverse breakdown voltage; zero disables the branch.
    z_voltage: f64,
    z_offset: f64,
    /// Limiting threshold for the breakdown exponential, a steeper curve than
    /// the forward one (Diode.java:44).
    vzcrit: f64,
    /// Rated forward drop, used to derive `leakage` when no saturation current
    /// is given (DiodeModel.java:149).
    fwdrop: f64,
    /// Emission coefficient (n), 2 for the default model.
    emcoef: f64,
    /// True when `saturationCurrent` was supplied, so forward-drop edits do
    /// not overwrite an explicit saturation current.
    explicit_sat: bool,
    /// Fixed series resistance between the cathode terminal and the junction.
    /// Zero means the junction sits directly on post 1.
    series_resistance: f64,
    /// Node index of the cathode side of the junction: 2 when the series
    /// resistor is present, else 1 (DiodeElm.java:72-82).
    diode_end: usize,
    last_v: f64,
    geq: f64,
    ieq: f64,
    /// `Some` only for the varactor variant (`Diode::new_varactor`); `None`
    /// for a plain diode or Zener.
    varactor: Option<VaractorCap>,
}

impl Diode {
    pub fn new(spec: &ElementSpec) -> Self {
        Self::build(spec, spec.param("breakdownVoltage", 0.0))
    }

    pub fn new_zener(spec: &ElementSpec) -> Self {
        Self::build(spec, spec.param("breakdownVoltage", 5.6))
    }

    /// `VaractorElm` always uses the plain diode model (never a Zener), and
    /// adds a voltage-dependent capacitance in parallel (VaractorElm.java:6).
    pub fn new_varactor(spec: &ElementSpec) -> Self {
        let mut d = Self::build(spec, 0.0);
        d.varactor = Some(VaractorCap::new(spec));
        d
    }

    fn build(spec: &ElementSpec, z_voltage: f64) -> Self {
        const DEFAULT_FWDROP: f64 = 0.805_904_783; // DiodeElm.java:51 defaultdrop

        let fwdrop = spec.param("forwardVoltage", DEFAULT_FWDROP).max(0.05);
        let emcoef = spec.param("emissionCoefficient", 2.0).max(0.1);
        let vscale = emcoef * VT; // DiodeModel.java:333
        let vdcoef = 1.0 / vscale;
        // An explicit saturation current wins; otherwise the curve is anchored
        // so the rated forward drop is on it, which is exactly how upstream
        // derives the default model (DiodeModel.java:149). With the defaults
        // this is bit-exact to the "default" model's Is.
        let explicit = spec.param("saturationCurrent", 0.0);
        let leakage = if explicit > 0.0 {
            explicit
        } else {
            1.0 / ((fwdrop * vdcoef).exp() - 1.0)
        };
        let series_resistance = spec.param("seriesResistance", 0.0).max(0.0);
        let z_offset = zener_offset(z_voltage, leakage);
        Self {
            base: Base::with_posts(2),
            leakage,
            vscale,
            vcrit: critical_voltage(vscale, leakage),
            vzcrit: critical_voltage(VT, leakage),
            z_voltage,
            z_offset,
            fwdrop,
            emcoef,
            explicit_sat: explicit > 0.0,
            series_resistance,
            diode_end: if series_resistance > 0.0 { 2 } else { 1 },
            last_v: 0.0,
            geq: 0.0,
            ieq: 0.0,
            varactor: None,
        }
    }

    /// Saturation current implied by the rated forward drop under the current
    /// scale voltage, the inverse of the derivation in `build`.
    fn derived_leakage(&self) -> f64 {
        1.0 / ((self.fwdrop / self.vscale).exp() - 1.0)
    }

    /// Keeps the breakdown knee consistent with the forward parameters that
    /// define it, using the same `vt`-based offset as `build`.
    fn recompute_z_offset(&mut self) {
        self.z_offset = zener_offset(self.z_voltage, self.leakage);
    }

    /// Current and its derivative at `v`, with a parallel junction conductance
    /// of `gmin` (the saturation-current-scaled base, or the geometric ramp
    /// once a step is stuck).
    fn evaluate(&self, v: f64, gmin: f64) -> (f64, f64) {
        let arg = (v / self.vscale).min(MAX_EXP_ARG);
        let ev = arg.exp();
        let mut i = self.leakage * (ev - 1.0);
        let mut g = self.leakage * ev / self.vscale;
        // The breakdown term belongs to the reverse side only: upstream's
        // forward branch is the plain Shockley law, and only the reverse branch
        // is `Is*(exp(v/vscale) - exp((-v-zoffset)/vt) - 1)`
        // (Diode.java:158-191). Subtracting the bare `ez`, not `ez - 1`, is
        // what that expression reduces to here. It matters twice: the two
        // branches then meet at v = 0 instead of stepping by `leakage`, and the
        // rated 5 mA lands exactly on `z_voltage`, which is how `z_offset` was
        // derived in the first place.
        if self.z_voltage > 0.0 && v < 0.0 {
            let zarg = (-(v + self.z_offset) / VT).min(MAX_EXP_ARG);
            let ez = zarg.exp();
            i -= self.leakage * ez;
            g += self.leakage * ez / VT;
        }
        (i, g + gmin)
    }

    /// The junction voltage the next `do_step` compares and limits against
    /// (`lastvoltdiff`, Diode.java:142-145). Inspection hook for embedded
    /// diodes whose `Base` no circuit ever sees.
    #[cfg(test)]
    pub(crate) fn junction_anchor(&self) -> f64 {
        self.last_v
    }
}

impl Element for Diode {
    fn kind(&self) -> &'static str {
        if self.varactor.is_some() {
            "varactor"
        } else if self.z_voltage > 0.0 {
            "zener"
        } else {
            "diode"
        }
    }
    fn base(&self) -> &Base {
        &self.base
    }
    fn base_mut(&mut self) -> &mut Base {
        &mut self.base
    }
    fn post_count(&self) -> usize {
        2
    }
    fn nonlinear(&self) -> bool {
        true
    }

    /// The series resistor's junction side is an extra node, invisible to the
    /// TypeScript side, exactly as upstream's `getInternalNodeCount`
    /// (DiodeElm.java:82).
    fn internal_node_count(&self) -> usize {
        if self.series_resistance > 0.0 {
            1
        } else {
            0
        }
    }

    fn stamp(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        // The series resistor is constant for the whole run, so it belongs in
        // the constant pass: it sits between post 1 and the internal node,
        // while the nonlinear junction (node 0 to internal node) is stamped by
        // do_step (DiodeElm.java:166-175).
        if self.series_resistance > 0.0 {
            s.resistor(
                self.base.nodes[1],
                self.base.nodes[2],
                self.series_resistance,
            );
        }
    }

    /// Recomputes the varactor's capacitance and companion-model values once
    /// per timestep, before Newton begins, matching upstream's
    /// `startIteration` (VaractorElm.java:102-114). No-op for a plain diode
    /// or Zener.
    fn start_iteration(&mut self, ctx: &SimCtx) {
        let Some(vc) = self.varactor.as_mut() else {
            return;
        };
        // Abrupt-junction law with grading coefficient 0.5, reusing the
        // diode's own forward drop as the junction potential: upstream has
        // no separate field for it either (VaractorElm.java:107-111). The
        // forward branch is pinned to the 0 V capacitance rather than
        // following the curve through its pole at v_prev == fwdrop.
        vc.capacitance = if vc.v_prev > 0.0 {
            vc.base_capacitance
        } else {
            vc.base_capacitance / (1.0 - vc.v_prev / self.fwdrop).sqrt()
        };
        if ctx.dc_analysis {
            // Steady-state treatment for the DC operating point, matching
            // how `Capacitor::stamp` treats every other reactive element
            // here; upstream has no such pass (see capacitor.rs's `DC_OPEN`).
            vc.geq = 1.0 / DC_OPEN;
            vc.ieq = 0.0;
        } else {
            // Trapezoidal Norton companion, the same shape as
            // `Capacitor::do_step` (upstream's varactor has no
            // backward-Euler option to mirror).
            vc.geq = 2.0 * vc.capacitance / ctx.dt;
            vc.ieq = vc.geq * vc.v_prev + vc.i_prev;
        }
    }

    fn do_step(&mut self, ctx: &SimCtx, s: &mut Stamper) {
        let (n0, nend) = (self.base.nodes[0], self.base.nodes[self.diode_end]);
        let mut v = self.base.volts[0] - self.base.volts[self.diode_end];
        if (v - self.last_v).abs() > CONVERGENCE_V {
            s.not_converged();
        }

        v = limit_junction(v, self.last_v, self.vscale, self.vcrit);
        if self.z_voltage > 0.0 {
            // The breakdown branch is the forward branch mirrored about
            // `-z_offset`, so limit it in the mirrored coordinate, with the
            // steeper `vt`/`vzcrit` scale of the breakdown exponential
            // (Diode.java:107-129).
            let mirrored = limit_junction(
                -(v + self.z_offset),
                -(self.last_v + self.z_offset),
                VT,
                self.vzcrit,
            );
            v = -mirrored - self.z_offset;
        }
        self.last_v = v;

        // Below the ramp start the parallel conductance tracks the model's
        // saturation current; once a step is stuck, the geometric ramp takes
        // over (Diode.java:147-156).
        let gmin = junction_gmin(self.leakage, ctx.subiter as u32);
        let (i, g) = self.evaluate(v, gmin);
        self.geq = g;
        self.ieq = i - g * v;
        s.conductance(n0, nend, g);
        s.current_source(n0, nend, self.ieq);

        // The varactor's junction capacitance, stamped directly across the
        // two device posts (nodes[0], nodes[1]) rather than through
        // `diode_end`: upstream places it there too, across the full
        // terminal pair rather than just the bare junction
        // (VaractorElm.java:97-101/117-119), which only differs from the
        // junction-only placement when a series resistance is also present.
        if let Some(vc) = self.varactor.as_ref() {
            let (p0, p1) = (self.base.nodes[0], self.base.nodes[1]);
            s.conductance(p0, p1, vc.geq);
            // Norton current source, matching `Capacitor::do_step`'s stamp:
            // `calculate_current`/`step_finished` both use the
            // `I(p0->p1) = geq*v - ieq` convention, so the branch's ieq term
            // needs the swapped node order `(p1, p0)` to land on the same
            // equation `current_source` implements as `+i` into its second
            // argument (see `Capacitor`'s identical swap in capacitor.rs).
            s.current_source(p1, p0, vc.ieq);
        }
    }

    fn calculate_current(&mut self, _ctx: &SimCtx) {
        // The junction current across the diode proper, not the terminal
        // current: with series resistance the two differ by the resistor.
        self.base.current =
            self.geq * (self.base.volts[0] - self.base.volts[self.diode_end]) + self.ieq;
        // VaractorElm.calculateCurrent adds the capacitor branch's own
        // current to the diode's (VaractorElm.java:37-40).
        if let Some(vc) = self.varactor.as_ref() {
            let v = self.base.volts[0] - self.base.volts[1];
            self.base.current += vc.geq * v - vc.ieq;
        }
    }

    /// Updates the varactor's persisted transient state once per timestep,
    /// after Newton has converged, matching upstream's `stepFinished`
    /// (VaractorElm.java:33-35). No-op for a plain diode or Zener, which
    /// upstream's `DiodeElm` also leaves without an override of its own.
    fn step_finished(&mut self, _ctx: &SimCtx) {
        if let Some(vc) = self.varactor.as_mut() {
            let v = self.base.volts[0] - self.base.volts[1];
            vc.i_prev = vc.geq * v - vc.ieq;
            vc.v_prev = v;
        }
    }

    /// Re-anchors the linearisation from the restored node voltages. Upstream
    /// leaves `lastvoltdiff` holding whatever the failed attempt last wrote
    /// (Diode.java:140-145); re-deriving it from `base.volts` makes the retry
    /// deterministic. The same expression `do_step` uses, so with a series
    /// resistance it anchors at the junction rather than the terminals.
    fn restore_iteration(&mut self) {
        self.last_v = self.base.volts[0] - self.base.volts[self.diode_end];
    }

    fn state_tokens(&self) -> Vec<(String, f64)> {
        // Only the varactor variant owns the persisted junction-voltage token
        // (VaractorElm.java:16); a plain diode or Zener has no operating
        // token in the format.
        match &self.varactor {
            Some(vc) => vec![("capVoltDiff".into(), vc.v_prev)],
            None => vec![],
        }
    }

    fn set_param(&mut self, name: &str, value: f64) -> bool {
        match name {
            "forwardVoltage" => {
                self.fwdrop = value.max(0.05);
                if !self.explicit_sat {
                    self.leakage = self.derived_leakage();
                }
            }
            "emissionCoefficient" => {
                self.emcoef = value.max(0.1);
                self.vscale = self.emcoef * VT;
                if !self.explicit_sat {
                    self.leakage = self.derived_leakage();
                }
            }
            "saturationCurrent" => {
                self.leakage = value.max(1e-20);
                self.explicit_sat = true;
            }
            "breakdownVoltage" => {
                self.z_voltage = value;
            }
            // VaractorElm's "Capacitance @ 0V" edit (VaractorElm.java:122-126).
            "baseCapacitance" if value > 0.0 => {
                let Some(vc) = self.varactor.as_mut() else {
                    return false;
                };
                vc.base_capacitance = value;
            }
            // Changing between zero and non-zero series resistance changes
            // `internal_node_count`, which a live patch cannot do: the caller
            // must rebuild.
            "seriesResistance" => return false,
            _ => return false,
        }
        self.vcrit = critical_voltage(self.vscale, self.leakage);
        self.vzcrit = critical_voltage(VT, self.leakage);
        self.recompute_z_offset();
        true
    }

    fn reset(&mut self) {
        self.base.reset();
        self.last_v = 0.0;
        self.geq = 0.0;
        self.ieq = 0.0;
        // Upstream's own `reset()` only clears `capvoltdiff`, leaving
        // `capCurrent` stale from the previous run (VaractorElm.java:41-44).
        // The Run/Reset button re-zeroes everything else on this side
        // (`self.base.reset()` above), so a stale branch current here would
        // be the one exception; clear it too.
        if let Some(vc) = self.varactor.as_mut() {
            vc.v_prev = 0.0;
            vc.i_prev = 0.0;
        }
    }
}
