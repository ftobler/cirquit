//! Multiplexer: a chip that routes one of its data inputs to the output,
//! chosen by the select bits (MultiplexerElm.java, dump 184).
//!
//! The individual-inputs layout, input mode 0, is the only one the text
//! format can express: upstream stores `inputMode` and `dataBusWidth` only in
//! its XML dump (MultiplexerElm.java:66-81), so every `.txt` file loads as
//! one data input per select combination. The output follows the selected
//! input combinationally; the optional strobe, when high, forces it low, and
//! the optional inverted output mirrors it. FLAG_BUS_SELECT is drawing-only
//! (it moves the select pins onto one shared post), so the engine never reads
//! it: the shared posts merge into one node by geometry anyway.

use crate::element::{Base, Element, SimCtx};
use crate::elements::chip::{Chip, ChipPin};
use crate::spec::ElementSpec;
use crate::stamp::Stamper;

const FLAG_INVERTED_OUTPUT: i64 = 2;
const FLAG_STROBE: i64 = 4;

pub struct Multiplexer {
    chip: Chip,
    /// Number of select bits, the file's one element token (`selectBitCount`,
    /// MultiplexerElm.java:39).
    select_bit_count: usize,
    /// Pin index of the first select pin (MultiplexerElm.java:45).
    select_pin: usize,
    /// Pin index of the output (MultiplexerElm.java:44); the inverted output,
    /// when present, is the next pin.
    output_pin: usize,
    /// Pin index of the strobe input, active high, when FLAG_STROBE adds one.
    strobe_pin: Option<usize>,
    has_inverted_output: bool,
}

impl Multiplexer {
    pub fn new(spec: &ElementSpec) -> Self {
        // The edit dialog rejects fewer than 1 and more than 6 select bits
        // (MultiplexerElm.java:326-334); clamping keeps a hand-edited count
        // from growing the input table past a sane size.
        let select_bit_count = (spec.param("bits", 2.0) as usize).clamp(1, 6);
        let input_count = 1 << select_bit_count;
        let has_inverted_output = spec.flag(FLAG_INVERTED_OUTPUT);
        let has_strobe = spec.flag(FLAG_STROBE);
        // Pin order (setupPins mode 0, MultiplexerElm.java:200-240): the data
        // inputs on the west, then the select bits on the south, then the
        // output on the east, then the inverted output and the strobe. No pin
        // is saved to the file, so none carries `state`.
        let mut pins = Vec::with_capacity(input_count + select_bit_count + 1);
        for _ in 0..input_count {
            pins.push(ChipPin::input());
        }
        let select_pin = input_count;
        for _ in 0..select_bit_count {
            pins.push(ChipPin::input());
        }
        let output_pin = select_pin + select_bit_count;
        pins.push(ChipPin::output(false));
        if has_inverted_output {
            pins.push(ChipPin::output(false));
        }
        let strobe_pin = if has_strobe {
            pins.push(ChipPin::input());
            Some(pins.len() - 1)
        } else {
            None
        };
        Self {
            chip: Chip::new(spec, pins),
            select_bit_count,
            select_pin,
            output_pin,
            strobe_pin,
            has_inverted_output,
        }
    }

    fn execute(&mut self) {
        // The select bits are the little-endian address of the chosen data
        // input (readSelectValue, MultiplexerElm.java:267-273).
        let mut selected = 0;
        for i in 0..self.select_bit_count {
            if self.chip.pins[self.select_pin + i].value {
                selected |= 1 << i;
            }
        }
        // A high strobe forces the output low regardless of the data
        // (MultiplexerElm.java:288-295).
        let mut value = self.chip.pins[selected].value;
        if let Some(strobe) = self.strobe_pin {
            if self.chip.pins[strobe].value {
                value = false;
            }
        }
        self.chip.write_output(self.output_pin, value);
        if self.has_inverted_output {
            self.chip.write_output(self.output_pin + 1, !value);
        }
    }
}

impl Element for Multiplexer {
    fn kind(&self) -> &'static str {
        "multiplexer"
    }
    fn base(&self) -> &Base {
        &self.chip.base
    }
    fn base_mut(&mut self) -> &mut Base {
        &mut self.chip.base
    }
    fn post_count(&self) -> usize {
        self.chip.pins.len()
    }
    fn voltage_source_count(&self) -> usize {
        self.chip.voltage_source_count()
    }
    fn voltage_source_nodes(&self, k: usize) -> (usize, usize) {
        self.chip.voltage_source_nodes(k)
    }
    /// No current path between the posts: only the output sources tie their
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

    fn state_tokens(&self) -> Vec<(String, f64)> {
        self.chip.state_tokens()
    }

    fn current_into_node(&self, post: usize) -> f64 {
        self.chip.current_into_node(post)
    }

    fn set_param(&mut self, name: &str, value: f64) -> bool {
        match name {
            "highVoltage" => self.chip.high_voltage = value,
            // "bits" changes the input and pin counts, which only a full
            // rebuild can reallocate.
            _ => return false,
        }
        true
    }

    fn reset(&mut self) {
        self.chip.reset();
    }

    /// The output's level as a voltage: what the readout shows and a scope on
    /// the Q pin plots. The chip pins never couple, so the default
    /// `V(post0) - V(post1)` would read I0 against S0 instead.
    fn value(&self) -> f64 {
        if self.chip.output_value(0) {
            self.chip.high_voltage
        } else {
            0.0
        }
    }
}
