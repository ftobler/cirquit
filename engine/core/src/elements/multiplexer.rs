//! Multiplexer: a chip that routes one of its data inputs to the output,
//! chosen by the select bits (MultiplexerElm.java, dump 184).
//!
//! Input mode 0 (the individual-inputs layout) is the one the text format
//! expresses with a single element token: one data input per select
//! combination, one single-bit output. Input mode 2 (BUS_BUS) is upstream's
//! bus-input/bus-output layout, where the west side is `outputCount *
//! dataBusWidth` input pins grouped into `outputCount` buses of `dataBusWidth`
//! bits and the east side is one `dataBusWidth`-wide output bus; the engine
//! models it faithfully (MultiplexerElm.java:87-150, :278-287). Input mode 1
//! (BUS_BIT) is deferred: it has no text-format home and no corpus user, so
//! the port falls back to mode 0 and the converter parks a trace comment.
//!
//! The optional strobe, when high, forces the output low, and the optional
//! inverted output mirrors it. FLAG_BUS_SELECT is drawing-only (it moves the
//! select pins onto one shared post), so the engine never reads it: the shared
//! posts merge into one node by geometry anyway.

use crate::element::{Base, Element, SimCtx};
use crate::elements::chip::{Chip, ChipPin};
use crate::spec::ElementSpec;
use crate::stamp::Stamper;

const FLAG_INVERTED_OUTPUT: i64 = 2;
const FLAG_STROBE: i64 = 4;

/// Upstream's INPUT_MODE_BUS_BUS (MultiplexerElm.java:37), the one faithful
/// bus/bus mode this port implements (mode 1 is deferred).
const INPUT_MODE_BUS_BUS: usize = 2;

pub struct Multiplexer {
    chip: Chip,
    /// The input mode: 0 individual, 2 bus/bus. Mode 1 is deferred and the
    /// engine treats it as mode 0 (MultiplexerElm.java:35-37).
    input_mode: usize,
    /// Number of bus bits per input/output group in bus/bus mode
    /// (`dataBusWidth`, MultiplexerElm.java:41), modelled generally.
    data_bus_width: usize,
    /// Number of select bits, the file's one element token (`selectBitCount`,
    /// MultiplexerElm.java:39).
    select_bit_count: usize,
    /// Pin index of the first select pin (MultiplexerElm.java:45).
    select_pin: usize,
    /// Pin index of the first output bit (MultiplexerElm.java:44); in bus/bus
    /// mode it is the head of the `dataBusWidth` output bus, and the inverted
    /// bus (when present) starts `dataBusWidth` later.
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
        let output_count = 1 << select_bit_count;
        let input_mode = (spec.param("inputMode", 0.0) as usize).clamp(0, 2);
        // dataBusWidth defaults to 4, the same value upstream writes only when
        // it differs from 4 (MultiplexerElm.java:41, :71-72).
        let data_bus_width = (spec.param("dataBusWidth", 4.0) as usize).clamp(1, 32);
        let has_inverted_output = spec.flag(FLAG_INVERTED_OUTPUT);
        let has_strobe = spec.flag(FLAG_STROBE);
        // The bus/bus pin order (setupPins INPUT_MODE_BUS_BUS,
        // MultiplexerElm.java:87-150): the `outputCount * dataBusWidth` input
        // pins flat as `g * dataBusWidth + i` (group `g`, bit `i`), each a
        // bus pin tagged `busZ = i`; the select bits; the `dataBusWidth`
        // output bus; the optional inverted output bus; the optional strobe.
        let mut pins: Vec<ChipPin> = Vec::new();
        let (select_pin, output_pin);
        if input_mode == INPUT_MODE_BUS_BUS {
            // `outputCount` buses of `dataBusWidth` bits each, flat as
            // `g * dataBusWidth + i`; every bit of group `g` shares the west
            // coordinate and carries its own bus index (MultiplexerElm.java:99-106).
            for _g in 0..output_count {
                for i in 0..data_bus_width {
                    let mut p = ChipPin::input();
                    p.bus_z = i;
                    pins.push(p);
                }
            }
            let input_pin_count = output_count * data_bus_width;
            select_pin = input_pin_count;
            for _ in 0..select_bit_count {
                pins.push(ChipPin::input());
            }
            output_pin = select_pin + select_bit_count;
            for i in 0..data_bus_width {
                let mut p = ChipPin::output(false);
                p.bus_z = i;
                pins.push(p);
            }
            if has_inverted_output {
                for i in 0..data_bus_width {
                    let mut p = ChipPin::output(false);
                    p.bus_z = i;
                    pins.push(p);
                }
            }
            if has_strobe {
                pins.push(ChipPin::input());
            }
        } else {
            // Mode 0 (and the deferred mode 1): one data input per select
            // combination, one single-bit output, the original behaviour
            // (MultiplexerElm.java:200-240).
            let input_count = output_count;
            for _ in 0..input_count {
                pins.push(ChipPin::input());
            }
            select_pin = input_count;
            for _ in 0..select_bit_count {
                pins.push(ChipPin::input());
            }
            output_pin = select_pin + select_bit_count;
            pins.push(ChipPin::output(false));
            if has_inverted_output {
                pins.push(ChipPin::output(false));
            }
            if has_strobe {
                pins.push(ChipPin::input());
            }
        }
        let strobe_pin = if has_strobe {
            Some(pins.len() - 1)
        } else {
            None
        };
        Self {
            chip: Chip::new(spec, pins),
            input_mode,
            data_bus_width,
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
        if self.input_mode == INPUT_MODE_BUS_BUS {
            // BUS_BUS: copy the chosen input bus to the output bus bit by bit
            // (MultiplexerElm.java:278-287). A high strobe forces the bus low.
            let strobed = match self.strobe_pin {
                Some(s) => self.chip.pins[s].value,
                None => false,
            };
            for i in 0..self.data_bus_width {
                let val = if strobed {
                    false
                } else {
                    self.chip.pins[selected * self.data_bus_width + i].value
                };
                self.chip.write_output(self.output_pin + i, val);
            }
            if self.has_inverted_output {
                for i in 0..self.data_bus_width {
                    self.chip.write_output(
                        self.output_pin + self.data_bus_width + i,
                        !self.chip.pins[self.output_pin + i].value,
                    );
                }
            }
        } else {
            // Mode 0 and the deferred mode 1 share the single-input logic.
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

    /// The bus bit index at post `p`, so a bus/bus input or output pin merges
    /// into its own node by coordinate and bit (upstream's `Point.z`,
    /// ChipElm.java:708).
    fn bus_z_of(&self, p: usize) -> usize {
        self.chip.pins[p].bus_z
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
    /// The bus bit index at each post, so bus/bus input and output pins merge
    /// into their own node by coordinate and bit (ChipElm.java:708).
    fn post_bus_z(&self, post: usize) -> usize {
        self.bus_z_of(post)
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

    /// The output as a voltage: in bus/bus mode the whole `dataBusWidth` bus
    /// reassembled into one integer (so a Q scope plots the routed byte), in
    /// mode 0 the single output bit's level. The chip pins never couple, so
    /// the default `V(post0) - V(post1)` would read I0 against S0 instead.
    fn value(&self) -> f64 {
        if self.input_mode == INPUT_MODE_BUS_BUS {
            let mut word = 0;
            for i in 0..self.data_bus_width {
                if self.chip.pins[self.output_pin + i].value {
                    word |= 1 << i;
                }
            }
            return word as f64;
        }
        if self.chip.output_value(0) {
            self.chip.high_voltage
        } else {
            0.0
        }
    }
}
