//! Tri-state buffer (TriStateElm.java), single-bit.

use crate::element::{Base, Element, SimCtx};
use crate::spec::ElementSpec;
use crate::stamp::{Stamper, GROUND};

/// Tri-state buffer: posts 0 input, 1 output, 2 control, plus one internal
/// node that the input's voltage source drives. When the control is high the
/// output follows the input's logic level through `r_on`; when low the output
/// goes high-impedance, left to the `r_off_ground` pulldown if any
/// (TriStateElm.java:191-206).
pub struct TriState {
    base: Base,
    r_on: f64,
    r_off: f64,
    r_off_ground: f64,
    high_voltage: f64,
    /// Whether the control currently opens the path; `resistance` is the
    /// matching internal->output resistance this step.
    open: bool,
    resistance: f64,
}

impl TriState {
    pub fn new(spec: &ElementSpec) -> Self {
        Self {
            base: Base::with_posts(3),
            // The token constructor's defaults, not the fresh constructor's
            // 1e8 pulldown: upstream's fresh-placement tri-state drags a
            // pulldown in (TriStateElm.java:44-45) but a bare `180` line reads
            // r_off_ground as 0 (TriStateElm.java:56), so 0 is the value that
            // round-trips. This port is file-first, so it follows the token.
            r_on: spec.param("r_on", 0.1),
            r_off: spec.param("r_off", 1e10),
            r_off_ground: spec.param("r_off_ground", 0.0),
            high_voltage: spec.param("highVoltage", 5.0),
            open: true,
            resistance: 0.0,
        }
    }
}

impl Element for TriState {
    fn kind(&self) -> &'static str {
        "triState"
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
    fn voltage_source_count(&self) -> usize {
        1
    }
    fn voltage_source_nodes(&self, _k: usize) -> (usize, usize) {
        // The input's source drives the internal node from ground
        // (TriStateElm.java:185, :241).
        (GROUND, self.base.nodes[3])
    }
    /// The switched resistor changes value per step, so the element is
    /// nonlinear even though each stamp is a plain resistor (TriStateElm.java:179).
    fn nonlinear(&self) -> bool {
        true
    }
    /// The input and control draw no current; only the output and the
    /// internal node carry the switched resistor (TriStateElm.java:278-280).
    fn connects(&self, _a: usize, _b: usize) -> bool {
        false
    }
    /// The internal->output resistor couples the two rows, so the pair must
    /// share a closure even though `connects` is false (TriStateElm.java:244-250).
    fn matrix_connects(&self, a: usize, b: usize) -> bool {
        let (internal, output) = (3, 1);
        (a == internal && b == output) || (a == output && b == internal)
    }

    fn stamp(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        s.voltage_source(GROUND, self.base.nodes[3], self.base.vs_base, 0.0);
    }

    fn do_step(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        self.open = self.base.volts[2] < self.high_voltage * 0.5;
        self.resistance = if self.open { self.r_off } else { self.r_on };
        s.resistor(self.base.nodes[3], self.base.nodes[1], self.resistance);
        if self.r_off_ground > 0.0 {
            s.resistor(self.base.nodes[1], GROUND, self.r_off_ground);
        }
        let drive = if self.base.volts[0] > self.high_voltage * 0.5 {
            self.high_voltage
        } else {
            0.0
        };
        s.voltage_source_value(self.base.vs_base, drive);
    }

    fn calculate_current(&mut self, _ctx: &SimCtx) {
        // Upstream sums the internal->output resistor current minus the
        // pulldown current (TriStateElm.java:161-170); the net is what flows
        // into the output node. `volts` is indexed by node position, so the
        // internal node is position 3 and the output position 1.
        let current31 = (self.base.volts[3] - self.base.volts[1]) / self.resistance;
        let current10 = if self.r_off_ground == 0.0 {
            0.0
        } else {
            self.base.volts[1] / self.r_off_ground
        };
        self.base.current = current31 - current10;
    }

    fn current_into_node(&self, post: usize) -> f64 {
        if post == 1 {
            self.base.current
        } else {
            0.0
        }
    }

    fn set_param(&mut self, name: &str, value: f64) -> bool {
        match name {
            "r_on" => self.r_on = value,
            "r_off" => self.r_off = value,
            "r_off_ground" => self.r_off_ground = value,
            "highVoltage" => self.high_voltage = value,
            _ => return false,
        }
        true
    }

    fn reset(&mut self) {
        self.base.reset();
        self.open = true;
        self.resistance = 0.0;
    }
}
