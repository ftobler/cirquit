//! Frequency-swept sine source (SweepElm.java).

use std::f64::consts::PI;

use crate::element::{Base, Element, SimCtx};
use crate::spec::ElementSpec;
use crate::stamp::{Stamper, GROUND};

/// Load-time flag meanings, shared with the TypeScript registry
/// (SweepElm.java:27-28).
const FLAG_LOG: i64 = 1;
const FLAG_BIDIR: i64 = 2;

/// A one-post sine source to ground whose frequency ramps from `min_f` to
/// `max_f` over `sweep_time`, then snaps back to `min_f` or, under FLAG_BIDIR,
/// sweeps back down before repeating.
///
/// The value is `max_v * sin(2*pi*phase)` with the phase the exact closed-form
/// integral of the swept frequency, so there is no per-step accumulator: the
/// value is a pure function of absolute time, matching the AC source's
/// `ctx.time` evaluation (voltage_source.rs). Upstream instead integrates by
/// hand, accumulating `frequency*2*pi*dt` each step and then advancing the
/// frequency (SweepElm.java:153-173), a left-Riemann sum whose result drifts
/// with the timestep; the closed form of the same continuous frequency law
/// reproduces the limit and stays independent of the fixed step. The linear
/// ramp `min_f + (max_f-min_f)*t/sweep_time` integrates to
/// `min_f*t + (max_f-min_f)*t^2/(2*sweep_time)`, and the log ramp
/// `min_f*(max_f/min_f)^(t/sweep_time)` to
/// `min_f*sweep_time/ln(max_f/min_f) * ((max_f/min_f)^(t/sweep_time) - 1)`;
/// the down ramp is the mirror image, so a cycle's phase is continuous.
pub struct Sweep {
    base: Base,
    min_f: f64,
    max_f: f64,
    max_v: f64,
    sweep_time: f64,
    log: bool,
    bidir: bool,
}

impl Sweep {
    pub fn new(spec: &ElementSpec) -> Self {
        Self {
            base: Base::with_posts(1),
            min_f: spec.param("minF", 20.0),
            max_f: spec.param("maxF", 4000.0),
            max_v: spec.param("maxV", 5.0),
            sweep_time: spec.param("sweepTime", 0.1),
            log: spec.flag(FLAG_LOG),
            bidir: spec.flag(FLAG_BIDIR),
        }
    }

    /// Source value at time `t`. During the DC solve the sweep collapses to
    /// zero, its bias, exactly as the AC source freezes at its own bias
    /// (VoltageElm.java:168-169).
    fn voltage(&self, ctx: &SimCtx) -> f64 {
        if ctx.dc_analysis {
            return 0.0;
        }
        self.max_v * (2.0 * PI * self.integrated_phase(ctx.time)).sin()
    }

    /// Phase accumulated by one full up ramp (or the up-down pair under
    /// FLAG_BIDIR), in cycles.
    fn cycle_phase(&self) -> f64 {
        let sweep = self.sweep_time;
        let half = if self.log {
            let r = self.max_f / self.min_f;
            self.min_f * sweep / r.ln() * (r - 1.0)
        } else {
            sweep * (self.min_f + self.max_f) / 2.0
        };
        if self.bidir {
            2.0 * half
        } else {
            half
        }
    }

    /// Phase in cycles up the ramp, `u` seconds into it.
    fn ramp_phase(&self, u: f64) -> f64 {
        let sweep = self.sweep_time;
        if self.log {
            let r = self.max_f / self.min_f;
            self.min_f * sweep / r.ln() * (r.powf(u / sweep) - 1.0)
        } else {
            self.min_f * u + (self.max_f - self.min_f) * u * u / (2.0 * sweep)
        }
    }

    /// Phase in cycles down the ramp, `u` seconds into it.
    fn down_ramp_phase(&self, u: f64) -> f64 {
        let sweep = self.sweep_time;
        if self.log {
            let r = self.max_f / self.min_f;
            self.max_f * sweep / r.ln() * (1.0 - r.powf(-u / sweep))
        } else {
            self.max_f * u - (self.max_f - self.min_f) * u * u / (2.0 * sweep)
        }
    }

    /// Integrated phase in cycles, `integral_0^t f(u) du`, for the exact
    /// swept-frequency law including the FLAG_BIDIR turn-around and the
    /// non-bidir snap back to `min_f`.
    fn integrated_phase(&self, t: f64) -> f64 {
        // A zero sweep time, a flat or descending range, or a log ratio with a
        // non-positive base all degenerate to a constant frequency: the sweep
        // becomes a plain sine source at `min_f`, so `phase = min_f * t`.
        let sweep = self.sweep_time;
        if !(sweep > 0.0 && self.max_f > self.min_f && (!self.log || self.min_f > 0.0)) {
            return self.min_f * t;
        }
        let cycle = if self.bidir { 2.0 * sweep } else { sweep };
        let c = (t / cycle).floor();
        let p = t - c * cycle;
        let mut phase = c * self.cycle_phase();
        if self.bidir && p >= sweep {
            // Past the turn-around: the completed up ramp plus the phase
            // accumulated so far down the return ramp.
            phase += self.cycle_phase() / 2.0 + self.down_ramp_phase(p - sweep);
        } else {
            phase += self.ramp_phase(p);
        }
        phase
    }
}

impl Element for Sweep {
    fn kind(&self) -> &'static str {
        "sweep"
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
    fn voltage_source_count(&self) -> usize {
        1
    }
    fn voltage_source_nodes(&self, _k: usize) -> (usize, usize) {
        // One-post source to ground, like the rail; the unknown must land in
        // the output node's closure (SweepElm.java:126-128).
        (GROUND, self.base.nodes[0])
    }
    /// A voltage source pins a capacitor loop, so the CAP_V walk must be able
    /// to cross it.
    fn is_voltage_source(&self) -> bool {
        true
    }

    fn stamp(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        // Stamp the topology now with a zero value; `do_step` supplies the
        // swept value each timestep, so the matrix (and its LU factors) stays
        // constant.
        s.voltage_source(GROUND, self.base.nodes[0], self.base.vs_base, 0.0);
    }

    fn do_step(&mut self, ctx: &SimCtx, s: &mut Stamper) {
        let v = self.voltage(ctx);
        s.voltage_source_value(self.base.vs_base, v);
    }

    fn calculate_current(&mut self, _ctx: &SimCtx) {
        self.base.current = self.base.vs_currents[0];
    }

    fn voltage_diff(&self) -> f64 {
        // Upstream reads out the single node voltage (SweepElm.java:178).
        self.base.volts.first().copied().unwrap_or(0.0)
    }

    fn power(&self) -> f64 {
        // Negated so a delivering source reads negative (SweepElm.java:240).
        -self.voltage_diff() * self.base().current
    }

    fn set_param(&mut self, name: &str, value: f64) -> bool {
        match name {
            "minF" => self.min_f = value,
            "maxF" => self.max_f = value,
            "maxV" => self.max_v = value,
            "sweepTime" => self.sweep_time = value,
            _ => return false,
        }
        true
    }

    fn reset(&mut self) {
        self.base.reset();
        // The phase is a closed-form integral of time, so there is no
        // accumulator to rewind (upstream's `freqTime`/`dir`, SweepElm.java:
        // 146-151); the next do_step just re-evaluates at the new t=0.
    }
}
