//! Wires, resistors and the two reactive elements.

use crate::element::{two_terminal_current, Base, Element, SimCtx};
use crate::spec::ElementSpec;
use crate::stamp::Stamper;

/// Resistance a capacitor is modelled with while solving the DC operating
/// point, standing in for an open circuit. `pub(crate)` so the varactor's
/// companion capacitance (semiconductor.rs) can reuse the same steady-state
/// treatment instead of picking its own constant.
pub(crate) const DC_OPEN: f64 = 1e8;
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
///
/// A series resistance is a real resistor to a real internal node, not a
/// value folded into the companion conductance: the companion spans post 0 to
/// the internal node and the resistor spans the internal node to post 1
/// (CapacitorElm.java:156-174). Folding it in instead would scale the
/// effective capacitance to `C/(1 + 2·C·R_s/dt)` and lose the ESR dynamics
/// entirely, since the stored charge would then track the terminal voltage
/// rather than the plate voltage.
pub struct Capacitor {
    base: Base,
    capacitance: f64,
    initial_voltage: f64,
    series_resistance: f64,
    /// Index into `base.nodes` the companion model's far plate sits on:
    /// post 1 for an ideal capacitor, the internal node 2 once there is a
    /// series resistance. Upstream's `capNode2` (CapacitorElm.java:159).
    cap_node: usize,
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
        // 1e-3, not 0: upstream deliberately puts a small charge on every
        // capacitor so a fresh LC tank self-starts (CapacitorElm.java:38, and
        // the same value is the load-time fallback at :46).
        let iv = spec.param("initialVoltage", 1e-3);
        let series_resistance = spec.param("seriesResistance", 0.0);
        Self {
            base: Base::with_posts(2),
            capacitance: spec.param("capacitance", 1e-5),
            initial_voltage: iv,
            series_resistance,
            cap_node: if series_resistance > 0.0 { 2 } else { 1 },
            backward_euler: spec.flag(Self::FLAG_BACK_EULER),
            polarized,
            // PolarCapacitorElm's constructor default (PolarCapacitorElm.java:11).
            max_negative_voltage: spec.param("maxNegativeVoltage", 1.0),
            geq: 0.0,
            ieq: 0.0,
            // The saved `voltDiff` token is the charge the file was saved
            // with (CapacitorElm.java:44); restoring it is what makes a
            // mid-transient save reload where it left off. Without the token
            // the initial voltage stands in, as upstream's `reset()` does.
            v_prev: spec.param("voltDiff", iv),
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

    /// One extra node for the plate behind the series resistance
    /// (`getInternalNodeCount`, CapacitorElm.java:213). Node assignment runs
    /// once, before the DC operating point, so unlike upstream this cannot
    /// also depend on `dc_analysis`; the DC stamp below keeps the node
    /// harmless instead.
    fn internal_node_count(&self) -> usize {
        if self.series_resistance > 0.0 {
            1
        } else {
            0
        }
    }

    fn stamp(&mut self, ctx: &SimCtx, s: &mut Stamper) {
        let (n0, n1) = (self.base.nodes[0], self.base.nodes[1]);
        let cn = self.base.nodes[self.cap_node];
        if ctx.dc_analysis {
            // Steady state: the capacitor is a 100 M open across its
            // terminals, with the internal node bypassed
            // (CapacitorElm.java:147-151). `geq` is left alone on purpose:
            // nothing reads it under DC (`do_step` returns early and
            // `calculate_current` has its own branch), and
            // `solve_operating_point` restamps before the first transient
            // step, which sets it.
            s.resistor(n0, n1, DC_OPEN);
            if self.series_resistance > 0.0 {
                // The internal node exists for the whole run, so under DC its
                // matrix row would otherwise be all zeros and this port's
                // dense solver would call the matrix singular. Tying it to
                // post 1 costs nothing: no current reaches it, so it just
                // follows post 1's voltage.
                s.resistor(n1, cn, self.series_resistance);
            }
            return;
        }
        self.geq = self.conductance(ctx);
        s.conductance(n0, cn, self.geq);
        if self.series_resistance > 0.0 {
            s.resistor(n1, cn, self.series_resistance);
        }
    }

    fn do_step(&mut self, ctx: &SimCtx, s: &mut Stamper) {
        if ctx.dc_analysis {
            return;
        }
        let n0 = self.base.nodes[0];
        let cn = self.base.nodes[self.cap_node];
        self.ieq = if self.backward_euler {
            self.geq * self.v_prev
        } else {
            self.geq * self.v_prev + self.i_prev
        };
        // `i = geq·v − ieq`, so the source pushes `ieq` into post 0. It spans
        // the companion, not the terminals: with a series resistance the far
        // end is the internal node (CapacitorElm.java:211).
        s.current_source(cn, n0, self.ieq);
    }

    fn calculate_current(&mut self, ctx: &SimCtx) {
        if ctx.dc_analysis {
            // The DC stamp bypasses the internal node, so the open circuit
            // spans the terminals (CapacitorElm.java:195-198).
            self.base.current = self.base.voltage_diff() / DC_OPEN;
            return;
        }
        // The branch current is the companion's, across the plates, not
        // across the terminals: with a series resistance the terminal voltage
        // is this plus `i·R_s`.
        let v = self.base.volts[0] - self.base.volts[self.cap_node];
        self.base.current = self.geq * v - self.ieq;
    }

    fn step_finished(&mut self, ctx: &SimCtx) {
        // The stored charge is the plate voltage (CapacitorElm.java:184).
        // Skipping the DC pass is what lets a restored `voltDiff`, and the
        // 1e-3 default, survive this port's always-on operating point.
        if !ctx.dc_analysis {
            self.v_prev = self.base.volts[0] - self.base.volts[self.cap_node];
            self.i_prev = self.base.current;
        }
    }

    /// `seriesResistance` is deliberately missing: it decides whether there
    /// is an internal node at all, and the live path only re-stamps. Falling
    /// through to `false` sends the edit down the full-rebuild path, which
    /// reallocates nodes, exactly as upstream's `allocNodes()` call does
    /// (CapacitorElm.java:262).
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

/// A fuse: an ideal resistor until it blows, then a large but finite resistor
/// for the rest of the run. FuseElm.java tracks a leaky I²t integrator rather
/// than a simple instantaneous current limit: `heat` accumulates `i²·dt` each
/// timestep and bleeds off at a fixed rate, on the assumption the fuse can
/// dissipate its whole rating in three seconds (FuseElm.java:150-163). Once
/// `heat` exceeds `i2t` the fuse is permanently blown; [`Element::reset`]
/// (the Run/Reset button) clears it and `reanalyze()` leaves it alone,
/// matching upstream's `reset()` (FuseElm.java:71-75) versus its
/// `startIteration()`. Like capacitor `voltDiff`/inductor `current`, a full
/// circuit rebuild from TS state also resets it, since that state never
/// round-trips back out of the engine.
pub struct Fuse {
    base: Base,
    resistance: f64,
    i2t: f64,
    heat: f64,
    blown: bool,
}

impl Fuse {
    /// FuseElm.java's no-args constructor, sourced from a Littelfuse 218-series
    /// datasheet (FuseElm.java:34-39).
    const DEFAULT_RESISTANCE: f64 = 0.0613;
    const DEFAULT_I2T: f64 = 6.73;
    /// Resistance substituted for a blown fuse: large enough to read as open,
    /// finite so the matrix never goes singular (FuseElm.java:33).
    const BLOWN_RESISTANCE: f64 = 1e9;
    /// Upstream assumes the fuse can dissipate its entire I²t rating in three
    /// seconds (FuseElm.java:156).
    const COOLING_SECONDS: f64 = 3.0;

    pub fn new(spec: &ElementSpec) -> Self {
        Self {
            base: Base::with_posts(2),
            resistance: spec.param("resistance", Self::DEFAULT_RESISTANCE),
            i2t: spec.param("i2t", Self::DEFAULT_I2T),
            heat: spec.param("heat", 0.0),
            blown: spec.param("blown", 0.0) != 0.0,
        }
    }

    fn effective_resistance(&self) -> f64 {
        if self.blown {
            Self::BLOWN_RESISTANCE
        } else {
            self.resistance
        }
    }
}

impl Element for Fuse {
    fn kind(&self) -> &'static str {
        "fuse"
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

    /// Blowing swaps the resistor stamped into the matrix from one timestep
    /// to the next, which needs a full refactor rather than an RHS-only
    /// update — the same reason a diode junction is nonlinear — even though
    /// nothing changes across a single timestep's own Newton iterations
    /// (FuseElm.java:149).
    fn nonlinear(&self) -> bool {
        true
    }

    /// Heat accumulates from the *previous* timestep's current once per
    /// timestep, before Newton begins. This mirrors upstream exactly:
    /// `startIteration()` runs once per timestep outside the subiteration
    /// loop (SimulationManager.java:1324-1328), so the `blown` decision it
    /// makes is fixed for every Newton iteration of this timestep, and
    /// `do_step` below never needs to re-check it.
    fn start_iteration(&mut self, ctx: &SimCtx) {
        let i = self.base.current;
        self.heat += i * i * ctx.dt;
        self.heat -= ctx.dt * self.i2t / Self::COOLING_SECONDS;
        if self.heat < 0.0 {
            self.heat = 0.0;
        }
        if self.heat > self.i2t {
            self.blown = true;
        }
    }

    fn do_step(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        s.resistor(
            self.base.nodes[0],
            self.base.nodes[1],
            self.effective_resistance(),
        );
    }

    fn calculate_current(&mut self, _ctx: &SimCtx) {
        self.base.current = two_terminal_current(&self.base, self.effective_resistance());
    }

    fn set_param(&mut self, name: &str, value: f64) -> bool {
        match name {
            "resistance" if value > 0.0 => self.resistance = value,
            "i2t" if value > 0.0 => self.i2t = value,
            _ => return false,
        }
        true
    }

    fn reset(&mut self) {
        self.base.reset();
        self.heat = 0.0;
        self.blown = false;
    }
}

/// An incandescent lamp: a resistor whose value is a function of filament
/// temperature, which itself evolves each timestep from the power dissipated
/// the step before, with independent warm-up and cool-down thermal masses
/// (LampElm.java). Like the fuse, this is a state-dependent resistor rather
/// than a junction device: there is nothing to linearise *within* a
/// timestep (the resistance for the step is fixed before Newton begins), but
/// the value can change from one timestep to the next, which needs a full
/// refactor rather than an RHS-only update. `nonlinear()` returns `true` for
/// that reason, exactly as Fuse's doc comment explains, and — like Fuse —
/// there is no `stamp()` override: upstream's `stamp()` only calls
/// `sim.stampNonLinear(...)`, which feeds the matrix-simplification pass
/// this port does not implement (see OVERVIEW.md's deliberate gaps), so
/// there is nothing to port there.
pub struct Lamp {
    base: Base,
    /// Filament temperature, kelvin (LampElm.java:29-30, `roomTemp`/`temp`).
    temp: f64,
    /// Rated power at `nom_v`, in watts (LampElm.java:34's default of 100).
    nom_pow: f64,
    /// Rated operating voltage, in volts (LampElm.java:35's default of 120).
    nom_v: f64,
    /// Thermal warm-up and cool-down time constants, in seconds, each
    /// normalised against upstream's baseline of 0.4 s (LampElm.java:36-37,
    /// :177-178).
    warm_time: f64,
    cool_time: f64,
    /// Resistance computed from `temp` at the start of this timestep
    /// (LampElm.java's `resistance` field), used both to stamp and to report
    /// current.
    resistance: f64,
}

impl Lamp {
    /// LampElm.java:29.
    const ROOM_TEMP: f64 = 300.0;
    /// LampElm.java:34-37's no-args constructor defaults.
    const DEFAULT_NOM_POW: f64 = 100.0;
    const DEFAULT_NOM_V: f64 = 120.0;
    const DEFAULT_WARM_TIME: f64 = 0.4;
    const DEFAULT_COOL_TIME: f64 = 0.4;
    /// The resistance-temperature curve below is only valid up to here
    /// (LampElm.java:171-172).
    const MAX_CURVE_TEMP: f64 = 5390.0;

    pub fn new(spec: &ElementSpec) -> Self {
        // The token constructor falls back to room temperature when the
        // saved token is NaN (LampElm.java:44-45); the TypeScript loader
        // already drops non-finite tokens before they reach `params`, so
        // `spec.param`'s own default covers the same case here.
        let mut lamp = Self {
            base: Base::with_posts(2),
            temp: spec.param("temp", Self::ROOM_TEMP),
            nom_pow: spec.param("nomPower", Self::DEFAULT_NOM_POW),
            nom_v: spec.param("nomVoltage", Self::DEFAULT_NOM_V),
            warm_time: spec.param("warmTime", Self::DEFAULT_WARM_TIME),
            cool_time: spec.param("coolTime", Self::DEFAULT_COOL_TIME),
            resistance: 0.0,
        };
        lamp.resistance = lamp.resistance_from_temp();
        lamp
    }

    /// Resistance-vs-temperature curve, cited upstream to
    /// http://www.intusoft.com/nlpdf/nl11.pdf (LampElm.java:169-175):
    /// `nom_r` is the resistance a plain resistor of the same rated power and
    /// voltage would have, and the polynomial in `tp` scales it from roughly
    /// 1/20th of `nom_r` at room temperature up toward `nom_r` itself near
    /// the filament's rated operating temperature.
    fn resistance_from_temp(&self) -> f64 {
        let nom_r = self.nom_v * self.nom_v / self.nom_pow;
        let tp = self.temp.min(Self::MAX_CURVE_TEMP);
        nom_r * (1.26104 - 4.90662 * (17.1839 / tp - 0.00318794).sqrt() - 7.8569 / (tp - 187.56))
    }
}

impl Element for Lamp {
    fn kind(&self) -> &'static str {
        "lamp"
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

    fn nonlinear(&self) -> bool {
        true
    }

    /// Mirrors `startIteration()` (LampElm.java:168-184) exactly: first
    /// compute this step's resistance from `temp` as it stood at the end of
    /// the previous step, *then* advance `temp` using the power dissipated
    /// over that previous step (`base.voltage_diff() * base.current`, both
    /// still holding the last converged solve — `getPower()` is
    /// `CircuitElm.java:1269`). The order matters: swapping it would make
    /// the stamped resistance react to power a step early.
    fn start_iteration(&mut self, ctx: &SimCtx) {
        self.resistance = self.resistance_from_temp();

        // Thermal mass scales with rated power; warm-up and cool-down carry
        // independent time constants (LampElm.java:176-178).
        let cap = 1.57e-4 * self.nom_pow;
        let capw = cap * self.warm_time / 0.4;
        let capc = cap * self.cool_time / 0.4;

        let power = self.base.voltage_diff() * self.base.current;
        self.temp += power * ctx.dt / capw;
        let cr = 2600.0 / self.nom_pow;
        self.temp -= ctx.dt * (self.temp - Self::ROOM_TEMP) / (capc * cr);
    }

    fn do_step(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        s.resistor(self.base.nodes[0], self.base.nodes[1], self.resistance);
    }

    fn calculate_current(&mut self, _ctx: &SimCtx) {
        self.base.current = two_terminal_current(&self.base, self.resistance);
    }

    fn set_param(&mut self, name: &str, value: f64) -> bool {
        // Matches setEditValue's `ei.value > 0` guard on all four fields
        // (LampElm.java:207-215).
        match name {
            "nomPower" if value > 0.0 => self.nom_pow = value,
            "nomVoltage" if value > 0.0 => self.nom_v = value,
            "warmTime" if value > 0.0 => self.warm_time = value,
            "coolTime" if value > 0.0 => self.cool_time = value,
            _ => return false,
        }
        true
    }

    /// Matches `reset()` (LampElm.java:79-84): back to room temperature,
    /// then recompute resistance. `base.reset()` already zeroes current and
    /// volts, so the power term above is moot here; no need to duplicate
    /// `start_iteration`'s temp-update math for a state that isn't moving.
    fn reset(&mut self) {
        self.base.reset();
        self.temp = Self::ROOM_TEMP;
        self.resistance = self.resistance_from_temp();
    }
}

/// An NTC thermistor. Upstream's file is `ThermistorNTCElm.java` — the class
/// name inside the file, despite this port's own `thermistor` kind and the
/// task that asked for it both saying "ThermistorElm". Unlike Fuse/Lamp,
/// there is no self-heating: `temperature` is derived purely from a slider
/// `position` in `[0, 1]` interpolated between two edited endpoints
/// (`minTempr`, `maxTempr`), the same way `PotElm.java`'s wiper `position`
/// sets its two resistances — this port has no slider widget yet (see
/// OVERVIEW.md's "Sliders (`38` lines)" gap), so `position` is exposed as a
/// directly-editable field instead, exactly as this port's `Potentiometer`
/// already does for its own wiper.
///
/// `stamp()` (ThermistorNTCElm.java:185-189) recomputes `temperature` from
/// `position` and `resistance` from `temperature` on every call — nothing
/// here depends on current or dissipated power, and nothing evolves between
/// timesteps. That is the same shape as `PotElm.java`'s `stamp()`
/// recomputing its two resistances from `position` every call, so this is a
/// plain resistor whose value only changes on edit: no `nonlinear()`
/// override, no `do_step`/`start_iteration`, matching `Potentiometer` below
/// rather than `Fuse`/`Lamp` above.
pub struct Thermistor {
    base: Base,
    /// Resistance at 25 C and 50 C, the two calibration points a datasheet
    /// gives (ThermistorNTCElm.java:28, defaults at :44-45: a Vishay
    /// NTCLE100E3010).
    r25: f64,
    r50: f64,
    /// Celsius range the `position` slider spans (ThermistorNTCElm.java:26,
    /// defaults at :42-43).
    min_tempr: f64,
    max_tempr: f64,
    /// Slider position in `[0, 1]`-ish (upstream's actual slider only
    /// reaches 0.005-0.995); default is 25 C on the -40..150 range
    /// (ThermistorNTCElm.java:46).
    position: f64,
    /// Resistance computed from `position` (ThermistorNTCElm.java's
    /// `resistance` field), recomputed whenever an editable field changes.
    resistance: f64,
}

impl Thermistor {
    const T0: f64 = 273.15;
    /// ThermistorNTCElm.java:42-46's no-args constructor defaults.
    const DEFAULT_R25: f64 = 10000.0;
    const DEFAULT_R50: f64 = 3605.0;
    const DEFAULT_MIN_TEMPR: f64 = -40.0;
    const DEFAULT_MAX_TEMPR: f64 = 150.0;
    const DEFAULT_POSITION: f64 = 0.34;

    pub fn new(spec: &ElementSpec) -> Self {
        let mut t = Self {
            base: Base::with_posts(2),
            r25: spec.param("r25", Self::DEFAULT_R25),
            r50: spec.param("r50", Self::DEFAULT_R50),
            min_tempr: spec.param("minTempr", Self::DEFAULT_MIN_TEMPR),
            max_tempr: spec.param("maxTempr", Self::DEFAULT_MAX_TEMPR),
            position: spec.param("position", Self::DEFAULT_POSITION),
            resistance: 0.0,
        };
        t.recompute();
        t
    }

    /// `calcB25100()` (ThermistorNTCElm.java:256-262): the Beta constant a
    /// datasheet's two calibration points imply, so `calc_resistance` below
    /// reproduces `r25` exactly at 25 C and `r50` exactly at 50 C.
    fn b25100(&self) -> f64 {
        let k1 = Self::T0 + 25.0;
        let k2 = Self::T0 + 50.0;
        (self.r25.ln() - self.r50.ln()) / (1.0 / k1 - 1.0 / k2)
    }

    /// `calcResistance()` (ThermistorNTCElm.java:247-250): the Beta/NTC
    /// exponential law referenced to `r25` at 25 C, `tempr` in Celsius.
    /// Upstream rounds to the nearest ohm.
    fn calc_resistance(&self, tempr: f64) -> f64 {
        let t25 = Self::T0 + 25.0;
        (self.r25 * (self.b25100() * (1.0 / (tempr + Self::T0) - 1.0 / t25)).exp()).round()
    }

    /// `temprFromSliderPos()` (ThermistorNTCElm.java:251-254). Upstream
    /// rounds to the nearest degree.
    fn temp_from_position(&self) -> f64 {
        (self.position * (self.max_tempr - self.min_tempr) + self.min_tempr).round()
    }

    fn recompute(&mut self) {
        self.resistance = self.calc_resistance(self.temp_from_position());
    }
}

impl Element for Thermistor {
    fn kind(&self) -> &'static str {
        "thermistor"
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
        match name {
            "r25" if value > 0.0 => self.r25 = value,
            "r50" if value > 0.0 => self.r50 = value,
            "minTempr" => self.min_tempr = value,
            "maxTempr" => self.max_tempr = value,
            "position" => self.position = value,
            _ => return false,
        }
        self.recompute();
        true
    }
}

/// A light-dependent resistor / photoresistor, `LDRElm.java`. Same shape as
/// `Thermistor` above: a slider `position` in `[0, 1]`-ish (upstream's own
/// slider only reaches 0.0001-0.9901, default 0.34, `LDRElm.java:30`) maps
/// through a fixed `minLux`/`maxLux` range (`0.1`/`10000`, hardcoded in both
/// constructors and never read from a file or exposed via `getEditInfo`, so
/// this port keeps them as constants rather than params) to a lux level, and
/// lux maps to resistance. `stamp()` (`LDRElm.java`:164-168) recomputes both
/// `lux` and `resistance` from `position` on every call — nothing depends on
/// current, voltage or a prior timestep — so like `Thermistor` this is a
/// plain resistor whose value only changes on edit: no `nonlinear()`
/// override, no `do_step`/`start_iteration`.
pub struct Ldr {
    base: Base,
    /// Slider position driving `lux` (`LDRElm.java`:18, default at :30).
    position: f64,
    /// Resistance computed from `position` (`LDRElm.java`'s `resistance`
    /// field), recomputed whenever an editable field changes.
    resistance: f64,
}

impl Ldr {
    /// `minLux`/`maxLux` (`LDRElm.java`:28-29): dark and full-sun endpoints,
    /// hardcoded in both constructors and never read from a file.
    const MIN_LUX: f64 = 0.1;
    const MAX_LUX: f64 = 10000.0;
    /// `LDRElm.java`:30's no-args constructor default.
    const DEFAULT_POSITION: f64 = 0.34;

    pub fn new(spec: &ElementSpec) -> Self {
        let mut l = Self {
            base: Base::with_posts(2),
            position: spec.param("position", Self::DEFAULT_POSITION),
            resistance: 0.0,
        };
        l.recompute();
        l
    }

    /// `LuxFromSliderPos()` (`LDRElm.java`:219-222).
    fn lux_from_position(&self) -> f64 {
        Self::MAX_LUX * self.position + Self::MIN_LUX
    }

    /// `calcResistance()` (`LDRElm.java`:206-218). Upstream rounds to the
    /// nearest ohm.
    fn calc_resistance(&self, lux: f64) -> f64 {
        ((Self::MAX_LUX - lux + 1.0) * 10.0).round()
    }

    fn recompute(&mut self) {
        self.resistance = self.calc_resistance(self.lux_from_position());
    }
}

impl Element for Ldr {
    fn kind(&self) -> &'static str {
        "ldr"
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
        match name {
            "position" => self.position = value,
            _ => return false,
        }
        self.recompute();
        true
    }
}
