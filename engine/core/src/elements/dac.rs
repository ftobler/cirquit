//! Digital-to-analog converter (DACElm.java, dump 166): a chip that turns its
//! bit inputs into an analog output voltage.
//!
//! The output pin drives a voltage source to ground at `ival * Vplus / ivalmax`,
//! where `ival` is the binary value of the thresholded bit inputs and `Vplus`
//! the V+ pin's own node voltage, so all bits high outputs exactly the V+ pin
//! and any pattern in between scales linearly (DACElm.java:42-51). The input
//! threshold is `highVoltage / 2` like every chip (ChipElm.java:74), and the
//! V+ pin doubles as the full-scale reference.
//!
//! This is the chip voltage-source pattern with a difference: the source value
//! is not a committed pin state but a live re-read of the node voltages on
//! every Newton iteration, `doStep` reads `volts[i]` directly rather than the
//! `pins[i].value` the base class commits (DACElm.java:42-51). The matrix
//! structure is still constant, so the element stays linear: only the source's
//! right-hand side changes per step, and the output lags the inputs by one
//! step exactly as upstream's first `doStep` reads the previous solve.

use crate::element::{Base, Element, SimCtx};
use crate::elements::chip::{Chip, ChipPin};
use crate::spec::ElementSpec;
use crate::stamp::Stamper;

pub struct Dac {
    chip: Chip,
    /// Number of bit inputs. Posts 0..bits are the bits, `bits` the O output
    /// source and `bits + 1` the V+ reference (setupPins, DACElm.java:31-41).
    bits: usize,
}

impl Dac {
    pub fn new(spec: &ElementSpec) -> Self {
        // A floor of 1 keeps a degenerate file from dividing by a zero
        // full-scale; the edit dialog already rejects fewer than 2 bits
        // (DACElm.java:66-71).
        let bits = (spec.param("bits", 4.0) as usize).max(1);
        // The bit inputs, then the O output source, then the V+ reference pin
        // (setupPins, DACElm.java:35-40). No pin carries saved state, so the
        // token stream after `bits` holds only the optional high voltage.
        let mut pins = Vec::with_capacity(bits + 2);
        for _ in 0..bits {
            pins.push(ChipPin::input());
        }
        pins.push(ChipPin::output(false)); // O
        pins.push(ChipPin::input()); // V+
        Self {
            chip: Chip::new(spec, pins),
            bits,
        }
    }

    /// The output source value, `ival * Vplus / (2^bits - 1)` (DACElm.java:
    /// 43-50). Bit `i` of the thresholded inputs contributes `2^i`, so post 0
    /// is the least significant bit whatever the drawn bit order.
    fn output_v(&self) -> f64 {
        let ivalmax = (1usize << self.bits) - 1;
        let mut ival: usize = 0;
        for i in 0..self.bits {
            if self.chip.base.volts[i] > self.chip.high_voltage * 0.5 {
                ival |= 1 << i;
            }
        }
        ival as f64 * self.chip.base.volts[self.bits + 1] / ivalmax as f64
    }
}

impl Element for Dac {
    fn kind(&self) -> &'static str {
        "dac"
    }
    fn base(&self) -> &Base {
        &self.chip.base
    }
    fn base_mut(&mut self) -> &mut Base {
        &mut self.chip.base
    }
    fn post_count(&self) -> usize {
        self.bits + 2
    }
    fn voltage_source_count(&self) -> usize {
        self.chip.voltage_source_count()
    }
    fn voltage_source_nodes(&self, k: usize) -> (usize, usize) {
        self.chip.voltage_source_nodes(k)
    }
    /// No current path couples the pins: only the output source ties its node
    /// to ground (ChipElm.java:467).
    fn connects(&self, _a: usize, _b: usize) -> bool {
        false
    }

    fn stamp(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        // Topology once with a zero value; `do_step` supplies the level every
        // iteration, so the matrix factors stay cached (ChipElm.java:314-326).
        self.chip.stamp(s);
    }

    fn do_step(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        s.voltage_source_value(self.chip.base.vs_base, self.output_v());
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
            // "bits" changes the pin count, which only a full rebuild can
            // reallocate.
            _ => return false,
        }
        true
    }

    fn reset(&mut self) {
        self.chip.reset();
    }
}
