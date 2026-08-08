//! The seven basic logic gates: AND, OR and XOR families plus their
//! inverting variants, one shared model (GateElm.java).

use crate::element::{Base, Element, SimCtx};
use crate::spec::ElementSpec;
use crate::stamp::{Stamper, GROUND};

/// Load-time flag meanings, shared with the TypeScript registry
/// (GateElm.java:26-28).
const FLAG_SCHMITT: i64 = 2;
const FLAG_INVERT_INPUTS: i64 = 4;

/// Which Boolean function the gate computes before the output bubble.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Function {
    And,
    Or,
    Xor,
}

/// A gate's `kind` string, so the shared model can report which element it is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GateKind {
    And,
    Nand,
    Or,
    Nor,
    Xor,
    Xnor,
}

impl GateKind {
    fn function(self) -> Function {
        match self {
            GateKind::And | GateKind::Nand => Function::And,
            GateKind::Or | GateKind::Nor => Function::Or,
            GateKind::Xor | GateKind::Xnor => Function::Xor,
        }
    }

    /// Whether the output bubble inverts the computed function
    /// (NandGateElm/NorGateElm/XnorGateElm `isInverting`).
    fn is_inverting(self) -> bool {
        matches!(self, GateKind::Nand | GateKind::Nor | GateKind::Xnor)
    }
}

/// One multi-input logic gate. The output is an ideal voltage source to
/// ground whose value `do_step` computes from the input voltages, so the
/// matrix stays constant and the gate never refactors (GateElm.java:242-244).
pub struct Gate {
    base: Base,
    kind: GateKind,
    input_count: usize,
    high_voltage: f64,
    /// The output level from the previous committed step, restored from the
    /// file token and seeded back into the inputs (GateElm.java:56-62).
    last_output: bool,
    has_schmitt: bool,
    invert_inputs: bool,
    /// Hysteresis memory per input, read and written by `get_input` under
    /// FLAG_SCHMITT (GateElm.java:250-256).
    input_states: Vec<bool>,
    oscillation_count: u32,
    /// Last simulation time the oscillation counter advanced, so it runs once
    /// per timestep even when a nonlinear circuit mates several Newton
    /// iterations (GateElm.java:261-281).
    last_time: f64,
    /// xorshift64* state for the 40% freeze roll, the port's deterministic
    /// stand-in for upstream's `app.getrand(10) > 5` (GateElm.java:274).
    rng: u64,
}

impl Gate {
    pub fn new(spec: &ElementSpec, kind: GateKind) -> Self {
        let input_count = (spec.param("inputCount", 2.0) as i64).clamp(1, 8) as usize;
        let high_voltage = spec.param("highVoltage", 5.0);
        let last_output_voltage = spec.param("lastOutputVoltage", 0.0);
        Self {
            base: Base::with_posts(input_count + 1),
            kind,
            input_count,
            high_voltage,
            last_output: last_output_voltage > high_voltage * 0.5,
            has_schmitt: spec.flag(FLAG_SCHMITT),
            invert_inputs: spec.flag(FLAG_INVERT_INPUTS),
            input_states: vec![false; input_count],
            oscillation_count: 0,
            last_time: 0.0,
            // A fixed seed keeps the freeze roll reproducible across runs and
            // rebuilds, salted by the element id like the noise source's.
            rng: 0x9E37_79B9_7F4A_7C15 ^ (spec.id as u64).wrapping_mul(0x2545_F491_4F6C_DD1D),
        }
    }

