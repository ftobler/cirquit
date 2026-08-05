//! Switches and the op-amp.

use crate::element::{Base, Element, SimCtx};
use crate::spec::ElementSpec;
use crate::stamp::{Stamper, GROUND};

/// Single-pole switch. Closed it behaves as a wire; open it contributes
/// nothing, and the analyser's floating-node handling copes with whatever is
/// left dangling.
///
/// Position 0 is closed, matching the file format.
pub struct Switch {
    base: Base,
    position: i32,
    momentary: bool,
}

impl Switch {
    pub fn new(spec: &ElementSpec) -> Self {
        Self {
            base: Base::with_posts(2),
            position: spec.param("position", 0.0) as i32,
            momentary: spec.param("momentary", 0.0) != 0.0,
        }
    }

    fn closed(&self) -> bool {
        self.position == 0
    }
}

impl Element for Switch {
    fn kind(&self) -> &'static str {
        "switch"
    }
    fn base(&self) -> &Base {
        &self.base
    }
    fn base_mut(&mut self) -> &mut Base {
        &mut self.base
    }
    fn post_count(&self) -> usize {
        2
    }
    fn voltage_source_count(&self) -> usize {
        if self.closed() {
            1
        } else {
            0
        }
    }
    fn connects(&self, _a: usize, _b: usize) -> bool {
        self.closed()
    }
    fn stamp(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        if self.closed() {
            s.voltage_source(
                self.base.nodes[0],
                self.base.nodes[1],
                self.base.vs_base,
                0.0,
            );
        }
    }
    fn calculate_current(&mut self, _ctx: &SimCtx) {
        self.base.current = if self.closed() {
            self.base.vs_currents[0]
        } else {
            0.0
        };
    }
    fn set_state(&mut self, state: i32) -> bool {
        self.position = state.clamp(0, 1);
        // Changing position changes the number of unknowns, so the caller has
        // to reallocate rather than just re-stamp.
        true
    }
    fn set_param(&mut self, name: &str, value: f64) -> bool {
        if name == "momentary" {
            self.momentary = value != 0.0;
        }
        false
    }
}

/// Multi-throw switch. Post 0 is the common terminal, the rest are throws.
pub struct MultiThrowSwitch {
    base: Base,
    position: i32,
    throw_count: usize,
}

impl MultiThrowSwitch {
    pub fn new(spec: &ElementSpec) -> Self {
        let throws = (spec.param("throwCount", 2.0) as usize).clamp(2, 8);
        Self {
            base: Base::with_posts(1 + throws),
            position: spec.param("position", 0.0) as i32,
            throw_count: throws,
        }
    }

    fn selected_post(&self) -> usize {
        1 + (self.position as usize).min(self.throw_count - 1)
    }
}

impl Element for MultiThrowSwitch {
    fn kind(&self) -> &'static str {
        "switch2"
    }
    fn base(&self) -> &Base {
        &self.base
    }
    fn base_mut(&mut self) -> &mut Base {
        &mut self.base
    }
    fn post_count(&self) -> usize {
        1 + self.throw_count
    }
    fn voltage_source_count(&self) -> usize {
        1
    }
    fn connects(&self, a: usize, b: usize) -> bool {
        let sel = self.selected_post();
        (a == 0 && b == sel) || (b == 0 && a == sel)
    }
    fn stamp(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        let sel = self.selected_post();
        s.voltage_source(
            self.base.nodes[0],
            self.base.nodes[sel],
            self.base.vs_base,
            0.0,
        );
    }
    fn calculate_current(&mut self, _ctx: &SimCtx) {
        self.base.current = self.base.vs_currents[0];
    }
    fn set_state(&mut self, state: i32) -> bool {
        self.position = state.rem_euclid(self.throw_count as i32);
        true
    }
}

/// Op-amp modelled as a saturating voltage-controlled voltage source.
///
/// Posts are inverting input, non-inverting input, output. The inputs draw no
/// current; the output is an ideal source referenced to ground, since the
/// supply rails are not modelled.
pub struct OpAmp {
    base: Base,
    gain: f64,
    max_out: f64,
    min_out: f64,
    last_vd: f64,
}

impl OpAmp {
    /// Slope used inside saturation. Not zero, because a perfectly flat
    /// region gives Newton no gradient to work with and the solve stalls.
    const SATURATED_SLOPE: f64 = 1e-4;

    pub fn new(spec: &ElementSpec) -> Self {
        Self {
            base: Base::with_posts(3),
            gain: spec.param("gain", 100_000.0),
            max_out: spec.param("maxOut", 15.0),
            min_out: spec.param("minOut", -15.0),
            last_vd: 0.0,
        }
    }
}

impl Element for OpAmp {
    fn kind(&self) -> &'static str {
        "opamp"
    }
    fn base(&self) -> &Base {
        &self.base
    }
    fn base_mut(&mut self) -> &mut Base {
        &mut self.base
    }
    fn post_count(&self) -> usize {
        3
    }
    fn voltage_source_count(&self) -> usize {
        1
    }
    fn nonlinear(&self) -> bool {
        true
    }
    /// The inputs are isolated; only the output terminal is driven.
    fn connects(&self, _a: usize, _b: usize) -> bool {
        false
    }

    fn stamp(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        // Topology only: the output is a source to ground whose value and
        // input coupling `do_step` fills in each iteration.
        s.voltage_source(GROUND, self.base.nodes[2], self.base.vs_base, 0.0);
    }

    fn do_step(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        let vd = self.base.volts[1] - self.base.volts[0];
        if (vd - self.last_vd).abs() > 1e-4 {
            s.not_converged();
        }
        self.last_vd = vd;

        // Piecewise-linear transfer curve, continuous at both knees.
        let (slope, offset) = if vd >= self.max_out / self.gain {
            (
                Self::SATURATED_SLOPE,
                self.max_out - Self::SATURATED_SLOPE * self.max_out / self.gain,
            )
        } else if vd <= self.min_out / self.gain {
            (
                Self::SATURATED_SLOPE,
                self.min_out - Self::SATURATED_SLOPE * self.min_out / self.gain,
            )
        } else {
            (self.gain, 0.0)
        };

        // Constraint row: V(out) − slope·(V(+) − V(−)) = offset.
        let row = s.vs_row(self.base.vs_base);
        if let Some(c) = s.node_row(self.base.nodes[1]) {
            s.raw(row, c, -slope);
        }
        if let Some(c) = s.node_row(self.base.nodes[0]) {
            s.raw(row, c, slope);
        }
        s.raw_rhs(row, offset);
    }

    fn calculate_current(&mut self, _ctx: &SimCtx) {
        self.base.current = self.base.vs_currents[0];
    }

    fn set_param(&mut self, name: &str, value: f64) -> bool {
        match name {
            "gain" if value > 0.0 => self.gain = value,
            "maxOut" => self.max_out = value,
            "minOut" => self.min_out = value,
            _ => return false,
        }
        false
    }

    fn reset(&mut self) {
        self.base.reset();
        self.last_vd = 0.0;
    }
}
