//! White-noise supply rail: the rail model pinned to the noise waveform
//! (upstream NoiseElm, a RailElm whose constructors force WF_NOISE).

use crate::element::{Base, Element, SimCtx};
use crate::elements::voltage_source::VoltageSource;
use crate::spec::ElementSpec;
use crate::stamp::Stamper;

/// The noise waveform's on-disk code, WF_NOISE (VoltageElm.java:45).
const WF_NOISE: f64 = 6.0;

/// A one-post supply rail whose output is white noise. It wraps the rail's
/// own model with the waveform pinned, the same wrapper pattern the LED uses
/// for the diode: the engine sees exactly the rail machinery, including the
/// once-per-step noise sample and the per-source seed salted by element id, so
/// a noise rail reproduces the plain rail's sequence given the same id.
pub struct Noise {
    source: VoltageSource,
}

impl Noise {
    pub fn new(spec: &ElementSpec) -> Self {
        // Upstream's token constructor reads the rail tokens and then forces
        // the waveform (NoiseElm.java:24-28). Clone rather than mutate: the
        // spec outlives the model.
        let mut spec = spec.clone();
        spec.params.insert("waveform".into(), WF_NOISE);
        Self {
            source: VoltageSource::new_rail(&spec),
        }
    }
}

impl Element for Noise {
    fn kind(&self) -> &'static str {
        "noise"
    }
    fn base(&self) -> &Base {
        self.source.base()
    }
    fn base_mut(&mut self) -> &mut Base {
        self.source.base_mut()
    }
    fn post_count(&self) -> usize {
        1
    }
    fn voltage_source_count(&self) -> usize {
        1
    }
    fn voltage_source_nodes(&self, k: usize) -> (usize, usize) {
        // The rail stamps its one terminal against ground, so the source
        // unknown must be assigned to that terminal's closure (RailElm.java:
        // 92-99).
        self.source.voltage_source_nodes(k)
    }

    /// A rail pins a capacitor loop, so the CAP_V walk must be able to cross
    /// one, exactly like the plain rail (VoltageElm.java's family-wide
    /// `isVoltageSource`).
    fn is_voltage_source(&self) -> bool {
        true
    }

    fn stamp(&mut self, ctx: &SimCtx, s: &mut Stamper) {
        self.source.stamp(ctx, s);
    }
    fn do_step(&mut self, ctx: &SimCtx, s: &mut Stamper) {
        self.source.do_step(ctx, s);
    }
    fn step_finished(&mut self, ctx: &SimCtx) {
        self.source.step_finished(ctx);
    }
    fn calculate_current(&mut self, ctx: &SimCtx) {
        self.source.calculate_current(ctx);
    }
    fn reset(&mut self) {
        self.source.reset();
    }
    fn set_frequency(&mut self, ctx: &SimCtx, new_freq: f64) -> bool {
        self.source.set_frequency(ctx, new_freq)
    }
    fn set_param(&mut self, name: &str, value: f64) -> bool {
        if name == "waveform" {
            // The noise rail is the noise waveform by definition, so a live
            // edit must not be able to unpin it; every other name passes
            // straight to the rail model.
            return self.source.set_param(name, WF_NOISE);
        }
        self.source.set_param(name, value)
    }
    fn voltage_diff(&self) -> f64 {
        self.source.voltage_diff()
    }
    fn power(&self) -> f64 {
        self.source.power()
    }
}
