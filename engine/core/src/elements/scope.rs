//! Scope embedded in the schematic (ScopeElm.java).

use crate::element::{Base, Element};
use crate::spec::ElementSpec;

/// A scope drawn as an element inside the schematic. It has zero posts, like
/// the box and line annotations, so it never touches a node and has no
/// electrical effect. The whole embedded scope view's configuration rides on
/// the element line as one underscore-joined token (ScopeElm.java:47-50);
/// the model carries it verbatim so the element is a faithful representation
/// of the file format, even though nothing in the engine reads it. The
/// frontend owns the round trip, the same division the `o` scope-line
/// fidelity work uses.
pub struct Scope {
    base: Base,
    #[allow(dead_code)]
    config: String,
}

impl Scope {
    pub fn new(spec: &ElementSpec) -> Self {
        Self {
            base: Base::with_posts(0),
            config: spec.label.clone().unwrap_or_default(),
        }
    }
}

impl Element for Scope {
    fn kind(&self) -> &'static str {
        "scope"
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
    /// A scope couples no terminals: there is no current path, so its corners
    /// must never merge into nodes.
    fn connects(&self, _a: usize, _b: usize) -> bool {
        false
    }
}
