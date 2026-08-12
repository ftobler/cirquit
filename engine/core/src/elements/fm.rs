//! Frequency-modulated sine source (FMElm.java).

use std::f64::consts::PI;

use crate::element::{Base, Element, SimCtx};
use crate::spec::ElementSpec;
use crate::stamp::{Stamper, GROUND};

/// A one-post voltage source to ground whose instantaneous frequency is
/// `cf + dev·sin(2π·sf·t)`, so the phase is the exact integral of that law
/// (FMElm.java:86-93). Upstream accumulates the phase as a per-step right-point
/// sum, `funcx += dt·(cf + sin(2π·sf·t)·dev)`, which drifts with the timestep;
/// the closed form reproduces the continuous limit and stays independent of the
/// fixed step, the same divergence the sweep source makes (sweep.rs).
pub struct FM {
    base: Base,
    carrier_freq: f64,
    signal_freq: f64,
    max_voltage: f64,
    deviation: f64,
}

impl FM {
    /// No-arg constructor defaults, which the token constructor shares
    /// (FMElm.java:32-38, :43-46). Upstream's FLAG_COS (bit 2) is cleared on
    /// load and converts nothing (FMElm.java:47-49), so no flag handling here.
    pub fn new(spec: &ElementSpec) -> Self {
        Self {
            base: Base::with_posts(1),
            carrier_freq: spec.param("carrierFreq", 800.0),
            signal_freq: spec.param("signalFreq", 40.0),
            max_voltage: spec.param("maxVoltage", 5.0),
            deviation: spec.param("deviation", 200.0),
        }
    }

    /// Phase in cycles, `integral_0^t (cf + dev·sin(2π·sf·u)) du`.
    fn phase(&self, t: f64) -> f64 {
        let w = 2.0 * PI * self.signal_freq;
        if w == 0.0 {
            // A zero signal frequency drives no modulation: the modulating sine
            // is 0 for every `t`, so the phase is just `cf·t`. The closed form
            // would otherwise divide by the zero `w`.
            self.carrier_freq * t
        } else {
            self.carrier_freq * t + self.deviation * (1.0 - (w * t).cos()) / w
        }
    }

    /// Source value at time `t`. During the DC solve the source collapses to
    /// zero, its bias, exactly as the AC source freezes at its own bias
    /// (VoltageElm.java:168-169).
    fn voltage(&self, ctx: &SimCtx) -> f64 {
        if ctx.dc_analysis {
            return 0.0;
        }
        self.max_voltage * (2.0 * PI * self.phase(ctx.time)).sin()
    }
}

impl Element for FM {
    fn kind(&self) -> &'static str {
        "fm"
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
        // the output node's closure (FMElm.java:81).
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
        // voltage (FMElm.java:131).
        self.base.volts.first().copied().unwrap_or(0.0)
    }

    fn power(&self) -> f64 {
        // Negated so a delivering source reads negative (FMElm.java:139).
        -self.voltage_diff() * self.base().current
    }

    fn set_param(&mut self, name: &str, value: f64) -> bool {
        match name {
            "carrierFreq" => self.carrier_freq = value,
            "signalFreq" => self.signal_freq = value,
            "maxVoltage" => self.max_voltage = value,
            "deviation" => self.deviation = value,
            _ => return false,
        }
        true
    }

    fn reset(&mut self) {
        self.base.reset();
    }
}
