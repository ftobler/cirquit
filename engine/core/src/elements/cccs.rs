//! Current-controlled current source (CCCSElm, dump 215).
//!
//! A chip with `inputCount` input pins arranged as pairs A+/A-, B+/B-.. on
//! the west and O+/O- on the east. Each pair is shorted by a 0 V sensing
//! voltage source whose current is the expression variable, and the current
//! delivered into the output pair is the expression value, with a numerical
//! derivative per sense current stamped as a CCCS and the constant part as an
//! independent current source (CCCSElm.java:45-62, :113-146). The output is
//! an ideal current source, so there are no voltage-source unknowns for it.
//!
//! A source whose output terminals have no DC current path is marked broken
//! by analysis and replaced by a 1e8 ohm resistor reporting zero current
//! (VCCSElm.java:109-115, :240-247), the same treatment the VCCS gets.

use crate::element::{Base, Element, SimCtx};
use crate::elements::controlled_source::{
    converge_limit, current_derivative, set_current_value, ExprSource,
};
use crate::expr::parse;
use crate::spec::ElementSpec;
use crate::stamp::Stamper;

/// Default expression for a fresh source (CCCSElm.java:38).
const DEFAULT_EXPR: &str = "2*a";

pub struct Cccs {
    base: Base,
    cs: ExprSource,
    broken: bool,
    /// The delivered current from two Newton iterations ago, the extra slot
    /// on the convergence walk upstream runs over the O- current too
    /// (CCCSElm.java:103-108).
    last_output: f64,
}

impl Cccs {
    /// Resistance stamped between the output terminals of a broken source
    /// (CCCSElm.java:89).
    const BROKEN_R: f64 = 1e8;

    pub fn new(spec: &ElementSpec) -> Self {
        // The inputs are pairs; an odd count truncates to the even value
        // below, the guard upstream enforces in the edit dialog
        // (CCCSElm.java:179-185).
        let pair_count = (spec.param("inputCount", 2.0) as i64).clamp(1, 8) as usize / 2;
        Self {
            base: Base::with_posts(2 * pair_count + 2),
            cs: ExprSource::new(pair_count, spec.label.as_deref().unwrap_or(DEFAULT_EXPR)),
            broken: false,
            last_output: 0.0,
        }
    }

    fn output_pair(&self) -> (usize, usize) {
        let out = 2 * self.cs.input_count;
        (self.base.nodes[out], self.base.nodes[out + 1])
    }
}

