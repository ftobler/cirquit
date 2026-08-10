//! Register/latch with optional reset, set and input/output enable pins
//! (LatchElm.java, dump 168).

use crate::element::{Base, Element, SimCtx};
use crate::elements::chip::{Chip, ChipPin};
use crate::spec::ElementSpec;
use crate::stamp::{Stamper, GROUND};

const FLAG_NO_EDGE: i64 = 4;
const FLAG_RESET: i64 = 8;
const FLAG_SET: i64 = 16;
/// The enable mode lives in bits 5-6: 0 none, 1 one enable pair, 2 two pairs
/// (LatchElm.java:27-29).
const FLAG_ENABLE_ONE: i64 = 32;
const FLAG_ENABLE_TWO: i64 = 64;
const FLAG_RESET_INVERT: i64 = 128;

pub struct Latch {
    chip: Chip,
    bits: usize,
    has_reset: bool,
    has_set: bool,
    reset_active_low: bool,
    edge_triggered: bool,
    enable_mode: usize,
    load_pin: usize,
    reset_pin: Option<usize>,
    set_pin: Option<usize>,
    ie1_pin: Option<usize>,
    ie2_pin: Option<usize>,
    oe1_pin: Option<usize>,
    oe2_pin: Option<usize>,
    /// The latched output levels (`lastOutputValues`, LatchElm.java:112-118).
    output_values: Vec<bool>,
}

impl Latch {
    pub fn new(spec: &ElementSpec) -> Self {
        // The edit dialog rejects fewer than 2 bits (LatchElm.java:281).
        let bits = (spec.param("bits", 4.0) as usize).max(2);
        let has_reset = spec.flag(FLAG_RESET);
        let has_set = spec.flag(FLAG_SET);
        let reset_active_low = spec.flag(FLAG_RESET_INVERT);
        let edge_triggered = !spec.flag(FLAG_NO_EDGE);
        // Bits 5-6 hold the enable mode; both set (3) is not a valid selection
        // and clamps to 2 (the TS exposes two checkboxes, one per bit).
        let enable_mode = {
            let m =
                (spec.flag(FLAG_ENABLE_ONE) as usize) + 2 * (spec.flag(FLAG_ENABLE_TWO) as usize);
            m.min(2)
        };
        let has_oe = enable_mode > 0;

        let mut pins: Vec<ChipPin> = Vec::with_capacity(2 * bits + 1 + 2 * enable_mode);
        // Bit inputs on the west, bit outputs on the east, in pin order
        // (makeBitPins, LatchElm.java:76-77). With output enable the output
        // posts are not voltage sources; each source hides behind an internal
        // node and a per-step switch resistor instead.
        for _ in 0..bits {
            pins.push(ChipPin::input());
        }
        for _ in 0..bits {
            pins.push(ChipPin::output(!has_oe));
        }
        let mut idx = 2 * bits;
        pins.push(ChipPin::input().clock());
        let load_pin = idx;
        idx += 1;
        let reset_pin = if has_reset {
            pins.push(ChipPin::input());
            idx += 1;
            Some(idx - 1)
        } else {
            None
        };
        let set_pin = if has_set {
            pins.push(ChipPin::input());
            idx += 1;
            Some(idx - 1)
        } else {
            None
        };
        // The input and output enable pins are active low (their labels carry
        // an overline, LatchElm.java:91-105).
        let ie1_pin = if enable_mode >= 1 {
            pins.push(ChipPin::input());
            idx += 1;
            Some(idx - 1)
        } else {
            None
        };
        let ie2_pin = if enable_mode >= 2 {
            pins.push(ChipPin::input());
            idx += 1;
            Some(idx - 1)
        } else {
            None
        };
        let oe1_pin = if enable_mode >= 1 {
            pins.push(ChipPin::input());
            idx += 1;
            Some(idx - 1)
        } else {
            None
        };
        let oe2_pin = if enable_mode >= 2 {
            pins.push(ChipPin::input());
            Some(idx)
        } else {
            None
        };

        let mut latch = Self {
            chip: Chip::new(spec, pins),
            bits,
            has_reset,
            has_set,
            reset_active_low,
            edge_triggered,
            enable_mode,
            load_pin,
            reset_pin,
            set_pin,
            ie1_pin,
            ie2_pin,
            oe1_pin,
            oe2_pin,
            output_values: vec![false; bits],
        };
        // The saved output levels restore into `outputValues` too, which is
        // what the step logic reads (restoreOutputValues, LatchElm.java:120-124).
        for i in 0..bits {
            latch.output_values[i] = latch.chip.pins[bits + i].value;
        }
        latch
    }

    fn has_output_enable(&self) -> bool {
        self.enable_mode > 0
    }

