//! D flip-flop (DFlipFlopElm.java, dump 155).

use crate::element::{Base, Element, SimCtx};
use crate::elements::chip::{Chip, ChipPin};
use crate::spec::ElementSpec;
use crate::stamp::Stamper;

const FLAG_RESET: i64 = 2;
const FLAG_SET: i64 = 4;
const FLAG_INVERT_SET_RESET: i64 = 8;

pub struct DFlipFlop {
    chip: Chip,
    has_set: bool,
    has_reset: bool,
    invert_set_reset: bool,
}

impl DFlipFlop {
    pub fn new(spec: &ElementSpec) -> Self {
        let has_set = spec.flag(FLAG_SET);
        let has_reset = spec.flag(FLAG_RESET) || has_set;
        let invert_set_reset = spec.flag(FLAG_INVERT_SET_RESET);
        // Pin layout (DFlipFlopElm.java:43-65): D and clock on the west,
        // Q and Qbar on the east, the optional R and S pins appearing only
        // under their flags.
        let mut pins = vec![
            ChipPin::input(),         // 0 D
            ChipPin::output(true),    // 1 Q, saved to the file
            ChipPin::output(false),   // 2 Qbar, never saved
            ChipPin::input().clock(), // 3 clock
        ];
        if has_set {
            pins.push(ChipPin::input()); // 4 R
            pins.push(ChipPin::input()); // 5 S
        } else if has_reset {
            pins.push(ChipPin::input()); // 4 R
        }
        let mut dff = Self {
            chip: Chip::new(spec, pins),
            has_set,
            has_reset,
            invert_set_reset,
        };
        // Qbar always mirrors Q (DFlipFlopElm.java:34, :39).
        dff.chip.pins[2].value = !dff.chip.pins[1].value;
        dff
    }

    fn execute(&mut self) {
        let mut is_set = false;
        let mut is_reset = false;
        if self.has_set && self.chip.pins[5].value != self.invert_set_reset {
            is_set = true;
        }
        if self.has_reset && self.chip.pins[4].value != self.invert_set_reset {
            is_reset = true;
        }
        if is_set || is_reset {
            self.chip.write_output(1, false);
            self.chip.write_output(2, false);
            if is_set {
                self.chip.write_output(1, true);
            }
            if is_reset {
                self.chip.write_output(2, true);
            }
        } else {
            // A rising clock edge copies D into Q; Qbar always follows Q
            // (DFlipFlopElm.java:98-101).
            if self.chip.pins[3].value && !self.chip.last_clock {
                self.chip.write_output(1, self.chip.pins[0].value);
            }
            self.chip.write_output(2, !self.chip.pins[1].value);
        }
    }
}

impl Element for DFlipFlop {
    fn kind(&self) -> &'static str {
        "dFlipFlop"
    }
    fn base(&self) -> &Base {
        &self.chip.base
    }
    fn base_mut(&mut self) -> &mut Base {
        &mut self.chip.base
    }
    fn post_count(&self) -> usize {
        4 + (self.has_reset as usize) + (self.has_set as usize)
    }
    fn voltage_source_count(&self) -> usize {
        self.chip.voltage_source_count()
    }
    fn voltage_source_nodes(&self, k: usize) -> (usize, usize) {
        self.chip.voltage_source_nodes(k)
    }
    /// No current path between posts: only the outputs' sources tie their
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
            // "bits" has no meaning here; any other name falls through so the
            // caller can rebuild, which is what a flag change needs anyway.
            _ => return false,
        }
        true
    }

    fn reset(&mut self) {
        self.chip.reset();
        // A cleared flip-flop shows Qbar high (DFlipFlopElm.java:70-74).
        self.chip.pins[2].value = true;
        self.chip.base.volts[2] = self.chip.high_voltage;
    }
}
