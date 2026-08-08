//! Silicon-controlled rectifier (SCRElm.java): a three-terminal latching
//! nonlinear device. The anode reaches the cathode through the series
//! combination of a latch-controlled variable resistor and the internal
//! diode, while the gate ties to the cathode through a fixed gate resistor.
//! A gate current above `triggerI`, or an anode current above `holdingI`,
//! latches the variable resistor into its low on-state; the anode term alone
//! keeps the latch set once the gate drive is gone.

use crate::element::{Base, Element, SimCtx};
use crate::elements::junction::{
    critical_voltage, limit_junction, ramp_gmin, CONVERGENCE_V, GMIN_RAMP_DENOM, GMIN_RAMP_START,
    JUNCTION_GMIN, MAX_EXP_ARG, VT,
};
use crate::spec::ElementSpec;
use crate::stamp::{Stamper, GROUND};

const DEF_TRIGGER_I: f64 = 0.01;
const DEF_HOLDING_I: f64 = 0.0082;
const DEF_G_RESISTANCE: f64 = 50.0;
/// On-state resistance of the anode-to-internal-node path (SCRElm.java:232).
const ON_RESISTANCE: f64 = 0.0105;
/// Off-state resistance of the same path, upstream's literal `10e5` (one
/// megaohm): high enough to block, but the internal diode still leaks the
/// microamps that decide whether the latch condition is met.
const OFF_RESISTANCE: f64 = 10e5;
/// Forward drop of the internal diode's default model, the same `defaultdrop`
/// the plain diode derives its saturation current from (DiodeElm.java:51).
const DEFAULT_FWDROP: f64 = 0.805_904_783;

/// Silicon-controlled rectifier.
///
/// Posts are anode, cathode and gate; the extra node between the variable
/// resistor and the internal diode is upstream's `inode`
/// (SCRElm.java:26-30).
pub struct Scr {
    base: Base,
    trigger_i: f64,
    holding_i: f64,
    g_resistance: f64,
    /// Resistance stamped between the anode and the internal node this step:
    /// `ON_RESISTANCE` when the latch is set, `OFF_RESISTANCE` when not.
    a_resistance: f64,
    /// Currents from the last converged solve. `do_step` reads these to
    /// decide the latch, so the state flips one step after the gate fires,
    /// exactly as upstream's use of the previously calculated `ia`/`ic`
    /// (SCRElm.java:229-232).
    ia: f64,
    ig: f64,
    /// Convergence anchors for the two anode-minus-terminal voltages, the
    /// file-format `lastvac`/`lastvag` (SCRElm.java:223-227).
    last_vac: f64,
    last_vag: f64,
    /// The internal junction, inode to cathode, on the default diode model.
    leakage: f64,
    vscale: f64,
    vcrit: f64,
    junction_last_v: f64,
    junction_ieq: f64,
}

impl Scr {
    pub fn new(spec: &ElementSpec) -> Self {
        let vscale = 2.0 * VT; // the default model's emission coefficient is 2
        let leakage = 1.0 / ((DEFAULT_FWDROP / vscale).exp() - 1.0);
        Self {
            base: Base::with_posts(3),
            trigger_i: spec.param("triggerI", DEF_TRIGGER_I),
            holding_i: spec.param("holdingI", DEF_HOLDING_I),
            g_resistance: spec.param("gResistance", DEF_G_RESISTANCE),
            a_resistance: OFF_RESISTANCE,
            ia: 0.0,
            ig: 0.0,
            last_vac: spec.param("lastvac", 0.0),
            last_vag: spec.param("lastvag", 0.0),
            leakage,
            vscale,
            vcrit: critical_voltage(vscale, leakage),
            junction_last_v: 0.0,
            junction_ieq: 0.0,
        }
    }

    /// Forward junction law, the plain Shockley branch with the parallel
    /// junction conductance, mirroring `Diode::evaluate` without the zener
    /// term (Diode.java:158-191).
    fn evaluate(&self, v: f64, gmin: f64) -> (f64, f64) {
        let arg = (v / self.vscale).min(MAX_EXP_ARG);
        let ev = arg.exp();
        let i = self.leakage * (ev - 1.0);
        let g = self.leakage * ev / self.vscale;
        (i, g + gmin)
    }

    /// Linearises the internal junction across inode to cathode.
    fn stamp_junction(&mut self, ctx: &SimCtx, s: &mut Stamper) {
        let (n_in, n_c) = (self.base.nodes[3], self.base.nodes[1]);
        let mut v = self.base.volts[3] - self.base.volts[1];
        if (v - self.junction_last_v).abs() > CONVERGENCE_V {
            s.not_converged();
        }
        v = limit_junction(v, self.junction_last_v, self.vscale, self.vcrit);
        self.junction_last_v = v;
        // The gmin ramp engages once a step is stuck, same as the diode.
        let gmin = if ctx.subiter as u32 > GMIN_RAMP_START {
            ramp_gmin(ctx.subiter as u32, GMIN_RAMP_DENOM)
        } else {
            JUNCTION_GMIN
        };
        let (i, g) = self.evaluate(v, gmin);
        self.junction_ieq = i - g * v;
        s.conductance(n_in, n_c, g);
        s.current_source(n_in, n_c, self.junction_ieq);
    }
}

