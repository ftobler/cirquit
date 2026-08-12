//! Bus splitter (BusSplitterElm.java, dump 433): `bits` bus-side pins share
//! one node and each individual pin `i` is an ideal short to bus bit `i`, so a
//! bus wire fans out into per-bit wires. The file line carries only the `bits`
//! token, exactly ChipElm's `needsBits` stream (ChipElm.java:51-55).
//!
//! Upstream treats each bit pair as a removable wire merged out of the matrix
//! (`isRemovableWire`, BusSplitterElm.java:65-66) and recovers the per-bit
//! currents separately. This port keeps the same cross-switch pattern as the
//! crossed switch: every bit is a 0 V voltage source instead of a merge, so
//! the current each bit carries stays reportable and the per-bit
//! `current_into_node` matches `getCurrentIntoNode` (BusSplitterElm.java:
//! 73-77).

use crate::element::{Base, Element, SimCtx};
use crate::spec::ElementSpec;
use crate::stamp::Stamper;

pub struct BusSplitter {
    base: Base,
    bits: usize,
    /// Per-bit current from the last solved step, positive bus side to
    /// individual side (`currents`, BusSplitterElm.java:54).
    currents: Vec<f64>,
}

impl BusSplitter {
    pub fn new(spec: &ElementSpec) -> Self {
        // The edit dialog rejects fewer than 2 bits (BusSplitterElm.java:99);
        // the clamp also keeps a corrupt file token from allocating unbounded
        // posts and sources.
        let bits = (spec.param("bits", 4.0) as usize).clamp(2, 32);
        Self {
            base: Base::with_posts(2 * bits),
            bits,
            currents: vec![0.0; bits],
        }
    }
}

impl Element for BusSplitter {
    fn kind(&self) -> &'static str {
        "busSplitter"
    }
    fn base(&self) -> &Base {
        &self.base
    }
    fn base_mut(&mut self) -> &mut Base {
        &mut self.base
    }
    fn post_count(&self) -> usize {
        2 * self.bits
    }
    /// Every bit is an ideal short stamped as a 0 V source, the crossed
    /// switch's pattern: the current unknown makes each bit's current
    /// reportable (CrossSwitchElm.java:231-234).
    fn voltage_source_count(&self) -> usize {
        self.bits
    }
    /// Source `k` spans bus bit `k` to individual bit `k + bits`, the pair the
    /// merge would have tied (upstream's `getConnectedPost`).
    fn voltage_source_nodes(&self, k: usize) -> (usize, usize) {
        (self.base.nodes[k], self.base.nodes[k + self.bits])
    }
    /// Bus bit `i` connects only to individual pin `i + bits`
    /// (getConnection, BusSplitterElm.java:60-63).
    fn connects(&self, a: usize, b: usize) -> bool {
        a.abs_diff(b) == self.bits
    }
    fn stamp(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        for k in 0..self.bits {
            s.voltage_source(
                self.base.nodes[k],
                self.base.nodes[k + self.bits],
                self.base.vs_base + k,
                0.0,
            );
        }
    }
    fn calculate_current(&mut self, _ctx: &SimCtx) {
        for k in 0..self.bits {
            self.currents[k] = self.base.vs_currents[k];
        }
        self.base.current = self.currents.iter().sum();
    }
    fn current_into_node(&self, post: usize) -> f64 {
        // getCurrentIntoNode (BusSplitterElm.java:73-77): the bus-side pins
        // drain their bit's current from the shared node, the individual pins
        // deliver it.
        if post < self.bits {
            -self.currents[post]
        } else {
            self.currents[post - self.bits]
        }
    }
    fn set_param(&mut self, _name: &str, _value: f64) -> bool {
        // "bits" changes the post and source count, which only a full rebuild
        // can reallocate.
        false
    }
    fn reset(&mut self) {
        self.base.reset();
        self.currents.iter_mut().for_each(|c| *c = 0.0);
    }
}
