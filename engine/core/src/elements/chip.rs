//! The shared base for the digital chip family: D flip-flop, JK flip-flop,
//! T flip-flop, latch, ring counter and counter (ChipElm.java).
//!
//! All six share the same electrical machinery: a pin table where each output
//! pin is one voltage source to ground, thresholded input reading at
//! `highVoltage / 2`, a per-step `execute()` that updates the output states
//! from the input levels, and a clock edge memory. The engine keeps only the
//! electrical roles of a pin; the geometry (side, row position, label, bubble)
//! lives in the TypeScript registry, which owns all drawing.

use crate::element::Base;
use crate::spec::ElementSpec;
use crate::stamp::{Stamper, GROUND};

/// File flag saying the `highVoltage` token follows the common fields
/// (ChipElm.java:34). The TS writer sets it whenever the high voltage is not
/// the default 5 V, so the token stream stays unambiguous.
pub const FLAG_CUSTOM_VOLTAGE: i64 = 1 << 13;

/// Port-extension flag saying the chip's bit order is upstream's
/// BIT_ORDER_BUS (ChipElm.java:37): every bit-pin group collapses onto one
/// coordinate and its pins carry per-post bus tags. Upstream carries the
/// state only as the XML attribute `bo="2"`, which has no text-format home,
/// so the port parks it in this free chip flag bit.
pub const FLAG_BIT_ORDER_BUS: i64 = 1 << 14;

/// One chip terminal. Only the fields the simulator needs; the pin's drawn
/// side, row and label never cross into the engine.
pub struct ChipPin {
    /// True for an output pin, which the base drives as a voltage source to
    /// ground. Inputs read their level from the node voltage each step.
    pub output: bool,
    /// True for the clock (or latch load) pin. The base commits its level to
    /// `last_clock` at the end of every step so subclasses can detect edges.
    pub clock: bool,
    /// The committed Boolean level. For an output this is the stored output
    /// state, written by the element's `execute()`; for an input it is
    /// re-read from `base.volts` every `start_iteration`.
    pub value: bool,
    /// True when the file format saves this pin's voltage (ChipElm.java:64-67,
    /// :369-371). Outputs carry it so a load restores the output state.
    pub state: bool,
    /// The bus bit index this pin carries at its coordinate, upstream's
    /// `Pin.busZ` (ChipElm.java:708). Only the bus/bus multiplexer sets it;
    /// every other pin is bit 0, the default the engine already gives plain
    /// posts, so `post_bus_z` returns it without the chip knowing the layout.
    pub bus_z: usize,
}

impl ChipPin {
    /// A plain input pin.
    pub fn input() -> Self {
        Self {
            output: false,
            clock: false,
            value: false,
            state: false,
            bus_z: 0,
        }
    }

    /// An output pin, optionally one whose level is saved to the file.
    pub fn output(state: bool) -> Self {
        Self {
            output: true,
            clock: false,
            value: false,
            state,
            bus_z: 0,
        }
    }

    /// Marks the pin as the clock (or latch load) input.
    pub fn clock(mut self) -> Self {
        self.clock = true;
        self
    }
}

/// The shared chip state: the post table, the high logic level, the clock
/// edge memory and the one-step load deferral.
pub struct Chip {
    pub base: Base,
    pub high_voltage: f64,
    /// The clock pin's level from the previous step, the edge detector
    /// (`lastClock`, ChipElm.java:166).
    pub last_clock: bool,
    /// True only for a chip built from a saved circuit. The first `execute()`
    /// is skipped because `base.volts` is still all zeroes, which a D flip-flop
    /// with an active-low reset would otherwise read as a spurious reset
    /// (DFlipFlopElm.java:76-80, JKFlipFlopElm.java:62-66).
    pub just_loaded: bool,
    pub pins: Vec<ChipPin>,
}

impl Chip {
    /// Builds the shared base from a spec: the pins, the high voltage and the
    /// saved output levels in one place, so every element's constructor just
    /// declares its pin table (ChipElm.java:56-68).
    pub fn new(spec: &ElementSpec, pins: Vec<ChipPin>) -> Self {
        let mut chip = Self {
            base: Base::with_posts(pins.len()),
            high_voltage: spec.param("highVoltage", 5.0),
            last_clock: false,
            just_loaded: false,
            pins,
        };
        chip.restore_state(spec);
        chip
    }

