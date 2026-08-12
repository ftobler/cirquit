//! Time-delay relay (TimeDelayRelayElm.java, dump 414).
//!
//! A four-post relay that is a ChipElm upstream but is deliberately NOT built
//! on the port's Chip base: it is not a digital chip, carries no voltage
//! sources, and its outputs are a plain switch contact rather than driven
//! pins. The coil sense (posts 0-1) is a fixed 10 kOhm resistor; the switched
//! path (posts 2-3) is a resistor that flips between `on_resistance` and
//! `off_resistance` once the delay elapses. `nonlinear()` is true because the
//! switched resistor changes value, so `do_step` re-stamps it every Newton
//! iteration (TimeDelayRelayElm.java:79-90).
//!
//! The state machine runs in `step_finished` (TimeDelayRelayElm.java:92-100):
//! `powered_state` is the coil sense above 2.5 V, `last_transition` records
//! when it changed, and `on_state` follows `powered_state` once
//! `t > last_transition + delay` has passed. The DC operating point skips the
//! machine so a powered-at-load file does not fire during the solve.

use crate::element::{Base, Element, SimCtx};
use crate::spec::ElementSpec;
use crate::stamp::Stamper;

/// The coil sense resistor (TimeDelayRelayElm.java:29).
const VIN_RESISTANCE: f64 = 10e3;
/// The coil voltage that counts as "powered" (TimeDelayRelayElm.java:95).
const POWER_LEVEL: f64 = 2.5;
/// Constructor defaults (TimeDelayRelayElm.java:36-39).
const DEF_ON_DELAY: f64 = 1.0;
const DEF_OFF_DELAY: f64 = 0.0;
const DEF_ON_RESISTANCE: f64 = 1.0;
const DEF_OFF_RESISTANCE: f64 = 10e6;

pub struct TimeDelayRelay {
    base: Base,
    on_delay: f64,
    off_delay: f64,
    on_resistance: f64,
    off_resistance: f64,
    /// The switched path's current value, `on`/`off` per `on_state`.
    resistance: f64,
    last_transition: f64,
    powered_state: bool,
    on_state: bool,
}

impl TimeDelayRelay {
    pub fn new(spec: &ElementSpec) -> Self {
        let off_resistance = spec.param("offResistance", DEF_OFF_RESISTANCE);
        Self {
            base: Base::with_posts(4),
            on_delay: spec.param("onDelay", DEF_ON_DELAY),
            off_delay: spec.param("offDelay", DEF_OFF_DELAY),
            on_resistance: spec.param("onResistance", DEF_ON_RESISTANCE),
            off_resistance,
            // The resting contact is open, so the switched path starts at the
            // off resistance (TimeDelayRelayElm.java:39).
            resistance: off_resistance,
            last_transition: 0.0,
            powered_state: false,
            on_state: false,
        }
    }
}

impl Element for TimeDelayRelay {
    fn kind(&self) -> &'static str {
        "timeDelayRelay"
    }
    fn base(&self) -> &Base {
        &self.base
    }
    fn base_mut(&mut self) -> &mut Base {
        &mut self.base
    }
    fn post_count(&self) -> usize {
        4
    }
    fn nonlinear(&self) -> bool {
        true
    }

    fn stamp(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        // The coil sense is a constant resistor (TimeDelayRelayElm.java:82).
        s.resistor(self.base.nodes[0], self.base.nodes[1], VIN_RESISTANCE);
    }

    fn do_step(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        // The switched path's value moves with `on_state`, so it is re-stamped
        // every Newton iteration (TimeDelayRelayElm.java:87-90).
        self.resistance = if self.on_state {
            self.on_resistance
        } else {
            self.off_resistance
        };
        s.resistor(self.base.nodes[2], self.base.nodes[3], self.resistance);
    }

    fn calculate_current(&mut self, _ctx: &SimCtx) {
        let v = &self.base.volts;
        self.base.current = (v[2] - v[3]) / self.resistance;
    }

    fn current_into_node(&self, post: usize) -> f64 {
        // The per-pin currents, positive into the node (TimeDelayRelayElm.java:
        // 103-106): the coil draws through posts 0-1, the switched path
        // through posts 2-3.
        let i01 = (self.base.volts[0] - self.base.volts[1]) / VIN_RESISTANCE;
        let i23 = (self.base.volts[2] - self.base.volts[3]) / self.resistance;
        match post {
            0 => -i01,
            1 => i01,
            2 => -i23,
            _ => i23,
        }
    }

    fn step_finished(&mut self, ctx: &SimCtx) {
        // The machine only advances for real time; the operating point's solve
        // at t = 0 must not arm the delay clock.
        if ctx.dc_analysis {
            return;
        }
        let old_state = self.powered_state;
        self.powered_state = self.base.volts[0] - self.base.volts[1] > POWER_LEVEL;
        if old_state != self.powered_state {
            self.last_transition = ctx.time;
        }
        let delay = if self.powered_state {
            self.on_delay
        } else {
            self.off_delay
        };
        if ctx.time > self.last_transition + delay {
            self.on_state = self.powered_state;
        }
    }

    fn voltage_diff(&self) -> f64 {
        // The coil sense, what a voltage scope on the relay plots
        // (TimeDelayRelayElm.java:95).
        self.base.volts[0] - self.base.volts[1]
    }

    fn set_param(&mut self, name: &str, value: f64) -> bool {
        match name {
            "onDelay" => self.on_delay = value,
            "offDelay" => self.off_delay = value,
            "onResistance" if value > 0.0 => self.on_resistance = value,
            "offResistance" if value > 0.0 => self.off_resistance = value,
            _ => return false,
        }
        true
    }

    fn reset(&mut self) {
        self.base.reset();
        self.last_transition = 0.0;
        self.powered_state = false;
        self.on_state = false;
    }
}
