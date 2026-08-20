//! Voltage-controlled voltage source (VCVSElm, dump 212).
//!
//! A chip with `inputCount` inputs A.. on the west and V+/V- on the east. The
//! output pair is one ideal voltage source whose value is the expression
//! evaluated against the input voltages, with a numerical derivative per input
//! stamped into the source's constraint row and a right-hand side for the
//! constant part (VCVSElm.java:51-96). The VCVS extends the VCCS upstream and
//! inherits its input-count/expression file format and its convergence logic;
//! only the stamp differs.

use crate::element::{Base, Element, SimCtx};
use crate::elements::controlled_source::{converge_limit, input_derivative, ExprSource};
use crate::spec::ElementSpec;
use crate::stamp::Stamper;

/// Default expression for a fresh source, inherited from the VCCS base
/// (VCCSElm.java:45).
const DEFAULT_EXPR: &str = ".1*(a-b)";

pub struct Vcvs {
    base: Base,
    cs: ExprSource,
}

impl Vcvs {
    pub fn new(spec: &ElementSpec) -> Self {
        let input_count = (spec.param("inputCount", 2.0) as i64).clamp(1, 8) as usize;
        Self {
            base: Base::with_posts(input_count + 2),
            cs: ExprSource::new(input_count, spec.label.as_deref().unwrap_or(DEFAULT_EXPR)),
        }
    }
}

impl Element for Vcvs {
    fn kind(&self) -> &'static str {
        "vcvs"
    }
    fn base(&self) -> &Base {
        &self.base
    }
    fn base_mut(&mut self) -> &mut Base {
        &mut self.base
    }
    fn post_count(&self) -> usize {
        self.cs.input_count + 2
    }
    fn voltage_source_count(&self) -> usize {
        1
    }
    fn nonlinear(&self) -> bool {
        true
    }
    /// The one source spans V- to V+ (VCVSElm.java:107).
    fn voltage_source_nodes(&self, _k: usize) -> (usize, usize) {
        let out = self.cs.input_count;
        (self.base.nodes[out + 1], self.base.nodes[out])
    }

    /// Only the output pair is tied together; the inputs are isolated
    /// (inherited from VCCSElm.getConnection).
    fn connects(&self, a: usize, b: usize) -> bool {
        let out = self.cs.input_count;
        (a == out && b == out + 1) || (a == out + 1 && b == out)
    }
    /// `do_step` stamps the input columns into the output VS row, so the whole
    /// part must share the output's closure (VCCSElm.getMatrixConnection).
    fn matrix_connects(&self, _a: usize, _b: usize) -> bool {
        true
    }

    fn stamp(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        // Topology only: the output source's value and input coupling
        // `do_step` fills in each iteration (VCVSElm.java:48).
        let out = self.cs.input_count;
        s.voltage_source(
            self.base.nodes[out + 1],
            self.base.nodes[out],
            self.base.vs_base,
            0.0,
        );
    }

    fn do_step(&mut self, ctx: &SimCtx, s: &mut Stamper) {
        let out = self.cs.input_count;
        let limit = converge_limit(ctx.subiter);
        for i in 0..self.cs.input_count {
            if (self.base.volts[i] - self.cs.last_volts[i]).abs() > limit {
                s.not_converged();
            }
        }
        if let Some(expr) = &self.cs.expr {
            self.cs.state.t = ctx.time;
            // `dadt`/`dcdt` divide by the step length, so the state must carry
            // it; otherwise the derivative is infinite and the matrix singular
            // (Expr.java:145-146).
            self.cs.state.time_step = ctx.dt;
            for i in 0..self.cs.input_count {
                self.cs.state.values[i] = self.base.volts[i];
            }
            let v0 = expr.eval(&self.cs.state);
            // The solved output must agree with the expression before the
            // step is settled (VCVSElm.java:68-69).
            let vd = self.base.volts[out] - self.base.volts[out + 1];
            if ctx.subiter < 100 && (vd - v0).abs() > v0.abs() * 0.01 {
                s.not_converged();
            }
            let mut rs = v0;
            for i in 0..self.cs.input_count {
                // The constraint row picks up `-dx*V(input)`; the constant
                // part rides in the right-hand side (VCVSElm.java:86-88).
                let dx = input_derivative(expr, &mut self.cs.state, &self.cs.last_volts, i);
                let row = s.vs_row(self.base.vs_base);
                if let Some(c) = s.node_row(self.base.nodes[i]) {
                    s.raw(row, c, -dx);
                }
                rs -= dx * self.base.volts[i];
            }
            s.raw_rhs(s.vs_row(self.base.vs_base), rs);
            self.cs.output = v0;
        }
        for i in 0..self.cs.input_count {
            self.cs.last_volts[i] = self.base.volts[i];
        }
    }

    fn calculate_current(&mut self, _ctx: &SimCtx) {
        // The output source's current, the port's `vs_currents` convention
        // (positive flowing V- to V+ inside the source).
        self.base.current = self.base.vs_currents[0];
    }

    fn current_into_node(&self, post: usize) -> f64 {
        let out = self.cs.input_count;
        match post {
            p if p == out => self.base.vs_currents[0],
            p if p == out + 1 => -self.base.vs_currents[0],
            _ => 0.0,
        }
    }

    fn step_finished(&mut self, _ctx: &SimCtx) {
        // `lastoutput` is the output voltage (VCVSElm.java:97-99).
        let out = self.cs.input_count;
        self.cs
            .state
            .update_last_values(self.base.volts[out] - self.base.volts[out + 1]);
    }

    /// Re-anchors the per-input snapshots from the restored node voltages, so
    /// a rejected step's retry converges against the committed operating point
    /// instead of the failed attempt's last iterate.
    fn restore_iteration(&mut self) {
        for i in 0..self.cs.input_count {
            self.cs.last_volts[i] = self.base.volts[i];
        }
    }

    fn voltage_diff(&self) -> f64 {
        // A scope on a VCVS plots the output pair, the quantity `do_step`
        // holds.
        let out = self.cs.input_count;
        self.base.volts[out] - self.base.volts[out + 1]
    }

    fn set_param(&mut self, _name: &str, _value: f64) -> bool {
        // See Vccs::set_param: an expression cannot be reparsed from a numeric
        // value and `inputCount` changes the post count, so every edit goes
        // down the full-rebuild path.
        false
    }

    fn reset(&mut self) {
        self.base.reset();
        self.cs.reset();
    }
}
