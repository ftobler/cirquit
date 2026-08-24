//! Diac: a two-terminal symmetric-breakdown device made of two back-to-back
//! diodes (DiacElm.java). A state latch switches a shared series resistance
//! between the off value and a 500 ohm on value: the device fires when the
//! terminal voltage exceeds `breakdown` and clears when the current falls
//! below `holdcurrent`, the same hysteresis the spark gap uses. Unlike the
//! spark gap, each direction conducts through its own forward-biased internal
//! diode, so the drop across a conducting diac is a junction drop plus the
//! on-resistance, not a bare resistor.

use crate::element::{Base, Element, SimCtx};
use crate::elements::junction::{
    critical_voltage, junction_gmin, limit_junction, CONVERGENCE_V, MAX_EXP_ARG, VT,
};
use crate::spec::ElementSpec;
use crate::stamp::Stamper;

const DEF_ON_RESISTANCE: f64 = 500.0;
const DEF_OFF_RESISTANCE: f64 = 1e8;
const DEF_BREAKDOWN: f64 = 30.0;
const DEF_HOLDCURRENT: f64 = 0.01;
/// Forward drop of the internal diodes' default model, the same `defaultdrop`
/// the plain diode derives its saturation current from (DiodeElm.java:51).
const DEFAULT_FWDROP: f64 = 0.805_904_783;

/// The two internal junctions' shared parameters, both on the default diode
/// model: emission coefficient 2 and a saturation current derived from the
/// rated 0.8059 V forward drop (DiodeModel.java:83-149).
#[derive(Clone, Copy)]
struct JunctionModel {
    leakage: f64,
    vscale: f64,
    vcrit: f64,
}

impl JunctionModel {
    fn default_model() -> Self {
        let vscale = 2.0 * VT; // the default model's emission coefficient is 2
        let leakage = 1.0 / ((DEFAULT_FWDROP / vscale).exp() - 1.0);
        Self {
            leakage,
            vscale,
            vcrit: critical_voltage(vscale, leakage),
        }
    }
}

/// One of the two back-to-back junctions, with its own Newton anchors. The
/// diodes are independent devices upstream, each with its own `lastvoltdiff`,
/// `geq` and `nc` (Diode.java:79-81), so the anchors cannot be shared.
struct Junction {
    model: JunctionModel,
    last_v: f64,
    geq: f64,
    ieq: f64,
}

impl Junction {
    fn new(model: JunctionModel) -> Self {
        Self {
            model,
            last_v: 0.0,
            geq: 0.0,
            ieq: 0.0,
        }
    }

    fn reset(&mut self) {
        self.last_v = 0.0;
        self.geq = 0.0;
        self.ieq = 0.0;
    }

    /// Linearises the Shockley law across `anode` to `cathode`, the same
    /// Norton companion the plain diode stamps (Diode.java:140-164). The
    /// junction voltage is passed in, read by the caller from its per-element
    /// `volts` at the local positions, because `anode`/`cathode` here are
    /// global node ids for the Stamper and cannot index that array.
    fn stamp(&mut self, ctx: &SimCtx, s: &mut Stamper, anode: usize, cathode: usize, mut v: f64) {
        if (v - self.last_v).abs() > CONVERGENCE_V {
            s.not_converged();
        }
        v = limit_junction(v, self.last_v, self.model.vscale, self.model.vcrit);
        self.last_v = v;
        // The gmin ramp engages once a step is stuck, same as the diode; the
        // base it replaces is the diode family's leakage*0.01, since upstream
        // stamps these junctions through real `Diode` instances
        // (DiacElm.java:53-54).
        let gmin = junction_gmin(self.model.leakage, ctx.subiter as u32);
        let arg = (v / self.model.vscale).min(MAX_EXP_ARG);
        let ev = arg.exp();
        let i = self.model.leakage * (ev - 1.0);
        self.geq = self.model.leakage * ev / self.model.vscale + gmin;
        self.ieq = i - self.geq * v;
        s.conductance(anode, cathode, self.geq);
        s.current_source(anode, cathode, self.ieq);
    }

    /// Re-anchors the linearisation point from the restored junction voltage,
    /// so a retry at a smaller step starts where the last committed step left
    /// off.
    fn restore(&mut self, v: f64) {
        self.last_v = v;
    }
}

/// The diac. Posts 0 and 1 are the two terminals; internal nodes 2 and 3 are
/// the junction ends of the two branches, upstream's `nodes[2]` and
/// `nodes[3]` (DiacElm.java:27-28).
pub struct Diac {
    base: Base,
    on_resistance: f64,
    off_resistance: f64,
    breakdown: f64,
    holdcurrent: f64,
    /// Resistance stamped this step: on or off by the latch, kept for the
    /// current report.
    resistance: f64,
    /// Whether the device is conducting this step.
    state: bool,
    /// Diode 1, from internal node 2 to post 1: conducts post 0 to post 1.
    j1: Junction,
    /// Diode 2, from post 1 to internal node 3: conducts post 1 to post 0.
    j2: Junction,
}

