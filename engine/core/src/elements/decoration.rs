//! Text annotation with no electrical presence (TextElm.java, dump 'x').

use crate::element::{Base, Element};
use crate::spec::ElementSpec;

/// A free-text label drawn at an arbitrary point to annotate a circuit.
/// Upstream extends `GraphicElm`, whose post count is zero
/// (GraphicElm.java:35): the anchor is drawing geometry and never touches a
/// node, so the model is a shell that exists only so a loaded `x` line keeps
/// its slot in the element list and round-trips as the element it is, not as
/// an unknown line.
pub struct Decoration {
    base: Base,
}

impl Decoration {
    pub fn new(_spec: &ElementSpec) -> Self {
        Self {
            base: Base::with_posts(0),
        }
    }
}

impl Element for Decoration {
    fn kind(&self) -> &'static str {
        "decoration"
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
    /// A decoration couples no terminals: there is no current path, so its
    /// anchor must never merge into a node.
    fn connects(&self, _a: usize, _b: usize) -> bool {
        false
    }
}
