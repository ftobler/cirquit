//! Analog multiplexer (AnalogMuxElm.java, dump 432): a chip whose output Z
//! connects to one of `2^selectBitCount` analog inputs through `r_on`, the
//! others through `r_off` or, under FLAG_PULLDOWN, to ground so unselected
//! inputs never float. The select pins read against the `threshold` token.
//! Purely resistive: no voltage sources, and every connection is a resistor
//! re-stamped each step because the selected input can change.
//!
//! The file line carries `selectBitCount r_on r_off threshold` after the
//! common chip fields (AnalogMuxElm.java:42-56), always written by the port
//! because upstream's own `dump()` does too (AnalogMuxElm.java:63-65).

use crate::element::{Base, Element, SimCtx};
use crate::spec::ElementSpec;
use crate::stamp::{Stamper, GROUND};

/// File flag saying the unselected inputs pull down to ground through `r_off`
/// instead of coupling to the output (AnalogMuxElm.java:26).
const FLAG_PULLDOWN: i64 = 2;

const DEF_R_ON: f64 = 20.0;
const DEF_R_OFF: f64 = 1e10;
const DEF_THRESHOLD: f64 = 2.5;

pub struct AnalogMux {
    base: Base,
    select_bit_count: usize,
    input_count: usize,
    r_on: f64,
    r_off: f64,
    threshold: f64,
    pulldown: bool,
    /// Current each pin exchanges with its node, indexed by post: the input
    /// pins drain their resistor current, the output pin delivers the sum, the
    /// select pins carry none. Kept for `current_into_node`, which runs after
    /// the solve.
    currents: Vec<f64>,
}

impl AnalogMux {
    pub fn new(spec: &ElementSpec) -> Self {
        // The edit dialog limits the count to 1..6 (AnalogMuxElm.java:202),
        // which caps the input count at 64.
        let select_bit_count = (spec.param("selectBitCount", 2.0) as usize).clamp(1, 6);
        let input_count = 1 << select_bit_count;
        let pulldown = spec.flag(FLAG_PULLDOWN);
        Self {
            base: Base::with_posts(input_count + select_bit_count + 1),
            select_bit_count,
            input_count,
            r_on: spec.param("r_on", DEF_R_ON),
            r_off: spec.param("r_off", DEF_R_OFF),
            threshold: spec.param("threshold", DEF_THRESHOLD),
            pulldown,
            currents: vec![0.0; input_count + select_bit_count + 1],
        }
    }

    fn output_pin(&self) -> usize {
        self.input_count + self.select_bit_count
    }

    fn is_select(&self, post: usize) -> bool {
        post >= self.input_count && post < self.output_pin()
    }

    /// Reads the select pins LSB first (AnalogMuxElm.java:119-122).
    fn selected_input(&self) -> usize {
        let mut selected = 0usize;
        for i in 0..self.select_bit_count {
            if self.base.volts[self.input_count + i] > self.threshold {
                selected |= 1 << i;
            }
        }
        selected
    }
}

impl Element for AnalogMux {
    fn kind(&self) -> &'static str {
        "analogMux"
    }
    fn base(&self) -> &Base {
        &self.base
    }
    fn base_mut(&mut self) -> &mut Base {
        &mut self.base
    }
    fn post_count(&self) -> usize {
        self.input_count + self.select_bit_count + 1
    }
    /// The connection resistors change every step, so the element is
    /// nonlinear (nonLinear, AnalogMuxElm.java:60).
    fn nonlinear(&self) -> bool {
        true
    }
    /// Select pins never couple to anything; every signal pin connects to
    /// every other for matrix topology purposes (getConnection,
    /// AnalogMuxElm.java:163-170).
    fn connects(&self, a: usize, b: usize) -> bool {
        !self.is_select(a) && !self.is_select(b)
    }
    fn stamp(&mut self, _ctx: &SimCtx, _s: &mut Stamper) {
        // Upstream only marks the signal nodes nonlinear here; the element's
        // own `nonlinear()` already makes its closure re-stamp every step, so
        // the constant stamps (the pulldown choice changes with the select
        // pins, so there are none) live entirely in `do_step`.
    }
    fn do_step(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        let selected = self.selected_input();
        let output = self.base.nodes[self.output_pin()];
        for i in 0..self.input_count {
            let input = self.base.nodes[i];
            if i == selected {
                s.resistor(input, output, self.r_on);
            } else if self.pulldown {
                // Better conditioned than coupling to the output, and the
                // unselected input reads zero instead of tracking Z
                // (AnalogMuxElm.java:124-135).
                s.resistor(input, GROUND, self.r_off);
            } else {
                s.resistor(input, output, self.r_off);
            }
        }
    }
    fn calculate_current(&mut self, _ctx: &SimCtx) {
        let selected = self.selected_input();
        let output = self.output_pin();
        let mut output_current = 0.0;
        for i in 0..self.input_count {
            if i == selected {
                // The selected input reports its resistor current negated, and
                // that current sums into the output pin's delivered current
                // (AnalogMuxElm.java:145-148).
                let c = (self.base.volts[i] - self.base.volts[output]) / self.r_on;
                self.currents[i] = -c;
                output_current += c;
            } else if self.pulldown {
                // The pulldown drains straight to ground and never reaches the
                // output (AnalogMuxElm.java:149-151).
                self.currents[i] = -self.base.volts[i] / self.r_off;
            } else {
                let c = (self.base.volts[i] - self.base.volts[output]) / self.r_off;
                self.currents[i] = -c;
                output_current += c;
            }
        }
        self.currents[output] = output_current;
        for i in 0..self.select_bit_count {
            self.currents[self.input_count + i] = 0.0;
        }
        self.base.current = output_current;
    }
    fn current_into_node(&self, post: usize) -> f64 {
        self.currents[post]
    }
    fn set_param(&mut self, name: &str, value: f64) -> bool {
        match name {
            "r_on" if value > 0.0 => self.r_on = value,
            "r_off" if value > 0.0 => self.r_off = value,
            "threshold" => self.threshold = value,
            // "selectBitCount" changes the post count, which only a full
            // rebuild can reallocate.
            _ => return false,
        }
        true
    }
    fn reset(&mut self) {
        self.base.reset();
        self.currents.iter_mut().for_each(|c| *c = 0.0);
    }
}
