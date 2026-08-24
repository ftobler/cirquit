//! Bidirectional thyristor (TriacElm.java): a three-terminal latching
//! nonlinear device that conducts in both directions once fired. The two main
//! terminals, MT2 and MT1, reach each other through a back-to-back pair of
//! internal diodes in series with a latch-controlled variable resistor, while
//! the gate ties to MT1 through a fixed resistor. A gate current above
//! `triggerI` fires the latch; it clears only when the main-terminal current
//! drops below `holdingI`, so either polarity stays conducting once fired.

use crate::element::{Base, Element, SimCtx};
use crate::elements::junction::{
    critical_voltage, junction_gmin, limit_junction, CONVERGENCE_V, MAX_EXP_ARG, VT,
};
use crate::spec::ElementSpec;
use crate::stamp::Stamper;

const DEF_TRIGGER_I: f64 = 0.01;
const DEF_HOLDING_I: f64 = 0.0082;
/// Gate-to-MT1 resistance, the file token `cresistance`.
const DEF_C_RESISTANCE: f64 = 100.0;
/// On-state resistance of the MT1-to-internal-node path (TriacElm.java:230).
const ON_RESISTANCE: f64 = 0.01;
/// Off-state resistance of the same path, upstream's literal `10e5` (one
/// megaohm): high enough to block, but the internal diodes still leak the
/// microamps that decide whether the latch condition is met.
const OFF_RESISTANCE: f64 = 10e5;
/// Forward drop of the internal diodes' default model, the same `defaultdrop`
/// the plain diode derives its saturation current from (DiodeElm.java:51).
const DEFAULT_FWDROP: f64 = 0.805_904_783;

/// Forward junction law of one leg, the plain Shockley branch with the
/// parallel junction conductance, mirroring `Diode::evaluate` without the
/// zener term (Diode.java:158-191).
fn evaluate_junction(v: f64, gmin: f64, leakage: f64, vscale: f64) -> (f64, f64) {
    let arg = (v / vscale).min(MAX_EXP_ARG);
    let ev = arg.exp();
    let i = leakage * (ev - 1.0);
    let g = leakage * ev / vscale;
    (i, g + gmin)
}

/// Bidirectional triode thyristor.
///
/// Posts are MT2, MT1 and gate; the extra node between the variable resistor
/// and the back-to-back diodes is upstream's `mtinode` (TriacElm.java:25-31).
pub struct Triac {
    base: Base,
    trigger_i: f64,
    holding_i: f64,
    c_resistance: f64,
    /// Resistance stamped between the internal node and MT1 this step:
    /// `ON_RESISTANCE` when the latch is set, `OFF_RESISTANCE` when not.
    a_resistance: f64,
    /// The latch, restored from the file-format `state` token and cleared or
    /// re-fired by `start_iteration` from the last converged currents.
    state: bool,
    /// Main-terminal current through the internal node to MT1, positive when
    /// the device conducts from MT2 toward MT1, from the last converged solve.
    i2: f64,
    /// Gate current (gate toward MT1), from the last converged solve.
    ig: f64,
    /// Linearisation anchors of the two antiparallel legs: `forward_last_v`
    /// is the leg whose anode is MT2, `reverse_last_v` the mirror image whose
    /// anode is the internal node.
    forward_last_v: f64,
    reverse_last_v: f64,
    leakage: f64,
    vscale: f64,
    vcrit: f64,
}

impl Triac {
    pub fn new(spec: &ElementSpec) -> Self {
        let vscale = 2.0 * VT; // the default model's emission coefficient is 2
        let leakage = 1.0 / ((DEFAULT_FWDROP / vscale).exp() - 1.0);
        let state = spec.param("state", 0.0) > 0.0;
        Self {
            base: Base::with_posts(3),
            trigger_i: spec.param("triggerI", DEF_TRIGGER_I),
            holding_i: spec.param("holdingI", DEF_HOLDING_I),
            c_resistance: spec.param("cresistance", DEF_C_RESISTANCE),
            a_resistance: if state { ON_RESISTANCE } else { OFF_RESISTANCE },
            state,
            i2: 0.0,
            ig: 0.0,
            forward_last_v: 0.0,
            reverse_last_v: 0.0,
            leakage,
            vscale,
            vcrit: critical_voltage(vscale, leakage),
        }
    }
}

impl Element for Triac {
    fn kind(&self) -> &'static str {
        "triac"
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
    fn internal_node_count(&self) -> usize {
        1
    }
    fn nonlinear(&self) -> bool {
        true
    }

    /// The gate resistor is constant for the whole run, so it lives in the
    /// constant pass; the back-to-back diodes and the variable resistor are
    /// nonlinear and stamped by `do_step` (TriacElm.java:215-223).
    fn stamp(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        s.resistor(self.base.nodes[2], self.base.nodes[1], self.c_resistance);
    }

