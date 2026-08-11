//! Single-pole switch.

use crate::element::{Base, Element, SimCtx};
use crate::spec::ElementSpec;
use crate::stamp::Stamper;

/// Closed resistance a switch child stamps inside a composite, mirroring
/// upstream's `COMPOSITE_CLOSED_R` (SwitchElm.java:31). Top level a closed
/// switch is a removable wire and never stamps; inside a composite the wire
/// merging only runs for top-level elements, so the switch has to be a real
/// small resistor there (SwitchElm.java:222-229).
const COMPOSITE_CLOSED_R: f64 = 0.001;

/// Single-pole switch. Closed it behaves as a wire; open it contributes
/// nothing, and the analyser's floating-node handling copes with whatever is
/// left dangling.
///
/// Position 0 is closed, matching the file format.
pub struct Switch {
    base: Base,
    position: i32,
    momentary: bool,
    /// True for a child of a composite, upstream's `inComposite`
    /// (CompositeElm.java:101): such a switch cannot be merged as a wire, so
    /// a closed one stamps `COMPOSITE_CLOSED_R` instead.
    in_composite: bool,
}

impl Switch {
    pub fn new(spec: &ElementSpec) -> Self {
        Self {
            base: Base::with_posts(2),
            position: spec.param("position", 0.0) as i32,
            momentary: spec.param("momentary", 0.0) != 0.0,
            in_composite: spec.param("inComposite", 0.0) != 0.0,
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
    /// A closed top-level switch is an ideal short like a wire: the analyser
    /// merges its terminals and the matrix never sees it. Inside a composite
    /// the merge never runs, so there the closed switch stamps its 1e-3 ohm
    /// resistance instead and must not be reported removable
    /// (SwitchElm.java:219-220).
    fn removable_wire(&self) -> bool {
        self.closed() && !self.in_composite
    }
    fn stamp(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        if self.in_composite && self.closed() {
            s.resistor(self.base.nodes[0], self.base.nodes[1], COMPOSITE_CLOSED_R);
        }
    }
    fn calculate_current(&mut self, _ctx: &SimCtx) {
        // A top-level closed switch is merged away and its current comes from
        // the wire-current recovery pass; an open switch is an open circuit.
        // Only a closed switch inside a composite needs its own current, from
        // the 1e-3 ohm it stamps (SwitchElm.java:171-178).
        self.base.current = if self.in_composite && self.closed() {
            self.base.voltage_diff() / COMPOSITE_CLOSED_R
        } else {
            0.0
        };
    }
    fn set_state(&mut self, state: i32) -> bool {
        self.position = state.clamp(0, 1);
        // Changing position changes which terminals merge (top level) or the
        // stamped closed resistance (in a composite), so the caller has to
        // re-analyse rather than just re-stamp.
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
