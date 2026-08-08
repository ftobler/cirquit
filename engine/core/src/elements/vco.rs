//! Voltage-controlled oscillator (VCOElm.java, dump 158): a chip whose output
//! square-wave frequency follows the Vi input voltage.
//!
//! The model is a behavioural current mirror. Two sense sources clamp the R1
//! pin to the Vi pin and hold the R2 pin at 5 V, so the current through each
//! external resistor (typically to ground) is measured as a voltage-source
//! current. `do_step` mirrors the sum of those currents into the external
//! capacitor across the C pins, charging it with the mirror's current in the
//! `dir` direction. A comparator with hysteresis on the cap voltage flips the
//! output and the mirror direction at 4.5 V and 0.5 V, so the cap swings
//! between those levels and the Vo pin drives the resulting square wave. With
//! R1 and R2 to ground the cap charges at `Vi/R1 + 5/R2`, giving a frequency
//! of `(Vi/R1 + 5/R2) / (8C)`.
//!
//! The cap is never fed by a resistor network; the mirror is the whole circuit
//! (VCOElm.java:45-56). The internal 1 M ohm across the cap pins gives the
//! current somewhere to go when no cap is connected. This element is not part
//! of the digital chip family: its output rails and comparator levels are
//! hardcoded 5 V logic rather than `highVoltage`-driven pin states, so it holds
//! its own `Base` like the timer and phase comparator.

use crate::element::{Base, Element, SimCtx};
use crate::spec::ElementSpec;
use crate::stamp::{Stamper, GROUND};

/// The internal resistance across the cap pins, a bleeder for the mirror
/// current when no capacitor is connected (VCOElm.java:57).
const C_RESISTANCE: f64 = 1e6;
/// The comparator's decision level on the output voltage (VCOElm.java:63).
const MID_LEVEL: f64 = 2.5;
/// Upper comparator level on the cap voltage (VCOElm.java:65).
const V_HIGH: f64 = 4.5;
/// Lower comparator level on the cap voltage (VCOElm.java:69).
const V_LOW: f64 = 0.5;

/// Pin order, fixed by the netlist format (VCOElm.java:29-42).
const N_VI: usize = 0;
const N_VO: usize = 1;
const N_C0: usize = 2;
const N_C1: usize = 3;
const N_R1: usize = 4;
const N_R2: usize = 5;

pub struct Vco {
    base: Base,
    /// Mirror current direction, +1 charging the cap, -1 discharging
    /// (`cDir`, VCOElm.java:59).
    dir: f64,
    /// Per-post currents for the wire-current recovery, in the file's pin
    /// order (`computeCurrent`, VCOElm.java:87-94).
    currents: Vec<f64>,
}

impl Vco {
    pub fn new(_spec: &ElementSpec) -> Self {
        // No file tokens beyond the common fields: the VCO has no bits, no
        // saved pin levels and never uses the ChipElm high-voltage token, so
        // the constructor is just the fixed pin count (ChipElm.java:36-47).
        Self {
            base: Base::with_posts(6),
            dir: 1.0,
            currents: vec![0.0; 6],
        }
    }
}

