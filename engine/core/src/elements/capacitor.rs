//! Capacitor companion model.

use crate::element::{Base, Element, SimCtx};
use crate::spec::ElementSpec;
use crate::stamp::Stamper;

/// Resistance a capacitor is modelled with while solving the DC operating
/// point, standing in for an open circuit. `pub(crate)` so the varactor's
/// companion capacitance (diode.rs) can reuse the same steady-state
/// treatment instead of picking its own constant.
///
/// The DC solve commits its result: `step_finished` runs for the operating
/// point too, so a capacitor the solve charged to its steady voltage starts
/// the transient pre-charged rather than from its initial value.
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

    pub fn new(spec: &ElementSpec) -> Result<Self, String> {
        Self::build(spec, false)
    }

    /// The polarised variant: same electrical model, plus a reverse-voltage
    /// rating (PolarCapacitorElm.java).
    pub fn new_polarized(spec: &ElementSpec) -> Result<Self, String> {
        Self::build(spec, true)
    }

    /// The spec constructor rejects a non-positive capacitance instead of
    /// storing it: a negative companion conductance stamps as an active
    /// negative resistance whose trapezoidal step is positive feedback, and
    /// an exact zero is skipped by the stamper, turning the part into an
    /// unlabelled open. `set_param` keeps the same positivity rule, so both
    /// entry points agree.
    fn build(spec: &ElementSpec, polarized: bool) -> Result<Self, String> {
        let capacitance = spec.param("capacitance", 1e-5);
        if capacitance <= 0.0 || capacitance.is_nan() {
            let kind = if polarized {
                "polarizedCapacitor"
            } else {
                "capacitor"
            };
            return Err(format!(
                "{kind} (id {}) capacitance must be positive, got {}",
                spec.id, capacitance
            ));
        }
        // 1e-3, not 0: upstream deliberately puts a small charge on every
        // capacitor so a fresh LC tank self-starts (CapacitorElm.java:38, and
        // the same value is the load-time fallback at :46).
        let iv = spec.param("initialVoltage", 1e-3);
        let series_resistance = spec.param("seriesResistance", 0.0);
        Ok(Self {
            base: Base::with_posts(2),
            capacitance,
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
        })
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

    /// A capacitor is an open at DC, so it never carries the current path
    /// `check_broken_sources` is looking for (FindPathInfo.INDUCT treats it
    /// as blocking).
    fn dc_connects(&self, _a: usize, _b: usize) -> bool {
        false
    }

    /// Ideal means no series resistance (CapacitorElm.java:271). A damped
    /// capacitor is therefore no longer traversable in the CAP_V walk, which
    /// is what stops a parallel pair from damping both members.
    fn is_ideal_capacitor(&self) -> bool {
        self.series_resistance == 0.0
    }

    /// A capacitor whose posts merged into one node is shorted: its stored
    /// charge and current are meaningless, so the walk zeroes them
    /// (CapacitorElm.java:63-66). The companion's self-node stamp already
    /// cancels, this just stops a stale voltDiff from feeding the readback.
    fn shorted(&mut self) {
        self.v_prev = 0.0;
        self.i_prev = 0.0;
    }

    /// The 0.1 ohm damping for ideal-capacitor loops (CapacitorElm.java:285).
    /// The internal node does not exist until the retry pass re-runs
    /// `assign_nodes`, which is why the validate pass reports the change.
    fn set_series_resistance(&mut self, r: f64) {
        self.series_resistance = r;
        self.cap_node = if r > 0.0 { 2 } else { 1 };
    }

    fn state_tokens(&self) -> Vec<(String, f64)> {
        vec![
            ("voltDiff".into(), self.v_prev),
            ("seriesResistance".into(), self.series_resistance),
        ]
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

    /// Charge on the plate, `C * Vplate`, upstream's `getScopeValue(VAL_CHARGE)`
    /// (CapacitorElm.java:225-229). `v_prev` holds the plate voltage
    /// (`step_finished` below), which is what the scope's stored charge must
    /// track, not the terminal voltage.
    fn charge(&self) -> f64 {
        self.capacitance * self.v_prev
    }

    fn step_finished(&mut self, _ctx: &SimCtx) {
        // The stored charge is the plate voltage (CapacitorElm.java:184).
        // The operating-point step commits too, so a capacitor the DC solve
        // charged carries that voltage into the first transient step instead
        // of glitching from an uncharged state. `i_prev` is the near-zero
        // current through the DC open (`calculate_current` above).
        self.v_prev = self.base.volts[0] - self.base.volts[self.cap_node];
        self.i_prev = self.base.current;
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
            // The saved `voltDiff` token is the stored charge, `v_prev`
            // (state_tokens reports it as voltDiff). The opampReal composite
            // restores its compensation capacitor's charge this way
            // (OpAmpRealElm.java:106), which must land in the plate voltage,
            // not the initial voltage, or the first reset would throw it away.
            "voltDiff" => self.v_prev = value,
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
