//! Bus logic input (BusLogicInputElm.java, XML type "bli").
//!
//! An N-bit wide logic input: one part drives N independent nodes, bit i of
//! its `value` becoming hiV or loV on post i. Every post sits at the same
//! coordinate carrying its own bus bit (`getPost(n) = new Point(x, y, n)`,
//! BusLogicInputElm.java:61-63), so a bus splitter's bus side or a bus wire
//! meets all N bits at once.
//!
//! Upstream saves this class only in the XML format (`getDumpType` is 0), so
//! the port assigns dump code 435: free upstream, and next to the other
//! port-assigned XML-era codes (the instruction display's 434).

use crate::element::{Base, Element, SimCtx};
use crate::spec::ElementSpec;
use crate::stamp::{Stamper, GROUND};

pub struct BusLogicInput {
    base: Base,
    /// Driven levels.
    hi_v: f64,
    lo_v: f64,
    /// The driven word; bit i drives post i.
    value: u32,
    width: usize,
    /// Per-bit source currents from the last solved step, the port of
    /// upstream's `currents[]` that setCurrent fills
    /// (BusLogicInputElm.java:73-79).
    per_bit_currents: Vec<f64>,
}

impl BusLogicInput {
    pub fn new(spec: &ElementSpec) -> Self {
        // The edit dialog rejects fewer than 2 bits
        // (BusLogicInputElm.java:155-160); the clamp also bounds the post and
        // source count against a corrupt token.
        let width = (spec.param("busWidth", 4.0) as usize).clamp(2, 32);
        Self {
            base: Base::with_posts(width),
            hi_v: spec.param("hiV", 5.0),
            lo_v: spec.param("loV", 0.0),
            value: spec.param("value", 0.0) as u32,
            width,
            per_bit_currents: vec![0.0; width],
        }
    }

    fn bit_voltage(&self, bit: usize) -> f64 {
        if self.value & (1 << bit) != 0 {
            self.hi_v
        } else {
            self.lo_v
        }
    }
}

impl Element for BusLogicInput {
    fn kind(&self) -> &'static str {
        "busLogicInput"
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
    /// Every post shares the anchor coordinate and each carries its own bit
    /// (`getPost(n) = new Point(x, y, n)`, BusLogicInputElm.java:61-63), so
    /// the bit tags are what keep the pins apart.
    fn post_bus_z(&self, post: usize) -> usize {
        post
    }
    /// One source per bit, spanning ground to that bit's post
    /// (getVoltageSourceCount and stamp, BusLogicInputElm.java:59, :122-127).
    fn voltage_source_count(&self) -> usize {
        self.width
    }
    fn voltage_source_nodes(&self, k: usize) -> (usize, usize) {
        (GROUND, self.base.nodes[k])
    }
    /// Each post is a voltage-source output; no two posts couple
    /// (isWireEquivalent false, BusLogicInputElm.java:131).
    fn connects(&self, _a: usize, _b: usize) -> bool {
        false
    }
    /// The CAP_V walk must be able to cross these sources, exactly like the
    /// rail and the single-bit logic input.
    fn is_voltage_source(&self) -> bool {
        true
    }
    fn stamp(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        for k in 0..self.width {
            s.voltage_source(GROUND, self.base.nodes[k], self.base.vs_base + k, 0.0);
        }
    }
    fn do_step(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        for k in 0..self.width {
            s.voltage_source_value(self.base.vs_base + k, self.bit_voltage(k));
        }
    }
    fn calculate_current(&mut self, _ctx: &SimCtx) {
        // The engine hands the solved source currents back in vs_currents;
        // keeping them per bit is what makes the wire-current recovery see
        // each bit separately.
        self.per_bit_currents
            .copy_from_slice(&self.base.vs_currents);
        self.base.current = self.per_bit_currents.iter().sum();
    }
    fn current_into_node(&self, post: usize) -> f64 {
        // getCurrentIntoNode returns currents[n] per bit
        // (BusLogicInputElm.java:81-83).
        self.per_bit_currents.get(post).copied().unwrap_or(0.0)
    }
    /// The readout shows the post-0 level like the single-bit input does.
    fn voltage_diff(&self) -> f64 {
        self.base.volts.first().copied().unwrap_or(0.0)
    }
    /// Clicking cycles the value through 0..2^width-1 (toggle,
    /// BusLogicInputElm.java:116-120); the frontend wraps and sends the next
    /// word.
    fn set_state(&mut self, state: i32) -> bool {
        self.value = state.max(0) as u32;
        true
    }
    fn set_param(&mut self, name: &str, value: f64) -> bool {
        match name {
            "hiV" => self.hi_v = value,
            "loV" => self.lo_v = value,
            "value" => self.value = value as u32,
            _ => return false,
        }
        true
    }
    fn reset(&mut self) {
        self.base.reset();
        self.per_bit_currents.iter_mut().for_each(|c| *c = 0.0);
    }
}
