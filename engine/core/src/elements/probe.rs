//! Two-terminal voltmeter with an optional series resistance.

use crate::element::{Base, Element, SimCtx};
use crate::spec::ElementSpec;
use crate::stamp::Stamper;

/// Selectable meter modes, matching `ProbeElm.java:36-46`. `TP_AVG` was
/// appended after `TP_DUT` to avoid renumbering saved circuits, so its value
/// (10) is not contiguous with the others.
const TP_VOL: i32 = 0;
const TP_RMS: i32 = 1;
const TP_MAX: i32 = 2;
const TP_MIN: i32 = 3;
const TP_P2P: i32 = 4;
const TP_BIN: i32 = 5;
const TP_AVG: i32 = 10;

/// Two-terminal voltmeter with an optional series resistance.
///
/// Resistance 0 means "infinite" (an ideal meter), matching the file format
/// where loaded probes default to 0 and new ones to 1e7.
pub struct Probe {
    base: Base,
    meter: i32,
    resistance: f64,
    rms_v: f64,
    total: f64,
    count: f64,
    avg_v: f64,
    total_v: f64,
    binary_level: f64,
    zerocount: i32,
    max_v: f64,
    last_max_v: f64,
    min_v: f64,
    last_min_v: f64,
    /// Tracked for completeness but not selectable: upstream's TP_FRQ..TP_DUT
    /// are absent from `meterChoices()` (ProbeElm.java:444-446), and frequency
    /// is never even assigned, so these are written but never read back.
    #[allow(dead_code)]
    period: f64,
    #[allow(dead_code)]
    pulse_width: f64,
    #[allow(dead_code)]
    duty_cycle: f64,
    period_start: f64,
    pulse_start: f64,
    increasing_v: bool,
    decreasing_v: bool,
    started: bool,
}

impl Probe {
    pub fn new(spec: &ElementSpec) -> Self {
        Self {
            base: Base::with_posts(2),
            meter: spec.param("meter", 0.0) as i32,
            resistance: spec.param("resistance", 0.0),
            rms_v: 0.0,
            total: 0.0,
            count: 0.0,
            avg_v: 0.0,
            total_v: 0.0,
            binary_level: 0.0,
            zerocount: 0,
            max_v: 0.0,
            last_max_v: 0.0,
            min_v: 0.0,
            last_min_v: 0.0,
            period: 0.0,
            pulse_width: 0.0,
            duty_cycle: 0.0,
            period_start: 0.0,
            pulse_start: 0.0,
            increasing_v: true,
            decreasing_v: true,
            started: false,
        }
    }

    /// Finalises the running RMS and average over the half-cycle just
    /// completed, then zeroes the accumulators for the next one. Ports
    /// `ProbeElm.java:289-299` and `:315-325`, identical at both turn types.
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

impl Element for Probe {
    fn kind(&self) -> &'static str {
        "probe"
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
    /// A probe with a series resistor couples its terminals for the
    /// floating-node analysis; an ideal one does not (ProbeElm.java:397).
    fn connects(&self, _a: usize, _b: usize) -> bool {
        self.resistance != 0.0
    }
    fn stamp(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        if self.resistance != 0.0 {
            s.resistor(self.base.nodes[0], self.base.nodes[1], self.resistance);
        }
    }
    fn calculate_current(&mut self, _ctx: &SimCtx) {
        self.base.current = if self.resistance != 0.0 {
            self.base.voltage_diff() / self.resistance
        } else {
            0.0
        };
    }
    fn set_param(&mut self, name: &str, value: f64) -> bool {
        match name {
            "resistance" => self.resistance = value,
            "meter" => self.meter = value as i32,
            _ => return false,
        }
        true
    }
    fn step_finished(&mut self, ctx: &SimCtx) {
        // The operating-point solve is a DC snapshot, not a transient step:
        // sampling it would pollute the accumulators with a steady-state
        // reading, exactly like the capacitor's `v_prev` guard.
        if ctx.dc_analysis {
            return;
        }
        self.count += 1.0;
        let v = self.base.voltage_diff();
        self.total += v * v;
        self.total_v += v;

        // Binary threshold is a fixed 2.5 V, assuming ~5 V logic levels; it is
        // not scaled to the circuit's actual voltage range (ProbeElm.java:255).
        self.binary_level = if v < 2.5 { 0.0 } else { 1.0 };

        if !self.started {
            // Prime max/min tracking with the first sample instead of the stale
            // defaults (0, increasingV == decreasingV == true), which could
            // otherwise register a bogus transition on the first step.
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
        // finalise the RMS and average over the completed half-cycle.
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
        // Falling-to-rising turn: capture the trough.
        if v > self.min_v && self.decreasing_v {
            self.last_min_v = self.min_v;
            self.pulse_start = ctx.time;
            self.max_v = v;
            self.increasing_v = true;
            self.decreasing_v = false;
            self.finalise_rms();
        }

        // A signal parked at zero must not leave a stale reading behind.
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
    }
    fn value(&self) -> f64 {
        match self.meter {
            TP_RMS => self.rms_v,
            TP_AVG => self.avg_v,
            TP_MAX => self.last_max_v,
            TP_MIN => self.last_min_v,
            TP_P2P => self.last_max_v - self.last_min_v,
            TP_BIN => self.binary_level,
            TP_VOL => self.base.voltage_diff(),
            _ => self.base.voltage_diff(), // TP_FRQ..TP_DUT, never selectable
        }
    }
    fn reset(&mut self) {
        self.base.reset();
        self.zerocount = 0;
        self.rms_v = 0.0;
        self.total = 0.0;
        self.count = 0.0;
        self.avg_v = 0.0;
        self.total_v = 0.0;
        self.max_v = 0.0;
        self.last_max_v = 0.0;
        self.min_v = 0.0;
        self.last_min_v = 0.0;
        self.binary_level = 0.0;
        self.period = 0.0;
        self.pulse_width = 0.0;
        self.duty_cycle = 0.0;
        self.period_start = 0.0;
        self.pulse_start = 0.0;
        self.increasing_v = true;
        self.decreasing_v = true;
        self.started = false;
    }
}
