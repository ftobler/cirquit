//! Analog-to-digital converter (ADCElm.java, dump 167): a chip that turns its
//! analog In pin into `bits` digital output bits against the V+ reference.
//!
//! The conversion law is upstream's exact expression: `trunc((2^bits - 1) *
//! V(in) / V(+))` clamped to the code range (ADCElm.java:42-46). The comment
//! there explains the truncation: rounding would break a half-flash ADC. The
//! outputs are ordinary chip output sources driven high (`highVoltage`) or
//! ground, so the electrical model is the shared chip base with the In and V+
//! pins left as plain sense inputs. Unlike the digital chip family there is no
//! saved output state: `makeBitPins` passes `state=false`, so the file carries
//! no `voltageN` tokens after `bits` and the optional `highVoltage`.

use crate::element::{Base, Element, SimCtx};
use crate::elements::chip::{Chip, ChipPin};
use crate::spec::ElementSpec;
use crate::stamp::Stamper;

pub struct Adc {
    chip: Chip,
    bits: usize,
}

impl Adc {
    pub fn new(spec: &ElementSpec) -> Self {
        // The edit dialog rejects fewer than 2 bits (ADCElm.java:64-69). The
        // upper clamp keeps the `1 << bits` code range well inside an i64, so
        // a hand-edited width cannot make the output bits silently wrap.
        let bits = (spec.param("bits", 4.0) as usize).clamp(2, 30);
        // Pin table (ADCElm.java:31-40): the bit outputs on the east (no saved
        // state), then the In and V+ sense inputs on the west.
        let mut pins = Vec::with_capacity(bits + 2);
        for _ in 0..bits {
            pins.push(ChipPin::output(false));
        }
        pins.push(ChipPin::input()); // bits   In
        pins.push(ChipPin::input()); // bits+1 V+
        Self {
            chip: Chip::new(spec, pins),
            bits,
        }
    }

    fn execute(&mut self) {
        // `imax * volts[bits] / volts[bits+1]`, truncated toward zero then
        // clamped (ADCElm.java:42-46). The pin indices are the In and V+ posts,
        // fixed as bits and bits+1 above. A NaN (0/0 on the very first step,
        // or an unterminated V+) casts to 0, matching Java's `(int)NaN`.
        let imax = (1i64 << self.bits) - 1;
        let val =
            imax as f64 * self.chip.base.volts[self.bits] / self.chip.base.volts[self.bits + 1];
        let ival = (val as i64).clamp(0, imax);
        for i in 0..self.bits {
            self.chip.write_output(i, (ival & (1 << i)) != 0);
        }
    }
}

impl Element for Adc {
    fn kind(&self) -> &'static str {
        "adc"
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
    /// No current path couples the posts: the outputs are voltage-source
    /// drives and the In and V+ pins only sense their nodes (ChipElm.java:467).
    fn connects(&self, _a: usize, _b: usize) -> bool {
        false
    }

    fn stamp(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        self.chip.stamp(s);
    }

    fn start_iteration(&mut self, _ctx: &SimCtx) {
        // No clock and no saved state, so every step recomputes the outputs
        // from the analog input. read_inputs keeps the shared base's
        // just-loaded first-step deferral even though no pin here carries
        // state (ADCElm.java:41-50).
        if self.chip.read_inputs() {
            self.execute();
        }
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
            // "bits" changes the pin count, which only a full rebuild can
            // reallocate.
            _ => return false,
        }
        true
    }

    fn reset(&mut self) {
        self.chip.reset();
    }

    /// The converted code as the instrument readout, what a scope or the
    /// Options panel shows: bit 0 is D0. `voltage_diff` stays the default
    /// `V(D0) - V(D1)`, like every other chip.
    fn value(&self) -> f64 {
        let mut v: u32 = 0;
        for i in 0..self.bits {
            if self.chip.pins[i].value {
                v |= 1 << i;
            }
        }
        v as f64
    }
}
