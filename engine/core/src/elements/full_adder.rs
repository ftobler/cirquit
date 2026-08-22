//! Ripple-carry full adder (FullAdderElm.java, dump 196): `bits` A inputs and
//! `bits` B inputs summed with a carry-in into `bits` S outputs and a
//! carry-out. The width is the `bits` file token under FLAG_BITS, or 1 for a
//! flagless line, exactly the file constructor's default (FullAdderElm.java:
//! 30-35). Every output is one voltage source to ground through the shared
//! chip base; the sum recomputes combinationally each step.

use crate::element::{Base, Element, SimCtx};
use crate::elements::chip::{Chip, ChipPin};
use crate::spec::ElementSpec;
use crate::stamp::Stamper;

/// File flag saying a `bits` token follows the common chip fields; the
/// interactive constructor always sets it, so only a hand-edited line is
/// flagless (FullAdderElm.java:25, :36).
const FLAG_BITS: i64 = 2;

pub struct FullAdder {
    chip: Chip,
    bits: usize,
    /// True under upstream's BIT_ORDER_BUS (ChipElm.java:37): the A, B and S
    /// groups share one coordinate each, told apart by per-post bit tags.
    bus: bool,
}

impl FullAdder {
    pub fn new(spec: &ElementSpec) -> Self {
        // The width comes from the token under FLAG_BITS; a flagless line
        // means a 1-bit adder. The clamp keeps a corrupt file token from
        // allocating 3*bits + 2 posts.
        let bits = if spec.flag(FLAG_BITS) {
            (spec.param("bits", 4.0) as usize).clamp(1, 16)
        } else {
            1
        };
        let bus = spec.flag(crate::elements::chip::FLAG_BIT_ORDER_BUS);
        // Pin order (setupPins, FullAdderElm.java:41-56): the A and B inputs
        // on the west MSB first, the S outputs on the east, then the carry-in
        // and carry-out (FullAdderElm.java:50-54). No pin is saved to the file.
        let mut pins = Vec::with_capacity(3 * bits + 2);
        for _ in 0..bits {
            pins.push(ChipPin::input()); // A_i
        }
        for _ in 0..bits {
            pins.push(ChipPin::input()); // B_i
        }
        for _ in 0..bits {
            pins.push(ChipPin::output(false)); // S_i
        }
        pins.push(ChipPin::input()); // 3*bits+0 carry in
        pins.push(ChipPin::output(false)); // 3*bits+1 carry out
        Self {
            chip: Chip::new(spec, pins),
            bits,
            bus,
        }
    }

    fn execute(&mut self) {
        // A ripple carry walks the bits low to high (FullAdderElm.java:62-71).
        // The carry-in sits at 3*bits, the carry-out at 3*bits+1
        // (FullAdderElm.java:50-54).
        let mut carry = self.chip.pins[3 * self.bits].value as u32;
        for i in 0..self.bits {
            let sum =
                self.chip.pins[i].value as u32 + self.chip.pins[self.bits + i].value as u32 + carry;
            carry = u32::from(sum > 1);
            self.chip.write_output(2 * self.bits + i, sum & 1 == 1);
        }
        self.chip.write_output(3 * self.bits + 1, carry == 1);
    }
}

impl Element for FullAdder {
    fn kind(&self) -> &'static str {
        "fullAdder"
    }
    fn base(&self) -> &Base {
        &self.chip.base
    }
    fn base_mut(&mut self) -> &mut Base {
        &mut self.chip.base
    }
    fn post_count(&self) -> usize {
        3 * self.bits + 2
    }
    /// Bus mode: the A, B and S groups each collapse onto one coordinate, and
    /// makeBitPins runs them unreversed, so pin p carries bit `p` within its
    /// block (FullAdderElm.java:44-48); execute reads exactly that mapping
    /// (:62-64).
    fn post_bus_z(&self, post: usize) -> usize {
        if !self.bus {
            return 0;
        }
        if post < self.bits {
            post
        } else if post < 2 * self.bits {
            post - self.bits
        } else if post < 3 * self.bits {
            post - 2 * self.bits
        } else {
            0
        }
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
            // "bits" changes the post count, which only a full rebuild can
            // reallocate.
            _ => return false,
        }
        true
    }

    fn reset(&mut self) {
        self.chip.reset();
    }
}
