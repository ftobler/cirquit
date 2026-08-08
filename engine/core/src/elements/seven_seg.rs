//! Seven-segment LED display (SevenSegElm.java, dump 157): a chip with no
//! output pins that lights its segments from its input bits. Like the decimal
//! display, everything electrical is that it reads: no voltage sources, no
//! stamps, no current path. The digit glyph lives in the frontend, which
//! thresholds the terminal voltages itself; the engine still reads the pins
//! every step so its `value()` readout can report the segment bit pattern,
//! which is what the tests pin against.
//!
//! The diode modes (common cathode/anode) add a common post and change the
//! glyph's lit rule, but the current through those LEDs is not modelled: the
//! segment posts are plain inputs here either way. The file format round-trips
//! and wires connect; only the diode currents are missing.

use crate::element::{Base, Element, SimCtx};
use crate::elements::chip::{Chip, ChipPin};
use crate::spec::ElementSpec;

/// Extra-segment choice meaning "none" (SevenSegElm.java:33-35). A positive
/// value, decimal point or colon, adds one segment pin.
const ES_NONE: i64 = 0;

pub struct SevenSeg {
    chip: Chip,
    /// Segment pins, the decimal point or colon included (SevenSegElm.java:30).
    segment_count: usize,
    /// All posts: the segments plus the common pin under a diode mode
    /// (setPinCount, SevenSegElm.java:391-405).
    pin_count: usize,
}

impl SevenSeg {
    pub fn new(spec: &ElementSpec) -> Self {
        // The edit dialog offers 7, 14 and 16 segments (getChipEditInfo); a
        // file carrying another count still rounds the way the frontend does.
        let base_segment_count = (spec.param("baseSegments", 7.0).round() as i64).max(1) as usize;
        let extra_segment = spec.param("extraSegment", 0.0).round() as i64;
        // 0 no diodes, 1 common cathode, -1 common anode. The sign is only
        // the LED direction upstream; either non-zero adds a common post.
        let diode_direction = spec.param("diodeDirection", 0.0).round() as i64;
        let segment_count = base_segment_count + usize::from(extra_segment > ES_NONE);
        let pin_count = segment_count + usize::from(diode_direction != 0);
        // One input per pin, in post order the segments then the common pin
        // (setupPins, SevenSegElm.java:86-135). No pin is an output and none
        // carries saved state, so there are no voltage sources and no tokens
        // beyond the element's own three.
        let mut pins = Vec::with_capacity(pin_count);
        for _ in 0..pin_count {
            pins.push(ChipPin::input());
        }
        Self {
            chip: Chip::new(spec, pins),
            segment_count,
            pin_count,
        }
    }
}

impl Element for SevenSeg {
    fn kind(&self) -> &'static str {
        "sevenSeg"
    }
    fn base(&self) -> &Base {
        &self.chip.base
    }
    fn base_mut(&mut self) -> &mut Base {
        &mut self.chip.base
    }
    fn post_count(&self) -> usize {
        self.pin_count
    }
    /// No current path couples the pins: the display only senses its nodes
    /// (getVoltageSourceCount = 0, SevenSegElm.java:335). Upstream's diode
    /// modes would couple the segments through the LEDs (getConnection,
    /// SevenSegElm.java:304-306); those currents are not modelled here, so
    /// the pins stay apart rather than being shorted together.
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
            // "baseSegments", "extraSegment" and "diodeDirection" change the
            // pin count, which only a full rebuild can reallocate.
            _ => return false,
        }
        true
    }
    fn reset(&mut self) {
        self.chip.reset();
    }
    /// The segment pins' thresholded pattern as a number: bit 0 is segment
    /// `a`, bit 6 segment `g`, a decimal point or colon the next bit. This is
    /// the instrument readout, what digit is lit; `voltage_diff` stays the
    /// default `V(a) - V(b)` for scopes, like every other chip.
    fn value(&self) -> f64 {
        let mut v: u32 = 0;
        for (i, pin) in self.chip.pins.iter().take(self.segment_count).enumerate() {
            if pin.value {
                v |= 1 << i;
            }
        }
        v as f64
    }
}
