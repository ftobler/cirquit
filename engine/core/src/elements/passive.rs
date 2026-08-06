//! Wires, resistors and the two reactive elements.

use crate::element::{two_terminal_current, Base, Element, SimCtx};
use crate::spec::ElementSpec;
use crate::stamp::Stamper;

/// Resistance a capacitor is modelled with while solving the DC operating
/// point, standing in for an open circuit.
const DC_OPEN: f64 = 1e8;
/// Resistance an inductor is modelled with while solving the DC operating
/// point, standing in for a short.
const DC_SHORT: f64 = 1e-6;

/// An ideal wire. Merged out of the matrix before stamping, so its two
/// endpoints become one node and the matrix never allocates a row or a
/// current unknown for it. Its current is indeterminate to the solve, so the
/// recovery pass derives it from the currents of the elements around it.
pub struct Wire {
    base: Base,
}

impl Wire {
    pub fn new(_spec: &ElementSpec) -> Self {
        Self {
            base: Base::with_posts(2),
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
        2
    }
    fn removable_wire(&self) -> bool {
        true
    }
}

/// The reference node symbol. Contributes nothing to the matrix: analysis
/// remaps its terminal onto node 0 directly.
pub struct Ground {
    base: Base,
}

impl Ground {
    pub fn new(_spec: &ElementSpec) -> Self {
        Self {
            base: Base::with_posts(1),
        }
    }
}

impl Element for Ground {
    fn kind(&self) -> &'static str {
        "ground"
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
    fn is_ground(&self) -> bool {
        true
    }
}

pub struct Resistor {
    base: Base,
    resistance: f64,
}

impl Resistor {
    pub fn new(spec: &ElementSpec) -> Self {
        Self {
            base: Base::with_posts(2),
            resistance: spec.param("resistance", 1000.0),
        }
    }
}

impl Element for Resistor {
    fn kind(&self) -> &'static str {
        "resistor"
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
    fn stamp(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        s.resistor(self.base.nodes[0], self.base.nodes[1], self.resistance);
    }
    fn calculate_current(&mut self, _ctx: &SimCtx) {
        self.base.current = two_terminal_current(&self.base, self.resistance);
    }
    fn set_param(&mut self, name: &str, value: f64) -> bool {
        if name == "resistance" && value > 0.0 {
            self.resistance = value;
            true
        } else {
            false
        }
    }
}

/// A three-terminal potentiometer: posts 0 and 1 are the track ends, post 2 is
/// the wiper.
pub struct Potentiometer {
    base: Base,
    max_resistance: f64,
    position: f64,
    r0: f64,
    r1: f64,
    /// Current through the second track half, positive flowing post 1 to the
    /// wiper. Tracked so the wire-current recovery can balance the wiper node.
    r1_current: f64,
}

impl Potentiometer {
    pub fn new(spec: &ElementSpec) -> Self {
        let mut p = Self {
            base: Base::with_posts(3),
            max_resistance: spec.param("maxResistance", 1000.0),
            position: spec.param("position", 0.5),
            r0: 0.0,
            r1: 0.0,
            r1_current: 0.0,
        };
        p.recompute();
        p
    }

