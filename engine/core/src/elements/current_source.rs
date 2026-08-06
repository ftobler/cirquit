//! Independent current source.

use crate::element::{Base, Element, SimCtx};
use crate::spec::ElementSpec;
use crate::stamp::Stamper;

/// Two-terminal current source pushing `current` from post 0 to post 1.
pub struct CurrentSource {
    base: Base,
    current_value: f64,
}

impl CurrentSource {
    pub fn new(spec: &ElementSpec) -> Self {
        Self {
            base: Base::with_posts(2),
            current_value: spec.param("current", 0.01),
        }
    }
}

impl Element for CurrentSource {
    fn kind(&self) -> &'static str {
        "current"
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
        let (n0, n1) = (self.base.nodes[0], self.base.nodes[1]);
        s.current_source(n0, n1, self.current_value);
    }

    fn calculate_current(&mut self, _ctx: &SimCtx) {
        self.base.current = self.current_value;
    }

    fn display_voltage_diff(&self) -> f64 {
        // Upstream's current source reads out volts[1] - volts[0]
        // (CurrentElm.java:199-201), the same positive-EMF convention as the
        // voltage source.
        self.base.volts[1] - self.base.volts[0]
    }

    /// An ideal current source does not tie its terminals together, so it
    /// cannot rescue a node from floating.
    fn connects(&self, _a: usize, _b: usize) -> bool {
        false
    }

    fn set_param(&mut self, name: &str, value: f64) -> bool {
        if name == "current" {
            self.current_value = value;
            return true;
        }
        false
    }
}
