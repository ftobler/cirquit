//! Half adder (HalfAdderElm.java, dump 195): a four-pin combinational chip
//! whose outputs are S = A XOR B and C = A AND B. The two outputs sit on the
//! east, the two inputs on the west. No pin carries saved state, so the file
//! line carries no tokens beyond the optional high voltage.

use crate::element::{Base, Element, SimCtx};
use crate::elements::chip::{Chip, ChipPin};
use crate::spec::ElementSpec;
use crate::stamp::Stamper;

pub struct HalfAdder {
    chip: Chip,
}

impl HalfAdder {
    pub fn new(spec: &ElementSpec) -> Self {
        // Pin order (setupPins, HalfAdderElm.java:31-43): S then C on the
        // east, A then B on the west. No pin is saved to the file.
        let pins = vec![
            ChipPin::output(false), // 0 S
            ChipPin::output(false), // 1 C
            ChipPin::input(),       // 2 A
            ChipPin::input(),       // 3 B
        ];
        Self {
            chip: Chip::new(spec, pins),
        }
    }

    fn execute(&mut self) {
        // S = A XOR B, C = A AND B (HalfAdderElm.java:49-53).
        let a = self.chip.pins[2].value;
        let b = self.chip.pins[3].value;
        self.chip.write_output(0, a ^ b);
        self.chip.write_output(1, a && b);
    }
}

impl Element for HalfAdder {
    fn kind(&self) -> &'static str {
        "halfAdder"
    }
    fn base(&self) -> &Base {
        &self.chip.base
    }
    fn base_mut(&mut self) -> &mut Base {
        &mut self.chip.base
    }
    fn post_count(&self) -> usize {
        4
    }
    fn voltage_source_count(&self) -> usize {
        self.chip.voltage_source_count()
    }
    fn voltage_source_nodes(&self, k: usize) -> (usize, usize) {
        self.chip.voltage_source_nodes(k)
    }
    /// No current path between the posts: only the outputs' sources tie their
    /// nodes to ground (ChipElm.java:467).
    fn connects(&self, _a: usize, _b: usize) -> bool {
        false
    }

    fn stamp(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        self.chip.stamp(s);
    }

    fn start_iteration(&mut self, _ctx: &SimCtx) {
        if self.chip.read_inputs() {
            self.execute();
        }
        self.chip.commit_clock();
    }

    fn do_step(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        self.chip.do_step(s);
    }

    fn calculate_current(&mut self, _ctx: &SimCtx) {
        self.chip.base.current = 0.0;
    }

    fn current_into_node(&self, post: usize) -> f64 {
        self.chip.current_into_node(post)
    }

    fn set_param(&mut self, name: &str, value: f64) -> bool {
        match name {
            "highVoltage" => self.chip.high_voltage = value,
            _ => return false,
        }
        true
    }

    fn reset(&mut self) {
        self.chip.reset();
    }
}
