//! Current-controlled voltage source (CCVSElm, dump 214).
//!
//! A chip with `inputCount` input pins arranged as pairs A+/A-, B+/B-.. on
//! the west and V+/V- on the east. Each pair is shorted by a 0 V sensing
//! voltage source whose current is the expression variable, and the output
//! pair is one ideal voltage source whose value is the expression evaluated
//! against those currents (CCVSElm.java:46-63). The output source's
//! constraint row couples to each sense source's current unknown at `-dx`
//! every Newton iteration, the current-source analogue of the VCVS's node
//! coupling (CCVSElm.java:132).

use crate::element::{Base, Element, SimCtx};
use crate::elements::controlled_source::{
    converge_limit, current_derivative, set_current_value, ExprSource,
};
use crate::spec::ElementSpec;
use crate::stamp::Stamper;

/// Default expression for a fresh source (CCVSElm.java:39).
const DEFAULT_EXPR: &str = "2*a";

pub struct Ccvs {
    base: Base,
    cs: ExprSource,
    /// The output-pair voltage from the previous Newton iterate, for the
    /// convergence check (`lastOutput`, CCVSElm.java:88).
    last_output: f64,
}

impl Ccvs {
    pub fn new(spec: &ElementSpec) -> Self {
        // The inputs are pairs; an odd count truncates to the even value
        // below, the guard upstream enforces in the edit dialog
        // (CCVSElm.java:187-193).
        let pair_count = (spec.param("inputCount", 2.0) as i64).clamp(1, 8) as usize / 2;
        Self {
            base: Base::with_posts(2 * pair_count + 2),
            cs: ExprSource::new(pair_count, spec.label.as_deref().unwrap_or(DEFAULT_EXPR)),
            last_output: 0.0,
        }
    }
}

impl Element for Ccvs {
    fn kind(&self) -> &'static str {
        "ccvs"
    }
    fn base(&self) -> &Base {
        &self.base
    }
    fn base_mut(&mut self) -> &mut Base {
        &mut self.base
    }
    fn post_count(&self) -> usize {
        2 * self.cs.input_count + 2
    }
    fn voltage_source_count(&self) -> usize {
        1 + self.cs.input_count
    }
    /// Sense source `k` shorts pair `k`; the last source spans V- to V+
    /// (CCVSElm.setVoltageSource, CCVSElm.java:219-230).
    fn voltage_source_nodes(&self, k: usize) -> (usize, usize) {
        let out = 2 * self.cs.input_count;
        if k < self.cs.input_count {
            (self.base.nodes[2 * k], self.base.nodes[2 * k + 1])
        } else {
            (self.base.nodes[out + 1], self.base.nodes[out])
        }
    }
    fn nonlinear(&self) -> bool {
        true
    }
    /// Every pair is tied together, the sense shorts and the output source
    /// included (CCVSElm.getConnection, CCVSElm.java:164-166).
    fn connects(&self, a: usize, b: usize) -> bool {
        a / 2 == b / 2
    }
    /// `do_step` couples the output source row to every sense column, so the
    /// whole part shares one closure (VCCSElm.getMatrixConnection).
    fn matrix_connects(&self, _a: usize, _b: usize) -> bool {
        true
    }

    fn stamp(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        // Topology only: the 0 V sense shorts and the output source, whose
        // value and coupling `do_step` fills each iteration (CCVSElm.java:
        // 67-85).
        for i in 0..self.cs.input_count {
            s.voltage_source(
                self.base.nodes[2 * i],
                self.base.nodes[2 * i + 1],
                self.base.vs_base + i,
                0.0,
            );
        }
        let out = 2 * self.cs.input_count;
        s.voltage_source(
            self.base.nodes[out + 1],
            self.base.nodes[out],
            self.base.vs_base + self.cs.input_count,
            0.0,
        );
    }

    fn do_step(&mut self, ctx: &SimCtx, s: &mut Stamper) {
        let out = 2 * self.cs.input_count;
        // Converged yet? The sense currents settle within a tenth of the
        // voltage limit, the output pair within the full one (CCVSElm.java:
        // 97-107).
        let limit = converge_limit(ctx.subiter) * 0.1;
        for i in 0..self.cs.input_count {
            if (self.base.vs_currents[i] - self.cs.last_volts[i]).abs() > limit {
                s.not_converged();
            }
        }
        let vd = self.base.volts[out] - self.base.volts[out + 1];
        if (vd - self.last_output).abs() > converge_limit(ctx.subiter) {
            s.not_converged();
        }
        if let Some(expr) = &self.cs.expr {
            self.cs.state.t = ctx.time;
            // `dadt`/`dcdt` divide by the step length, so the state must carry
            // it; otherwise the derivative is infinite and the matrix singular
            // (Expr.java:145-146).
            self.cs.state.time_step = ctx.dt;
            for i in 0..self.cs.input_count {
                set_current_value(&mut self.cs.state, i, self.base.vs_currents[i]);
            }
            let v0 = expr.eval(&self.cs.state);
            let mut rs = v0;
            for i in 0..self.cs.input_count {
                let cur = self.base.vs_currents[i];
                // The output source row picks up `-dx*I(sense)`; the constant
                // part rides in the right-hand side (CCVSElm.java:132-139).
                // The CCVS fixes the derivative perturbation at 1e-9
                // (CCVSElm.java:124).
                let dx = current_derivative(expr, &mut self.cs.state, i, cur, 1e-9);
                let row = s.vs_row(self.base.vs_base + self.cs.input_count);
                let col = s.vs_row(self.base.vs_base + i);
                s.raw(row, col, -dx);
                rs -= dx * cur;
            }
            s.raw_rhs(s.vs_row(self.base.vs_base + self.cs.input_count), rs);
        }
        for i in 0..self.cs.input_count {
            self.cs.last_volts[i] = self.base.vs_currents[i];
        }
        self.last_output = vd;
    }

    fn calculate_current(&mut self, _ctx: &SimCtx) {
        // The output source's current, the port's `vs_currents` convention
        // (positive flowing V- to V+ inside the source).
        self.base.current = self.base.vs_currents[self.cs.input_count];
    }

    fn current_into_node(&self, post: usize) -> f64 {
        let out = 2 * self.cs.input_count;
        if post < out {
            // A sense pair reads C+ = -cur, C- = +cur
            // (CCVSElm.setCurrent, CCVSElm.java:170-177).
            if post.is_multiple_of(2) {
                -self.base.vs_currents[post / 2]
            } else {
                self.base.vs_currents[post / 2]
            }
        } else if post == out {
            self.base.vs_currents[self.cs.input_count]
        } else {
            -self.base.vs_currents[self.cs.input_count]
        }
    }

    fn step_finished(&mut self, _ctx: &SimCtx) {
        // `lastoutput` is the output-pair voltage (CCVSElm.java:149).
        let out = 2 * self.cs.input_count;
        self.cs
            .state
            .update_last_values(self.base.volts[out] - self.base.volts[out + 1]);
    }

    /// Re-anchors the sense-current snapshots from the restored currents, so
    /// a rejected step's retry converges against the committed operating
    /// point instead of the failed attempt's last iterate.
    fn restore_iteration(&mut self) {
        for i in 0..self.cs.input_count {
            self.cs.last_volts[i] = self.base.vs_currents[i];
        }
    }

    fn voltage_diff(&self) -> f64 {
        // A scope on a CCVS plots the output pair, the quantity `do_step`
        // holds.
        let out = 2 * self.cs.input_count;
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
        self.last_output = 0.0;
    }
}
