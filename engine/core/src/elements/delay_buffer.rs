//! Delay buffer: an output voltage source that follows its input a `delay`
//! later (DelayBufferElm.java).

use crate::element::{Base, Element, SimCtx};
use crate::spec::ElementSpec;
use crate::stamp::{Stamper, GROUND};

/// A two-terminal buffer whose output is a voltage source to ground. The
/// output follows the input only once a pending change has been pending for
/// `delay`; an input pulse shorter than the delay never reaches the output,
/// which is the debouncing behaviour the part is for (DelayBufferElm.java:
/// 107-116).
pub struct DelayBuffer {
    base: Base,
    delay: f64,
    threshold: f64,
    high_voltage: f64,
    /// Simulation time at which a pending output flip may happen. Kept from
    /// `reset()`, exactly as upstream has no reset override for it
    /// (DelayBufferElm.java:105).
    delay_end_time: f64,
}

impl DelayBuffer {
    /// The token constructor defaults: `delay` is the only read token, and
    /// `threshold`/`highVoltage` stay on their no-arg defaults unless the file
    /// carries them (DelayBufferElm.java:35-46). The no-arg constructor never
    /// sets `delay`, so a fresh part starts at 0.
    pub fn new(spec: &ElementSpec) -> Self {
        Self {
            base: Base::with_posts(2),
            delay: spec.param("delay", 0.0),
            threshold: spec.param("threshold", 2.5),
            high_voltage: spec.param("highVoltage", 5.0),
            delay_end_time: 0.0,
        }
    }
}

impl Element for DelayBuffer {
    fn kind(&self) -> &'static str {
        "delayBuffer"
    }
    fn base(&self) -> &Base {
        &self.base
    }
    fn base_mut(&mut self) -> &mut Base {
        &mut self.base
    }
    fn post_count(&self) -> usize {
        2
    }
    fn voltage_source_count(&self) -> usize {
        1
    }
    fn voltage_source_nodes(&self, _k: usize) -> (usize, usize) {
        // The output is a source to ground (DelayBufferElm.java:102).
        (GROUND, self.base.nodes[1])
    }
    /// No current path through the input; only the output reaches ground
    /// (DelayBufferElm.java:143-146).
    fn connects(&self, _a: usize, _b: usize) -> bool {
        false
    }

    fn stamp(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        s.voltage_source(GROUND, self.base.nodes[1], self.base.vs_base, 0.0);
    }

    fn do_step(&mut self, ctx: &SimCtx, s: &mut Stamper) {
        let in_state = self.base.volts[0] > self.threshold;
        let mut out_state = self.base.volts[1] > self.threshold;
        if in_state != out_state {
            // The output may follow the input once the pending change has
            // been waiting `delay` (DelayBufferElm.java:110-112).
            if ctx.time >= self.delay_end_time {
                out_state = in_state;
            }
        } else {
            // Input and output agree, so any pending change is re-armed from
            // now (DelayBufferElm.java:113-114).
            self.delay_end_time = ctx.time + self.delay;
        }
        s.voltage_source_value(
            self.base.vs_base,
            if out_state { self.high_voltage } else { 0.0 },
        );
    }

    fn calculate_current(&mut self, _ctx: &SimCtx) {
        self.base.current = self.base.vs_currents[0];
    }

    fn current_into_node(&self, post: usize) -> f64 {
        if post == 1 {
            self.base.current
        } else {
            0.0
        }
    }

    /// A scope on a delay buffer plots its input, not the two-terminal
    /// difference (DelayBufferElm.java:117).
    fn voltage_diff(&self) -> f64 {
        self.base.volts[0]
    }

    fn set_param(&mut self, name: &str, value: f64) -> bool {
        match name {
            "delay" => self.delay = value,
            "threshold" => self.threshold = value,
            "highVoltage" => self.high_voltage = value,
            _ => return false,
        }
        true
    }

    fn reset(&mut self) {
        self.base.reset();
        // No reset override upstream: `delayEndTime` survives a reset
        // (DelayBufferElm.java has none), so only the base clears.
    }
}