    fn recompute(&mut self) {
        // A wiper at an extreme would otherwise short a track section to
        // nothing, so keep a floor on each half.
        let p = self.position.clamp(0.0, 1.0);
        self.r0 = (self.max_resistance * p).max(1e-6);
        self.r1 = (self.max_resistance * (1.0 - p)).max(1e-6);
    }
}

impl Element for Potentiometer {
    fn kind(&self) -> &'static str {
        "potentiometer"
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
    fn stamp(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        s.resistor(self.base.nodes[0], self.base.nodes[2], self.r0);
        s.resistor(self.base.nodes[2], self.base.nodes[1], self.r1);
    }
    fn calculate_current(&mut self, _ctx: &SimCtx) {
        self.base.current = (self.base.volts[0] - self.base.volts[2]) / self.r0;
        self.r1_current = (self.base.volts[1] - self.base.volts[2]) / self.r1;
    }
    fn current_into_node(&self, post: usize) -> f64 {
        match post {
            0 => -self.base.current,
            1 => -self.r1_current,
            2 => self.base.current + self.r1_current,
            _ => 0.0,
        }
    }
    fn set_param(&mut self, name: &str, value: f64) -> bool {
        match name {
            "position" => self.position = value,
            "maxResistance" if value > 0.0 => self.max_resistance = value,
            _ => return false,
        }
        self.recompute();
        true
    }
}

/// Trapezoidal or backward-Euler companion model for a capacitor.
///
/// Trapezoidal integration gives `i = (2C/dt)·v - [(2C/dt)·v_prev + i_prev]`,
/// which is a conductance in parallel with a current source. Backward Euler
/// uses `C/dt` and drops the `i_prev` term; it damps ringing at the cost of
/// accuracy, which is why it is selectable.
pub struct Capacitor {
    base: Base,
    capacitance: f64,
    initial_voltage: f64,
    series_resistance: f64,
    backward_euler: bool,
    /// True for the polarised variant (`PolarCapacitorElm`). Electrically
    /// identical to the plain capacitor; only changes `kind()` and carries
    /// `max_negative_voltage`, which upstream uses solely for a UI warning
    /// when the cap is driven past it in reverse, not for the stamp.
    polarized: bool,
    max_negative_voltage: f64,
    geq: f64,
    ieq: f64,
    v_prev: f64,
    i_prev: f64,
}

impl Capacitor {
    /// Upstream file flag selecting backward Euler.
    const FLAG_BACK_EULER: i64 = 2;

    pub fn new(spec: &ElementSpec) -> Self {
        Self::build(spec, false)
    }

    /// The polarised variant: same electrical model, plus a reverse-voltage
    /// rating (PolarCapacitorElm.java).
    pub fn new_polarized(spec: &ElementSpec) -> Self {
        Self::build(spec, true)
    }

    fn build(spec: &ElementSpec, polarized: bool) -> Self {
        let iv = spec.param("initialVoltage", 0.0);
        Self {
            base: Base::with_posts(2),
            capacitance: spec.param("capacitance", 1e-5),
            initial_voltage: iv,
            series_resistance: spec.param("seriesResistance", 0.0),
            backward_euler: spec.flag(Self::FLAG_BACK_EULER),
            polarized,
            // PolarCapacitorElm's constructor default (PolarCapacitorElm.java:11).
            max_negative_voltage: spec.param("maxNegativeVoltage", 1.0),
            geq: 0.0,
            ieq: 0.0,
            v_prev: iv,
            i_prev: 0.0,
        }
    }

    fn conductance(&self, ctx: &SimCtx) -> f64 {
        let scale = if self.backward_euler { 1.0 } else { 2.0 };
        scale * self.capacitance / ctx.dt
    }
}

impl Element for Capacitor {
    fn kind(&self) -> &'static str {
        if self.polarized {
            "polarizedCapacitor"
        } else {
            "capacitor"
        }
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

    fn stamp(&mut self, ctx: &SimCtx, s: &mut Stamper) {
        let (n0, n1) = (self.base.nodes[0], self.base.nodes[1]);
        if ctx.dc_analysis {
            self.geq = 1.0 / DC_OPEN;
        } else {
            self.geq = self.conductance(ctx);
        }
        // A series resistance turns the companion into a divider; fold it in
        // by combining the two in series.
        let r = 1.0 / self.geq + self.series_resistance;
        self.geq = 1.0 / r;
        s.conductance(n0, n1, self.geq);
    }

    fn do_step(&mut self, ctx: &SimCtx, s: &mut Stamper) {
        if ctx.dc_analysis {
            return;
        }
        let (n0, n1) = (self.base.nodes[0], self.base.nodes[1]);
        self.ieq = if self.backward_euler {
            self.geq * self.v_prev
        } else {
            self.geq * self.v_prev + self.i_prev
        };
        // `i = geq·v − ieq`, so the source pushes `ieq` into post 0.
        s.current_source(n1, n0, self.ieq);
    }