impl Element for Scr {
    fn kind(&self) -> &'static str {
        "scr"
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
    /// constant pass; the variable resistor and the junction are nonlinear
    /// and stamped by `do_step` (SCRElm.java:211-218).
    fn stamp(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        s.resistor(self.base.nodes[2], self.base.nodes[1], self.g_resistance);
    }

    fn do_step(&mut self, ctx: &SimCtx, s: &mut Stamper) {
        let vac = self.base.volts[0] - self.base.volts[1];
        let vag = self.base.volts[0] - self.base.volts[2];
        if (vac - self.last_vac).abs() > CONVERGENCE_V
            || (vag - self.last_vag).abs() > CONVERGENCE_V
        {
            s.not_converged();
        }
        self.last_vac = vac;
        self.last_vag = vag;

        self.stamp_junction(ctx, s);

        // The latch: `-icmult*ic + ia*iamult` with `icmult = 1/triggerI` and
        // `iamult = 1/holdingI - 1/triggerI` reduces to `ig/triggerI +
        // ia/holdingI` because `ic = -ig - ia` (SCRElm.java:229-232,
        // :248-252). A gate current past trigger fires it, and an anode
        // current past holding keeps it latched once the gate drive is gone.
        let on = self.ig / self.trigger_i + self.ia / self.holding_i > 1.0;
        self.a_resistance = if on { ON_RESISTANCE } else { OFF_RESISTANCE };
        s.resistor(self.base.nodes[0], self.base.nodes[3], self.a_resistance);
    }

    fn calculate_current(&mut self, _ctx: &SimCtx) {
        self.ig = (self.base.volts[2] - self.base.volts[1]) / self.g_resistance;
        self.ia = (self.base.volts[0] - self.base.volts[3]) / self.a_resistance;
        // The anode and gate paths both deliver into the cathode, so KCL
        // gives `ic = -ia - ig`; the element current reports the anode
        // current, which is the conduction the latch acts on.
        self.base.current = self.ia;
    }

    /// Upstream reports each terminal's current into the device, negated for
    /// the node injection (SCRElm.java:191-197).
    fn current_into_node(&self, post: usize) -> f64 {
        match post {
            0 => -self.ia,
            1 => self.ia + self.ig,
            2 => -self.ig,
            _ => 0.0,
        }
    }

    fn power(&self) -> f64 {
        // Includes the gate branch's dissipation: `(Va-Vg)*ia + (Vc-Vg)*ic`
        // (SCRElm.java:206-208).
        let v = &self.base.volts;
        (v[0] - v[2]) * self.ia + (v[1] - v[2]) * -(self.ia + self.ig)
    }

    /// The file's lastvac/lastvag are the last anode-minus-terminal voltages;
    /// the anode is seeded at 0, so the cathode and gate restore as their
    /// negatives. Never overwrite the reference node (SCRElm.java:54-56).
    fn seed_initial_voltages(&mut self, v: &mut [f64]) {
        let n_c = self.base.nodes[1];
        let n_g = self.base.nodes[2];
        if n_c != GROUND {
            v[n_c] = -self.last_vac;
        }
        if n_g != GROUND {
            v[n_g] = -self.last_vag;
        }
    }

    fn set_param(&mut self, name: &str, value: f64) -> bool {
        match name {
            "triggerI" if value > 0.0 => self.trigger_i = value,
            "holdingI" if value > 0.0 => self.holding_i = value,
            "gResistance" if value > 0.0 => self.g_resistance = value,
            _ => return false,
        }
        true
    }

    /// Re-anchors the Newton state from the restored node voltages after a
    /// rejected step, so the retry starts where the last committed step left
    /// off. The latch's `ia`/`ig` do not move during a step, so
    /// `a_resistance` needs no re-derivation.
    fn restore_iteration(&mut self) {
        self.last_vac = self.base.volts[0] - self.base.volts[1];
        self.last_vag = self.base.volts[0] - self.base.volts[2];
        self.junction_last_v = self.base.volts[3] - self.base.volts[1];
    }

    fn reset(&mut self) {
        self.base.reset();
        self.ia = 0.0;
        self.ig = 0.0;
        self.last_vac = 0.0;
        self.last_vag = 0.0;
        self.a_resistance = OFF_RESISTANCE;
        self.junction_last_v = 0.0;
        self.junction_ieq = 0.0;
    }
}