    /// The latch, upstream's `startIteration` (TriacElm.java:225-230). Clear
    /// first, then set: when both conditions hold in one step the fire wins,
    /// exactly like upstream's two independent ifs. The absolute values make
    /// the device fire and hold in either polarity.
    fn start_iteration(&mut self, _ctx: &SimCtx) {
        if self.i2.abs() < self.holding_i {
            self.state = false;
        }
        if self.ig.abs() > self.trigger_i {
            self.state = true;
        }
        self.a_resistance = if self.state {
            ON_RESISTANCE
        } else {
            OFF_RESISTANCE
        };
    }

    fn do_step(&mut self, ctx: &SimCtx, s: &mut Stamper) {
        let (n_mt2, n_mt1, n_in) = (self.base.nodes[0], self.base.nodes[1], self.base.nodes[3]);
        // The gmin ramp engages once a step is stuck, same as the diode; the
        // base it replaces is the diode family's leakage*0.01, since upstream
        // stamps these junctions through real `Diode` instances
        // (TriacElm.java:66-68).
        let gmin = junction_gmin(self.leakage, ctx.subiter as u32);

        // The MT2-to-internal leg, forward when MT2 sits above the internal
        // node and carrying the main current in the forward direction.
        let mut v = self.base.volts[0] - self.base.volts[3];
        if (v - self.forward_last_v).abs() > CONVERGENCE_V {
            s.not_converged();
        }
        v = limit_junction(v, self.forward_last_v, self.vscale, self.vcrit);
        self.forward_last_v = v;
        let (i, g_fwd) = evaluate_junction(v, gmin, self.leakage, self.vscale);
        let ieq_fwd = i - g_fwd * v;

        // The internal-to-MT2 leg, its mirror image carrying the reverse
        // current. The two legs share the one model but limit and anchor
        // independently, like upstream's two `Diode` instances
        // (TriacElm.java:39-40).
        let mut v = self.base.volts[3] - self.base.volts[0];
        if (v - self.reverse_last_v).abs() > CONVERGENCE_V {
            s.not_converged();
        }
        v = limit_junction(v, self.reverse_last_v, self.vscale, self.vcrit);
        self.reverse_last_v = v;
        let (i, g_rev) = evaluate_junction(v, gmin, self.leakage, self.vscale);
        let ieq_rev = i - g_rev * v;

        // The antiparallel pair is one branch across MT2 and the internal
        // node: the conductances add and the second leg's source flips sign,
        // leaving the antisymmetric law `f(v) - f(-v)` between the two legs.
        s.conductance(n_mt2, n_in, g_fwd + g_rev);
        s.current_source(n_mt2, n_in, ieq_fwd - ieq_rev);

        s.resistor(n_in, n_mt1, self.a_resistance);
    }

    fn calculate_current(&mut self, _ctx: &SimCtx) {
        // Upstream guards against a 0 `aresistance` at start-up
        // (TriacElm.java:248-252); the port's resistance is never 0, so the
        // guard only mirrors the intent.
        self.i2 = if self.a_resistance > 0.0 {
            (self.base.volts[3] - self.base.volts[1]) / self.a_resistance
        } else {
            0.0
        };
        self.ig = (self.base.volts[2] - self.base.volts[1]) / self.c_resistance;
        // The scope reports the main-terminal current (TriacElm.java:278).
        self.base.current = self.i2;
    }

    fn state_tokens(&self) -> Vec<(String, f64)> {
        vec![("state".into(), if self.state { 1.0 } else { 0.0 })]
    }

    /// Upstream reports each terminal's current into the device, negated for
    /// the node injection (TriacElm.java:202-208).
    fn current_into_node(&self, post: usize) -> f64 {
        match post {
            0 => -self.i2,
            1 => self.i2 + self.ig,
            2 => -self.ig,
            _ => 0.0,
        }
    }

    fn power(&self) -> f64 {
        // Includes the gate branch's dissipation: `(Vmt2-Vmt1)*i2 +
        // (Vg-Vmt1)*ig` (TriacElm.java:256-258).
        let v = &self.base.volts;
        (v[0] - v[1]) * self.i2 + (v[2] - v[1]) * self.ig
    }

    fn set_param(&mut self, name: &str, value: f64) -> bool {
        match name {
            "triggerI" if value > 0.0 => self.trigger_i = value,
            "holdingI" if value > 0.0 => self.holding_i = value,
            "cresistance" if value > 0.0 => self.c_resistance = value,
            _ => return false,
        }
        true
    }

    /// Re-anchors the Newton state from the restored node voltages after a
    /// rejected step, so the retry starts where the last committed step left
    /// off. The latch's `i2`/`ig` do not move during a step, so
    /// `a_resistance` needs no re-derivation.
    fn restore_iteration(&mut self) {
        self.forward_last_v = self.base.volts[0] - self.base.volts[3];
        self.reverse_last_v = self.base.volts[3] - self.base.volts[0];
    }

    fn reset(&mut self) {
        self.base.reset();
        self.i2 = 0.0;
        self.ig = 0.0;
        self.state = false;
        self.a_resistance = OFF_RESISTANCE;
        self.forward_last_v = 0.0;
        self.reverse_last_v = 0.0;
    }
}
