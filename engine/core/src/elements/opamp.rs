//! Op-amp modelled as a saturating VCVS.

use crate::element::{Base, Element, SimCtx};
use crate::spec::ElementSpec;
use crate::stamp::{Stamper, GROUND};

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

    fn current_into_node(&self, post: usize) -> f64 {
        // The inputs draw nothing; the output source delivers its solved
        // current into the output node.
        if post == 2 {
            self.base.current
        } else {
            0.0
        }
    }

    fn set_param(&mut self, name: &str, value: f64) -> bool {
        match name {
            "gain" if value > 0.0 => self.gain = value,
            "maxOut" => self.max_out = value,
            "minOut" => self.min_out = value,
            _ => return false,
        }
        true
    }

    fn reset(&mut self) {
        self.base.reset();
        self.last_vd = 0.0;
    }
}
