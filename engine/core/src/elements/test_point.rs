//! Test point: a one-post sensing instrument with selectable meter modes.

use crate::element::{Base, Element, SimCtx};
use crate::spec::ElementSpec;

/// Meter modes, matching `TestPointElm.java:30-40`. `TP_AVG` was appended
/// after `TP_DUT` to avoid renumbering saved circuits, so its value (10) is
/// not contiguous with the others.
const TP_VOL: i32 = 0;
const TP_RMS: i32 = 1;
const TP_MAX: i32 = 2;
const TP_MIN: i32 = 3;
const TP_P2P: i32 = 4;
const TP_BIN: i32 = 5;
const TP_FRQ: i32 = 6;
const TP_PER: i32 = 7;
const TP_PWI: i32 = 8;
const TP_DUT: i32 = 9;
const TP_AVG: i32 = 10;

/// One-post sensing element (TestPointElm.java:28): it draws no current and
/// measures its single terminal's voltage through the selectable meter modes.
/// The mode's accumulator runs in `step_finished`, exactly the state machine
/// of TestPointElm.java:225-355.
pub struct TestPoint {
    base: Base,
    meter: i32,
    count: f64,
    total: f64,
    total_v: f64,
    rms_v: f64,
    avg_v: f64,
    max_v: f64,
    last_max_v: f64,
    min_v: f64,
    last_min_v: f64,
    binary_level: f64,
    /// Never computed anywhere upstream (TestPointElm.java:373), but it is a
    /// selectable meter mode whose value() must read something.
    frequency: f64,
    period: f64,
    pulse_width: f64,
    duty_cycle: f64,
    selected_value: f64,
    period_start: f64,
    pulse_start: f64,
    increasing_v: bool,
    decreasing_v: bool,
    started: bool,
    zerocount: i32,
}

impl TestPoint {
    pub fn new(spec: &ElementSpec) -> Self {
        Self {
            base: Base::with_posts(1),
            meter: spec.param("meter", 0.0) as i32,
            count: 0.0,
            total: 0.0,
            total_v: 0.0,
            rms_v: 0.0,
            avg_v: 0.0,
            max_v: 0.0,
            last_max_v: 0.0,
            min_v: 0.0,
            last_min_v: 0.0,
            binary_level: 0.0,
            frequency: 0.0,
            period: 0.0,
            pulse_width: 0.0,
            duty_cycle: 0.0,
            selected_value: 0.0,
            period_start: 0.0,
            pulse_start: 0.0,
            increasing_v: true,
            decreasing_v: true,
            started: false,
            zerocount: 0,
        }
    }

    /// Finalises the running RMS and average over the half-cycle just
    /// completed, then zeroes the accumulators for the next one. Ports the
    /// duplicated halves of TestPointElm.java:267-278 and :293-304.
    fn finalise_rms(&mut self) {
        let rms = (self.total / self.count).sqrt();
        self.rms_v = if rms.is_nan() { 0.0 } else { rms };
        let avg = self.total_v / self.count;
        self.avg_v = if avg.is_nan() { 0.0 } else { avg };
        self.count = 0.0;
        self.total = 0.0;
        self.total_v = 0.0;
    }
}

