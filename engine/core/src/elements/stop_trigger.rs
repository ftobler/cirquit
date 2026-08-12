//! Stop trigger: pauses the simulation when its terminal crosses a threshold.

use crate::element::{Base, Element, SimCtx};
use crate::spec::ElementSpec;

/// One-post sensing element (StopTriggerElm.java:68-69): it draws no current
/// and watches its single terminal for a threshold crossing. After `count`
/// rising edges (type 0: `>=`, type 1: `<=`) it arms, and once `delay` seconds
/// have passed it reports stopped through [`Element::display_state`]
/// (StopTriggerElm.java:91-110). Upstream pauses the simulator directly with
/// `app.setSimRunning(false)`; the engine cannot pause itself, so the latch
/// stays set until `reset()` or the dedicated re-arm, and the frame loop
/// polls it.
pub struct StopTrigger {
    base: Base,
    trigger_voltage: f64,
    trigger_type: i32,
    delay: f64,
    count: i32,
    triggered: bool,
    condition_active: bool,
    trigger_count: i32,
    trigger_time: f64,
    stopped: bool,
}

impl StopTrigger {
    pub fn new(spec: &ElementSpec) -> Self {
        Self {
            base: Base::with_posts(1),
            trigger_voltage: spec.param("triggerVoltage", 1.0),
            trigger_type: spec.param("type", 0.0) as i32,
            delay: spec.param("delay", 0.0),
            count: (spec.param("count", 1.0) as i32).max(1),
            triggered: false,
            condition_active: false,
            trigger_count: 0,
            trigger_time: 0.0,
            stopped: false,
        }
    }
}

impl Element for StopTrigger {
    fn kind(&self) -> &'static str {
        "stopTrigger"
    }
    fn base(&self) -> &Base {
        &self.base
    }
    fn base_mut(&mut self) -> &mut Base {
        &mut self.base
    }
    fn post_count(&self) -> usize {
        1
    }
    /// An ideal meter has infinite impedance, so it does not couple its
    /// terminal to anything.
    fn connects(&self, _a: usize, _b: usize) -> bool {
        false
    }
    fn calculate_current(&mut self, _ctx: &SimCtx) {
        self.base.current = 0.0;
    }
    fn set_param(&mut self, name: &str, value: f64) -> bool {
        match name {
            "triggerVoltage" => self.trigger_voltage = value,
            "type" => self.trigger_type = value as i32,
            "delay" => self.delay = value,
            "count" => self.count = (value as i32).max(1),
            _ => return false,
        }
        true
    }
    fn step_finished(&mut self, ctx: &SimCtx) {
        // The operating-point solve is a DC snapshot, not a transient step:
        // a triggered edge must not fire on the pre-charged snapshot.
        if ctx.dc_analysis {
            return;
        }
        let v = self.base.volts[0];
        let condition = (self.trigger_type == 0 && v >= self.trigger_voltage)
            || (self.trigger_type == 1 && v <= self.trigger_voltage);
        if !self.condition_active && condition {
            self.condition_active = true;
            self.trigger_count += 1;
            if !self.triggered && self.trigger_count >= self.count {
                self.triggered = true;
                self.trigger_time = ctx.time;
            }
        }
        if self.condition_active && !condition {
            self.condition_active = false;
        }
        if self.triggered && ctx.time >= self.trigger_time + self.delay {
            self.triggered = false;
            self.trigger_count = 0;
            self.stopped = true;
        }
    }
    fn voltage_diff(&self) -> f64 {
        // One-post elements read out their single node voltage
        // (StopTriggerElm.java:112).
        self.base.volts[0]
    }
    /// The stop latch: 1 while stopped, 0 otherwise. The frontend pauses on
    /// this and the element draws highlighted, the two consumers of the one
    /// scalar.
    fn display_state(&self) -> f64 {
        if self.stopped {
            1.0
        } else {
            0.0
        }
    }
    fn reset(&mut self) {
        self.base.reset();
        self.triggered = false;
        self.condition_active = false;
        self.trigger_count = 0;
        self.trigger_time = 0.0;
        self.stopped = false;
    }
    /// Re-arms to the waiting state without rewinding time, what upstream's
    /// next stepFinished does when the sim resumes. Stepping must never clear
    /// the latch (the frame loop reads it to pause), so it clears only here
    /// and in `reset`.
    fn clear_stop(&mut self) {
        self.stopped = false;
        self.triggered = false;
        self.trigger_count = 0;
        self.condition_active = false;
    }
}
