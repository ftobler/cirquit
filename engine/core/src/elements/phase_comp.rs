//! Phase comparator (PhaseCompElm.java, dump 161): a digital phase detector
//! whose output carries which of two inputs rose first.
//!
//! Two edge-triggered flip-flops remember the order of the edges: I1 rising
//! sets ff1 and the output drives high, I2 rising sets ff2 and the output
//! drives low, and once both are set the cycle is complete and both clear,
//! returning the output to its idle state. While neither has risen the output
//! source is high impedance, its current tied to zero. That third state is
//! what makes the element nonlinear: the drive states stamp a full voltage
//! source and the idle state stamps a lone diagonal on the source's current
//! unknown, so the matrix structure depends on the internal state and cannot
//! be fixed in `stamp` (PhaseCompElm.java:36-65).

use crate::element::{Base, Element, SimCtx};
use crate::elements::chip::{Chip, ChipPin};
use crate::spec::ElementSpec;
use crate::stamp::{Stamper, GROUND};

pub struct PhaseComp {
    chip: Chip,
    /// True once I1 has risen first; the output drives high.
    ff1: bool,
    /// True once I2 has risen; the output drives low.
    ff2: bool,
}

impl PhaseComp {
    pub fn new(spec: &ElementSpec) -> Self {
        // Pin layout (PhaseCompElm.java:30-38): I1 and I2 on the west, the
        // single output on the east. No pin saves its level to the file, so
        // the chip base reads no `voltage{i}` tokens.
        let pins = vec![
            ChipPin::input(),       // 0 I1
            ChipPin::input(),       // 1 I2
            ChipPin::output(false), // 2 O, never saved
        ];
        Self {
            chip: Chip::new(spec, pins),
            ff1: false,
            ff2: false,
        }
    }
}

impl Element for PhaseComp {
    fn kind(&self) -> &'static str {
        "phaseComp"
    }
    fn base(&self) -> &Base {
        &self.chip.base
    }
    fn base_mut(&mut self) -> &mut Base {
        &mut self.chip.base
    }
    fn post_count(&self) -> usize {
        3
    }
    fn voltage_source_count(&self) -> usize {
        self.chip.voltage_source_count()
    }
    fn voltage_source_nodes(&self, k: usize) -> (usize, usize) {
        self.chip.voltage_source_nodes(k)
    }
    /// No current path between posts: the inputs are logic levels and only the
    /// output source ties its node to ground when driving (ChipElm.java:467).
    fn connects(&self, _a: usize, _b: usize) -> bool {
        false
    }
    /// Every post shares the output's closure so the idle-state stamp
    /// (`raw(vs, vs, 1)`) lands in the source's system: the element's closure
    /// is the closure of its first non-ground node, which must be the output's
    /// (PhaseCompElm.java:70).
    fn matrix_connects(&self, _a: usize, _b: usize) -> bool {
        true
    }
    /// The output source's matrix structure depends on the internal state, so
    /// the element is re-stamped on every Newton iteration (PhaseCompElm.java:39).
    fn nonlinear(&self) -> bool {
        true
    }

    /// Nothing constant to contribute: the source is stamped only in the state
    /// `do_step` chooses, exactly as upstream's `stamp` only marks the nodes
    /// nonlinear (PhaseCompElm.java:40-44).
    fn stamp(&mut self, _ctx: &SimCtx, _s: &mut Stamper) {}

    fn start_iteration(&mut self, _ctx: &SimCtx) {
        // The input pins' committed values from the previous step are the edge
        // memory (pins[0].value / pins[1].value, PhaseCompElm.java:49-56).
        let prev1 = self.chip.pins[0].value;
        let prev2 = self.chip.pins[1].value;
        if self.chip.read_inputs() {
            let v1 = self.chip.pins[0].value;
            let v2 = self.chip.pins[1].value;
            if v1 && !prev1 {
                self.ff1 = true;
            }
            if v2 && !prev2 {
                self.ff2 = true;
            }
            // Both edges seen: the phase cycle is complete, clear both.
            if self.ff1 && self.ff2 {
                self.ff1 = false;
                self.ff2 = false;
            }
        }
    }

    fn do_step(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        let vs = self.chip.base.vs_base;
        if self.ff1 {
            s.voltage_source(GROUND, self.chip.base.nodes[2], vs, self.chip.high_voltage);
        } else if self.ff2 {
            s.voltage_source(GROUND, self.chip.base.nodes[2], vs, 0.0);
        } else {
            // Neither edge seen: float the output and tie its source current
            // to zero (stampMatrix(vs, vs, 1), PhaseCompElm.java:63-64).
            let row = s.vs_row(vs);
            s.raw(row, row, 1.0);
        }
    }

    fn calculate_current(&mut self, _ctx: &SimCtx) {
        self.chip.base.current = 0.0;
    }

    fn current_into_node(&self, post: usize) -> f64 {
        self.chip.current_into_node(post)
    }

    fn set_param(&mut self, name: &str, value: f64) -> bool {
        match name {
            "highVoltage" => self.chip.high_voltage = value,
            _ => return false,
        }
        true
    }

    fn reset(&mut self) {
        self.chip.reset();
        // A reset returns to t = 0, where no edge has been seen. Upstream's
        // ChipElm.reset clears the pins but forgets the internal flip-flops,
        // so a reset there keeps a stale phase state; the port clears them to
        // match what a fresh build does.
        self.ff1 = false;
        self.ff2 = false;
    }
}
