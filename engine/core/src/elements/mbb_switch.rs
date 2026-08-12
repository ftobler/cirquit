//! Make-before-break switch (MBBSwitchElm.java, dump 416).
//!
//! A three-post switch with four positions: 0 closes pole A only, 1 closes
//! both, 2 closes pole B only, 3 closes both (`both = position == 1 ||
//! position == 3`, MBBSwitchElm.java:177). The common post 0 carries either
//! one or two throws, so the ideal path's voltage-source count depends on the
//! position: one 0 V source for a single-pole position, two when both throws
//! conduct (MBBSwitchElm.java:176-181). A resistance above zero stamps plain
//! resistors instead, on the same pairs.

use crate::element::{Base, Element, SimCtx};
use crate::spec::ElementSpec;
use crate::stamp::Stamper;

pub struct MbbSwitch {
    base: Base,
    position: i32,
    momentary: bool,
    resistance: f64,
    /// Switch Group token: toggling one MBB sets every MBB with the same
    /// nonzero group to the same position. The propagation happens in the
    /// frontend store, mirroring upstream's elmList scan
    /// (MBBSwitchElm.java:182-195); the engine only carries the token.
    link: i64,
    /// Per-pole current from the last solved step.
    currents: [f64; 2],
}

impl MbbSwitch {
    pub fn new(spec: &ElementSpec) -> Self {
        Self {
            base: Base::with_posts(3),
            position: spec.param("position", 0.0) as i32,
            momentary: spec.param("momentary", 0.0) != 0.0,
            resistance: spec.param("resistance", 0.0),
            link: spec.param("link", 0.0) as i64,
            currents: [0.0; 2],
        }
    }

    /// True when both throws conduct, positions 1 and 3
    /// (MBBSwitchElm.java:177).
    fn both(&self) -> bool {
        self.position == 1 || self.position == 3
    }
}

impl Element for MbbSwitch {
    fn kind(&self) -> &'static str {
        "mbbSwitch"
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
        if self.resistance > 0.0 {
            0
        } else if self.both() {
            2
        } else {
            1
        }
    }
    /// The source must join the closure of the throw it actually stamps, and
    /// the throw set depends on the position, so only the element knows the
    /// pair (MBBSwitchElm.java:150-158).
    fn voltage_source_nodes(&self, k: usize) -> (usize, usize) {
        if self.both() {
            (self.base.nodes[0], self.base.nodes[k + 1])
        } else if self.position == 0 {
            (self.base.nodes[0], self.base.nodes[1])
        } else {
            (self.base.nodes[0], self.base.nodes[2])
        }
    }
    fn connects(&self, a: usize, b: usize) -> bool {
        // Both positions short every throw together; single positions connect
        // the common post to the one selected throw (MBBSwitchElm.java:196-200).
        if self.both() {
            true
        } else {
            let sel = 1 + (self.position / 2) as usize;
            (a == 0 && b == sel) || (b == 0 && a == sel)
        }
    }

    fn stamp(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        if self.resistance > 0.0 {
            if self.both() || self.position == 0 {
                s.resistor(self.base.nodes[0], self.base.nodes[1], self.resistance);
            }
            if self.both() || self.position == 2 {
                s.resistor(self.base.nodes[0], self.base.nodes[2], self.resistance);
            }
            return;
        }
        // The ideal path is a 0 V voltage source per conducting throw, in
        // order, so `voltage_source_nodes` and the vs currents agree
        // (MBBSwitchElm.java:167-172).
        let mut vs = self.base.vs_base;
        if self.both() || self.position == 0 {
            s.voltage_source(self.base.nodes[0], self.base.nodes[1], vs, 0.0);
            vs += 1;
        }
        if self.both() || self.position == 2 {
            s.voltage_source(self.base.nodes[0], self.base.nodes[2], vs, 0.0);
        }
    }

    fn calculate_current(&mut self, _ctx: &SimCtx) {
        if self.resistance > 0.0 {
            self.currents[0] = if self.both() || self.position == 0 {
                (self.base.volts[0] - self.base.volts[1]) / self.resistance
            } else {
                0.0
            };
            self.currents[1] = if self.both() || self.position == 2 {
                (self.base.volts[0] - self.base.volts[2]) / self.resistance
            } else {
                0.0
            };
        } else {
            // The ideal path reads the source currents, zeroing the
            // unconnected pole. When both throws conduct the sources line up
            // with the poles; a single source lands in pole `position/2`
            // (MBBSwitchElm.java:133-139, :146-149).
            self.currents = [0.0; 2];
            if self.both() {
                self.currents[0] = self.base.vs_currents[0];
                self.currents[1] = self.base.vs_currents[1];
            } else {
                self.currents[(self.position / 2) as usize] = self.base.vs_currents[0];
            }
        }
        self.base.current = self.currents[0] + self.currents[1];
    }

    fn current_into_node(&self, post: usize) -> f64 {
        // The common post drains both pole currents; each throw carries its
        // own (MBBSwitchElm.java:117-121).
        if post == 0 {
            -self.currents[0] - self.currents[1]
        } else {
            self.currents[post - 1]
        }
    }

    fn set_state(&mut self, state: i32) -> bool {
        self.position = state.rem_euclid(4);
        // The throw set changes which terminals merge and how many voltage
        // sources exist, so the caller re-allocates rather than just re-stamps.
        true
    }

    fn set_param(&mut self, name: &str, value: f64) -> bool {
        match name {
            "momentary" => self.momentary = value != 0.0,
            // A resistance edit that crosses the ideal/resistor boundary flips
            // `voltage_source_count` from 0 to up to 2, which the live restamp
            // cannot reallocate: the closure builder would index the new vs
            // slots past the end of the stale array. Return false so the
            // caller does a full rebuild, which reallocates and re-serialises
            // the edited resistance. A same-side edit keeps the fast path and
            // the sim clock.
            "resistance" => {
                if (value > 0.0) != (self.resistance > 0.0) {
                    return false;
                }
                self.resistance = value;
            }
            "link" => self.link = value as i64,
            _ => return false,
        }
        true
    }
}
