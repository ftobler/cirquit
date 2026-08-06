//! Voltmeter-style readouts.

use crate::element::{Base, Element, SimCtx};
use crate::spec::ElementSpec;

/// A voltmeter-style readout. Ideal, so it draws no current.
pub struct Meter {
    base: Base,
    kind: &'static str,
    posts: usize,
}

impl Meter {
    /// Single-terminal node voltage display.
    pub fn new_output(_spec: &ElementSpec) -> Self {
        Self {
            base: Base::with_posts(1),
            kind: "output",
            posts: 1,
        }
    }

    /// Two-terminal differential probe.
    pub fn new_probe(_spec: &ElementSpec) -> Self {
        Self {
            base: Base::with_posts(2),
            kind: "probe",
            posts: 2,
        }
    }
}

impl Element for Meter {
    fn kind(&self) -> &'static str {
        self.kind
    }
    fn base(&self) -> &Base {
        &self.base
    }
    fn base_mut(&mut self) -> &mut Base {
        &mut self.base
    }
    fn post_count(&self) -> usize {
        self.posts
    }
    /// An ideal meter has infinite impedance, so it does not couple its
    /// terminals.
    fn connects(&self, _a: usize, _b: usize) -> bool {
        false
    }
    fn calculate_current(&mut self, _ctx: &SimCtx) {
        self.base.current = 0.0;
    }
}
