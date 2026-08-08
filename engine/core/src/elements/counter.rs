//! Binary counter with optional up/down control and negative-edge triggering
//! (CounterElm.java, dump 164).

use crate::element::{Base, Element, SimCtx};
use crate::elements::chip::{Chip, ChipPin};
use crate::spec::ElementSpec;
use crate::stamp::Stamper;

const FLAG_UP_DOWN: i64 = 4;
const FLAG_NEGATIVE_EDGE: i64 = 8;

pub struct Counter {
    chip: Chip,
    bits: usize,
    /// Count modulus; 0 disables wrapping (CounterElm.java:29).
    modulus: usize,
    /// Reset polarity, carried as a file token rather than a flag
    /// (CounterElm.java:28, :39-46).
    invert_reset: bool,
    has_up_down: bool,
    negative_edge: bool,
}

impl Counter {
    pub fn new(spec: &ElementSpec) -> Self {
        // The edit dialog rejects fewer than 3 bits (CounterElm.java:118).
        let bits = (spec.param("bits", 4.0) as usize).max(3);
        let modulus = spec.param("modulus", 0.0).max(0.0) as usize;
        // The default is active-low reset, `invertreset = true`
        // (CounterElm.java:28, :40).
        let invert_reset = spec.param("invertreset", 1.0) != 0.0;
        let has_up_down = spec.flag(FLAG_UP_DOWN);
        let negative_edge = spec.flag(FLAG_NEGATIVE_EDGE);
        let mut pins = vec![
            ChipPin::input().clock(), // 0 clock
            ChipPin::input(),         // 1 reset
        ];
        for _ in 0..bits {
            pins.push(ChipPin::output(true));
        }
        if has_up_down {
            pins.push(ChipPin::input()); // bits + 2 U/D
        }
        Self {
            chip: Chip::new(spec, pins),
            bits,
            modulus,
            invert_reset,
            has_up_down,
            negative_edge,
        }
    }

    fn execute(&mut self) {
        let neg = self.negative_edge;
        // The edge fires when the clock crosses toward its active level: the
        // default rising edge, a falling one under FLAG_NEGATIVE_EDGE
        // (CounterElm.java:143).
        if self.chip.pins[0].value != neg && self.chip.last_clock == neg {
            let mut value: i64 = 0;
            let dir = if self.has_up_down && self.chip.pins[self.bits + 2].value {
                -1
            } else {
                1
            };
            // The output pins run MSB first, so pin 2 + (bits-1) is the least
            // significant bit (makeBitPins with reversed = true,
            // CounterElm.java:81).
            let last_bit = self.bits + 1;
            for i in 0..self.bits {
                if self.chip.pins[last_bit - i].value {
                    value |= 1 << i;
                }
            }
            value = if self.modulus != 0 {
                (value + dir).rem_euclid(self.modulus as i64)
            } else {
                value + dir
            };
            for i in 0..self.bits {
                self.chip.pins[last_bit - i].value = (value & (1 << i)) != 0;
            }
        }
        if self.chip.pins[1].value != self.invert_reset {
            for i in 0..self.bits {
                self.chip.pins[i + 2].value = false;
            }
        }
    }
}

impl Element for Counter {
    fn kind(&self) -> &'static str {
        "counter"
    }
    fn base(&self) -> &Base {
        &self.chip.base
    }
    fn base_mut(&mut self) -> &mut Base {
        &mut self.chip.base
    }
    fn post_count(&self) -> usize {
        self.bits + 2 + (self.has_up_down as usize)
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

    fn current_into_node(&self, post: usize) -> f64 {
        self.chip.current_into_node(post)
    }

    fn set_param(&mut self, name: &str, value: f64) -> bool {
        match name {
            "highVoltage" => self.chip.high_voltage = value,
            // "bits" changes the output count, which needs a full rebuild.
            _ => return false,
        }
        true
    }

    fn reset(&mut self) {
        self.chip.reset();
    }
}