impl Element for Vco {
    fn kind(&self) -> &'static str {
        "vco"
    }
    fn base(&self) -> &Base {
        &self.base
    }
    fn base_mut(&mut self) -> &mut Base {
        &mut self.base
    }
    fn post_count(&self) -> usize {
        6
    }
    fn voltage_source_count(&self) -> usize {
        3
    }
    fn voltage_source_nodes(&self, k: usize) -> (usize, usize) {
        match k {
            // The Vo output source to ground.
            0 => (GROUND, self.base.nodes[N_VO]),
            // The R1 sense source clamps the R1 pin to the Vi pin.
            1 => (self.base.nodes[N_VI], self.base.nodes[N_R1]),
            // The R2 sense source holds the R2 pin at 5 V.
            _ => (GROUND, self.base.nodes[N_R2]),
        }
    }
    /// No passive DC path couples the pins: every coupling is a stamp, so the
    /// floating-node walk treats the posts as separate (ChipElm.java:467).
    fn connects(&self, _a: usize, _b: usize) -> bool {
        false
    }
    /// The mirror couples every pin's rows, so the whole chip is one matrix
    /// closure (getMatrixConnection returns true, VCOElm.java:103).
    fn matrix_connects(&self, _a: usize, _b: usize) -> bool {
        true
    }
    /// The mirror direction and the comparator change the matrix structure
    /// between steps, so the closure is re-stamped every iteration
    /// (VCOElm.java:43).
    fn nonlinear(&self) -> bool {
        true
    }

    fn stamp(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        // The Vo output source; its value is supplied per step.
        s.voltage_source(GROUND, self.base.nodes[N_VO], self.base.vs_base, 0.0);
        // The R1 sense source holds the R1 pin at the Vi pin's voltage, so its
        // current equals the external R1 resistor's (VCOElm.java:48).
        s.voltage_source(
            self.base.nodes[N_VI],
            self.base.nodes[N_R1],
            self.base.vs_base + 1,
            0.0,
        );
        // The R2 sense source holds the R2 pin at 5 V (VCOElm.java:50).
        s.voltage_source(GROUND, self.base.nodes[N_R2], self.base.vs_base + 2, 5.0);
        // The internal bleeder across the cap pins (VCOElm.java:53).
        s.resistor(self.base.nodes[N_C0], self.base.nodes[N_C1], C_RESISTANCE);
    }

    fn do_step(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        let vc = self.base.volts[N_C1] - self.base.volts[N_C0];
        let vo = self.base.volts[N_VO];
        // The Schmitt-triggered comparator (VCOElm.java:60-72): the output is
        // low while the cap charges past 4.5 V, then high while it discharges
        // past 0.5 V, and the mirror direction follows.
        let mut dir = if vo < MID_LEVEL { 1.0 } else { -1.0 };
        let mut out = vo;
        if vo < MID_LEVEL && vc > V_HIGH {
            out = 5.0;
            dir = -1.0;
        }
        if vo > MID_LEVEL && vc < V_LOW {
            out = 0.0;
            dir = 1.0;
        }
        s.voltage_source_value(self.base.vs_base, out);
        // Mirror the sense-source currents into the cap (VCOElm.java:79-82):
        // `dir*(i4 + i5)` leaves the C post 0 row and enters the C post 1 row,
        // so the cap current equals the sum of the external resistor currents.
        if let Some(r0) = s.node_row(self.base.nodes[N_C0]) {
            s.raw(r0, s.vs_row(self.base.vs_base + 1), dir);
            s.raw(r0, s.vs_row(self.base.vs_base + 2), dir);
        }
        if let Some(r1) = s.node_row(self.base.nodes[N_C1]) {
            s.raw(r1, s.vs_row(self.base.vs_base + 1), -dir);
            s.raw(r1, s.vs_row(self.base.vs_base + 2), -dir);
        }
        self.dir = dir;
    }

    fn calculate_current(&mut self, _ctx: &SimCtx) {
        // `computeCurrent` (VCOElm.java:87-94): the cap pins carry the mirrored
        // current plus the internal bleeder's, and the Vi pin the R1 sense
        // current it supplied. The source currents are the solved unknowns.
        let i4 = self.base.vs_currents[1];
        let i5 = self.base.vs_currents[2];
        let c =
            self.dir * (i4 + i5) + (self.base.volts[N_C1] - self.base.volts[N_C0]) / C_RESISTANCE;
        self.currents[N_VI] = -i4;
        self.currents[N_VO] = self.base.vs_currents[0];
        self.currents[N_C0] = -c;
        self.currents[N_C1] = c;
        self.currents[N_R1] = i4;
        self.currents[N_R2] = i5;
        self.base.current = 0.0;
    }

    fn current_into_node(&self, post: usize) -> f64 {
        if post < self.currents.len() {
            self.currents[post]
        } else {
            0.0
        }
    }

    fn reset(&mut self) {
        self.base.reset();
        self.dir = 1.0;
        self.currents.fill(0.0);
    }
}