impl Element for TestPoint {
    fn kind(&self) -> &'static str {
        "testPoint"
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
            "meter" => self.meter = value as i32,
            _ => return false,
        }
        true
    }
    fn step_finished(&mut self, ctx: &SimCtx) {
        // The operating-point solve is a DC snapshot, not a transient step:
        // sampling it would pollute the accumulators with a steady-state
        // reading. The test point is a meter, so the DC snapshot is not a
        // reading, matching the ammeter and probe.
        if ctx.dc_analysis {
            return;
        }
        self.count += 1.0;
        let v = self.base.volts[0];
        self.total += v * v;
        self.total_v += v;

        // Binary threshold is a fixed 2.5 V, assuming ~5 V logic levels
        // (TestPointElm.java:233-237).
        self.binary_level = if v < 2.5 { 0.0 } else { 1.0 };

        if !self.started {
            // Prime max/min tracking with the first sample instead of the stale
            // defaults, which could otherwise register a bogus transition on
            // the first step (TestPointElm.java:239-247).
            self.started = true;
            self.max_v = v;
            self.min_v = v;
            self.increasing_v = true;
            self.decreasing_v = false;
            self.period_start = ctx.time;
            self.pulse_start = ctx.time;
        }

        // Rising: track the maximum.
        if v > self.max_v && self.increasing_v {
            self.max_v = v;
            self.increasing_v = true;
            self.decreasing_v = false;
        }
        // Rising-to-falling turn: capture the peak and the cycle timing, then
        // finalise the RMS and average over the completed half-cycle
        // (TestPointElm.java:255-279).
        if v < self.max_v && self.increasing_v {
            self.last_max_v = self.max_v;
            let period_length = ctx.time - self.period_start;
            self.period_start = ctx.time;
            self.period = period_length;
            self.pulse_width = ctx.time - self.pulse_start;
            self.duty_cycle = self.pulse_width / period_length;
            self.min_v = v;
            self.increasing_v = false;
            self.decreasing_v = true;
            self.finalise_rms();
        }
        // Falling: track the minimum.
        if v < self.min_v && self.decreasing_v {
            self.min_v = v;
            self.increasing_v = false;
            self.decreasing_v = true;
        }
        // Falling-to-rising turn: capture the trough and finalise again
        // (TestPointElm.java:286-305).
        if v > self.min_v && self.decreasing_v {
            self.last_min_v = self.min_v;
            self.pulse_start = ctx.time;
            self.max_v = v;
            self.increasing_v = true;
            self.decreasing_v = false;
            self.finalise_rms();
        }

        // A signal parked at zero must not leave a stale reading behind
        // (TestPointElm.java:307-318).
        if v == 0.0 {
            self.zerocount += 1;
            if self.zerocount > 5 {
                self.total = 0.0;
                self.rms_v = 0.0;
                self.avg_v = 0.0;
                self.max_v = 0.0;
                self.min_v = 0.0;
            }
        } else {
            self.zerocount = 0;
        }

        self.selected_value = match self.meter {
            TP_VOL => v,
            TP_RMS => self.rms_v,
            TP_AVG => self.avg_v,
            TP_MAX => self.last_max_v,
            TP_MIN => self.last_min_v,
            TP_P2P => self.last_max_v - self.last_min_v,
            TP_BIN => self.binary_level,
            TP_FRQ => self.frequency,
            TP_PER => self.period,
            TP_PWI => self.pulse_width,
            TP_DUT => self.duty_cycle,
            _ => 0.0, // an out-of-range file meter value
        };
    }
    /// The instrument reading, the selected meter's quantity
    /// (TestPointElm.java:319-353).
    fn value(&self) -> f64 {
        self.selected_value
    }
    fn voltage_diff(&self) -> f64 {
        // One-post elements read out their single node voltage
        // (TestPointElm.java:366).
        self.base.volts[0]
    }
    fn reset(&mut self) {
        self.base.reset();
        self.zerocount = 0;
        self.count = 0.0;
        self.total = 0.0;
        self.total_v = 0.0;
        self.rms_v = 0.0;
        self.avg_v = 0.0;
        self.max_v = 0.0;
        self.last_max_v = 0.0;
        self.min_v = 0.0;
        self.last_min_v = 0.0;
        self.binary_level = 0.0;
        self.period = 0.0;
        self.pulse_width = 0.0;
        self.duty_cycle = 0.0;
        self.selected_value = 0.0;
        self.period_start = 0.0;
        self.pulse_start = 0.0;
        self.increasing_v = true;
        self.decreasing_v = true;
        self.started = false;
    }
}
