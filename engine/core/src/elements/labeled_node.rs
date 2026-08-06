//! The named-node connector.

use crate::element::{Base, Element};
use crate::spec::ElementSpec;

/// Connects by name rather than by position: every named node sharing a label
/// is merged into one node during analysis.
pub struct LabeledNode {
    base: Base,
    label: String,
}

impl LabeledNode {
    pub fn new(spec: &ElementSpec) -> Self {
        Self {
            base: Base::with_posts(1),
            label: spec.label.clone().unwrap_or_default(),
        }
    }
}

impl Element for LabeledNode {
    fn kind(&self) -> &'static str {
        "labeledNode"
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
    fn node_label(&self) -> Option<&str> {
        if self.label.is_empty() {
            None
        } else {
            Some(&self.label)
        }
    }
}
