//! Second-generation current conveyor, CCII+/CCII- (CC2Elm, dump 179).
//!
//! A chip with three posts: X (output, west row 0), Y (west row 2) and Z
//! (east row 1), a 2x3 pin grid (CC2Elm.setupPins). The X terminal is driven
//! by a 0 V voltage source whose constraint row `do_step` never changes, so
//! the conveyor is linear despite its controlled-source flavour: a VCVS makes
//! X follow Y and a CCCS makes the Z current `gain` times the X current
//! (CC2Elm.java:61-67). `gain` of +1 is a CCII+, -1 a CCII-.
//!
//! `stamp` is the constant pass and `do_step` is empty, so `nonlinear()` is
//! false: nothing re-linearises, and the matrix factors once. The commented
//! `nonLinear` in CC2Elm.java:59 confirms upstream's own intent.

use crate::element::{Base, Element, SimCtx};
use crate::spec::ElementSpec;
use crate::stamp::{Stamper, GROUND};

pub struct Cc2 {
    base: Base,
    /// +1 for a CCII+, -1 for a CCII- (CC2Elm.java:32).
    gain: f64,
}

impl Cc2 {
    pub fn new(spec: &ElementSpec) -> Self {
        Self {
            base: Base::with_posts(3),
            gain: spec.param("gain", 1.0),
        }
    }
}

impl Element for Cc2 {
    fn kind(&self) -> &'static str {
        "cc2"
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
    fn voltage_source_count(&self) -> usize {
        1
    }
    /// The one source spans ground to the X terminal (CC2Elm.java:62).
    fn voltage_source_nodes(&self, _k: usize) -> (usize, usize) {
        (GROUND, self.base.nodes[0])
    }

    /// The Y input is isolated; only X is driven (ChipElm.getConnection).
    fn connects(&self, _a: usize, _b: usize) -> bool {
        false
    }
    /// The VCVS and CCCS couple the Y and Z rows into the X source's closure,
    /// so all three posts must share one (CC2Elm.getMatrixConnection).
    fn matrix_connects(&self, _a: usize, _b: usize) -> bool {
        true
    }

    fn stamp(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        // X is a 0 V source whose constraint row the VCVS controls: the row
        // reads V(X) = V(Y) after `vcvs`, and the CCCS delivers `gain*I(X)`
        // into Z (CC2Elm.java:61-67).
        s.voltage_source(GROUND, self.base.nodes[0], self.base.vs_base, 0.0);
        s.vcvs(GROUND, self.base.nodes[1], 1.0, self.base.vs_base);
        s.cccs(GROUND, self.base.nodes[2], self.base.vs_base, self.gain);
    }

    fn calculate_current(&mut self, _ctx: &SimCtx) {
        // The Z current is the X current scaled by the gain
        // (CC2Elm.java:68-71); base.current reports the Z current, and
        // `current_into_node` hands X and Z out separately.
        self.base.current = self.gain * self.base.vs_currents[0];
    }

    fn current_into_node(&self, post: usize) -> f64 {
        match post {
            // Current into the X terminal from the 0 V source.
            0 => self.base.vs_currents[0],
            // The Y input draws nothing.
            1 => 0.0,
            // The conveyed Z current.
            2 => self.base.current,
            _ => 0.0,
        }
    }

    fn voltage_diff(&self) -> f64 {
        // The conveyor's output quantity, V(X) - V(Y): zero when the device
        // is doing its job.
        self.base.volts[0] - self.base.volts[1]
    }

    fn set_param(&mut self, name: &str, value: f64) -> bool {
        match name {
            "gain" if value == 1.0 || value == -1.0 => self.gain = value,
            _ => return false,
        }
        true
    }

    fn reset(&mut self) {
        self.base.reset();
    }
}
