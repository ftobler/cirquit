//! Seven-, 14- and 16-segment decoder (SevenSegDecoderElm.java, dump 197): a
//! chip that turns a 4-bit hex digit into the segment pattern that displays
//! it. The segment count comes from the `segmentType` token (0, 1, 2), the
//! four inputs sit on the west MSB first, the segment outputs on the east
//! (bit 0 is segment `a`), and FLAG_ENABLE adds an active-low blank pin. Under
//! FLAG_BLANK_F the all-ones input blanks instead of lighting the digit F.
//!
//! The glyph tables are packed one segment per bit, bit 0 = segment `a`
//! (SevenSegDecoderElm.java:27-89), so the pattern lookup is a single shift
//! per output pin.

use crate::element::{Base, Element, SimCtx};
use crate::elements::chip::{Chip, ChipPin};
use crate::spec::ElementSpec;
use crate::stamp::Stamper;

/// Adds the active-low blank input pin (SevenSegDecoderElm.java:91).
const FLAG_ENABLE: i64 = 1 << 1;
/// The all-ones input blanks all segments instead of lighting digit F
/// (SevenSegDecoderElm.java:92).
const FLAG_BLANK_F: i64 = 1 << 2;

/// The 7-segment glyphs, digit index 0..15, bit 0 = segment `a` (top),
/// bit 6 = segment `g` (centre), the order the outputs are named 'a'..'g'.
const SYMBOLS_7: [u16; 16] = [
    0x3f, 0x6, 0x5b, 0x4f, 0x66, 0x6d, 0x7d, 0x7, 0x7f, 0x67, 0x77, 0x7c, 0x39, 0x5e, 0x79, 0x71,
];

/// The 14-segment glyphs, bit 0 = `a` through bit 13 = `n`
/// (SevenSegDecoderElm.java:46-49).
const SYMBOLS_14: [u16; 16] = [
    0x113f, 0x106, 0x221b, 0x220f, 0x2226, 0x222d, 0x223d, 0x901, 0x223f, 0x222f, 0x2237, 0xa8f,
    0x39, 0x88f, 0x2239, 0x2231,
];

/// The 16-segment glyphs, bit 0 = `a` through bit 15 = `p`
/// (SevenSegDecoderElm.java:68-72).
const SYMBOLS_16: [u16; 16] = [
    0x44ff, 0x40c, 0x8877, 0x883f, 0x888c, 0x88bb, 0x88fb, 0x2403, 0x88ff, 0x88bf, 0x88cf, 0x2a3f,
    0xf3, 0x223f, 0x88f3, 0x88c3,
];

pub struct SevenSegDecoder {
    chip: Chip,
    /// Segment count: 7, 14 or 16 from the `segmentType` token
    /// (SevenSegDecoderElm.java:117-121).
    seg_count: usize,
    has_enable: bool,
    blank_on_f: bool,
}

impl SevenSegDecoder {
    pub fn new(spec: &ElementSpec) -> Self {
        let segment_type = spec.param("segmentType", 0.0).round() as usize;
        let seg_count = match segment_type {
            1 => 14,
            2 => 16,
            _ => 7,
        };
        let has_enable = spec.flag(FLAG_ENABLE);
        let blank_on_f = spec.flag(FLAG_BLANK_F);
        // Pin order (setupPins, SevenSegDecoderElm.java:135-160): the segment
        // outputs on the east, the four inputs on the west MSB first, then the
        // blank pin. No pin is saved to the file.
        let mut pins = Vec::with_capacity(seg_count + 5);
        for _ in 0..seg_count {
            pins.push(ChipPin::output(false));
        }
        for _ in 0..4 {
            pins.push(ChipPin::input());
        }
        if has_enable {
            pins.push(ChipPin::input()); // seg_count+4 blank, active low
        }
        Self {
            chip: Chip::new(spec, pins),
            seg_count,
            has_enable,
            blank_on_f,
        }
    }

    fn symbols(&self) -> &'static [u16; 16] {
        match self.seg_count {
            14 => &SYMBOLS_14,
            16 => &SYMBOLS_16,
            _ => &SYMBOLS_7,
        }
    }

    fn execute(&mut self) {
        // The inputs read MSB first: pin seg_count is the 8s bit
        // (SevenSegDecoderElm.java:172-177).
        let mut input = 0usize;
        for i in 0..4 {
            if self.chip.pins[self.seg_count + i].value {
                input |= 1 << (3 - i);
            }
        }
        // The blank pin is active low; the all-ones input blanks instead under
        // FLAG_BLANK_F (SevenSegDecoderElm.java:178-188).
        let enabled = !self.has_enable || self.chip.pins[self.seg_count + 4].value;
        let blank = !enabled || (input == 15 && self.blank_on_f);
        let syms = self.symbols();
        for i in 0..self.seg_count {
            let lit = !blank && (syms[input] & (1 << i)) != 0;
            self.chip.write_output(i, lit);
        }
    }
}

impl Element for SevenSegDecoder {
    fn kind(&self) -> &'static str {
        "sevenSegDecoder"
    }
    fn base(&self) -> &Base {
        &self.chip.base
    }
    fn base_mut(&mut self) -> &mut Base {
        &mut self.chip.base
    }
    fn post_count(&self) -> usize {
        self.seg_count + 4 + usize::from(self.has_enable)
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
            // "segmentType" and the FLAG_ENABLE/FLAG_BLANK_F pins change the
            // post count, which only a full rebuild can reallocate.
            _ => return false,
        }
        true
    }

    fn reset(&mut self) {
        self.chip.reset();
    }
}
