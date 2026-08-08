//! Ring counter: one output high, advanced one position per clock edge
//! (RingCounterElm.java, dump 163).

use crate::element::{Base, Element, SimCtx};
use crate::elements::chip::{Chip, ChipPin};
use crate::spec::ElementSpec;
use crate::stamp::Stamper;

const FLAG_CLOCK_INHIBIT: i64 = 2;
const FLAG_RESET_HIGH: i64 = 4;

pub struct RingCounter {
    chip: Chip,
    bits: usize,
    /// Index of the optional CE (clock inhibit) pin, active low.
    ce_pin: Option<usize>,
    /// True when the reset pin is active high; the flag says the opposite
    /// (hasInvertReset, RingCounterElm.java:41).
    invert_reset: bool,
}

impl RingCounter {
    pub fn new(spec: &ElementSpec) -> Self {
        // The edit dialog rejects fewer than 2 bits (RingCounterElm.java:123);
        // the default is 10 (RingCounterElm.java:39).
        let bits = (spec.param("bits", 10.0) as usize).max(2);
        let clock_inhibit = spec.flag(FLAG_CLOCK_INHIBIT) && bits >= 3;
        let invert_reset = !spec.flag(FLAG_RESET_HIGH);
        let mut pins = vec![
            ChipPin::input().clock(), // 0 clock
            ChipPin::input(),         // 1 reset
        ];
        for _ in 0..bits {
            pins.push(ChipPin::output(true));
        }
        let ce_pin = if clock_inhibit {
            pins.push(ChipPin::input());
            Some(pins.len() - 1)
        } else {
            None
        };
        Self {
            chip: Chip::new(spec, pins),
            bits,
            ce_pin,
            invert_reset,
        }
    }

    fn execute(&mut self) {
        // A high CE pin stops the count (RingCounterElm.java:78-80).
        let running = !self.ce_pin.is_some_and(|p| self.chip.pins[p].value);
        // Find the single high output, if any (RingCounterElm.java:83-85).
        let mut i = 0;
        while i < self.bits && !self.chip.pins[i + 2].value {
            i += 1;
        }
        // A rising clock edge moves the high bit one position on
        // (RingCounterElm.java:87-92).
        if self.chip.pins[0].value && !self.chip.last_clock && running {
            if i < self.bits {
                self.chip.pins[i + 2].value = false;
                i += 1;
            }
            i %= self.bits;
            self.chip.pins[i + 2].value = true;
        }
        // Reset when requested, or when every output has gone low: Q0 alone
        // restarts the ring (RingCounterElm.java:95-99).
        if self.chip.pins[1].value != self.invert_reset || i == self.bits {
            for j in 1..self.bits {
                self.chip.pins[j + 2].value = false;
            }
            self.chip.pins[2].value = true;
        }
    }
}

impl Element for RingCounter {
    fn kind(&self) -> &'static str {
        "ringCounter"
    }
    fn base(&self) -> &Base {
        &self.chip.base
    }
    fn base_mut(&mut self) -> &mut Base {
        &mut self.chip.base
    }
    fn post_count(&self) -> usize {
        self.bits + 2 + (self.ce_pin.is_some() as usize)
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
