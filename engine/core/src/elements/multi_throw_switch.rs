//! Multi-throw (SPDT and up) switch.

use crate::element::{Base, Element, SimCtx};
use crate::spec::ElementSpec;
use crate::stamp::Stamper;

/// Multi-throw switch. Post 0 is the common terminal, the rest are throws.
pub struct MultiThrowSwitch {
    base: Base,
    position: i32,
    throw_count: usize,
}

impl MultiThrowSwitch {
    pub fn new(spec: &ElementSpec) -> Self {
        let throws = (spec.param("throwCount", 2.0) as usize).clamp(2, 8);
        Self {
            base: Base::with_posts(1 + throws),
            position: spec.param("position", 0.0) as i32,
            throw_count: throws,
        }
    }

    fn selected_post(&self) -> usize {
        1 + (self.position as usize).min(self.throw_count - 1)
    }
}

impl Element for MultiThrowSwitch {
    fn kind(&self) -> &'static str {
        "switch2"
    }
    fn base(&self) -> &Base {
        &self.base
    }
    fn base_mut(&mut self) -> &mut Base {
        &mut self.base
    }
    fn post_count(&self) -> usize {
        1 + self.throw_count
    }
    fn voltage_source_count(&self) -> usize {
        1
    }
    fn voltage_source_nodes(&self, _k: usize) -> (usize, usize) {
        // `stamp` drives the source between the common post and the selected
        // throw, so the unknown must join the selected throw's closure, not
        // the first non-ground post's. Upstream's `setVoltageSource` records
        // exactly this pairing.
        (self.base.nodes[0], self.base.nodes[self.selected_post()])
    }
    fn connects(&self, a: usize, b: usize) -> bool {
        let sel = self.selected_post();
        (a == 0 && b == sel) || (b == 0 && a == sel)
    }
    fn stamp(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        let sel = self.selected_post();
        s.voltage_source(
            self.base.nodes[0],
            self.base.nodes[sel],
            self.base.vs_base,
            0.0,
        );
    }
    fn calculate_current(&mut self, _ctx: &SimCtx) {
        self.base.current = self.base.vs_currents[0];
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
    fn set_state(&mut self, state: i32) -> bool {
        self.position = state.rem_euclid(self.throw_count as i32);
        true
    }
}
