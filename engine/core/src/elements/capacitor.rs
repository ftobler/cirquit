//! Capacitor companion model.

use crate::element::{Base, Element, SimCtx};
use crate::spec::ElementSpec;
use crate::stamp::Stamper;

/// Resistance a capacitor is modelled with while solving the DC operating
/// point, standing in for an open circuit. `pub(crate)` so the varactor's
/// companion capacitance (diode.rs) can reuse the same steady-state
/// treatment instead of picking its own constant.
pub(crate) const DC_OPEN: f64 = 1e8;

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
