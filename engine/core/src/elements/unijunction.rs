//! Unijunction transistor (UnijunctionElm, dump 417).
//!
//! Upstream builds it as a CompositeElm of a diode, a 0 V source, a
//! current-controlled voltage source, two resistors, a VCCS and a capacitor
//! (UnijunctionElm.java:38-40). This port implements that sub-circuit directly
//! instead of a generic composite, so the stamps and the convergence checks
//! live in one place.
//!
//! The composite's node map (model string, local node 0 = ground):
//!
//! ```text
//! DiodeElm 1 4                       emitter E -> node 4
//! VoltageElm 4 5                     0 V source, senses the emitter current
//! CCVSElm 4 5 6 0                    V(node6) = 1000 * I(4->5)
//! ResistorElm 0 6                    1 M from node 6 to ground
//! VCCSElm 5 7 5 7 6 7 5              i = 0.00028*(a-b)+0.00575*(c-d)*e
//! CapacitorElm 5 7                   3.5e-11 F between node 5 and node 7
//! ResistorElm 7 2                    38.15 ohm node 7 -> B1
//! ResistorElm 3 5                    2518 ohm B2 -> node 5
//! ```
//!
//! External nodes {1,2,3} are posts E, B1, B2; nodes 4..7 are internal. The
//! `ujtModelDump` tokens map to the sub-elements in model order:
//!
//! * `2 x2n2646-emitter` the diode's model (default model, not looked up),
//! * `0 0 0 0 0 0 0` the 0 V source,
//! * `2 2 1000*a` the CCVS, input count 2 and expression `1000*a` sensing `a`,
//! * `0 1000000` the 1 M resistor,
//! * `0 5 0.00028*(a-b)\p0.00575*(c-d)*e` the VCCS, input count 5, `\p` the
//!   escaped `+`,
//! * `2 3.5e-11 0 0` the capacitor (3.5e-11 F, 0 V charge),
//! * `0 38.15` the 38.15 ohm resistor,
//! * `0 2518` the 2518 ohm resistor.
//!
//! The CCVS reuses the 0 V source's current unknown (its FLAG_SPICE path
//! finds the parallel VoltageElm), so the composite needs only two voltage
//! sources: the 0 V sense source and the CCVS output.

use crate::element::{Base, Element, SimCtx};
use crate::elements::capacitor::DC_OPEN;
use crate::elements::controlled_source::{converge_limit, input_derivative, sign};
use crate::elements::junction::{
    critical_voltage, limit_junction, ramp_gmin, CONVERGENCE_V, GMIN_RAMP_DENOM, GMIN_RAMP_START,
    JUNCTION_GMIN, MAX_EXP_ARG, VT,
};
use crate::expr::{parse, Expr, ExprState};
use crate::spec::ElementSpec;
use crate::stamp::{Stamper, GROUND};

// Local node positions into `base.nodes`: the three posts then four internal
// nodes, in the order `assign_nodes` hands them out (UnijunctionElm.java:23-25,
// CompositeElm's buildCompNodeList).
const E: usize = 0;
const B1: usize = 1;
const B2: usize = 2;
/// Diode cathode.
const N4: usize = 3;
/// Emitter region; the capacitor and B2-side resistor hang off it.
const N5: usize = 4;
/// CCVS output; the 1 M resistor to ground hangs off it.
const N6: usize = 5;
/// Base-one side; the capacitor and B1-side resistor hang off it.
const N7: usize = 6;

/// The VCCS expression's five inputs, in order `a b c d e` (the model string
/// `5 7 5 7 6`, i.e. N5, N7, N5, N7, N6).
const VCCS_INPUTS: [usize; 5] = [N5, N7, N5, N7, N6];

/// Internal capacitor, the `3.5e-11` token.
const CAP: f64 = 3.5e-11;
/// The 1 M resistor from the CCVS output to ground, the `1000000` token.
const R_OUT: f64 = 1e6;
/// Base-one resistor, the `38.15` token.
const R_B1: f64 = 38.15;
/// Base-two resistor, the `2518` token.
const R_B2: f64 = 2518.0;
/// The diode's forward drop, the default model the `x2n2646-emitter` name
/// stands in for (DiodeElm.java:51 defaultdrop).
const DIODE_FWDROP: f64 = 0.805_904_783;

