//! T flip-flop (TFlipFlopElm.java, dump 193).

use crate::element::{Base, Element, SimCtx};
use crate::elements::chip::{Chip, ChipPin};
use crate::spec::ElementSpec;
use crate::stamp::Stamper;

const FLAG_RESET: i64 = 2;
const FLAG_SET: i64 = 4;

pub struct TFlipFlop {
    chip: Chip,
    has_set: bool,
    has_reset: bool,
}

impl TFlipFlop {
    pub fn new(spec: &ElementSpec) -> Self {
        let has_set = spec.flag(FLAG_SET);
        let has_reset = spec.flag(FLAG_RESET) || has_set;
        // Pin layout (TFlipFlopElm.java:34-53): T and clock on the west,
        // Q and Qbar on the east, the optional R and S pins under their flags.
        let mut pins = vec![
            ChipPin::input(),         // 0 T
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
        let mut tff = Self {
            chip: Chip::new(spec, pins),
            has_set,
            has_reset,
        };
        // Qbar mirrors Q (TFlipFlopElm.java:31).
        tff.chip.pins[2].value = !tff.chip.pins[1].value;
        tff
    }

    fn execute(&mut self) {
        // A rising clock edge toggles Q when T is high (TFlipFlopElm.java:64-72).
        if self.chip.pins[3].value && !self.chip.last_clock && self.chip.pins[0].value {
            self.chip.pins[1].value = !self.chip.pins[1].value;
        }
        if self.has_set && self.chip.pins[5].value {
            self.chip.pins[1].value = true;
        }
        if self.has_reset && self.chip.pins[4].value {
            self.chip.pins[1].value = false;
        }
        self.chip.pins[2].value = !self.chip.pins[1].value;
    }
}

impl Element for TFlipFlop {
    fn kind(&self) -> &'static str {
        "tFlipFlop"
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

    fn state_tokens(&self) -> Vec<(String, f64)> {
        self.chip.state_tokens()
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
        // A cleared flip-flop shows Qbar high (TFlipFlopElm.java:58-62).
        self.chip.pins[2].value = true;
        self.chip.base.volts[2] = self.chip.high_voltage;
    }
}
