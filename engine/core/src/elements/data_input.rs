//! Data file input: a one-post voltage source whose value steps through a
//! loaded sample buffer (DataInputElm.java).

use serde::Deserialize;

use crate::element::{Base, Element, SimCtx};
use crate::spec::ElementSpec;
use crate::stamp::{Stamper, GROUND};

/// The repeat checkbox bit (DataInputElm.java:43).
const FLAG_REPEAT: i64 = 256;

/// The sample payload the frontend builds from its session cache by
/// `fileNum`, riding the `spec.model` string carrier like the audio input
/// (DataInputElm.java:46-47). A missing or garbage payload is an empty
/// buffer, so the source reads zero exactly like upstream's `data == null`
/// (DataInputElm.java:117-118).
#[derive(Deserialize)]
struct DataModel {
    #[serde(default)]
    samples: Vec<f64>,
}

/// A one-post voltage source to ground (a rail, DataInputElm extends RailElm)
/// whose injected value is the sample at index `timeOffset / sampleLength`,
/// clamped to the last sample or wrapped to zero under FLAG_REPEAT.
pub struct DataInput {
    base: Base,
    sample_length: f64,
    scale_factor: f64,
    /// The file identifier the cache keyed the samples under. The engine
    /// never reads it: the frontend resolves it to the payload. Kept so the
    /// token round-trips and a live edit is accepted.
    #[allow(dead_code)]
    file_num: f64,
    repeat: bool,
    samples: Vec<f64>,
    /// Seconds into the buffer; `reset()` returns it to zero
    /// (DataInputElm.java:102-104) and `step_finished` advances it by the
    /// step (DataInputElm.java:132-134).
    time_offset: f64,
}

impl DataInput {
    pub fn new(spec: &ElementSpec) -> Self {
        let samples = spec
            .model
            .as_deref()
            .and_then(|m| serde_json::from_str::<DataModel>(m).ok())
            .map(|m| m.samples)
            .unwrap_or_default();
        Self {
            base: Base::with_posts(1),
            sample_length: spec.param("sampleLength", 1e-3),
            scale_factor: spec.param("scaleFactor", 1.0),
            file_num: spec.param("fileNum", 0.0),
            repeat: spec.flag(FLAG_REPEAT),
            samples,
            time_offset: 0.0,
        }
    }

    /// The source value. During the DC solve the source collapses to zero,
    /// its bias, exactly as the AC source freezes at its own bias
    /// (VoltageElm.java:168-169). Otherwise the sample read is upstream's
    /// `getVoltage` (DataInputElm.java:116-130): the sample at the current
    /// index, clamped to the last one once the buffer runs out, or wrapped
    /// back to the first under FLAG_REPEAT.
    fn voltage(&mut self, ctx: &SimCtx) -> f64 {
        if ctx.dc_analysis {
            return 0.0;
        }
        if self.samples.is_empty() {
            return 0.0;
        }
        let mut ptr = (self.time_offset / self.sample_length).trunc() as i64;
        if ptr < 0 {
            ptr = 0;
        }
        if ptr >= self.samples.len() as i64 {
            if self.repeat {
                // The wrap mutates the cursor so the loop replays from the
                // start, exactly as upstream resets `timeOffset` in place
                // (DataInputElm.java:123-126).
                ptr = 0;
                self.time_offset = 0.0;
            } else {
                ptr = self.samples.len() as i64 - 1;
            }
        }
        self.samples[ptr as usize] * self.scale_factor
    }
}

impl Element for DataInput {
    fn kind(&self) -> &'static str {
        "dataInput"
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
        // The buffer cursor advances once per converged step (DataInputElm.java:
        // 132-134). `ctx.time` is the end-of-step time, matching `sim.t` there.
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
            "sampleLength" => self.sample_length = value,
            "scaleFactor" => self.scale_factor = value,
            "fileNum" => self.file_num = value,
            _ => return false,
        }
        true
    }

    fn reset(&mut self) {
        self.base.reset();
        // The buffer cursor rewinds to the start of the data (DataInputElm.java:
        // 102-104).
        self.time_offset = 0.0;
    }
}