pub struct Unijunction {
    base: Base,
    /// The emitter junction, the `DiodeElm` of the composite. The default
    /// model (emission coefficient 2) is used; the model name in the file is
    /// preserved but not looked up, like every other model name in this port.
    vscale: f64,
    leakage: f64,
    vcrit: f64,
    diode_last_v: f64,
    diode_geq: f64,
    diode_ieq: f64,
    /// The CCVS expression `1000*a`, `a` the current through the 0 V sense
    /// source.
    ccvs_expr: Expr,
    ccvs_state: ExprState,
    last_sense: f64,
    /// The CCVS output voltage from the previous iterate, for its own
    /// convergence test (CCVSElm.java:105-107).
    last_output: f64,
    /// The VCCS expression `0.00028*(a-b)+0.00575*(c-d)*e`.
    vccs_expr: Expr,
    vccs_state: ExprState,
    vccs_last_volts: [f64; 5],
    /// The VCCS output current (= the expression value), for `step_finished`.
    vccs_output: f64,
    /// Internal capacitor companion, the same trapezoidal model as
    /// `Capacitor` (CapacitorElm.java:196-211).
    geq: f64,
    ieq: f64,
    v_prev: f64,
    i_prev: f64,
    cap_current: f64,
}

impl Unijunction {
    pub fn new(_spec: &ElementSpec) -> Self {
        // The default diode model's parameters, derived exactly as the diode
        // element derives them (DiodeModel.java:149).
        let vscale = 2.0 * VT;
        let leakage = 1.0 / ((DIODE_FWDROP / vscale).exp() - 1.0);
        Self {
            base: Base::with_posts(3),
            vscale,
            leakage,
            vcrit: critical_voltage(vscale, leakage),
            diode_last_v: 0.0,
            diode_geq: 0.0,
            diode_ieq: 0.0,
            // `\p` in the dump token unescapes to `+`; the frontend's shared
            // escape set would already have done it, so parse the plain string.
            ccvs_expr: parse("1000*a").expect("CCVS expression is fixed"),
            ccvs_state: ExprState::new(),
            last_sense: 0.0,
            last_output: 0.0,
            vccs_expr: parse("0.00028*(a-b)+0.00575*(c-d)*e").expect("VCCS expression is fixed"),
            vccs_state: ExprState::new(),
            vccs_last_volts: [0.0; 5],
            vccs_output: 0.0,
            geq: 0.0,
            ieq: 0.0,
            v_prev: 0.0,
            i_prev: 0.0,
            cap_current: 0.0,
        }
    }
}