impl Diac {
    pub fn new(spec: &ElementSpec) -> Self {
        let model = JunctionModel::default_model();
        Self {
            base: Base::with_posts(2),
            on_resistance: spec.param("r_on", DEF_ON_RESISTANCE),
            off_resistance: spec.param("r_off", DEF_OFF_RESISTANCE),
            breakdown: spec.param("breakdown", DEF_BREAKDOWN),
            holdcurrent: spec.param("holdcurrent", DEF_HOLDCURRENT),
            resistance: DEF_OFF_RESISTANCE,
            state: false,
            j1: Junction::new(model),
            j2: Junction::new(model),
        }
    }
}

impl Element for Diac {
    fn kind(&self) -> &'static str {
        "diac"
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
    fn internal_node_count(&self) -> usize {
        2
    }
    fn nonlinear(&self) -> bool {
        true
    }

    fn start_iteration(&mut self, _ctx: &SimCtx) {
        // Clear first, then set: when both conditions hold in one step the
        // fire wins, exactly like upstream's two independent ifs
        // (DiacElm.java:123-127).
        if self.base.current.abs() < self.holdcurrent {
            self.state = false;
        }
        if self.base.voltage_diff().abs() > self.breakdown {
            self.state = true;
        }
    }

    fn do_step(&mut self, ctx: &SimCtx, s: &mut Stamper) {
        let r = if self.state {
            self.on_resistance
        } else {
            self.off_resistance
        };
        self.resistance = r;
        // Both branches hang off post 0 through the latch resistor: branch A
        // runs diode 1 from internal node 2 to post 1, branch B runs diode 2
        // from post 1 to internal node 3, the back-to-back pair that breaks
        // down symmetrically (DiacElm.java:128-134).
        let (n0, n1, n2, n3) = (
            self.base.nodes[0],
            self.base.nodes[1],
            self.base.nodes[2],
            self.base.nodes[3],
        );
        s.resistor(n0, n2, r);
        s.resistor(n0, n3, r);
        self.j1
            .stamp(ctx, s, n2, n1, self.base.volts[2] - self.base.volts[1]);
        self.j2
            .stamp(ctx, s, n1, n3, self.base.volts[1] - self.base.volts[3]);
    }

    fn calculate_current(&mut self, _ctx: &SimCtx) {
        // Both branches report through their shared series resistor
        // (DiacElm.java:119-122).
        self.base.current = (self.base.volts[0] - self.base.volts[2]) / self.resistance
            + (self.base.volts[0] - self.base.volts[3]) / self.resistance;
    }

    /// Re-anchors both junction linearisations from the restored node
    /// voltages. `state` is fixed once `start_iteration` ran, so `resistance`
    /// needs no re-derivation.
    fn restore_iteration(&mut self) {
        self.j1.restore(self.base.volts[2] - self.base.volts[1]);
        self.j2.restore(self.base.volts[1] - self.base.volts[3]);
    }

    fn set_param(&mut self, name: &str, value: f64) -> bool {
        match name {
            "r_on" if value > 0.0 => self.on_resistance = value,
            "r_off" if value > 0.0 => self.off_resistance = value,
            "breakdown" if value > 0.0 => self.breakdown = value,
            "holdcurrent" if value > 0.0 => self.holdcurrent = value,
            _ => return false,
        }
        true
    }

    fn reset(&mut self) {
        // Upstream has no reset override at all (DiacElm), so only the base
        // volts and curcount are zeroed: state survives, and start_iteration
        // re-derives the latch from the element current, which upstream's
        // base reset also leaves alone.
        let current = self.base.current;
        self.base.reset();
        self.base.current = current;
        self.j1.reset();
        self.j2.reset();
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    fn spec(kind: &str) -> ElementSpec {
        ElementSpec {
            id: 1,
            kind: kind.into(),
            posts: Vec::new(),
            params: HashMap::new(),
            label: None,
            model: None,
            flags: 0,
        }
    }

    #[test]
    fn diac_latch_survives_reset_like_upstream() {
        let mut d = Diac::new(&spec("diac"));
        d.state = true;
        d.resistance = d.on_resistance;
        // Upstream's CircuitElm.reset zeroes volts and curcount but never
        // `current` (CircuitElm.java:258-263), and DiacElm has no reset
        // override at all, so start_iteration re-derives the on state from
        // the surviving element current (DiacElm.java:123-127).
        d.base.current = 10.0 * DEF_HOLDCURRENT;
        d.reset();
        assert_eq!(
            d.base.current,
            10.0 * DEF_HOLDCURRENT,
            "the element current feeding the latch must survive Reset"
        );
        d.start_iteration(&SimCtx::default());
        assert!(d.state, "a conducting diac must still be on after Reset");
    }

    #[test]
    fn diac_reset_still_zeroes_the_terminal_volts_and_junction_anchors() {
        let mut d = Diac::new(&spec("diac"));
        d.base.volts = vec![40.0, 5.0];
        d.j1.last_v = 0.7;
        d.reset();
        assert!(d.base.volts.iter().all(|v| *v == 0.0));
        assert_eq!(d.j1.last_v, 0.0);
    }
}
