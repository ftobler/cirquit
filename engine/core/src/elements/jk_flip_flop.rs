//! JK flip-flop (JKFlipFlopElm.java, dump 156).

use crate::element::{Base, Element, SimCtx};
use crate::elements::chip::{Chip, ChipPin};
use crate::spec::ElementSpec;
use crate::stamp::Stamper;

const FLAG_RESET: i64 = 2;
const FLAG_POSITIVE_EDGE: i64 = 4;
const FLAG_INVERT_RESET: i64 = 8;

pub struct JKFlipFlop {
    chip: Chip,
    has_reset: bool,
    positive_edge: bool,
    invert_reset: bool,
}

impl JKFlipFlop {
    pub fn new(spec: &ElementSpec) -> Self {
        let has_reset = spec.flag(FLAG_RESET);
        let positive_edge = spec.flag(FLAG_POSITIVE_EDGE);
        let invert_reset = spec.flag(FLAG_INVERT_RESET);
        // Pin layout (JKFlipFlopElm.java:37-56): J, clock and K on the west,
        // Q and Qbar on the east, the optional R pin on the east.
        let mut pins = vec![
            ChipPin::input(),         // 0 J
            ChipPin::input().clock(), // 1 clock
            ChipPin::input(),         // 2 K
            ChipPin::output(true),    // 3 Q, saved to the file
            ChipPin::output(false),   // 4 Qbar, never saved
        ];
        if has_reset {
            pins.push(ChipPin::input()); // 5 R
        }
        let mut jk = Self {
            chip: Chip::new(spec, pins),
            has_reset,
            positive_edge,
            invert_reset,
        };
        // Qbar mirrors Q (JKFlipFlopElm.java:33).
        jk.chip.pins[4].value = !jk.chip.pins[3].value;
        jk
    }

    fn execute(&mut self) {
        // The default is negative-edge triggered (the clock pin carries a
        // bubble); FLAG_POSITIVE_EDGE flips it (JKFlipFlopElm.java:69-73).
        let transition = if self.positive_edge {
            self.chip.pins[1].value && !self.chip.last_clock
        } else {
            !self.chip.pins[1].value && self.chip.last_clock
        };
        if transition {
            let mut q = self.chip.pins[3].value;
            if self.chip.pins[0].value {
                if self.chip.pins[2].value {
                    q = !q;
                } else {
                    q = true;
                }
            } else if self.chip.pins[2].value {
                q = false;
            }
            self.chip.write_output(3, q);
        }
        if self.has_reset && self.chip.pins[5].value != self.invert_reset {
            self.chip.write_output(3, false);
        }
        self.chip.write_output(4, !self.chip.pins[3].value);
    }
}

impl Element for JKFlipFlop {
    fn kind(&self) -> &'static str {
        "jkFlipFlop"
    }
    fn base(&self) -> &Base {
        &self.chip.base
    }
    fn base_mut(&mut self) -> &mut Base {
        &mut self.chip.base
    }
    fn post_count(&self) -> usize {
        5 + (self.has_reset as usize)
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
    }
}