impl Element for Unijunction {
    fn kind(&self) -> &'static str {
        "unijunction"
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
        4
    }
    /// The composite carries two voltage sources: the 0 V sense source and
    /// the CCVS output.
    fn voltage_source_count(&self) -> usize {
        2
    }
    fn voltage_source_nodes(&self, k: usize) -> (usize, usize) {
        match k {
            // The 0 V source between node 4 and node 5, whose current is the
            // CCVS's sensed quantity.
            0 => (self.base.nodes[N4], self.base.nodes[N5]),
            // The CCVS output source to ground (CCVSElm.java:84).
            1 => (GROUND, self.base.nodes[N6]),
            _ => unreachable!("unijunction has two voltage sources"),
        }
    }
    fn nonlinear(&self) -> bool {
        true
    }
    /// The CCVS couples the sense source to the output source and the VCCS
    /// couples the input nodes into the output, so the whole part shares one
    /// closure.
    fn matrix_connects(&self, _a: usize, _b: usize) -> bool {
        true
    }
    fn connects(&self, a: usize, b: usize) -> bool {
        // The composite's sub-element connections (DiodeElm, VoltageElm,
        // CapacitorElm and the resistors all connect their terminal pairs).
        matches!(
            (a, b),
            (E, N4)
                | (N4, E)
                | (N4, N5)
                | (N5, N4)
                | (N5, N7)
                | (N7, N5)
                | (N5, B2)
                | (B2, N5)
                | (N7, B1)
                | (B1, N7)
        )
    }
    /// The internal capacitor is an open at DC, so it must not contribute a
    /// path to the broken-source walk (CapacitorElm's own `dc_connects`).
    fn dc_connects(&self, a: usize, b: usize) -> bool {
        if matches!((a, b), (N5, N7) | (N7, N5)) {
            return false;
        }
        self.connects(a, b)
    }

    fn stamp(&mut self, ctx: &SimCtx, s: &mut Stamper) {
        // The 0 V sense source and the CCVS output source; the CCVS fills the
        // output's value and derivative in `do_step`.
        s.voltage_source(
            self.base.nodes[N4],
            self.base.nodes[N5],
            self.base.vs_base,
            0.0,
        );
        s.voltage_source(GROUND, self.base.nodes[N6], self.base.vs_base + 1, 0.0);
        // The fixed resistors.
        s.resistor(GROUND, self.base.nodes[N6], R_OUT);
        s.resistor(self.base.nodes[N7], self.base.nodes[B1], R_B1);
        s.resistor(self.base.nodes[N5], self.base.nodes[B2], R_B2);
        // The capacitor companion's conductance, or the DC open circuit.
        if ctx.dc_analysis {
            s.resistor(self.base.nodes[N5], self.base.nodes[N7], DC_OPEN);
        } else {
            self.geq = 2.0 * CAP / ctx.dt;
            s.conductance(self.base.nodes[N5], self.base.nodes[N7], self.geq);
        }
    }

    fn do_step(&mut self, ctx: &SimCtx, s: &mut Stamper) {
        // ─── emitter diode junction ───
        let (ne, n4) = (self.base.nodes[E], self.base.nodes[N4]);
        let mut v = self.base.volts[E] - self.base.volts[N4];
        if (v - self.diode_last_v).abs() > CONVERGENCE_V {
            s.not_converged();
        }
        v = limit_junction(v, self.diode_last_v, self.vscale, self.vcrit);
        self.diode_last_v = v;
        let gmin = if ctx.subiter as u32 > GMIN_RAMP_START {
            ramp_gmin(ctx.subiter as u32, GMIN_RAMP_DENOM)
        } else {
            JUNCTION_GMIN
        };
        let arg = (v / self.vscale).min(MAX_EXP_ARG);
        let ev = arg.exp();
        let i = self.leakage * (ev - 1.0);
        let g = self.leakage * ev / self.vscale + gmin;
        self.diode_geq = g;
        self.diode_ieq = i - g * v;
        s.conductance(ne, n4, g);
        s.current_source(ne, n4, self.diode_ieq);

        // ─── CCVS: V(node6) = 1000 * I(4->5) ───
        let limit = converge_limit(ctx.subiter);
        let sense = self.base.vs_currents[0];
        if (sense - self.last_sense).abs() > limit * 0.1 {
            s.not_converged();
        }
        let out_v = self.base.volts[N6];
        if (out_v - self.last_output).abs() > limit {
            s.not_converged();
        }
        // `a` is the sensed current; slot 8 aliases it for the backward-
        // compatible `i` variable (CCVSElm.setCurrentExprValue,
        // CCVSElm.java:154-159).
        self.ccvs_state.values[0] = sense;
        self.ccvs_state.values[8] = sense;
        self.ccvs_state.t = ctx.time;
        let v0 = self.ccvs_expr.eval(&self.ccvs_state);
        // The CCVS fixes the derivative step at 1e-9 (CCVSElm.java:124).
        let dv = 1e-9;
        self.ccvs_state.values[0] = sense - dv;
        self.ccvs_state.values[8] = sense - dv;
        let lo = self.ccvs_expr.eval(&self.ccvs_state);
        self.ccvs_state.values[0] = sense;
        self.ccvs_state.values[8] = sense;
        let mut dx = (v0 - lo) / dv;
        if dx.abs() < 1e-6 {
            dx = sign(dx, 1e-6);
        }
        let vs_out = s.vs_row(self.base.vs_base + 1);
        let vs_sense = s.vs_row(self.base.vs_base);
        s.raw(vs_out, vs_sense, -dx);
        s.raw_rhs(vs_out, v0 - dx * sense);

        // ─── VCCS: i(N7->N5) = -expr(a..e) ───
        for (i, &n) in VCCS_INPUTS.iter().enumerate() {
            if (self.base.volts[n] - self.vccs_last_volts[i]).abs() > limit {
                s.not_converged();
            }
        }
        self.vccs_state.t = ctx.time;
        for (i, &n) in VCCS_INPUTS.iter().enumerate() {
            self.vccs_state.values[i] = self.base.volts[n];
        }
        let v0 = -self.vccs_expr.eval(&self.vccs_state);
        let mut rs = v0;
        let (cp, cm) = (self.base.nodes[N7], self.base.nodes[N5]);
        for (i, &n) in VCCS_INPUTS.iter().enumerate() {
            let dx = -input_derivative(
                &self.vccs_expr,
                &mut self.vccs_state,
                &self.vccs_last_volts,
                i,
            );
            s.vccs(cp, cm, self.base.nodes[n], GROUND, dx);
            rs -= dx * self.base.volts[n];
        }
        s.current_source(cp, cm, rs);
        self.vccs_output = -v0;

        // ─── capacitor companion ───
        if !ctx.dc_analysis {
            let (n5, n7) = (self.base.nodes[N5], self.base.nodes[N7]);
            self.ieq = self.geq * self.v_prev + self.i_prev;
            s.current_source(n7, n5, self.ieq);
        }

        // ─── commit Newton snapshots ───
        self.last_sense = sense;
        self.last_output = out_v;
        for (i, &n) in VCCS_INPUTS.iter().enumerate() {
            self.vccs_last_volts[i] = self.base.volts[n];
        }
    }

    fn calculate_current(&mut self, ctx: &SimCtx) {
        // The emitter current is the diode current (E -> node 4 -> 0 V source
        // -> node 5); base.current reports it positive out of E, the
        // two-terminal convention.
        self.base.current =
            self.diode_geq * (self.base.volts[E] - self.base.volts[N4]) + self.diode_ieq;
        if ctx.dc_analysis {
            self.cap_current = (self.base.volts[N5] - self.base.volts[N7]) / DC_OPEN;
        } else {
            self.cap_current = self.geq * (self.base.volts[N5] - self.base.volts[N7]) - self.ieq;
        }
    }

    fn current_into_node(&self, post: usize) -> f64 {
        match post {
            // Emitter current leaves E through the diode.
            E => -self.base.current,
            // The current that the 38.15 ohm resistor pushes into B1.
            B1 => (self.base.volts[N7] - self.base.volts[B1]) / R_B1,
            // The current that the 2518 ohm resistor pushes into B2.
            B2 => (self.base.volts[N5] - self.base.volts[B2]) / R_B2,
            _ => 0.0,
        }
    }

    fn step_finished(&mut self, _ctx: &SimCtx) {
        // Each sub-expression's `lastoutput` (CCVSElm.java:148-152,
        // VCCSElm.java:165-167).
        self.ccvs_state.update_last_values(self.base.volts[N6]);
        self.vccs_state.update_last_values(self.vccs_output);
        // The internal capacitor's history, the same commit as `Capacitor`.
        self.v_prev = self.base.volts[N5] - self.base.volts[N7];
        self.i_prev = self.cap_current;
    }

    fn restore_iteration(&mut self) {
        // Re-anchor every Newton snapshot from the restored committed
        // solution, so a rejected step's retry converges against the operating
        // point it was rejected from.
        self.diode_last_v = self.base.volts[E] - self.base.volts[N4];
        self.last_sense = self.base.vs_currents[0];
        self.last_output = self.base.volts[N6];
        for (i, &n) in VCCS_INPUTS.iter().enumerate() {
            self.vccs_last_volts[i] = self.base.volts[n];
        }
    }

    fn reset(&mut self) {
        self.base.reset();
        self.diode_last_v = 0.0;
        self.diode_geq = 0.0;
        self.diode_ieq = 0.0;
        self.ccvs_state.reset();
        self.vccs_state.reset();
        self.last_sense = 0.0;
        self.last_output = 0.0;
        self.vccs_last_volts.fill(0.0);
        self.vccs_output = 0.0;
        self.geq = 0.0;
        self.ieq = 0.0;
        self.v_prev = 0.0;
        self.i_prev = 0.0;
        self.cap_current = 0.0;
    }
}
