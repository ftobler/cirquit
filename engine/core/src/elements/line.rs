//! Decoration with no electrical presence.

use crate::element::{Base, Element};
use crate::spec::ElementSpec;

/// A straight line drawn between two points (LineElm.java). Upstream declares
/// no posts at all (GraphicElm.java:35), so the two endpoints are drawing
/// geometry, never terminals: the model has zero posts, connects nothing and
/// exists only so a `423` netlist line round-trips through the engine.
pub struct Line {
    base: Base,
}

impl Line {
    pub fn new(_spec: &ElementSpec) -> Self {
        Self {
            base: Base::with_posts(0),
        }
    }
}

impl Element for Line {
    fn kind(&self) -> &'static str {
        "line"
    }
    fn base(&self) -> &Base {
        &self.base
    }
    fn base_mut(&mut self) -> &mut Base {
        &mut self.base
    }
    fn post_count(&self) -> usize {
        0
    }
    /// No posts exist to couple: the line must never merge a node, or a wire
    /// dropped on its endpoints would connect where upstream does not.
    fn connects(&self, _a: usize, _b: usize) -> bool {
        false
    }
}
