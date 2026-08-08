//! The 555 timer (TimerElm.java, dump 165). A nonlinear chip with no voltage
//! sources: an internal 5000/10000 ohm divider holds CTL at two thirds of
//! VCC, and a pair of comparators set a latch that `do_step` turns into a 1
//! ohm tie of OUT to VCC or ground, with a 10 ohm discharge path while low.

use crate::element::{Base, Element, SimCtx};
use crate::spec::ElementSpec;
use crate::stamp::{Stamper, GROUND};

/// File flags (TimerElm.java:23-25).
const FLAG_RESET: i64 = 2;
const FLAG_GROUND: i64 = 4;
/// Drawing-only: pin numbers instead of names, so the engine never reads it.
#[allow(dead_code)]
const FLAG_NUMBERS: i64 = 8;

/// Pin order, fixed by the netlist format (TimerElm.java:27-34).
const N_DIS: usize = 0;
const N_TRIG: usize = 1;
const N_THRES: usize = 2;
const N_VCC: usize = 3;
const N_CTL: usize = 4;
const N_OUT: usize = 5;
const N_RST: usize = 6;
const N_GND: usize = 7;

/// The divider stamps CTL at 2/3 VCC (TimerElm.java:70-71).
const DIV_HI: f64 = 5000.0;
const DIV_LO: f64 = 10000.0;
/// The discharge path while OUT is low (TimerElm.java:124).
const R_DISCHARGE: f64 = 10.0;
/// The output tie to VCC or ground (TimerElm.java:127).
const R_OUTPUT: f64 = 1.0;
/// The reset pin's active-low threshold, 0.7 V above the ground reference.
const RESET_LEVEL: f64 = 0.7;

pub struct Timer {
    base: Base,
    has_reset: bool,
    has_ground: bool,
    high_voltage: f64,
    /// The latched output state (TimerElm.java:95).
    out: bool,
    /// A trigger that arrived while reset was held, released once reset lifts
    /// (TimerElm.java:96).
    trigger_suppressed: bool,
    /// Per-post currents for the wire-current recovery, in the file's pin
    /// order (TimerElm.java:79-94).
    currents: Vec<f64>,
}

impl Timer {
    pub fn new(spec: &ElementSpec) -> Self {
        let has_ground = spec.flag(FLAG_GROUND);
        let has_reset = spec.flag(FLAG_RESET) || has_ground;
        let posts = if has_ground {
            8
        } else if has_reset {
            7
        } else {
            6
        };
        let mut t = Self {
            base: Base::with_posts(posts),
            has_reset,
            has_ground,
            high_voltage: spec.param("highVoltage", 5.0),
            out: false,
            trigger_suppressed: false,
            currents: vec![0.0; posts],
        };
        // The file saves the OUT level (ChipElm.java:369-370, with state=true
        // on OUT). `start_iteration` recomputes `out` from the node voltages
        // before any `do_step`, so the restore only seeds the very first step.
        if let Some(&v) = spec.params.get("voltage5") {
            t.out = v > t.high_voltage * 0.5;
        }
        t
    }

    /// The ground reference: the GND pin's node when present, else the real
    /// ground (TimerElm.java:68).
    fn ground(&self) -> usize {
        if self.has_ground {
            self.base.nodes[N_GND]
        } else {
            GROUND
        }
    }
}

