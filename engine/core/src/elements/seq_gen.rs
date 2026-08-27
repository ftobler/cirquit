//! Sequence generator (SeqGenElm.java, dump 188). A rising clock edge emits
//! the next bit of the stored sequence, wrapping at the bit count, or holding
//! the output low under FLAG_PLAY_ONCE. FLAG_HAS_RESET adds an active-high
//! reset pin that rewinds to the first bit and syncs the clock memory. The
//! pre-2009 byte format (no FLAG_NEW_VERSION) is upgraded on the TypeScript
//! side before it reaches the engine.

use crate::element::{Base, Element, SimCtx};
use crate::elements::chip::{Chip, ChipPin};
use crate::spec::ElementSpec;
use crate::stamp::Stamper;

const FLAG_PLAY_ONCE: i64 = 4;
const FLAG_HAS_RESET: i64 = 8;

/// Ceiling on the stored bit count; upstream fixes no cap (SeqGenElm.java:65-66
/// sizes `data` straight from the token), so this is the port's own. 1<<16 bits
/// packs into 2048 i64 words, a generous sequence, and stays well under the
/// `usize` ceiling where the old code overflowed `Vec::with_capacity`.
const MAX_SEQ_GEN_BITS: usize = 1 << 16;

pub struct SeqGen {
    chip: Chip,
    /// The sequence as packed 32-bit words, LSB of `data[0]` first
    /// (`data`, SeqGenElm.java:36).
    data: Vec<i64>,
    bit_count: usize,
    /// Which bit the next clock emits (`bitPosition`, SeqGenElm.java:34).
    bit_position: usize,
    has_play_once: bool,
    has_reset: bool,
}

impl SeqGen {
    pub fn new(spec: &ElementSpec) -> Result<Self, String> {
        let has_reset = spec.flag(FLAG_HAS_RESET);
        let bit_count =
            spec.param_count("bitCount", 8.0, 1.0, MAX_SEQ_GEN_BITS as f64, "seqGen")?;
        let words = bit_count.div_ceil(32);
        let mut data = Vec::with_capacity(words);
        for w in 0..words {
            data.push(spec.param(&format!("data{w}"), 0.0) as i64);
        }
        // A corrupt file can ask for more bits than the words it supplied
        // (SeqGenElm.java:74-76).
        let bit_count = bit_count.min(words * 32);
        let mut pins = vec![
            ChipPin::input().clock(), // 0 clock
            ChipPin::output(false),   // 1 Q
        ];
        if has_reset {
            pins.push(ChipPin::input()); // 2 R
        }
        Ok(Self {
            chip: Chip::new(spec, pins).with_sticky_clock(),
            data,
            bit_count,
            bit_position: 0,
            has_play_once: spec.flag(FLAG_PLAY_ONCE),
            has_reset,
        })
    }

    /// Emits the bit at the current position and advances, wrapping to the
    /// start when the sequence runs out unless FLAG_PLAY_ONCE holds it low
    /// (SeqGenElm.java:105-119).
    fn next_bit(&mut self) {
        if self.data.is_empty() || self.bit_count == 0 {
            self.chip.pins[1].value = false;
            return;
        }
        if self.bit_position >= self.bit_count {
            if self.has_play_once {
                self.chip.pins[1].value = false;
                return;
            }
            self.bit_position = 0;
        }
        let word = self.data[self.bit_position / 32];
        self.chip.pins[1].value = word & (1 << (self.bit_position % 32)) != 0;
        self.bit_position += 1;
    }

    fn execute(&mut self) {
        if self.has_reset && self.chip.pins[2].value {
            // The reset rewinds to the first bit; `commit_clock` keeps the
            // clock memory in step so releasing reset with the clock still
            // high does not fire a spurious edge (SeqGenElm.java:122-126).
            self.bit_position = 0;
            self.next_bit();
        } else if self.chip.pins[0].value && !self.chip.last_clock {
            self.next_bit();
        }
    }
}

impl Element for SeqGen {
    fn kind(&self) -> &'static str {
        "seqGen"
    }
    fn base(&self) -> &Base {
        &self.chip.base
    }
    fn base_mut(&mut self) -> &mut Base {
        &mut self.chip.base
    }
    fn post_count(&self) -> usize {
        2 + (self.has_reset as usize)
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

    fn chip_pin_levels(&self) -> Option<Vec<bool>> {
        Some(self.chip.pin_levels())
    }

    fn set_param(&mut self, name: &str, value: f64) -> bool {
        match name {
            "highVoltage" => self.chip.high_voltage = value,
            // The sequence data and the bit count live in the file tokens and
            // need a full rebuild to take effect.
            _ => return false,
        }
        true
    }

    fn reset(&mut self) {
        self.chip.reset();
        self.bit_position = 0;
    }
}
