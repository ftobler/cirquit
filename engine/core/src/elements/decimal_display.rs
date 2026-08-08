//! Decimal/hex/octal display: a bit-width chip with no output pins that reads
//! its west inputs and shows the binary value (DecimalDisplayElm.java, dump
//! 419).
//!
//! Everything electrical about this element is that it reads: no voltage
//! sources, no stamps, no current path. The digit glyph lives in the frontend,
//! which thresholds the terminal voltages itself; the engine still reads the
//! pins every step so its `value()` readout can report the thresholded bit
//! pattern, which is what the tests pin against.

use crate::element::{Base, Element, SimCtx};
use crate::elements::chip::{Chip, ChipPin};
use crate::spec::ElementSpec;

pub struct DecimalDisplay {
    chip: Chip,
    bits: usize,
}

impl DecimalDisplay {
    pub fn new(spec: &ElementSpec) -> Self {
        // The edit dialog clamps to 8 bits (the port's limit; upstream lets it
        // go to 16). A file carrying more is clamped on load too.
        let bits = (spec.param("bits", 4.0) as usize).clamp(1, 8);
        // One west input per bit, in pin order bit 0 .. bit (bits-1), matching
        // makeBitPins (DecimalDisplayElm.java:100). The display never writes a
        // pin, so every pin is a plain input with no saved state
        // (ChipElm.java:657-670), and getVoltageSourceCount() is 0.
        let mut pins = Vec::with_capacity(bits);
        for _ in 0..bits {
            pins.push(ChipPin::input());
        }
        Self {
            chip: Chip::new(spec, pins),
            bits,
        }
    }
}

impl Element for DecimalDisplay {
    fn kind(&self) -> &'static str {
        "decimalDisplay"
    }
    fn base(&self) -> &Base {
        &self.chip.base
    }
    fn base_mut(&mut self) -> &mut Base {
        &mut self.chip.base
    }
    fn post_count(&self) -> usize {
        self.bits
    }
    /// No current path couples the input pins: the element only senses its
    /// nodes (getVoltageSourceCount = 0, DecimalDisplayElm.java:105).
    fn connects(&self, _a: usize, _b: usize) -> bool {
        false
    }
    fn start_iteration(&mut self, _ctx: &SimCtx) {
        self.chip.read_inputs();
    }
    fn calculate_current(&mut self, _ctx: &SimCtx) {
        self.chip.base.current = 0.0;
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
    /// The thresholded bit pattern as a number, what the display shows
    /// (DecimalDisplayElm.java:63-66). This is the instrument readout, not the
    /// voltage a scope plots: `voltage_diff` stays the default `V(I0) - V(I1)`.
    fn value(&self) -> f64 {
        let mut v: u32 = 0;
        for (i, pin) in self.chip.pins.iter().enumerate() {
            if pin.value {
                v |= 1 << i;
            }
        }
        v as f64
    }
}
