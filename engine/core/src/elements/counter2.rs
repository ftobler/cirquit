//! Counter 2 (Counter2Elm.java, dump 421): a bit-width counter with
//! parallel-load and clear pins. The count advances on a rising clock edge
//! while EnP and EnT are both high, wraps at the `modulus` token (or at 2^bits
//! when the modulus is 0), and RCO pulses high while the count sits at
//! modulus-1 and EnT is high. LOAD and CLR are active low; CLR is level-based
//! and wins over everything.

use crate::element::{Base, Element, SimCtx};
use crate::elements::chip::{Chip, ChipPin};
use crate::spec::ElementSpec;
use crate::stamp::Stamper;

pub struct Counter2 {
    chip: Chip,
    bits: usize,
    modulus: usize,
    /// RCO's latch: high while the count is at `realmod - 1` after the last
    /// clock (Counter2Elm.java:120).
    carry: bool,
}

impl Counter2 {
    pub fn new(spec: &ElementSpec) -> Self {
        // The edit dialog rejects fewer than 2 bits (Counter2Elm.java:107).
        let bits = (spec.param("bits", 4.0) as usize).max(2);
        let modulus = spec.param("modulus", 0.0).max(0.0) as usize;
        let mut pins: Vec<ChipPin> = Vec::with_capacity(2 * bits + 6);
        // The Q outputs first, MSB at pin 0 (makeBitPins reversed,
        // Counter2Elm.java:75).
        for _ in 0..bits {
            pins.push(ChipPin::output(true));
        }
        // The parallel-load inputs (makeBitPins reversed, Counter2Elm.java:76).
        for _ in 0..bits {
            pins.push(ChipPin::input());
        }
        pins.push(ChipPin::input().clock()); // 2*bits+0 clk
        pins.push(ChipPin::input()); // 2*bits+1 clr
        pins.push(ChipPin::input()); // 2*bits+2 enp
        pins.push(ChipPin::output(false)); // 2*bits+3 rco
        pins.push(ChipPin::input()); // 2*bits+4 load
        pins.push(ChipPin::input()); // 2*bits+5 ent
        Self {
            chip: Chip::new(spec, pins),
            bits,
            modulus,
            carry: false,
        }
    }

    fn clk(&self) -> usize {
        2 * self.bits
    }
    fn clr(&self) -> usize {
        2 * self.bits + 1
    }
    fn enp(&self) -> usize {
        2 * self.bits + 2
    }
    fn rco(&self) -> usize {
        2 * self.bits + 3
    }
    fn load(&self) -> usize {
        2 * self.bits + 4
    }
    fn ent(&self) -> usize {
        2 * self.bits + 5
    }

    /// The count the Q pins hold, bit `i` on pin `bits - 1 - i`
    /// (Counter2Elm.java:129-132).
    fn read_q(&self) -> i64 {
        let mut value = 0i64;
        for i in 0..self.bits.min(62) {
            if self.chip.pins[self.bits - 1 - i].value {
                value |= 1i64 << i;
            }
        }
        value
    }

    fn write_q(&mut self, value: i64) {
        for i in 0..self.bits.min(62) {
            self.chip.pins[self.bits - 1 - i].value = (value & (1i64 << i)) != 0;
        }
    }

    /// The wrap modulus: the file token, or 2^bits when it is 0
    /// (Counter2Elm.java:136, :159).
    fn real_mod(&self) -> i64 {
        if self.modulus != 0 {
            self.modulus as i64
        } else {
            1i64 << self.bits.min(30)
        }
    }

    fn execute(&mut self) {
        if self.chip.pins[self.clk()].value && !self.chip.last_clock {
            if self.chip.pins[self.enp()].value && self.chip.pins[self.ent()].value {
                // Count, wrapping at the modulus (Counter2Elm.java:123-144).
                let value = (self.read_q() + 1).rem_euclid(self.real_mod());
                self.write_q(value);
                self.carry = value == self.real_mod() - 1;
            }
            if !self.chip.pins[self.load()].value {
                // Parallel load, active low; the carry recomputes from the
                // loaded value (Counter2Elm.java:146-162).
                for i in 0..self.bits {
                    self.chip.pins[i].value = self.chip.pins[self.bits + i].value;
                }
                let value = self.read_q();
                self.carry = value == self.real_mod() - 1;
            }
        }
        if !self.chip.pins[self.clr()].value {
            // Clear, active low and level-based (Counter2Elm.java:164-169).
            for i in 0..self.bits {
                self.chip.pins[i].value = false;
            }
            self.carry = false;
        }
        // RCO tracks the carry while EnT is high (Counter2Elm.java:172).
        let ent = self.chip.pins[self.ent()].value;
        let rco = self.rco();
        self.chip.pins[rco].value = self.carry && ent;
    }
}

impl Element for Counter2 {
    fn kind(&self) -> &'static str {
        "counter2"
    }
    fn base(&self) -> &Base {
        &self.chip.base
    }
    fn base_mut(&mut self) -> &mut Base {
        &mut self.chip.base
    }
    fn post_count(&self) -> usize {
        2 * self.bits + 6
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
            // "bits" and "modulus" change the pin count or the wrap, which a
            // live edit cannot apply.
            _ => return false,
        }
        true
    }

    fn reset(&mut self) {
        self.chip.reset();
        self.carry = false;
    }
}