    fn calculate_current(&mut self, ctx: &SimCtx) {
        let v = self.base.voltage_diff();
        self.base.current = if ctx.dc_analysis {
            0.0
        } else {
            self.geq * v - self.ieq
        };
    }

    fn step_finished(&mut self, ctx: &SimCtx) {
        if !ctx.dc_analysis {
            self.v_prev = self.base.voltage_diff();
            self.i_prev = self.base.current;
        }
    }

    fn set_param(&mut self, name: &str, value: f64) -> bool {
        match name {
            "capacitance" if value > 0.0 => self.capacitance = value,
            "initialVoltage" => self.initial_voltage = value,
            // PolarCapacitorElm.setEditValue: rejects a negative rating (PolarCapacitorElm.java:69-73).
            "maxNegativeVoltage" if value >= 0.0 => self.max_negative_voltage = value,
            _ => return false,
        }
        true
    }

    fn reset(&mut self) {
        self.base.reset();
        self.v_prev = self.initial_voltage;
        self.i_prev = 0.0;
        self.ieq = 0.0;
    }
}

/// Companion model for an inductor: `i = (dt/2L)·v + [i_prev + (dt/2L)·v_prev]`.
pub struct Inductor {
    base: Base,
    inductance: f64,
    initial_current: f64,
    backward_euler: bool,
    geq: f64,
    ieq: f64,
    v_prev: f64,
    i_prev: f64,
}

impl Inductor {
    const FLAG_BACK_EULER: i64 = 2;

    pub fn new(spec: &ElementSpec) -> Self {
        let ic = spec.param("initialCurrent", 0.0);
        Self {
            base: Base::with_posts(2),
            inductance: spec.param("inductance", 1e-3),
            initial_current: ic,
            backward_euler: spec.flag(Self::FLAG_BACK_EULER),
            geq: 0.0,
            ieq: 0.0,
            v_prev: 0.0,
            i_prev: ic,
        }
    }
}

impl Element for Inductor {
    fn kind(&self) -> &'static str {
        "inductor"
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

    fn stamp(&mut self, ctx: &SimCtx, s: &mut Stamper) {
        let (n0, n1) = (self.base.nodes[0], self.base.nodes[1]);
        self.geq = if ctx.dc_analysis {
            1.0 / DC_SHORT
        } else if self.backward_euler {
            ctx.dt / self.inductance
        } else {
            ctx.dt / (2.0 * self.inductance)
        };
        s.conductance(n0, n1, self.geq);
    }

    fn do_step(&mut self, ctx: &SimCtx, s: &mut Stamper) {
        if ctx.dc_analysis {
            return;
        }
        let (n0, n1) = (self.base.nodes[0], self.base.nodes[1]);
        self.ieq = if self.backward_euler {
            self.i_prev
        } else {
            self.i_prev + self.geq * self.v_prev
        };
        // `i = geq·v + ieq`, so the source draws `ieq` from post 0.
        s.current_source(n0, n1, self.ieq);
    }

    fn calculate_current(&mut self, ctx: &SimCtx) {
        let v = self.base.voltage_diff();
        self.base.current = if ctx.dc_analysis {
            v / DC_SHORT
        } else {
            self.geq * v + self.ieq
        };
    }

    fn step_finished(&mut self, ctx: &SimCtx) {
        if !ctx.dc_analysis {
            self.v_prev = self.base.voltage_diff();
            self.i_prev = self.base.current;
        }
    }

    fn set_param(&mut self, name: &str, value: f64) -> bool {
        match name {
            "inductance" if value > 0.0 => self.inductance = value,
            "initialCurrent" => self.initial_current = value,
            _ => return false,
        }
        true
    }

    fn reset(&mut self) {
        self.base.reset();
        self.v_prev = 0.0;
        self.i_prev = self.initial_current;
        self.ieq = 0.0;
    }
}