    fn next_rand(&mut self) -> u64 {
        self.rng ^= self.rng >> 12;
        self.rng ^= self.rng << 25;
        self.rng ^= self.rng >> 27;
        self.rng.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    /// One input's Boolean level, flipped by FLAG_INVERT_INPUTS and
    /// hysteresis-thresholded under FLAG_SCHMITT (GateElm.java:246-257).
    fn get_input(&mut self, x: usize) -> bool {
        let high = !self.invert_inputs;
        if !self.has_schmitt {
            return if self.base.volts[x] > self.high_voltage * 0.5 {
                high
            } else {
                !high
            };
        }
        let res =
            self.base.volts[x] > self.high_voltage * if self.input_states[x] { 0.35 } else { 0.55 };
        self.input_states[x] = res;
        if res {
            high
        } else {
            !high
        }
    }

    fn calc_function(&mut self) -> bool {
        match self.kind.function() {
            Function::And => (0..self.input_count).all(|i| self.get_input(i)),
            Function::Or => (0..self.input_count).any(|i| self.get_input(i)),
            Function::Xor => {
                let mut f = false;
                for i in 0..self.input_count {
                    f ^= self.get_input(i);
                }
                f
            }
        }
    }
}

impl Element for Gate {
    fn kind(&self) -> &'static str {
        match self.kind {
            GateKind::And => "andGate",
            GateKind::Nand => "nandGate",
            GateKind::Or => "orGate",
            GateKind::Nor => "norGate",
            GateKind::Xor => "xorGate",
            GateKind::Xnor => "xnorGate",
        }
    }
    fn base(&self) -> &Base {
        &self.base
    }
    fn base_mut(&mut self) -> &mut Base {
        &mut self.base
    }
    fn post_count(&self) -> usize {
        self.input_count + 1
    }
    fn voltage_source_count(&self) -> usize {
        1
    }
    fn voltage_source_nodes(&self, _k: usize) -> (usize, usize) {
        // The output is a source to ground (GateElm.java:243, :352-354), so
        // the unknown must land in the output node's closure.
        (GROUND, self.base.nodes[self.input_count])
    }
    /// No current path between posts: the inputs are isolated and only the
    /// output's voltage source ties that node to ground (GateElm.java:351).
    fn connects(&self, _a: usize, _b: usize) -> bool {
        false
    }

    fn stamp(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        s.voltage_source(
            GROUND,
            self.base.nodes[self.input_count],
            self.base.vs_base,
            0.0,
        );
    }

    fn do_step(&mut self, ctx: &SimCtx, s: &mut Stamper) {
        let mut f = self.calc_function();
        if self.kind.is_inverting() {
            f = !f;
        }
        // Atanua-style anti-oscillation (GateElm.java:263-281): after 50
        // flips the output randomly freezes, so a combinational loop cannot
        // run forever at the timestep frequency. `last_time` gates it to once
        // per timestep even when a nonlinear neighbour forces several Newton
        // iterations.
        if self.last_time != ctx.time {
            // The desired output differs from the committed one: a flip.
            if self.last_output != f {
                self.oscillation_count += 1;
                if self.oscillation_count > 50 {
                    self.oscillation_count = 0;
                    if self.next_rand() % 10 > 5 {
                        f = self.last_output;
                    }
                }
            } else {
                self.oscillation_count = 0;
            }
            self.last_time = ctx.time;
        }
        self.last_output = f;
        s.voltage_source_value(self.base.vs_base, if f { self.high_voltage } else { 0.0 });
    }

    fn calculate_current(&mut self, _ctx: &SimCtx) {
        // The source delivers `vs_currents[0]` into the output node, which is
        // the current upstream reports (getCurrentIntoNode, GateElm.java:356-360).
        self.base.current = self.base.vs_currents[0];
    }

    fn current_into_node(&self, post: usize) -> f64 {
        if post == self.input_count {
            self.base.current
        } else {
            0.0
        }
    }

    fn seed_initial_voltages(&mut self, v: &mut [f64]) {
        // setupVolts fills the inputs with the levels that reproduce the saved
        // output, so the first step does not glitch (GateElm.java:168-174).
        let seed = if self.last_output ^ self.kind.is_inverting() {
            self.high_voltage
        } else {
            0.0
        };
        for i in 0..self.input_count {
            if let Some(slot) = v.get_mut(self.base.nodes[i]) {
                *slot = seed;
            }
        }
    }

    fn set_param(&mut self, name: &str, value: f64) -> bool {
        match name {
            "highVoltage" => self.high_voltage = value,
            _ => return false,
        }
        true
    }

    fn reset(&mut self) {
        self.base.reset();
        // The counters must not carry the oscillation history across a reset,
        // or a reset could freeze an output that never actually flipped.
        self.oscillation_count = 0;
        self.last_time = 0.0;
        self.input_states.fill(false);
    }
}
