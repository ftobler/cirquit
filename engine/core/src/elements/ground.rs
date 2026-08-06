//! The reference node symbol.

use crate::element::{Base, Element};
use crate::spec::ElementSpec;

/// The reference node symbol. Contributes nothing to the matrix: analysis
/// remaps its terminal onto node 0 directly.
pub struct Ground {
    base: Base,
}

impl Ground {
    pub fn new(_spec: &ElementSpec) -> Self {
        Self {
            base: Base::with_posts(1),
        }
    }
}

impl Element for Ground {
    fn kind(&self) -> &'static str {
        "ground"
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
    fn is_ground(&self) -> bool {
        true
    }
}
