//! Spark gap: a two-terminal nonlinear resistor with hysteresis
//! (SparkGapElm.java). Off at `r_off` until the voltage across it exceeds
//! `breakdown`, then on at `r_on` until the current through it drops below
//! `holdcurrent`.

use crate::element::{Base, Element, SimCtx};
use crate::spec::ElementSpec;
use crate::stamp::Stamper;

const DEF_R_ON: f64 = 1e3;
const DEF_R_OFF: f64 = 1e9;
const DEF_BREAKDOWN: f64 = 1e3;
const DEF_HOLDCURRENT: f64 = 1e-3;

/// Two-terminal resistor whose stamped value switches on hysteresis
/// (SparkGapElm.java:30-37). Each state stamps a plain resistor, so the
/// element is nonlinear only because the stamped value moves with the state
/// (SparkGapElm.java:46, :116-119).
pub struct SparkGap {
    base: Base,
    r_on: f64,
    r_off: f64,
    breakdown: f64,
    holdcurrent: f64,
    /// Resistance stamped this step; kept for the current report.
    resistance: f64,
    /// Whether the gap is conducting this step.
    state: bool,
}

impl SparkGap {
    pub fn new(spec: &ElementSpec) -> Self {
        Self {
            base: Base::with_posts(2),
            r_on: spec.param("r_on", DEF_R_ON),
            r_off: spec.param("r_off", DEF_R_OFF),
            breakdown: spec.param("breakdown", DEF_BREAKDOWN),
            holdcurrent: spec.param("holdcurrent", DEF_HOLDCURRENT),
            resistance: DEF_R_OFF,
            state: false,
        }
    }
}

impl Element for SparkGap {
    fn kind(&self) -> &'static str {
        "sparkGap"
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
    fn connects(&self, _a: usize, _b: usize) -> bool {
        true
    }

    /// Nothing in `stamp` differs over the run, so the snapshot pass is empty
    /// and `nonlinear()` marks the closure for a full re-stamp each Newton
    /// iteration (SparkGapElm.java:120-123).
    fn start_iteration(&mut self, _ctx: &SimCtx) {
        // Clear first, then set: when both conditions hold in one step the
        // fire wins, exactly like upstream's two independent ifs
        // (SparkGapElm.java:108-113).
        if self.base.current.abs() < self.holdcurrent {
            self.state = false;
        }
        if self.base.voltage_diff().abs() > self.breakdown {
            self.state = true;
        }
    }

    fn do_step(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        self.resistance = if self.state { self.r_on } else { self.r_off };
        s.resistor(self.base.nodes[0], self.base.nodes[1], self.resistance);
    }

    fn calculate_current(&mut self, _ctx: &SimCtx) {
        self.base.current = self.base.voltage_diff() / self.resistance;
    }

    fn current_into_node(&self, post: usize) -> f64 {
        match post {
            0 => -self.base.current,
            1 => self.base.current,
            _ => 0.0,
        }
    }

    fn set_param(&mut self, name: &str, value: f64) -> bool {
        match name {
            "r_on" if value > 0.0 => self.r_on = value,
            "r_off" if value > 0.0 => self.r_off = value,
            "breakdown" if value > 0.0 => self.breakdown = value,
            "holdcurrent" if value > 0.0 => self.holdcurrent = value,
            _ => return false,
        }
        true
    }

    fn reset(&mut self) {
        self.base.reset();
        self.resistance = self.r_off;
        self.state = false;
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
    fn spark_gap_clears_its_latch_on_reset() {
        // Unlike the thyristor family, upstream's SparkGapElm explicitly
        // resets its own state (SparkGapElm.java:103-106), so this behaviour
        // is correct and must not change alongside them.
        let mut g = SparkGap::new(&spec("sparkGap"));
        g.state = true;
        g.resistance = g.r_on;
        g.reset();
        assert!(!g.state);
        assert_eq!(g.resistance, g.r_off);
    }
}
