//! DPDT switch (DPDTSwitchElm.java, dump 429).
//!
//! A multi-pole, double-throw switch: `pole_count` poles (default 2, clamped
//! to 2..=10) of `3*pole_count` posts, positions 0 and 1. Per pole, the pole
//! post `3i` joins throw `3i+1` at position 0 or throw `3i+2` at position 1.
//! The ideal path (resistance 0, the default) stamps one 0 V voltage source
//! per pole so each pole's current stays reportable; a resistance above zero
//! stamps plain resistors instead (DPDTSwitchElm.java:186-199). The pole
//! count is read from the file, so a loaded switch carries its own width.

use crate::element::{Base, Element, SimCtx};
use crate::spec::ElementSpec;
use crate::stamp::Stamper;

const MIN_POLES: usize = 2;
const MAX_POLES: usize = 10;

pub struct DpdtSwitch {
    base: Base,
    position: i32,
    momentary: bool,
    pole_count: usize,
    resistance: f64,
    /// Per-pole current from the last solved step.
    currents: Vec<f64>,
}

impl DpdtSwitch {
    pub fn new(spec: &ElementSpec) -> Self {
        let pole_count = (spec.param("poleCount", 2.0) as usize).clamp(MIN_POLES, MAX_POLES);
        Self {
            base: Base::with_posts(3 * pole_count),
            position: spec.param("position", 0.0) as i32,
            momentary: spec.param("momentary", 0.0) != 0.0,
            pole_count,
            resistance: spec.param("resistance", 0.0),
            currents: vec![0.0; pole_count],
        }
    }
}

impl Element for DpdtSwitch {
    fn kind(&self) -> &'static str {
        "dpdtSwitch"
    }
    fn base(&self) -> &Base {
        &self.base
    }
    fn base_mut(&mut self) -> &mut Base {
        &mut self.base
    }
    fn post_count(&self) -> usize {
        3 * self.pole_count
    }
    fn voltage_source_count(&self) -> usize {
        if self.resistance > 0.0 {
            0
        } else {
            self.pole_count
        }
    }
    fn voltage_source_nodes(&self, k: usize) -> (usize, usize) {
        // The source joins the closure of the throw it actually stamps, which
        // moves with the position (DPDTSwitchElm.java:180-184).
        (
            self.base.nodes[3 * k],
            self.base.nodes[self.position as usize + 1 + 3 * k],
        )
    }
    fn connects(&self, a: usize, b: usize) -> bool {
        // Any pole's pole-to-selected-throw pair (DPDTSwitchElm.java:201-206).
        (0..self.pole_count).any(|i| {
            let sel = self.position as usize + 1 + 3 * i;
            (a == 3 * i && b == sel) || (b == 3 * i && a == sel)
        })
    }

    fn stamp(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        for i in 0..self.pole_count {
            let (n0, n1) = (
                self.base.nodes[3 * i],
                self.base.nodes[self.position as usize + 1 + 3 * i],
            );
            if self.resistance > 0.0 {
                s.resistor(n0, n1, self.resistance);
            } else {
                s.voltage_source(n0, n1, self.base.vs_base + i, 0.0);
            }
        }
    }

    fn calculate_current(&mut self, _ctx: &SimCtx) {
        for i in 0..self.pole_count {
            self.currents[i] = if self.resistance > 0.0 {
                (self.base.volts[3 * i] - self.base.volts[self.position as usize + 1 + 3 * i])
                    / self.resistance
            } else {
                self.base.vs_currents[i]
            };
        }
        self.base.current = self.currents[0];
    }

    fn current_into_node(&self, post: usize) -> f64 {
        // Per pole, the pole post drains the pole's current and the selected
        // throw injects it (DPDTSwitchElm.java:146-154).
        let t = post / 3;
        let n3 = post % 3;
        if n3 == 0 {
            -self.currents[t]
        } else if n3 == (self.position + 1) as usize {
            self.currents[t]
        } else {
            0.0
        }
    }

    fn set_state(&mut self, state: i32) -> bool {
        self.position = state.clamp(0, 1);
        // The throw pairing changes which terminals merge, so the caller has
        // to re-analyse rather than just re-stamp.
        true
    }

    fn set_param(&mut self, name: &str, value: f64) -> bool {
        match name {
            "momentary" => self.momentary = value != 0.0,
            // A resistance edit that crosses the ideal/resistor boundary flips
            // `voltage_source_count` from 0 to `pole_count`, which the live
            // restamp cannot reallocate: the closure builder would index the
            // new vs slots past the end of the stale array. Return false so
            // the caller does a full rebuild, which reallocates and
            // re-serialises the edited resistance. A same-side edit keeps the
            // fast path and the sim clock.
            "resistance" => {
                if (value > 0.0) != (self.resistance > 0.0) {
                    return false;
                }
                self.resistance = value;
            }
            // poleCount changes the post count, which a live edit cannot;
            // falling through returns false and the caller rebuilds.
            "poleCount" => return false,
            _ => return false,
        }
        true
    }

    fn reset(&mut self) {
        self.base.reset();
        self.currents.iter_mut().for_each(|c| *c = 0.0);
    }
}
