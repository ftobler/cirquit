//! Single-pole switch.

use crate::element::{Base, Element, SimCtx};
use crate::spec::ElementSpec;

/// Single-pole switch. Closed it behaves as a wire; open it contributes
/// nothing, and the analyser's floating-node handling copes with whatever is
/// left dangling.
///
/// Position 0 is closed, matching the file format.
pub struct Switch {
    base: Base,
    position: i32,
    momentary: bool,
}

impl Switch {
    pub fn new(spec: &ElementSpec) -> Self {
        Self {
            base: Base::with_posts(2),
            position: spec.param("position", 0.0) as i32,
            momentary: spec.param("momentary", 0.0) != 0.0,
        }
    }

    fn closed(&self) -> bool {
        self.position == 0
    }
}

impl Element for Switch {
    fn kind(&self) -> &'static str {
        "switch"
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
    fn connects(&self, _a: usize, _b: usize) -> bool {
        self.closed()
    }
    /// A closed switch is an ideal short like a wire: the analyser merges its
    /// terminals and the matrix never sees it. An open switch contributes
    /// nothing either way, so no position carries a current unknown.
    fn removable_wire(&self) -> bool {
        self.closed()
    }
    fn calculate_current(&mut self, _ctx: &SimCtx) {
        // The recovery pass owns a closed switch's current; an open switch is
        // an open circuit. `vs_currents` is empty in both positions.
        self.base.current = 0.0;
    }
    fn set_state(&mut self, state: i32) -> bool {
        self.position = state.clamp(0, 1);
        // Changing position changes which terminals merge, so the caller has
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
