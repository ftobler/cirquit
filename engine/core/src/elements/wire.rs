//! An ideal wire, plain or N-bit.

use crate::element::{Base, Element};
use crate::spec::ElementSpec;

/// An ideal wire. Merged out of the matrix before stamping, so its two
/// endpoints become one node and the matrix never allocates a row or a
/// current unknown for it. Its current is indeterminate to the solve, so the
/// recovery pass derives it from the currents of the elements around it.
///
/// With `busWidth` N the wire carries N independent signals: post j and
/// post N + j are bit j's two ends, merged per bit and never across bits
/// (WireElm.java:40-58). The width comes from the file's optional trailing
/// token or from the wide pin the wire touches; the frontend resolves that
/// propagation and sends the effective width here.
pub struct Wire {
    base: Base,
    /// Signals carried, 1 for a plain wire. Clamped like every other width
    /// token so a hand-edited netlist cannot allocate unbounded posts.
    width: usize,
    /// Per-bit current from the last recovery pass, positive flowing post j
    /// to post N + j (upstream's `currents[bit]`, set via setWireCurrent).
    bit_currents: Vec<f64>,
}

impl Wire {
    pub fn new(spec: &ElementSpec) -> Self {
        let width = (spec.param("busWidth", 1.0) as usize).clamp(1, 32);
        Self {
            base: Base::with_posts(2 * width),
            width,
            bit_currents: vec![0.0; width],
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
        2 * self.width
    }
    fn removable_wire(&self) -> bool {
        true
    }
    /// One merge pair per bit: endpoints j and N + j are the same node, and
    /// no other pair is (WireElm.getConnection, WireElm.java:53-58).
    fn removable_wire_pair_count(&self) -> usize {
        self.width
    }
    fn removable_wire_pair(&self, k: usize) -> (usize, usize) {
        (k, k + self.width)
    }
    /// Bit j owns terminal j on the first end and terminal N + j on the
    /// second, upstream's `new Point(point1.x, point1.y, n)` z tags
    /// (WireElm.java:43-49). A plain wire keeps every terminal at bit 0.
    fn post_bus_z(&self, post: usize) -> usize {
        if self.width == 1 {
            0
        } else {
            post % self.width
        }
    }
    /// Stores one recovered bit current and keeps `base.current` at the sum,
    /// which is what the current dots animate (WireElm.draw sums currents[],
    /// WireElm.java:81-85).
    fn set_recovered_pair_current(&mut self, pair: usize, current: f64) {
        if let Some(c) = self.bit_currents.get_mut(pair) {
            *c = current;
        }
        self.base.current = self.bit_currents.iter().sum();
    }
    /// Per-terminal report for the renderer: each bus-side terminal drains
    /// its own bit's current, each far-end terminal delivers it
    /// (getCurrentIntoNode, WireElm.java:160-169).
    fn current_into_node(&self, post: usize) -> f64 {
        if self.width == 1 {
            return if post == 0 {
                -self.base.current
            } else {
                self.base.current
            };
        }
        match self.bit_currents.get(post % self.width) {
            Some(&c) => {
                if post < self.width {
                    -c
                } else {
                    c
                }
            }
            None => 0.0,
        }
    }
}
