//! Audio file input: a one-post voltage source whose value is a linear
//! interpolation of a loaded sample buffer (AudioInputElm.java).

use serde::Deserialize;

use crate::element::{Base, Element, SimCtx};
use crate::spec::ElementSpec;
use crate::stamp::{Stamper, GROUND};

/// The sample payload the frontend builds from its session cache by
/// `fileNum`, riding the `spec.model` string carrier like the custom-logic
/// model (AudioInputElm.java:48-50). A missing or garbage payload is an
/// empty buffer, so the source reads zero exactly like upstream's `data ==
/// null` (AudioInputElm.java:130-131).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AudioModel {
    #[serde(default)]
    samples: Vec<f64>,
    #[serde(default)]
    sampling_rate: f64,
}

/// A one-post voltage source to ground (a rail, AudioInputElm extends
/// RailElm) whose injected value is a linear interpolation between the two
/// samples around `timeOffset * samplingRate`.
pub struct AudioInput {
    base: Base,
    max_voltage: f64,
    start_position: f64,
    /// The file identifier the cache keyed the samples under. The engine
    /// never reads it: the frontend resolves it to the payload. Kept so the
    /// token round-trips and a live edit is accepted.
    #[allow(dead_code)]
    file_num: f64,
    samples: Vec<f64>,
    sampling_rate: f64,
    /// Seconds into the buffer; `reset()` returns it to `start_position`
    /// (AudioInputElm.java:113-115) and `step_finished` advances it by the
    /// step (AudioInputElm.java:144-146).
    time_offset: f64,
}

impl AudioInput {
    pub fn new(spec: &ElementSpec) -> Self {
        let model = spec
            .model
            .as_deref()
            .and_then(|m| serde_json::from_str::<AudioModel>(m).ok());
        let samples = model
            .as_ref()
            .map(|m| m.samples.clone())
            .unwrap_or_default();
        let sampling_rate = model.map(|m| m.sampling_rate).unwrap_or(0.0);
        let start_position = spec.param("startPosition", 0.0);
        Self {
            base: Base::with_posts(1),
            max_voltage: spec.param("maxVoltage", 5.0),
            start_position,
            file_num: spec.param("fileNum", 0.0),
            samples,
            sampling_rate,
            time_offset: start_position,
        }
    }

    /// The source value. During the DC solve the source collapses to zero,
    /// its bias, exactly as the AC source freezes at its own bias
    /// (VoltageElm.java:168-169). Otherwise the sample read is upstream's
    /// `getVoltage` (AudioInputElm.java:129-142): a linear interpolation
    /// between `samples[iptr]` and the next sample, past the end of the
    /// buffer zero.
    fn voltage(&self, ctx: &SimCtx) -> f64 {
        if ctx.dc_analysis {
            return 0.0;
        }
        if self.samples.is_empty() || self.sampling_rate <= 0.0 {
            return 0.0;
        }
        let dptr = self.time_offset.max(self.start_position) * self.sampling_rate;
        let iptr = dptr.trunc() as usize;
        if iptr >= self.samples.len() {
            return 0.0;
        }
        let frac = dptr - iptr as f64;
        let value1 = self.samples[iptr];
        let value2 = if iptr + 1 < self.samples.len() {
            self.samples[iptr + 1]
        } else {
            0.0
        };
        (value1 * (1.0 - frac) + value2 * frac) * self.max_voltage
    }
}

impl Element for AudioInput {
    fn kind(&self) -> &'static str {
        "audioInput"
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
        // sample value each timestep, so the matrix (and its LU factors)
        // stays constant.
        s.voltage_source(GROUND, self.base.nodes[0], self.base.vs_base, 0.0);
    }

    fn do_step(&mut self, ctx: &SimCtx, s: &mut Stamper) {
        let v = self.voltage(ctx);
        s.voltage_source_value(self.base.vs_base, v);
    }

    fn step_finished(&mut self, ctx: &SimCtx) {
        // The buffer cursor advances once per converged step (AudioInputElm.java:
        // 144-146). `ctx.time` is the end-of-step time, matching `sim.t` there.
        self.time_offset += ctx.dt;
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

    fn set_param(&mut self, name: &str, value: f64) -> bool {
        match name {
            "maxVoltage" => self.max_voltage = value,
            "startPosition" => self.start_position = value,
            "fileNum" => self.file_num = value,
            _ => return false,
        }
        true
    }

    fn reset(&mut self) {
        self.base.reset();
        // The buffer cursor rewinds to the start position (AudioInputElm.java:
        // 113-115); a live `startPosition` edit therefore takes effect at the
        // next reset, exactly as upstream's setEditValue leaves `timeOffset`
        // alone.
        self.time_offset = self.start_position;
    }
}
