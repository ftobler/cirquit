//! Ideal ammeter: a zero-ohm current meter.

use crate::element::{Base, Element, SimCtx};
use crate::spec::ElementSpec;
use crate::stamp::Stamper;

/// Meter modes, matching `AmmeterElm.java:33-34`. `AM_VOL` reads the instant
/// current; `AM_RMS` the running RMS over the completed half-cycle.
const AM_VOL: i32 = 0;
const AM_RMS: i32 = 1;

/// Ideal ammeter. Electrically it is a zero-volt voltage source in series
/// with the wire, exactly like upstream's `stamp()` (AmmeterElm.java:211-213):
/// it reads the loop current without adding any loading, and it is never
/// merged out as a removable wire, so the current is available every step.
pub struct Ammeter {
    base: Base,
    meter: i32,
    rms_i: f64,
    total: f64,
    count: f64,
    max_i: f64,
    min_i: f64,
    zerocount: i32,
    increasing_i: bool,
    decreasing_i: bool,
}

impl Ammeter {
    pub fn new(spec: &ElementSpec) -> Self {
        Self {
            base: Base::with_posts(2),
            meter: spec.param("meter", 0.0) as i32,
            rms_i: 0.0,
            total: 0.0,
            count: 0.0,
            max_i: 0.0,
            min_i: 0.0,
            zerocount: 0,
            increasing_i: true,
            decreasing_i: true,
        }
    }

    /// Finalises the running RMS over the half-cycle just completed, then
    /// zeroes the accumulators for the next one. Ports the duplicated halves
    /// of `AmmeterElm.java:97-110` and `:118-133`.
    fn finalise_rms(&mut self) {
        let rms = (self.total / self.count).sqrt();
        self.rms_i = if rms.is_nan() { 0.0 } else { rms };
        self.count = 0.0;
        self.total = 0.0;
    }
}

impl Element for Ammeter {
    fn kind(&self) -> &'static str {
        "ammeter"
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

    /// A zero-volt source reads as a wire to the capacitor-validation walk,
    /// exactly the upstream traverse of `isWireEquivalent()` elements
    /// (FindPathInfo.java:68), so a cap in a loop with an ammeter is damped
    /// like one in a loop with a wire.
    fn is_voltage_source(&self) -> bool {
        true
    }

    fn stamp(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        s.voltage_source(
            self.base.nodes[0],
            self.base.nodes[1],
            self.base.vs_base,
            0.0,
        );
    }

    fn calculate_current(&mut self, _ctx: &SimCtx) {
        self.base.current = self.base.vs_currents[0];
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
        // reading. The ammeter is a meter, so the DC snapshot is not a reading.
        if ctx.dc_analysis {
            return;
        }
        let i = self.base.current;
        self.count += 1.0;
        self.total += i * i;

        // Rising: track the maximum.
        if i > self.max_i && self.increasing_i {
            self.max_i = i;
            self.increasing_i = true;
            self.decreasing_i = false;
        }
        // Rising-to-falling turn: capture the peak and finalise the RMS over
        // the completed half-cycle (AmmeterElm.java:97-110).
        if i < self.max_i && self.increasing_i {
            self.min_i = i;
            self.increasing_i = false;
            self.decreasing_i = true;
            self.finalise_rms();
        }
        // Falling: track the minimum.
        if i < self.min_i && self.decreasing_i {
            self.min_i = i;
            self.increasing_i = false;
            self.decreasing_i = true;
        }
        // Falling-to-rising turn: capture the trough (AmmeterElm.java:118-133).
        if i > self.min_i && self.decreasing_i {
            self.max_i = i;
            self.increasing_i = true;
            self.decreasing_i = false;
            self.finalise_rms();
        }
        // A signal parked at zero must not leave a stale reading behind
        // (AmmeterElm.java:136-146).
        if i == 0.0 {
            self.zerocount += 1;
            if self.zerocount > 5 {
                self.total = 0.0;
                self.rms_i = 0.0;
                self.max_i = 0.0;
                self.min_i = 0.0;
            }
        } else {
            self.zerocount = 0;
        }
    }

    /// Instrument reading reported to the UI each frame: the instant current,
    /// or the running RMS over the last completed half-cycle, matching
    /// `selectedValue` (AmmeterElm.java:147-154). A file value out of range
    /// falls back to the instant current rather than a stale accumulator.
    fn value(&self) -> f64 {
        match self.meter {
            AM_VOL => self.base.current,
            AM_RMS => self.rms_i,
            _ => self.base.current,
        }
    }

    fn reset(&mut self) {
        self.base.reset();
        self.rms_i = 0.0;
        self.total = 0.0;
        self.count = 0.0;
        self.max_i = 0.0;
        self.min_i = 0.0;
        self.zerocount = 0;
        self.increasing_i = true;
        self.decreasing_i = true;
    }
}
