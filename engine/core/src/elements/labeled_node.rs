//! The named-node connector.

use crate::element::{Base, Element};
use crate::spec::ElementSpec;

/// Connects by name rather than by position: every named node sharing a label
/// is merged into one node during analysis. A wide node presents one post per
/// bit at its anchor coordinate, each carrying its own bit index the way
/// upstream's getPost does (`new Point(x, y, n)`, LabeledNodeElm.java:130-135),
/// so bit b of the label lands on bit b of whatever bus touches the
/// coordinate.
pub struct LabeledNode {
    base: Base,
    label: String,
    width: usize,
}

impl LabeledNode {
    pub fn new(spec: &ElementSpec) -> Self {
        // Upstream defaults the width to 1 (LabeledNodeElm.java:67) and the
        // text format never saves it; the frontend's width resolver injects
        // the derived answer as a param on every build. The clamp bounds the
        // post count against a corrupt token, like every other width.
        let width = (spec.param("busWidth", 1.0) as usize).clamp(1, 32);
        Self {
            base: Base::with_posts(width),
            label: spec.label.clone().unwrap_or_default(),
            width,
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
        self.width
    }
    /// Wide posts share the anchor and are told apart only by their bit tag;
    /// a narrow one is plain bit 0 either way.
    fn post_bus_z(&self, post: usize) -> usize {
        post
    }
    fn node_label_key(&self, post: usize) -> Option<(&str, Option<usize>)> {
        if self.label.is_empty() {
            return None;
        }
        Some((&self.label, if self.width > 1 { Some(post) } else { None }))
    }
    /// Reads out the anchor's bit-0 level, upstream's `getVoltageDiff`
    /// (LabeledNodeElm.java:243): a labeled node is a junction, so a hover or
    /// a Voltage scope shows the net voltage, never the bit-to-bit difference
    /// the two-terminal default would compute for a wide node.
    fn voltage_diff(&self) -> f64 {
        self.base.volts.first().copied().unwrap_or(0.0)
    }
    /// Wire-equivalent like upstream (`getConnection` returns n1 == n2): no
    /// two distinct terminals couple in the matrix, so the floating-node pass
    /// cannot see bit 1 as grounded through bit 0.
    fn connects(&self, a: usize, b: usize) -> bool {
        a == b
    }
}
