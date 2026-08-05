//! Elements that carry meaning for the UI but contribute nothing to the
//! matrix, plus the named-node connector.

use crate::element::{Base, Element, SimCtx};
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

/// Annotation with no electrical presence at all (text, boxes, lines).
pub struct Decoration {
    base: Base,
    posts: usize,
}

impl Decoration {
    pub fn new(spec: &ElementSpec) -> Self {
        let posts = spec.posts.len();
        Self {
            base: Base::with_posts(posts),
            posts,
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
        self.posts
    }
    fn connects(&self, _a: usize, _b: usize) -> bool {
        false
    }
}
