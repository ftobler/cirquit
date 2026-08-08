//! Analog switch: a control-voltage-driven resistor between two signal posts
//! (AnalogSwitchElm.java). Posts 0 and 1 are the signal path, post 2 the
//! control, which draws no current. When the control sits above `threshold`
//! the path stamps `r_on`, below it `r_off`, and FLAG_INVERT flips the sense
//! into a "normally closed" part. FLAG_PULLDOWN ties each signal post to
//! ground through `r_off` so an open path still reads zero.

use crate::element::{Base, Element, SimCtx};
use crate::spec::ElementSpec;
use crate::stamp::{Stamper, GROUND};

const DEF_R_ON: f64 = 20.0;
const DEF_R_OFF: f64 = 1e10;
const DEF_THRESHOLD: f64 = 2.5;

const FLAG_INVERT: i64 = 1; // AnalogSwitchElm.java:26
const FLAG_PULLDOWN: i64 = 2; // AnalogSwitchElm.java:27

/// Control-driven SPST. The resistance between the signal posts changes with
/// the control voltage every step, so the element is nonlinear even though
/// each stamp is a plain resistor (AnalogSwitchElm.java:142).
pub struct AnalogSwitch {
    base: Base,
    r_on: f64,
    r_off: f64,
    threshold: f64,
    invert: bool,
    pulldown: bool,
    /// Resistance stamped between the signal posts this step; kept for the
    /// current report.
    resistance: f64,
    /// Whether the signal path is open this step.
    open: bool,
}

impl AnalogSwitch {
    pub fn new(spec: &ElementSpec) -> Self {
        Self {
            base: Base::with_posts(3),
            r_on: spec.param("r_on", DEF_R_ON),
            r_off: spec.param("r_off", DEF_R_OFF),
            threshold: spec.param("threshold", DEF_THRESHOLD),
            invert: spec.flag(FLAG_INVERT),
            pulldown: spec.flag(FLAG_PULLDOWN),
            resistance: DEF_R_ON,
            open: false,
        }
    }
}

impl Element for AnalogSwitch {
    fn kind(&self) -> &'static str {
        "analogSwitch"
    }
    fn base(&self) -> &Base {
        &self.base
    }
    fn base_mut(&mut self) -> &mut Base {
        &mut self.base
    }
    fn post_count(&self) -> usize {
        3
    }
    fn nonlinear(&self) -> bool {
        true
    }
    /// The control post never couples to the signal path, and the two signal
    /// posts always connect for matrix topology purposes, even when open
    /// (getConnection, AnalogSwitchElm.java:181-185).
    fn connects(&self, a: usize, b: usize) -> bool {
        a != 2 && b != 2
    }

    fn stamp(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        // The pulldowns are constant for the whole run, so they belong in the
        // snapshot pass (AnalogSwitchElm.java:149-153). The switched path
        // resistor is re-stamped every Newton iteration from `do_step`; the
        // Stamper has no `stampNonLinear` hook, and the element's own
        // `nonlinear()` already marks its closure for per-iteration restore.
        if self.pulldown {
            s.resistor(self.base.nodes[0], GROUND, self.r_off);
            s.resistor(self.base.nodes[1], GROUND, self.r_off);
        }
    }

    fn do_step(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        self.open = self.base.volts[2] < self.threshold;
        if self.invert {
            self.open = !self.open;
        }
        // With FLAG_PULLDOWN, an open switch is a complete disconnect: only
        // the constant pulldowns from `stamp` tie the signal posts down, so
        // nothing is stamped here (AnalogSwitchElm.java:160-165).
        if !(self.pulldown && self.open) {
            self.resistance = if self.open { self.r_off } else { self.r_on };
            s.resistor(self.base.nodes[0], self.base.nodes[1], self.resistance);
        }
    }

    fn calculate_current(&mut self, _ctx: &SimCtx) {
        // The open switch with pulldowns reports zero, even though a little
        // pulldown current flows (AnalogSwitchElm.java:132-139).
        self.base.current = if self.pulldown && self.open {
            0.0
        } else {
            self.base.voltage_diff() / self.resistance
        };
    }

    fn current_into_node(&self, post: usize) -> f64 {
        match post {
            0 => -self.base.current,
            1 => self.base.current,
            _ => 0.0,
        }
    }

    fn set_param(&mut self, name: &str, value: f64) -> bool {
        match name {
            "r_on" if value > 0.0 => self.r_on = value,
            "r_off" if value > 0.0 => self.r_off = value,
            "threshold" => self.threshold = value,
            _ => return false,
        }
        true
    }

    fn reset(&mut self) {
        self.base.reset();
        self.resistance = self.r_on;
        self.open = false;
    }
}