impl Element for Timer {
    fn kind(&self) -> &'static str {
        "timer"
    }
    fn base(&self) -> &Base {
        &self.base
    }
    fn base_mut(&mut self) -> &mut Base {
        &mut self.base
    }
    fn post_count(&self) -> usize {
        if self.has_ground {
            8
        } else if self.has_reset {
            7
        } else {
            6
        }
    }
    fn nonlinear(&self) -> bool {
        true
    }
    /// The divider is a real DC path, so CTL must reach ground through it: the
    /// floating-node walk unions posts by `connects`, and without the divider
    /// pair it would pin CTL with GMIN on top of the genuine 10000 ohm leg
    /// (ChipElm.java:467 reports all-false, but its findUnconnectedNodes only
    /// walks `getConnection`, so the pin is an upstream artifact too). VCC is
    /// coupled to CTL by the upper leg; the lower leg reaches the GND post
    /// only when that pin exists, otherwise it lands on node 0 directly and
    /// `connects` cannot name it.
    fn connects(&self, a: usize, b: usize) -> bool {
        match (a, b) {
            (N_VCC, N_CTL) | (N_CTL, N_VCC) => true,
            (N_CTL, N_GND) | (N_GND, N_CTL) => self.has_ground,
            _ => false,
        }
    }
    /// The divider and the `do_step` output tie couple every post into one
    /// matrix closure (TimerElm.java:131).
    fn matrix_connects(&self, _a: usize, _b: usize) -> bool {
        true
    }

    fn stamp(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        let ground = self.ground();
        // The constant divider, CTL at two thirds of VCC (TimerElm.java:69-71).
        s.resistor(self.base.nodes[N_VCC], self.base.nodes[N_CTL], DIV_HI);
        s.resistor(self.base.nodes[N_CTL], ground, DIV_LO);
        // The discharge, output and supply pins change conductance every step,
        // so their `stampNonLinear` call has no port: the element's own
        // `nonlinear()` already marks its closure for per-iteration restore,
        // and the switching resistors live in `do_step` below.
    }

    fn start_iteration(&mut self, _ctx: &SimCtx) {
        let v = &self.base.volts;
        let ground_volts = if self.has_ground { v[N_GND] } else { 0.0 };
        let mut out = v[N_OUT] > (v[N_VCC] + ground_volts) / 2.0;
        // The threshold comparator resets the latch (TimerElm.java:102-103).
        if v[N_THRES] > v[N_CTL] {
            out = false;
        }
        // The trigger comparator sets it and beats the threshold; a trigger
        // that arrived while reset was held is latched so it fires once reset
        // releases (TimerElm.java:107-109).
        let triggered = (v[N_CTL] + ground_volts) / 2.0 > v[N_TRIG];
        if triggered || self.trigger_suppressed {
            out = true;
        }
        // Reset overrides the trigger (TimerElm.java:112-117).
        if self.has_reset && v[N_RST] < RESET_LEVEL + ground_volts {
            out = false;
            self.trigger_suppressed = triggered;
        } else {
            self.trigger_suppressed = false;
        }
        self.out = out;
    }

    fn do_step(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        let ground = self.ground();
        // While the output is low, DIS is pulled to ground through a small
        // resistor (TimerElm.java:123-124).
        if !self.out {
            s.resistor(self.base.nodes[N_DIS], ground, R_DISCHARGE);
        }
        // The output is tied to VCC or ground through 1 ohm, so an external
        // load sees a near-ideal rail swing (TimerElm.java:126-127).
        let rail = if self.out {
            self.base.nodes[N_VCC]
        } else {
            ground
        };
        s.resistor(rail, self.base.nodes[N_OUT], R_OUTPUT);
    }

    fn calculate_current(&mut self, _ctx: &SimCtx) {
        let v = &self.base.volts;
        let ground_volts = if self.has_ground { v[N_GND] } else { 0.0 };
        self.currents.fill(0.0);
        // Divider current feeds VCC and leaves through CTL (TimerElm.java:82-84).
        self.currents[N_VCC] = (v[N_CTL] - v[N_VCC]) / DIV_HI;
        self.currents[N_CTL] = -(v[N_CTL] - ground_volts) / DIV_LO - self.currents[N_VCC];
        // DIS carries the discharge current only while the output is low
        // (TimerElm.java:85).
        if !self.out {
            self.currents[N_DIS] = -(v[N_DIS] - ground_volts) / R_DISCHARGE;
        }
        // The output current is the 1 ohm tie to the rail (TimerElm.java:86).
        let rail = if self.out { v[N_VCC] } else { ground_volts };
        self.currents[N_OUT] = -(v[N_OUT] - rail);
        if self.out {
            self.currents[N_VCC] -= self.currents[N_OUT];
        }
        if self.has_ground {
            self.currents[N_GND] = (v[N_CTL] - ground_volts) / DIV_LO;
            if !self.out {
                self.currents[N_GND] +=
                    (v[N_DIS] - ground_volts) / R_DISCHARGE + (v[N_OUT] - ground_volts);
            }
        }
        self.base.current = 0.0;
    }

    fn current_into_node(&self, post: usize) -> f64 {
        // The per-pin currents are the chip's `getCurrentIntoNode` values,
        // positive into the node (ChipElm.java:472-478).
        if post < self.currents.len() {
            self.currents[post]
        } else {
            0.0
        }
    }

    fn set_param(&mut self, name: &str, value: f64) -> bool {
        match name {
            "highVoltage" if value > 0.0 => self.high_voltage = value,
            // The flags change the post count, which a live edit cannot, so
            // they fall through and the caller rebuilds.
            _ => return false,
        }
        true
    }

    fn reset(&mut self) {
        self.base.reset();
        self.out = false;
        self.trigger_suppressed = false;
        self.currents.fill(0.0);
    }
}
