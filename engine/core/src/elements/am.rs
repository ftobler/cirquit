//! Amplitude-modulated sine source (AMElm.java).

use std::f64::consts::PI;

use crate::element::{Base, Element, SimCtx};
use crate::spec::ElementSpec;
use crate::stamp::{Stamper, GROUND};

/// A one-post voltage source to ground whose value is
/// `((sin(2π·sf·t)+1)/2)·sin(2π·cf·t)·maxV`: the carrier `cf` rides under an
/// envelope in `[0, 1]` driven by `sf`, so the peak swings between 0 and
/// `maxV` (AMElm.java:80-83). Each factor is bounded by 1, so `|V| <= maxV`
/// for every `t`. The value is a pure function of time, so the fixed timestep
/// cannot alias the envelope.
pub struct AM {
    base: Base,
    carrier_freq: f64,
    signal_freq: f64,
    max_voltage: f64,
}

impl AM {
    /// No-arg constructor defaults, which the token constructor shares
    /// (AMElm.java:30-35, :40-42). Upstream's FLAG_COS (bit 2) is cleared on
    /// load and converts nothing (AMElm.java:43-45), so no flag handling here.
    pub fn new(spec: &ElementSpec) -> Self {
        Self {
            base: Base::with_posts(1),
            carrier_freq: spec.param("carrierFreq", 1000.0),
            signal_freq: spec.param("signalFreq", 40.0),
            max_voltage: spec.param("maxVoltage", 5.0),
        }
    }

    /// The waveform at `ctx.time`. During the DC solve the source collapses to
    /// zero, its bias, exactly as the AC source freezes at its own bias
    /// (VoltageElm.java:168-169).
    fn voltage(&self, ctx: &SimCtx) -> f64 {
        if ctx.dc_analysis {
            return 0.0;
        }
        let w = 2.0 * PI * ctx.time;
        ((w * self.signal_freq).sin() + 1.0) / 2.0
            * (w * self.carrier_freq).sin()
            * self.max_voltage
    }
}

impl Element for AM {
    fn kind(&self) -> &'static str {
        "am"
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
        // the output node's closure (AMElm.java:75).
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
        // voltage (AMElm.java:121).
        self.base.volts.first().copied().unwrap_or(0.0)
    }

    fn power(&self) -> f64 {
        // Negated so a delivering source reads negative (AMElm.java:129).
        -self.voltage_diff() * self.base().current
    }

    fn set_param(&mut self, name: &str, value: f64) -> bool {
        match name {
            "carrierFreq" => self.carrier_freq = value,
            "signalFreq" => self.signal_freq = value,
            "maxVoltage" => self.max_voltage = value,
            _ => return false,
        }
        true
    }

    fn reset(&mut self) {
        self.base.reset();
    }
}
