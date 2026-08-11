//! Monostable one-shot (MonostableElm.java, dump 194). A rising edge on the
//! trigger drives Q high and Qbar low for `delay` seconds, then returns. A new
//! rising edge while the pulse is in flight restarts it only when the
//! retriggerable token says so; otherwise it is ignored until the pulse
//! expires.

use crate::element::{Base, Element, SimCtx};
use crate::elements::chip::{Chip, ChipPin};
use crate::spec::ElementSpec;
use crate::stamp::Stamper;

pub struct Monostable {
    chip: Chip,
    retriggerable: bool,
    delay: f64,
    /// The trigger pin's level from the previous step, the rising-edge
    /// detector (`prevInputValue`, MonostableElm.java:28).
    prev_input_value: bool,
    /// True while the one-shot is running (`triggered`, MonostableElm.java:30).
    triggered: bool,
    /// The simulation time the running pulse started
    /// (`lastRisingEdge`, MonostableElm.java:31).
    last_rising_edge: f64,
}

impl Monostable {
    pub fn new(spec: &ElementSpec) -> Self {
        let mut m = Self {
            chip: Chip::new(
                spec,
                vec![
                    ChipPin::input().clock(), // 0 trigger
                    ChipPin::output(false),   // 1 Q
                    ChipPin::output(false),   // 2 Qbar
                ],
            ),
            retriggerable: spec.param("retriggerable", 0.0) != 0.0,
            delay: spec.param("delay", 0.01),
            prev_input_value: false,
            triggered: false,
            last_rising_edge: 0.0,
        };
        // Qbar rests high (MonostableElm.java:61).
        m.chip.pins[2].value = true;
        m
    }

    fn execute(&mut self, t: f64) {
        // A rising trigger starts the one-shot; a retriggerable one restarts an
        // in-flight pulse (MonostableElm.java:70-75).
        if self.chip.pins[0].value
            && self.prev_input_value != self.chip.pins[0].value
            && (self.retriggerable || !self.triggered)
        {
            self.last_rising_edge = t;
            self.chip.pins[1].value = true;
            self.chip.pins[2].value = false;
            self.triggered = true;
        }
        // The pulse expires once the delay has passed (MonostableElm.java:77-81).
        if self.triggered && t > self.last_rising_edge + self.delay {
            self.chip.pins[1].value = false;
            self.chip.pins[2].value = true;
            self.triggered = false;
        }
        self.prev_input_value = self.chip.pins[0].value;
    }
}

impl Element for Monostable {
    fn kind(&self) -> &'static str {
        "monostable"
    }
    fn base(&self) -> &Base {
        &self.chip.base
    }
    fn base_mut(&mut self) -> &mut Base {
        &mut self.chip.base
    }
    fn post_count(&self) -> usize {
        3
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

    fn start_iteration(&mut self, ctx: &SimCtx) {
        if self.chip.read_inputs() {
            self.execute(ctx.time);
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
            "retriggerable" => self.retriggerable = value != 0.0,
            "delay" => self.delay = value,
            _ => return false,
        }
        true
    }

    fn reset(&mut self) {
        self.chip.reset();
        // A reset restores the resting state: Qbar high, no pulse running
        // (MonostableElm.java:59-63).
        self.chip.pins[2].value = true;
        self.triggered = false;
        self.prev_input_value = false;
    }
}