impl Element for Cccs {
    fn kind(&self) -> &'static str {
        "cccs"
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
        self.cs.input_count
    }
    /// Sense source `k` shorts pair `k` (CCCSElm.setVoltageSource,
    /// CCCSElm.java:211-218).
    fn voltage_source_nodes(&self, k: usize) -> (usize, usize) {
        (self.base.nodes[2 * k], self.base.nodes[2 * k + 1])
    }
    fn nonlinear(&self) -> bool {
        true
    }
    /// Every pair is tied together, the sense shorts and the output pair
    /// included (CCCSElm.getConnection, CCCSElm.java:163-165).
    fn connects(&self, a: usize, b: usize) -> bool {
        a / 2 == b / 2
    }
    /// The input pairs are shorted by their 0 V sense sources, real DC paths;
    /// the output pair is an ideal current source and provides none, so the
    /// broken-path walk must not union it (VCCSElm.java:241). Kept distinct
    /// from `connects`, which the floating-node check uses to tie the output
    /// pair together.
    fn dc_connects(&self, a: usize, b: usize) -> bool {
        a / 2 == b / 2 && a < 2 * self.cs.input_count
    }
    /// `do_step` couples every sense source into the output rows, so the whole
    /// part shares one closure (VCCSElm.getMatrixConnection).
    fn matrix_connects(&self, _a: usize, _b: usize) -> bool {
        true
    }
    /// The output pair is what analysis tests for a DC path (VCCSElm.java:241).
    fn current_output_nodes(&self) -> Option<(usize, usize)> {
        Some(self.output_pair())
    }

    fn set_broken(&mut self, broken: bool) {
        self.broken = broken;
    }

    fn stamp(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        for i in 0..self.cs.input_count {
            // A 0 V source across each pair measures its current
            // (CCCSElm.java:70-74).
            s.voltage_source(
                self.base.nodes[2 * i],
                self.base.nodes[2 * i + 1],
                self.base.vs_base + i,
                0.0,
            );
        }
        if self.broken {
            // No current path; the source would drive the floating output
            // nodes apart. A 1e8 ohm resistor stands in and the source reports
            // zero current (CCCSElm.java:85-90). Upstream stamps it in
            // `doStep`; here it is constant, so it lives in the snapshot.
            let (op, om) = self.output_pair();
            s.resistor(op, om, Self::BROKEN_R);
        }
    }

    fn do_step(&mut self, ctx: &SimCtx, s: &mut Stamper) {
        if self.broken {
            // The resistor was stamped by `stamp`; nothing else changes.
            self.cs.output = 0.0;
            return;
        }
        let (op, om) = self.output_pair();
        // Converged yet? The sense currents and the output's own current all
        // settle within a tenth of the voltage limit (CCCSElm.java:100-111).
        let limit = converge_limit(ctx.subiter) * 0.1;
        for i in 0..self.cs.input_count {
            if (self.base.vs_currents[i] - self.cs.last_volts[i]).abs() > limit {
                s.not_converged();
            }
        }
        let prev_output = self.cs.output;
        if (prev_output - self.last_output).abs() > limit {
            s.not_converged();
        }
        if let Some(expr) = &self.cs.expr {
            // The delivered current is +expr, upstream's own sign for this
            // source: `rs` flows O- to O+ (CCCSElm.java:121-122).
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
                // dv clamped to the distance from the previous iterate, the
                // same floor the voltage-controlled sources use
                // (CCCSElm.java:126-128).
                let mut dv = cur - self.cs.last_volts[i];
                if dv.abs() < 1e-6 {
                    dv = 1e-6;
                }
                let dx = current_derivative(expr, &mut self.cs.state, i, cur, dv);
                s.cccs(om, op, self.base.vs_base + i, dx);
                rs -= dx * cur;
            }
            s.current_source(om, op, rs);
            self.cs.output = v0;
        }
        for i in 0..self.cs.input_count {
            self.cs.last_volts[i] = self.base.vs_currents[i];
        }
        self.last_output = prev_output;
    }

    fn calculate_current(&mut self, _ctx: &SimCtx) {
        // Upstream reports pins[O+].current = v0 = expr, i.e. the current
        // INTO the O+ pin from the element (CCCSElm.java:121-122).
        self.base.current = if self.broken { 0.0 } else { self.cs.output };
    }

    fn current_into_node(&self, post: usize) -> f64 {
        let out = 2 * self.cs.input_count;
        if post < out {
            // A sense pair reads C+ = -cur, C- = +cur
            // (CCCSElm.setCurrent, CCCSElm.java:169-177).
            if post.is_multiple_of(2) {
                -self.base.vs_currents[post / 2]
            } else {
                self.base.vs_currents[post / 2]
            }
        } else if post == out {
            self.base.current
        } else {
            -self.base.current
        }
    }

    fn step_finished(&mut self, _ctx: &SimCtx) {
        // `lastoutput` is the delivered current (CCCSElm.java:150).
        self.cs.state.update_last_values(self.base.current);
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
        // A scope on a CCCS plots the output pair, the quantity that carries
        // the current it stamps.
        let out = 2 * self.cs.input_count;
        self.base.volts[out] - self.base.volts[out + 1]
    }

    fn set_param(&mut self, _name: &str, _value: f64) -> bool {
        // Everything about this element is declared at build time: an
        // expression cannot be reparsed from a numeric value (the string only
        // reaches the engine through a rebuild) and `inputCount` changes the
        // post count, so every edit goes down the full-rebuild path rather
        // than the live `set_param` fast path.
        false
    }

    fn set_string_param(&mut self, name: &str, value: &str) -> bool {
        // The optocoupler's parent hands its CCCS child the CTR curve after
        // the composite is built (optocoupler.rs), the one place a CCCS
        // expression is set from inside the engine. A bad expression stays
        // `None`, exactly as `ExprSource::new` leaves a parse failure, so the
        // child simulates as a passive stub rather than refusing to build.
        if name == "expr" {
            self.cs.expr = parse(value).ok();
            self.cs.reset();
            true
        } else {
            false
        }
    }

    fn reset(&mut self) {
        self.base.reset();
        self.cs.reset();
        self.last_output = 0.0;
    }
}
