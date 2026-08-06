//! Ohmic two-terminal resistor.

use crate::element::{two_terminal_current, Base, Element, SimCtx};
use crate::spec::ElementSpec;
use crate::stamp::Stamper;

pub struct Resistor {
    base: Base,
    resistance: f64,
}

impl Resistor {
    pub fn new(spec: &ElementSpec) -> Self {
        Self {
            base: Base::with_posts(2),
            resistance: spec.param("resistance", 1000.0),
        }
    }
}

impl Element for Resistor {
    fn kind(&self) -> &'static str {
        "resistor"
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
    fn stamp(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        s.resistor(self.base.nodes[0], self.base.nodes[1], self.resistance);
    }
    fn calculate_current(&mut self, _ctx: &SimCtx) {
        self.base.current = two_terminal_current(&self.base, self.resistance);
    }
    fn set_param(&mut self, name: &str, value: f64) -> bool {
        if name == "resistance" && value > 0.0 {
            self.resistance = value;
            true
        } else {
            false
        }
    }
}
