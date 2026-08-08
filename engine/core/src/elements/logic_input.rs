//! Logic input: a one-post voltage source to ground whose output follows a
//! user-settable position (LogicInputElm.java).

use crate::element::{Base, Element, SimCtx};
use crate::spec::ElementSpec;
use crate::stamp::{Stamper, GROUND};

/// Load-time flag meanings, shared with the TypeScript registry
/// (LogicInputElm.java:26-27). FLAG_NUMERIC (bit 2) is display-only and never
/// reaches the engine.
const FLAG_TERNARY: i64 = 1;

/// One-post logic-level source. Position 0 drives `loV`, position 1 `hiV`;
/// under FLAG_TERNARY a third position drives the midpoint, and the ternary
/// formula degenerates to the plain two-level one at positions 0 and 2
/// (LogicInputElm.java:106-109).
pub struct LogicInput {
    base: Base,
    hi_v: f64,
    lo_v: f64,
    position: i32,
    /// Display/shortcut concept upstream; stored for round-trip only.
    momentary: bool,
    is_ternary: bool,
}

impl LogicInput {
    pub fn new(spec: &ElementSpec) -> Self {
        Self {
            base: Base::with_posts(1),
            hi_v: spec.param("hiV", 5.0),
            lo_v: spec.param("loV", 0.0),
            position: spec.param("position", 0.0) as i32,
            momentary: spec.param("momentary", 0.0) != 0.0,
            is_ternary: spec.flag(FLAG_TERNARY),
        }
    }

    fn output_voltage(&self) -> f64 {
        if self.is_ternary {
            self.lo_v + self.position as f64 * (self.hi_v - self.lo_v) * 0.5
        } else if self.position == 0 {
            self.lo_v
        } else {
            self.hi_v
        }
    }
}

impl Element for LogicInput {
    fn kind(&self) -> &'static str {
        "logicInput"
    }
    fn base(&self) -> &Base {
        &self.base
    }
    fn base_mut(&mut self) -> &mut Base {
        &mut self.base
    }
    fn post_count(&self) -> usize {
        1
    }
    fn voltage_source_count(&self) -> usize {
        1
    }
    fn voltage_source_nodes(&self, _k: usize) -> (usize, usize) {
        // The single post is driven against ground (LogicInputElm.java:99),
        // so the unknown must land in the post's closure.
        (GROUND, self.base.nodes[0])
    }
    /// No current path between posts: there is only one, and it is the output
    /// of a voltage source (LogicInputElm.java:102-103).
    fn connects(&self, _a: usize, _b: usize) -> bool {
        false
    }
    /// A voltage source pins a capacitor loop, so the CAP_V walk must be able
    /// to cross one, the same role the rail plays.
    fn is_voltage_source(&self) -> bool {
        true
    }

    fn stamp(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        // Topology once with a zero value; `do_step` supplies the level every
        // iteration, so a position change only restamps the RHS, never the
        // matrix structure.
        s.voltage_source(GROUND, self.base.nodes[0], self.base.vs_base, 0.0);
    }

    fn do_step(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        s.voltage_source_value(self.base.vs_base, self.output_voltage());
    }

    fn calculate_current(&mut self, _ctx: &SimCtx) {
        // The source delivers `vs_currents[0]` into the post's node, which is
        // the current upstream reports (getCurrentIntoNode,
        // LogicInputElm.java:177-179).
        self.base.current = self.base.vs_currents[0];
    }

    fn current_into_node(&self, post: usize) -> f64 {
        if post == 0 {
            self.base.current
        } else {
            0.0
        }
    }

    /// The post's own voltage is what the readout and a scope show
    /// (getVoltageDiff, LogicInputElm.java:112).
    fn voltage_diff(&self) -> f64 {
        self.base.volts[0]
    }

    fn set_state(&mut self, state: i32) -> bool {
        let max = if self.is_ternary { 2 } else { 1 };
        self.position = state.clamp(0, max);
        true
    }

    fn set_param(&mut self, name: &str, value: f64) -> bool {
        match name {
            "hiV" => self.hi_v = value,
            "loV" => self.lo_v = value,
            "momentary" => self.momentary = value != 0.0,
            _ => return false,
        }
        true
    }

    fn reset(&mut self) {
        self.base.reset();
    }
}
