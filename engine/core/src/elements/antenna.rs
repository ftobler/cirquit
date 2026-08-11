//! Antenna: a rail whose injected value is a synthesized AM/FM waveform
//! (upstream AntennaElm, a RailElm with WF_AC forced and getVoltage
//! overridden).

use std::f64::consts::PI;

use crate::element::{Base, Element, SimCtx};
use crate::spec::ElementSpec;
use crate::stamp::{Stamper, GROUND};

/// A one-post voltage source to ground whose value is the antenna's
/// synthesized waveform. Three amplitude-modulated carriers plus a
/// frequency-modulated term, each sine bounded by construction, so the
/// injected voltage is finite for any number of steps.
pub struct Antenna {
    base: Base,
    /// Phase of the FM carrier in radians, integrated once per converged step
    /// (AntennaElm.java:29, :42-44). Upstream's reset() never rewinds it, so
    /// neither does this model's.
    fm_phase: f64,
}

impl Antenna {
    pub fn new(_spec: &ElementSpec) -> Self {
        Self {
            base: Base::with_posts(1),
            fm_phase: 0.0,
        }
    }

    /// The waveform at `ctx.time`: three AM carriers at 2433, 2710 and 3000 Hz
    /// plus the 3 V FM term (AntennaElm.java:35-40). Each carrier sine is
    /// bounded by `(1.3+1)*3 = 6.9 V`, so the three sum to 20.7 V, and the FM
    /// term adds at most 3 V: `|V| <= 23.7` for every `t`.
    fn voltage(&self, ctx: &SimCtx) -> f64 {
        let t = ctx.time;
        let w = |hz: f64| 2.0 * PI * hz * t;
        w(3000.0).sin() * (1.3 + w(12.0).sin()) * 3.0
            + w(2710.0).sin() * (1.3 + w(13.0).sin()) * 3.0
            + w(2433.0).sin() * (1.3 + w(14.0).sin()) * 3.0
            + 3.0 * self.fm_phase.sin()
    }
}

impl Element for Antenna {
    fn kind(&self) -> &'static str {
        "antenna"
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
        // the output node's closure (RailElm.java:92-99).
        (GROUND, self.base.nodes[0])
    }
    /// A voltage source pins a capacitor loop, so the CAP_V walk must be able
    /// to cross one, exactly like the plain rail.
    fn is_voltage_source(&self) -> bool {
        true
    }

    fn stamp(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        // Stamp the topology once with a zero value; `do_step` supplies the
        // waveform each timestep, so the matrix (and its LU factors) stays
        // constant.
        s.voltage_source(GROUND, self.base.nodes[0], self.base.vs_base, 0.0);
    }

    fn do_step(&mut self, ctx: &SimCtx, s: &mut Stamper) {
        let v = self.voltage(ctx);
        s.voltage_source_value(self.base.vs_base, v);
    }

    fn step_finished(&mut self, ctx: &SimCtx) {
        // The FM carrier's phase integrates once per converged step, exactly
        // the integrand and cadence upstream uses (AntennaElm.java:42-44).
        // `ctx.time` is the end-of-step time, matching `sim.t` there.
        self.fm_phase += 2.0 * PI * (2200.0 + (2.0 * PI * ctx.time * 13.0).sin() * 100.0) * ctx.dt;
    }

    fn calculate_current(&mut self, _ctx: &SimCtx) {
        self.base.current = self.base.vs_currents[0];
    }

    /// The post is the source's delivery terminal, so the current exits the
    /// source into the node there (see `voltage_source.rs`); without this the
    /// wire-current recovery sees no injection at the post.
    fn current_into_node(&self, post: usize) -> f64 {
        if post == 0 {
            self.base.current
        } else {
            0.0
        }
    }

    fn voltage_diff(&self) -> f64 {
        // One terminal referenced to ground, so the element plots its node
        // voltage (RailElm.java:92).
        self.base.volts.first().copied().unwrap_or(0.0)
    }

    fn power(&self) -> f64 {
        // Negated so a delivering source reads negative (VoltageElm.java:461).
        -self.voltage_diff() * self.base().current
    }

    fn reset(&mut self) {
        self.base.reset();
        // Upstream's reset() leaves `fmphase` alone (VoltageElm.java:130-133
        // only rewinds `freqTimeZero`), so only a rebuild restarts the FM
        // phase.
    }
}
