//! Voltage-controlled current source (VCCSElm, dump 213).
//!
//! A chip with `inputCount` inputs A.. on the west and C+/C- on the east. The
//! current delivered into the output pair is the value of the expression
//! evaluated against the input voltages, with a numerical derivative per input
//! stamped as a VCCS and the constant part as an independent current source
//! (VCCSElm.java:105-164). The output is an ideal current source, so there are
//! no voltage-source unknowns.
//!
//! A source whose output terminals have no DC current path is marked broken
//! by analysis and replaced by a 1e8 ohm resistor reporting zero current
//! (VCCSElm.java:109-115, :240-247).

use crate::element::{Base, Element, SimCtx};
use crate::elements::controlled_source::{converge_limit, input_derivative, ExprSource};
use crate::spec::ElementSpec;
use crate::stamp::{Stamper, GROUND};

/// Default expression for a fresh source (VCCSElm.java:45).
const DEFAULT_EXPR: &str = ".1*(a-b)";

pub struct Vccs {
    base: Base,
    cs: ExprSource,
    broken: bool,
}

impl Vccs {
    /// Resistance stamped between the output terminals of a broken source
    /// (VCCSElm.java:113).
    const BROKEN_R: f64 = 1e8;

    pub fn new(spec: &ElementSpec) -> Self {
        let input_count = (spec.param("inputCount", 2.0) as i64).clamp(1, 8) as usize;
        Self {
            base: Base::with_posts(input_count + 2),
            cs: ExprSource::new(input_count, spec.label.as_deref().unwrap_or(DEFAULT_EXPR)),
            broken: false,
        }
    }

    fn output_pair(&self) -> (usize, usize) {
        (
            self.base.nodes[self.cs.input_count],
            self.base.nodes[self.cs.input_count + 1],
        )
    }
}

impl Element for Vccs {
    fn kind(&self) -> &'static str {
        "vccs"
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
    fn nonlinear(&self) -> bool {
        true
    }

    /// Only the output pair is tied together; the inputs are isolated
    /// (VCCSElm.getConnection, VCCSElm.java:176-178).
    fn connects(&self, a: usize, b: usize) -> bool {
        let out = self.cs.input_count;
        (a == out && b == out + 1) || (a == out + 1 && b == out)
    }
    /// `do_step` stamps the input columns into the output rows, so the whole
    /// part must share the output's closure (VCCSElm.java:179).
    fn matrix_connects(&self, _a: usize, _b: usize) -> bool {
        true
    }
    /// The output is an ideal current source: it provides no DC path of its
    /// own, and the broken-path union-find must not union the source's own
    /// C+/C- pair (upstream's walk skips the element being validated,
    /// FindPathInfo.java:51). Kept distinct from `connects`, which the
    /// floating-node check uses to tie the output pair together.
    fn dc_connects(&self, _a: usize, _b: usize) -> bool {
        false
    }

    /// The output pair is what analysis tests for a DC path (VCCSElm.java:241).
    fn current_output_nodes(&self) -> Option<(usize, usize)> {
        Some(self.output_pair())
    }

    fn set_broken(&mut self, broken: bool) {
        self.broken = broken;
    }

    fn stamp(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        if self.broken {
            // No current path; the source would drive the floating output
            // nodes apart. A 1e8 ohm resistor stands in and the source
            // reports zero current (VCCSElm.java:113). Upstream stamps it in
            // `doStep`; here it is constant, so it lives in the snapshot.
            let (cp, cm) = self.output_pair();
            s.resistor(cp, cm, Self::BROKEN_R);
        }
    }

    fn do_step(&mut self, ctx: &SimCtx, s: &mut Stamper) {
        if self.broken {
            // The resistor was stamped by `stamp`; nothing else changes.
            self.cs.output = 0.0;
            return;
        }
        let (cp, cm) = self.output_pair();
        let limit = converge_limit(ctx.subiter);
        for i in 0..self.cs.input_count {
            if (self.base.volts[i] - self.cs.last_volts[i]).abs() > limit {
                s.not_converged();
            }
        }
        if let Some(expr) = &self.cs.expr {
            // The delivered current is -expr, the negation matching upstream
            // and the port's current-source sign (VCCSElm.java:132): a
            // positive expression pushes current from C- into C+.
            self.cs.state.t = ctx.time;
            for i in 0..self.cs.input_count {
                self.cs.state.values[i] = self.base.volts[i];
            }
            let v0 = -expr.eval(&self.cs.state);
            let mut rs = v0;
            for i in 0..self.cs.input_count {
                // The slope is d(-expr)/dv; `input_derivative` returns
                // d(expr)/dv, so negate.
                let dx = -input_derivative(expr, &mut self.cs.state, &self.cs.last_volts, i);
                s.vccs(cp, cm, self.base.nodes[i], GROUND, dx);
                rs -= dx * self.base.volts[i];
            }
            s.current_source(cp, cm, rs);
            self.cs.output = -v0;
        }
        for i in 0..self.cs.input_count {
            self.cs.last_volts[i] = self.base.volts[i];
        }
    }

    fn calculate_current(&mut self, _ctx: &SimCtx) {
        // Upstream reports pins[C+].current = -v0 = expr, i.e. the current
        // INTO the C+ pin from the element (VCCSElm.java:158-159).
        self.base.current = if self.broken { 0.0 } else { self.cs.output };
    }

    fn current_into_node(&self, post: usize) -> f64 {
        let out = self.cs.input_count;
        match post {
            p if p == out => self.base.current,
            p if p == out + 1 => -self.base.current,
            _ => 0.0,
        }
    }

    fn step_finished(&mut self, _ctx: &SimCtx) {
        // `lastoutput` is the delivered current (VCCSElm.java:165-167).
        self.cs.state.update_last_values(self.base.current);
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
        // A scope on a VCCS plots the output pair, the quantity that carries
        // the current it stamps.
        let out = self.cs.input_count;
        self.base.volts[out] - self.base.volts[out + 1]
    }

    fn set_param(&mut self, _name: &str, _value: f64) -> bool {
        // Everything about this element is declared at build time: an
        // expression cannot be reparsed from a numeric value (the string only
        // reaches the engine through a rebuild) and `inputCount` changes the
        // post count, so every edit goes down the full-rebuild path rather
        // than the live `set_param` fast path. The capacitor's
        // `seriesResistance` uses the same refusal for the same reason.
        false
    }

    fn reset(&mut self) {
        self.base.reset();
        self.cs.reset();
    }
}