    /// The load logic shared by `execute()` and the output-enable path
    /// (doLoad, LatchElm.java:145-167). Set wins over reset, reset wins over
    /// the clock, and the clock samples the inputs on a rising edge (or at any
    /// high level for a plain latch).
    fn do_load(&mut self) {
        if let Some(sp) = self.set_pin {
            if self.chip.pins[sp].value {
                self.output_values.fill(true);
                return;
            }
        }
        if let Some(rp) = self.reset_pin {
            if self.chip.pins[rp].value != self.reset_active_low {
                self.output_values.fill(false);
                return;
            }
        }
        let mut input_enabled = true;
        if let Some(p) = self.ie1_pin {
            if self.chip.pins[p].value {
                input_enabled = false;
            }
        }
        if let Some(p) = self.ie2_pin {
            if self.chip.pins[p].value {
                input_enabled = false;
            }
        }
        let load =
            self.chip.pins[self.load_pin].value && (!self.edge_triggered || !self.chip.last_clock);
        if input_enabled && load {
            for i in 0..self.bits {
                self.output_values[i] = self.chip.pins[i].value;
            }
        }
    }

    fn execute(&mut self) {
        self.do_load();
        for i in 0..self.bits {
            self.chip.pins[self.bits + i].value = self.output_values[i];
        }
    }
}

impl Element for Latch {
    fn kind(&self) -> &'static str {
        "latch"
    }
    fn base(&self) -> &Base {
        &self.chip.base
    }
    fn base_mut(&mut self) -> &mut Base {
        &mut self.chip.base
    }
    fn post_count(&self) -> usize {
        2 * self.bits
            + 1
            + (self.has_reset as usize)
            + (self.has_set as usize)
            + 2 * self.enable_mode
    }
    /// One extra node per output bit, holding the voltage source while the
    /// output enable is present (getInternalNodeCount, LatchElm.java:218-220).
    fn internal_node_count(&self) -> usize {
        if self.has_output_enable() {
            self.bits
        } else {
            0
        }
    }
    fn voltage_source_count(&self) -> usize {
        self.bits
    }
    fn voltage_source_nodes(&self, k: usize) -> (usize, usize) {
        if self.has_output_enable() {
            (GROUND, self.base().nodes[self.post_count() + k])
        } else {
            self.chip.voltage_source_nodes(k)
        }
    }
    fn nonlinear(&self) -> bool {
        self.has_output_enable()
    }
    fn connects(&self, _a: usize, _b: usize) -> bool {
        false
    }
    /// The enable switch resistors couple each internal node to its output
    /// post, so they must share a closure (getMatrixConnection, LatchElm.java:
    /// 233-240).
    fn matrix_connects(&self, a: usize, b: usize) -> bool {
        if !self.has_output_enable() {
            return false;
        }
        for k in 0..self.bits {
            let (internal, out) = (self.post_count() + k, self.bits + k);
            if (a == internal && b == out) || (a == out && b == internal) {
                return true;
            }
        }
        false
    }

    fn stamp(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        if !self.has_output_enable() {
            self.chip.stamp(s);
            return;
        }
        // With output enable the sources sit on the internal nodes and the
        // output posts follow through the per-step switch resistors
        // (LatchElm.java:204-214).
        for k in 0..self.bits {
            s.voltage_source(
                GROUND,
                self.base().nodes[self.post_count() + k],
                self.base().vs_base + k,
                0.0,
            );
        }
    }

    fn start_iteration(&mut self, _ctx: &SimCtx) {
        self.chip.read_inputs();
        // With output enable the custom startIteration stops at doLoad and
        // `do_step` drives the outputs; without it execute() also mirrors the
        // levels onto the output pins (LatchElm.java:169-180).
        if self.has_output_enable() {
            self.do_load();
        } else {
            self.execute();
        }
        self.chip.commit_clock();
    }

    fn do_step(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        if !self.has_output_enable() {
            self.chip.do_step(s);
            return;
        }
        // The output enable pins are active low: any high one disables the
        // outputs, which then hang off a 100 M resistor to ground instead of
        // the 1 ohm to the driven internal node (LatchElm.java:188-201).
        let mut output_enabled = true;
        if let Some(p) = self.oe1_pin {
            if self.chip.pins[p].value {
                output_enabled = false;
            }
        }
        if let Some(p) = self.oe2_pin {
            if self.chip.pins[p].value {
                output_enabled = false;
            }
        }
        for k in 0..self.bits {
            let v = if self.output_values[k] {
                self.chip.high_voltage
            } else {
                0.0
            };
            s.voltage_source_value(self.base().vs_base + k, v);
            let internal = self.base().nodes[self.post_count() + k];
            let out = self.base().nodes[self.bits + k];
            if output_enabled {
                s.resistor(internal, out, 1.0);
            } else {
                s.resistor(out, GROUND, 1e8);
            }
        }
    }

    fn calculate_current(&mut self, _ctx: &SimCtx) {
        self.chip.base.current = 0.0;
    }

    fn state_tokens(&self) -> Vec<(String, f64)> {
        self.chip.state_tokens()
    }

    fn current_into_node(&self, post: usize) -> f64 {
        // With output enable the sources sit on internal nodes, not posts, so
        // no post current is reported, matching upstream's never-set pin
        // currents. Without it the plain chip mapping applies.
        if self.has_output_enable() {
            0.0
        } else {
            self.chip.current_into_node(post)
        }
    }

    fn set_param(&mut self, name: &str, value: f64) -> bool {
        match name {
            "highVoltage" => self.chip.high_voltage = value,
            // "bits" and "enableMode" change the pin and internal-node counts,
            // which only a full rebuild can reallocate.
            _ => return false,
        }
        true
    }

    fn reset(&mut self) {
        self.chip.reset();
        self.output_values.fill(false);
    }
}
