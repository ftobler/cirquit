//! Audio output: a one-post passive sink for a node voltage
//! (AudioOutputElm.java).

use crate::element::{Base, Element, SimCtx};
use crate::spec::ElementSpec;

/// An audio output. The port is a static site with no audio device, so this
/// element is purely passive: it samples nothing, plays nothing and draws no
/// current. The three tokens are file-format state kept only so a load/save
/// round-trips them exactly (AudioOutputElm.java:53-55): `duration` is the
/// buffer length in seconds, `sampling_rate` the WAV sample rate and
/// `label_num` the per-session counter that disambiguates multiple outputs.
pub struct AudioOutput {
    base: Base,
    #[allow(dead_code)]
    duration: f64,
    #[allow(dead_code)]
    sampling_rate: f64,
    #[allow(dead_code)]
    label_num: f64,
}

impl AudioOutput {
    /// The no-args constructor defaults (AudioOutputElm.java:31-34). The
    /// upstream `labelNum` comes from a per-session counter; this port has no
    /// cross-element scan, so 0 stands in and the token still round-trips.
    pub fn new(spec: &ElementSpec) -> Self {
        Self {
            base: Base::with_posts(1),
            duration: spec.param("duration", 1.0),
            sampling_rate: spec.param("samplingRate", 8000.0),
            label_num: spec.param("labelNum", 0.0),
        }
    }
}

impl Element for AudioOutput {
    fn kind(&self) -> &'static str {
        "audioOutput"
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
    /// A single-post indicator does not couple its terminal: there is no
    /// current path of its own, so the node it reads is never loaded.
    fn connects(&self, _a: usize, _b: usize) -> bool {
        false
    }
    fn calculate_current(&mut self, _ctx: &SimCtx) {
        self.base.current = 0.0;
    }
    fn set_param(&mut self, name: &str, value: f64) -> bool {
        match name {
            "duration" => self.duration = value,
            "samplingRate" => self.sampling_rate = value,
            "labelNum" => self.label_num = value,
            _ => return false,
        }
        true
    }
    /// Scopes plot the node voltage, matching upstream's `getVoltageDiff()`
    /// (AudioOutputElm.java:125).
    fn voltage_diff(&self) -> f64 {
        self.base.volts.first().copied().unwrap_or(0.0)
    }
    /// The three tokens are file state, not run state, so reset only clears the
    /// per-step buffer scratch upstream keeps (`reset()`,
    /// AudioOutputElm.java:91-97), which here reduces to the base's volts and
    /// current.
    fn reset(&mut self) {
        self.base.reset();
    }
}
