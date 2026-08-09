//! Cross (crossover) switch.

use crate::element::{Base, Element, SimCtx};
use crate::spec::ElementSpec;
use crate::stamp::Stamper;

/// The cross switch always has two pole pairs (CrossSwitchElm.java:23).
const POLES: usize = 2;

/// Cross switch: two independent SPST channels whose throw pairing swaps with
/// the lever. Position 0 connects posts (0,1) and (2,3) straight through;
/// position 1 crosses them to (0,3) and (2,1). Unlike the plain switch the
/// part is never merged out of the matrix: every pole is an ideal short
/// stamped as a 0 V voltage source, so its current stays reportable
/// (CrossSwitchElm.java:200-218, :231-234).
pub struct CrossSwitch {
    base: Base,
    position: i32,
    momentary: bool,
    /// Per-pole current from the last solved step, for the wire-current
    /// recovery.
    currents: [f64; POLES],
}

impl CrossSwitch {
    pub fn new(spec: &ElementSpec) -> Self {
        Self {
            base: Base::with_posts(2 * POLES),
            position: spec.param("position", 0.0) as i32,
            momentary: spec.param("momentary", 0.0) != 0.0,
            currents: [0.0; POLES],
        }
    }

    /// The throw post pole `p` joins at the current position: straight
    /// through (p, 2p+1) at position 0, crossed (p, 3-2p) at position 1
    /// (CrossSwitchElm.java:203-217).
    fn other_end(&self, pole: usize) -> usize {
        if self.position == 0 {
            pole * 2 + 1
        } else {
            3 - pole * 2
        }
    }
}

impl Element for CrossSwitch {
    fn kind(&self) -> &'static str {
        "crossSwitch"
    }
    fn base(&self) -> &Base {
        &self.base
    }
    fn base_mut(&mut self) -> &mut Base {
        &mut self.base
    }
    fn post_count(&self) -> usize {
        2 * POLES
    }
    /// Every pole is an ideal short, and `isRemovableWire` is false upstream,
    /// so each short is stamped as a 0 V voltage source rather than merged
    /// away (CrossSwitchElm.java:231-234).
    fn voltage_source_count(&self) -> usize {
        POLES
    }
    /// The source must join the closure of the throw it actually stamps, and
    /// that throw flips with the position, so only the element knows the pair
    /// (upstream's `setVoltageSource`, CrossSwitchElm.java:194-198).
    fn voltage_source_nodes(&self, k: usize) -> (usize, usize) {
        (self.base.nodes[2 * k], self.base.nodes[self.other_end(k)])
    }
    fn connects(&self, a: usize, b: usize) -> bool {
        (0..POLES).any(|p| {
            let other = self.other_end(p);
            (a == 2 * p && b == other) || (b == 2 * p && a == other)
        })
    }
    fn stamp(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        for p in 0..POLES {
            s.voltage_source(
                self.base.nodes[2 * p],
                self.base.nodes[self.other_end(p)],
                self.base.vs_base + p,
                0.0,
            );
        }
    }
    fn calculate_current(&mut self, _ctx: &SimCtx) {
        for p in 0..POLES {
            self.currents[p] = self.base.vs_currents[p];
        }
        self.base.current = self.currents.iter().sum();
    }
    fn current_into_node(&self, post: usize) -> f64 {
        // Upstream's getCurrentIntoNode (CrossSwitchElm.java:159-165): the
        // even posts are the poles, each draining its own channel's current;
        // at position 1 the odd throw posts carry the crossed channel's
        // current instead of their own.
        if post.is_multiple_of(2) {
            -self.currents[post / 2]
        } else if self.position == 0 {
            self.currents[post / 2]
        } else {
            self.currents[1 - post / 2]
        }
    }
    fn set_state(&mut self, state: i32) -> bool {
        self.position = state.clamp(0, 1);
        // The throw pairing changes which terminals merge, so the caller has
        // to re-analyse rather than just re-stamp.
        true
    }
    fn set_param(&mut self, name: &str, value: f64) -> bool {
        if name == "momentary" {
            self.momentary = value != 0.0;
            true
        } else {
            false
        }
    }
}
