//! Analog switch with two throws (AnalogSwitch2Elm.java), the SPDT sibling
//! of the analog switch. Posts 0 is the common terminal, 1 and 2 the two
//! throws, 3 the control, which draws no current. The control gates which
//! throw carries `r_on`: below `threshold` the switch is open, so throw 2
//! carries the on-resistance and throw 1 the off-resistance, and FLAG_INVERT
//! swaps the pair. FLAG_PULLDOWN is inherited from the SPST (AnalogSwitchElm.
//! java:27): with it set, both throws are tied to ground through `r_off` for
//! the whole run, so the unselected throw is a complete disconnect instead of
//! carrying the off-resistance (AnalogSwitch2Elm.java:100-117).

use crate::element::{Base, Element, SimCtx};
use crate::spec::ElementSpec;
use crate::stamp::{Stamper, GROUND};

const DEF_R_ON: f64 = 20.0;
const DEF_R_OFF: f64 = 1e10;
const DEF_THRESHOLD: f64 = 2.5;

const FLAG_INVERT: i64 = 1; // AnalogSwitchElm.java:26
const FLAG_PULLDOWN: i64 = 2; // AnalogSwitchElm.java:27

/// Control-driven SPDT. The throw pairing changes with the control voltage
/// every step, so the element is nonlinear even though each stamp is a plain
/// resistor (AnalogSwitchElm.java:142).
pub struct AnalogSwitch2 {
    base: Base,
    r_on: f64,
    r_off: f64,
    threshold: f64,
    invert: bool,
    pulldown: bool,
    /// Whether the lever is open this step: throw 2 carries `r_on` when true,
    /// throw 1 when false.
    open: bool,
}

impl AnalogSwitch2 {
    pub fn new(spec: &ElementSpec) -> Self {
        Self {
            base: Base::with_posts(4),
            r_on: spec.param("r_on", DEF_R_ON),
            r_off: spec.param("r_off", DEF_R_OFF),
            threshold: spec.param("threshold", DEF_THRESHOLD),
            invert: spec.flag(FLAG_INVERT),
            pulldown: spec.flag(FLAG_PULLDOWN),
            open: true,
        }
    }

    /// The throw stamped with `r_on`. At rest (control below threshold) the
    /// switch is open, so post 2 is the normally closed side
    /// (AnalogSwitch2Elm.java:105-118).
    fn selected_post(&self) -> usize {
        if self.open {
            2
        } else {
            1
        }
    }
}

impl Element for AnalogSwitch2 {
    fn kind(&self) -> &'static str {
        "analogSwitch2"
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
    /// The control post never couples to the switch body, and the common and
    /// both throws always connect for matrix topology purposes, even though
    /// the chosen stamp changes every step (getConnection, AnalogSwitch2Elm.java:
    /// 124-126).
    fn connects(&self, a: usize, b: usize) -> bool {
        a != 3 && b != 3
    }

    fn stamp(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        // The pulldowns are constant for the whole run, so they belong in the
        // snapshot pass, exactly as the SPST's do (AnalogSwitchElm.java:149-153,
        // AnalogSwitch2Elm.java:100-103).
        if self.pulldown {
            s.resistor(self.base.nodes[1], GROUND, self.r_off);
            s.resistor(self.base.nodes[2], GROUND, self.r_off);
        }
    }

    fn do_step(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        self.open = self.base.volts[3] < self.threshold;
        if self.invert {
            self.open = !self.open;
        }
        // One throw carries `r_on`, the other `r_off`, whichever way the lever
        // points. With FLAG_PULLDOWN the unselected throw is already tied to
        // ground by `stamp`, so it is left a complete disconnect here
        // (AnalogSwitch2Elm.java:109-117).
        let sel = self.selected_post();
        let unsel = if sel == 1 { 2 } else { 1 };
        s.resistor(self.base.nodes[0], self.base.nodes[sel], self.r_on);
        if !self.pulldown {
            s.resistor(self.base.nodes[0], self.base.nodes[unsel], self.r_off);
        }
    }

    fn calculate_current(&mut self, _ctx: &SimCtx) {
        self.base.current =
            (self.base.volts[0] - self.base.volts[self.selected_post()]) / self.r_on;
    }

    fn current_into_node(&self, post: usize) -> f64 {
        if post == 0 {
            -self.base.current
        } else if post == self.selected_post() {
            self.base.current
        } else {
            0.0
        }
    }

    /// The quantity a voltage scope on the element should plot: the drop
    /// across the conducting throw, matching the current formula.
    fn voltage_diff(&self) -> f64 {
        self.base.volts[0] - self.base.volts[self.selected_post()]
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
        self.open = true;
    }
}