    /// Applies the file's saved output levels: each `state` pin's voltage
    /// token becomes its committed value, and the presence of any such token
    /// arms the one-step load deferral (ChipElm.java:61-67).
    fn restore_state(&mut self, spec: &ElementSpec) {
        let mut loaded = false;
        for (i, pin) in self.pins.iter_mut().enumerate() {
            if !pin.state {
                continue;
            }
            if let Some(&v) = spec.params.get(&format!("voltage{i}")) {
                loaded = true;
                pin.value = v > self.high_voltage * 0.5;
            }
        }
        self.just_loaded = loaded;
    }

    /// Post index of the `k`-th output pin, in pin order.
    fn output_pin(&self, k: usize) -> usize {
        self.pins
            .iter()
            .enumerate()
            .filter(|(_, p)| p.output)
            .nth(k)
            .map(|(i, _)| i)
            .unwrap_or_else(|| panic!("chip has no output pin {k}"))
    }

    /// The `k`-th output's committed level.
    pub fn output_value(&self, k: usize) -> bool {
        self.pins[self.output_pin(k)].value
    }

    /// Sets an output pin's stored level, `writeOutput` (ChipElm.java:421-425).
    pub fn write_output(&mut self, pin: usize, value: bool) {
        debug_assert!(self.pins[pin].output, "chip pin {pin} is not an output");
        self.pins[pin].value = value;
    }

    /// Number of output voltage sources, one per output pin.
    pub fn voltage_source_count(&self) -> usize {
        self.pins.iter().filter(|p| p.output).count()
    }

    /// The `k`-th output source spans ground to the output pin's node
    /// (ChipElm.java:306).
    pub fn voltage_source_nodes(&self, k: usize) -> (usize, usize) {
        (GROUND, self.base.nodes[self.output_pin(k)])
    }

    /// Stamps every output source at zero; `do_step` supplies the values, so
    /// the matrix stays constant for a plain chip (ChipElm.java:314-326).
    pub fn stamp(&mut self, s: &mut Stamper) {
        for k in 0..self.voltage_source_count() {
            s.voltage_source(
                GROUND,
                self.base.nodes[self.output_pin(k)],
                self.base.vs_base + k,
                0.0,
            );
        }
    }

    /// Drives every output source to high or zero from the stored pin levels
    /// (ChipElm.java:337-345).
    pub fn do_step(&mut self, s: &mut Stamper) {
        for k in 0..self.voltage_source_count() {
            let v = if self.output_value(k) {
                self.high_voltage
            } else {
                0.0
            };
            s.voltage_source_value(self.base.vs_base + k, v);
        }
    }

    /// Reads each input pin's level from its node voltage, then reports
    /// whether the per-step `execute()` should run. The first step after a
    /// load is skipped: `base.volts` is still all zeroes, so the inputs read
    /// low and an active-low reset would fire spuriously.
    pub fn read_inputs(&mut self) -> bool {
        for (i, pin) in self.pins.iter_mut().enumerate() {
            if !pin.output {
                pin.value = self.base.volts[i] > self.high_voltage * 0.5;
            }
        }
        if self.just_loaded {
            self.just_loaded = false;
            return false;
        }
        true
    }

    /// Moves the clock memory to the clock pin's current level, the shared
    /// `lastClock = pins[clk].value` every subclass's `execute()` ends with.
    pub fn commit_clock(&mut self) {
        for pin in self.pins.iter() {
            if pin.clock {
                self.last_clock = pin.value;
                return;
            }
        }
    }

    /// One output's source current, `getCurrentIntoNode` (ChipElm.java:472-478).
    pub fn current_into_node(&self, post: usize) -> f64 {
        let mut k = 0;
        for (i, pin) in self.pins.iter().enumerate() {
            if !pin.output {
                continue;
            }
            if i == post {
                return self.base.vs_currents[k];
            }
            k += 1;
        }
        0.0
    }

    /// Live values of the saved `voltage{i}` tokens, one per state-carrying
    /// pin, named by pin index exactly as `restore_state` reads them
    /// (ChipElm.java:64-67). An output enable or a combinational chip that
    /// never saves a pin level reports nothing.
    pub fn state_tokens(&self) -> Vec<(String, f64)> {
        self.pins
            .iter()
            .enumerate()
            .filter(|(_, p)| p.state)
            .map(|(i, p)| {
                (
                    format!("voltage{i}"),
                    if p.value { self.high_voltage } else { 0.0 },
                )
            })
            .collect()
    }

    /// The shared reset: every pin level cleared and the clock memory reset
    /// (ChipElm.java:346-354). Subclasses re-assert their default output state
    /// afterwards.
    pub fn reset(&mut self) {
        self.base.reset();
        for pin in self.pins.iter_mut() {
            pin.value = false;
        }
        self.last_clock = false;
    }
}
