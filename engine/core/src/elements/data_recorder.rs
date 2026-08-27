//! Data recorder: a one-post sensing element that logs samples into a ring.

use crate::element::{Base, Element, SimCtx};
use crate::spec::ElementSpec;

/// Ceiling on the sample ring a data recorder may hold; upstream fixes no cap
/// (DataRecorderElm.java:19, :78-83) and the dialog only requires a positive
/// count, so this is the port's own. 1<<20 f64 samples is 8 MiB, already a
/// generous export log, and the next step would overflow wasm32's `usize`
/// allocation ceiling, aborting the instance.
const MAX_DATA_RECORDER_SAMPLES: usize = 1 << 20;

/// One-post sensing element (DataRecorderElm.java:34-35): it draws no current
/// and records its single terminal's voltage every step into a ring buffer,
/// wrapping when full (DataRecorderElm.java:67-76). The samples are exported
/// on demand through [`Element::data_recorder_data`], the frontend's "export"
/// channel; the engine holds the ring and the UI reads it, so no per-frame
/// call crosses the boundary.
pub struct DataRecorder {
    base: Base,
    data_count: usize,
    data: Vec<f64>,
    data_ptr: usize,
    data_full: bool,
    /// The sampling bucket this recorder last wrote in, upstream's
    /// `lastTimeStepCount` (DataRecorderElm.java:71). While adaptation has
    /// halved the working step, several committed steps share one
    /// nominal-step bucket and only the bucket's last step may write.
    last_bucket: u64,
}

impl DataRecorder {
    pub fn new(spec: &ElementSpec) -> Result<Self, String> {
        let data_count = spec.param_count(
            "dataCount",
            10240.0,
            1.0,
            MAX_DATA_RECORDER_SAMPLES as f64,
            "dataRecorder",
        )?;
        Ok(Self {
            base: Base::with_posts(1),
            data_count,
            data: vec![0.0; data_count],
            data_ptr: 0,
            data_full: false,
            last_bucket: 0,
        })
    }
}

impl Element for DataRecorder {
    fn kind(&self) -> &'static str {
        "dataRecorder"
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
    /// An ideal meter has infinite impedance, so it does not couple its
    /// terminal to anything.
    fn connects(&self, _a: usize, _b: usize) -> bool {
        false
    }
    fn calculate_current(&mut self, _ctx: &SimCtx) {
        self.base.current = 0.0;
    }
    fn set_param(&mut self, name: &str, value: f64) -> bool {
        match name {
            "dataCount" => {
                // A size change reallocates and clears, matching setDataCount
                // (DataRecorderElm.java:78-83). Soft-clamp to the same ceiling
                // as `new`: set_param has no error channel, so a huge value is
                // silently capped rather than trusted into `vec!` and aborting
                // the instance.
                self.data_count = (value.max(1.0).min(MAX_DATA_RECORDER_SAMPLES as f64)) as usize;
                self.data = vec![0.0; self.data_count];
                self.data_ptr = 0;
                self.data_full = false;
                self.last_bucket = 0;
            }
            _ => return false,
        }
        true
    }
    fn step_finished(&mut self, ctx: &SimCtx) {
        // The operating-point solve is a DC snapshot, not a transient step:
        // recording it would inject one steady-state sample into the log.
        if ctx.dc_analysis {
            return;
        }
        // One row per nominal step, not per committed step, upstream's gate
        // on sim.timeStepCount (DataRecorderElm.java:68-70): with the working
        // step halved by adaptation, writing per commit would sample the
        // waveform faster than the export's time grid says it was sampled.
        if ctx.sample_bucket == self.last_bucket {
            return;
        }
        self.last_bucket = ctx.sample_bucket;
        self.data[self.data_ptr] = self.base.volts[0];
        self.data_ptr += 1;
        if self.data_ptr >= self.data_count {
            self.data_ptr = 0;
            self.data_full = true;
        }
    }
    fn voltage_diff(&self) -> f64 {
        // One-post elements read out their single node voltage
        // (DataRecorderElm.java:61).
        self.base.volts[0]
    }
    /// The valid samples, oldest first. A full ring starts at the write
    /// pointer; a partial one starts at the buffer head
    /// (DataRecorderElm.java:108-114).
    fn data_recorder_data(&self) -> Vec<f64> {
        if self.data_full {
            (0..self.data_count)
                .map(|i| self.data[(i + self.data_ptr) % self.data_count])
                .collect()
        } else {
            self.data[..self.data_ptr].to_vec()
        }
    }
    fn reset(&mut self) {
        self.base.reset();
        self.data_ptr = 0;
        self.data_full = false;
        self.last_bucket = 0;
    }
}
