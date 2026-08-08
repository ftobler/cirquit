//! Inverting buffer with slew-rate-limited output (InverterElm.java).

use crate::element::{Base, Element, SimCtx};
use crate::spec::ElementSpec;
use crate::stamp::{Stamper, GROUND};

/// Two-terminal inverting buffer. The output is a slew-rate-limited voltage
/// source to ground whose value `do_step` computes from the input
/// (InverterElm.java:113-127).
pub struct Inverter {
    base: Base,
    slew_rate: f64,
    high_voltage: f64,
    /// The output voltage at the start of the step, anchoring the slew clamp
    /// (InverterElm.java:119-121).
    last_output_voltage: f64,
}

impl Inverter {
    pub fn new(spec: &ElementSpec) -> Self {
        Self {
            base: Base::with_posts(2),
            slew_rate: spec.param("slewRate", 0.5),
            high_voltage: spec.param("highVoltage", 5.0),
            last_output_voltage: 0.0,
        }
    }
}

impl Element for Inverter {
    fn kind(&self) -> &'static str {
        "inverter"
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
    fn voltage_source_count(&self) -> usize {
        1
    }
    fn voltage_source_nodes(&self, _k: usize) -> (usize, usize) {
        // The output is a source to ground (InverterElm.java:114, :151-153).
        (GROUND, self.base.nodes[1])
    }
    /// No current path through the input; only the output reaches ground
    /// (InverterElm.java:150).
    fn connects(&self, _a: usize, _b: usize) -> bool {
        false
    }

    fn stamp(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        s.voltage_source(GROUND, self.base.nodes[1], self.base.vs_base, 0.0);
    }

    fn start_iteration(&mut self, _ctx: &SimCtx) {
        // The slew clamp anchors on the output at the step start
        // (InverterElm.java:119-121).
        self.last_output_voltage = self.base.volts[1];
    }

    fn do_step(&mut self, ctx: &SimCtx, s: &mut Stamper) {
        let mut out = if self.base.volts[0] > self.high_voltage * 0.5 {
            0.0
        } else {
            self.high_voltage
        };
        // maxStep is in volts per step: slewRate is V/ns, so multiplying the
        // seconds-per-step by 1e9 converts (InverterElm.java:124).
        let max_step = self.slew_rate * ctx.dt * 1e9;
        out = out
            .max(self.last_output_voltage - max_step)
            .min(self.last_output_voltage + max_step);
        s.voltage_source_value(self.base.vs_base, out);
    }

    fn calculate_current(&mut self, _ctx: &SimCtx) {
        self.base.current = self.base.vs_currents[0];
    }

    fn current_into_node(&self, post: usize) -> f64 {
        if post == 1 {
            self.base.current
        } else {
            0.0
        }
    }

    /// A scope on an inverter plots its input, not the two-terminal
    /// difference (InverterElm.java:128).
    fn voltage_diff(&self) -> f64 {
        self.base.volts[0]
    }

    fn set_param(&mut self, name: &str, value: f64) -> bool {
        match name {
            "slewRate" => self.slew_rate = value,
            "highVoltage" => self.high_voltage = value,
            _ => return false,
        }
        true
    }

    fn reset(&mut self) {
        self.base.reset();
        self.last_output_voltage = 0.0;
    }
}
