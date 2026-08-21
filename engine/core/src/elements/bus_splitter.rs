//! Bus splitter (BusSplitterElm.java, dump 433): `bits` bus-side pins hang at
//! one coordinate, each carrying its own bit, and each individual pin `i` is
//! an ideal short to bus bit `i`, so a bus wire fans out into per-bit wires.
//! The file line carries only the `bits` token, exactly ChipElm's
//! `needsBits` stream (ChipElm.java:51-55).
//!
//! Upstream merges every bit pair out of the matrix (`isRemovableWire`,
//! BusSplitterElm.java:65-66): bit `j`'s bus pin and individual pin collapse
//! into one node, exactly like a wire's endpoints but one pair per bit. This
//! port now does the same, through the per-pair merge hooks plus the
//! per-bit terminal tags. The merge matters for singularity: two splitters
//! joined bus-to-bus and wired through on the individual side would
//! otherwise close a ring of ideal 0 V sources, which has no solution.
//! Per-bit currents come from the wire-current recovery instead of voltage
//! source unknowns, which reports the same numbers
//! (`getCurrentIntoNode`, BusSplitterElm.java:73-77).

use crate::element::{Base, Element, SimCtx};
use crate::spec::ElementSpec;

pub struct BusSplitter {
    base: Base,
    bits: usize,
    /// Per-bit current from the last recovery pass, positive bus side to
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
    /// Every bit pair is an ideal short merged out of the matrix, one pair
    /// per bit (isRemovableWire, BusSplitterElm.java:65-66).
    fn removable_wire(&self) -> bool {
        true
    }
    fn removable_wire_pair_count(&self) -> usize {
        self.bits
    }
    fn removable_wire_pair(&self, k: usize) -> (usize, usize) {
        (k, k + self.bits)
    }
    /// The bus-side pins all sit at one coordinate and each carries its own
    /// bit (`pins[ii].busZ = i`, BusSplitterElm.java:44), so bit i merges only
    /// with bit-i terminals of whatever touches that coordinate: the real
    /// fan-out. The individual pins are plain bit-0 terminals.
    fn post_bus_z(&self, post: usize) -> usize {
        if post < self.bits {
            post
        } else {
            0
        }
    }
    /// Bus bit `i` connects only to individual pin `i + bits`
    /// (getConnection, BusSplitterElm.java:60-63).
    fn connects(&self, a: usize, b: usize) -> bool {
        a.abs_diff(b) == self.bits
    }
    /// Receives one recovered bit current and keeps `base.current` at the
    /// sum, what the dots animate (`setWireCurrent` totals onto pin 0,
    /// BusSplitterElm.java:79-87).
    fn set_recovered_pair_current(&mut self, pair: usize, current: f64) {
        if let Some(c) = self.currents.get_mut(pair) {
            *c = current;
        }
        self.base.current = self.currents.iter().sum();
    }
    fn calculate_current(&mut self, _ctx: &SimCtx) {}
    fn current_into_node(&self, post: usize) -> f64 {
        // getCurrentIntoNode (BusSplitterElm.java:73-77): the bus-side pins
        // drain their bit's current from the shared node, the individual pins
        // deliver it.
        match self.currents.get(post % self.bits) {
            Some(&c) => {
                if post < self.bits {
                    -c
                } else {
                    c
                }
            }
            None => 0.0,
        }
    }
    fn set_param(&mut self, _name: &str, _value: f64) -> bool {
        // "bits" changes the post count, which only a full rebuild can
        // reallocate.
        false
    }
    fn reset(&mut self) {
        self.base.reset();
        self.currents.iter_mut().for_each(|c| *c = 0.0);
    }
}
