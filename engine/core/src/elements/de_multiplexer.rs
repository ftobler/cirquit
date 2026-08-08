//! Demultiplexer: routes one data input to the output chosen by the select
//! bits (DeMultiplexerElm.java, dump 185).
//!
//! A ChipElm subclass with three pin groups: the individual outputs on the
//! east, the select bits on the south, then the single data input on the west,
//! in that post order. Every output is one voltage source to ground, the
//! shared chip machinery drives them from the committed pin levels, and
//! `execute()` re-routes each step: all outputs idle, then the selected one
//! copies the data input. Upstream's bus-output modes are XML-only, so the
//! text format is always the individual-output mode implemented here.

use crate::element::{Base, Element, SimCtx};
use crate::elements::chip::{Chip, ChipPin};
use crate::spec::ElementSpec;
use crate::stamp::Stamper;

/// Inactive outputs idle high instead of low, the 74139 behaviour
/// (DeMultiplexerElm.java:29). An electrical choice: it flips which outputs
/// `execute()` drives high before the data copy lands on the selected one.
const FLAG_INVERT_OUTPUTS: i64 = 16;

pub struct DeMultiplexer {
    chip: Chip,
    /// Select-bit count from the file token; 0 becomes the default 2
    /// (DeMultiplexerElm.java:82-83).
    select_bit_count: usize,
    /// Output count, `1 << select_bit_count`.
    output_count: usize,
    /// Index of the first select pin in the pin table.
    select_pin: usize,
    /// Index of the single data input pin.
    input_pin: usize,
    /// Inactive outputs idle high under FLAG_INVERT_OUTPUTS.
    invert_outputs: bool,
}

impl DeMultiplexer {
    pub fn new(spec: &ElementSpec) -> Self {
        // The token constructor turns a missing or zero count into 2; the edit
        // dialog caps it at 6, which is 64 outputs (DeMultiplexerElm.java:82-83,
        // :255-260). The clamp keeps a huge file token from allocating 2^n pins.
        let mut select_bit_count = spec.param("selectBits", 2.0).round() as usize;
        if select_bit_count == 0 {
            select_bit_count = 2;
        }
        let select_bit_count = select_bit_count.min(6);
        let output_count = 1 << select_bit_count;
        let invert_outputs = spec.flag(FLAG_INVERT_OUTPUTS);
        // Pin order, the individual-output mode: the outputs, then the select
        // bits, then the data input (DeMultiplexerElm.java:162-191). No pin
        // carries saved state, so no voltage tokens follow the select count.
        let mut pins = Vec::with_capacity(1 + select_bit_count + output_count);
        for _ in 0..output_count {
            pins.push(ChipPin::output(false));
        }
        let select_pin = pins.len();
        for _ in 0..select_bit_count {
            pins.push(ChipPin::input());
        }
        let input_pin = pins.len();
        pins.push(ChipPin::input());
        Self {
            chip: Chip::new(spec, pins),
            select_bit_count,
            output_count,
            select_pin,
            input_pin,
            invert_outputs,
        }
    }

    fn execute(&mut self) {
        // The select value is the bits LSB first (readSelectValue,
        // DeMultiplexerElm.java:210-216).
        let mut selected = 0;
        for i in 0..self.select_bit_count {
            if self.chip.pins[self.select_pin + i].value {
                selected |= 1 << i;
            }
        }
        // Every output idles, then the selected one carries the data input
        // (DeMultiplexerElm.java:218-228).
        for i in 0..self.output_count {
            self.chip.write_output(i, self.invert_outputs);
        }
        self.chip
            .write_output(selected, self.chip.pins[self.input_pin].value);
    }
}

impl Element for DeMultiplexer {
    fn kind(&self) -> &'static str {
        "deMultiplexer"
    }
    fn base(&self) -> &Base {
        &self.chip.base
    }
    fn base_mut(&mut self) -> &mut Base {
        &mut self.chip.base
    }
    fn post_count(&self) -> usize {
        1 + self.select_bit_count + self.output_count
    }
    fn voltage_source_count(&self) -> usize {
        self.chip.voltage_source_count()
    }
    fn voltage_source_nodes(&self, k: usize) -> (usize, usize) {
        self.chip.voltage_source_nodes(k)
    }
    /// No current path between posts: only the outputs' sources tie their
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
            // "selectBits" changes the output count, which needs a full rebuild.
            _ => return false,
        }
        true
    }

    fn reset(&mut self) {
        self.chip.reset();
    }
}
