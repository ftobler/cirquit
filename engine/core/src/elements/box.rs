//! Box annotation with no electrical presence (BoxElm.java).

use crate::element::{Base, Element};
use crate::spec::ElementSpec;

/// A dashed rectangle drawn between two arbitrary corners to annotate a
/// circuit. Upstream extends `GraphicElm`, whose post count is zero
/// (GraphicElm.java:35), so the box never touches a node. The model is a
/// shell that exists only so a loaded `b` line keeps its slot in the element
/// list and round-trips as the element it is, not as an unknown line.
pub struct Box {
    base: Base,
}

impl Box {
    pub fn new(_spec: &ElementSpec) -> Self {
        Self {
            base: Base::with_posts(0),
        }
    }
}

impl Element for Box {
    fn kind(&self) -> &'static str {
        "box"
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
    /// corners must never merge into nodes.
    fn connects(&self, _a: usize, _b: usize) -> bool {
        false
    }
}
