//! An ideal wire.

use crate::element::{Base, Element};
use crate::spec::ElementSpec;

/// An ideal wire. Merged out of the matrix before stamping, so its two
/// endpoints become one node and the matrix never allocates a row or a
/// current unknown for it. Its current is indeterminate to the solve, so the
/// recovery pass derives it from the currents of the elements around it.
pub struct Wire {
    base: Base,
}

impl Wire {
    pub fn new(_spec: &ElementSpec) -> Self {
        Self {
            base: Base::with_posts(2),
        }
    }
}

impl Element for Wire {
    fn kind(&self) -> &'static str {
        "wire"
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
    fn removable_wire(&self) -> bool {
        true
    }
}
