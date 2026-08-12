//! Data recorder: a one-post sensing element that logs samples into a ring.

use crate::element::{Base, Element, SimCtx};
use crate::spec::ElementSpec;

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
}

impl DataRecorder {
    pub fn new(spec: &ElementSpec) -> Self {
        let data_count = spec.param("dataCount", 10240.0).max(1.0) as usize;
        Self {
            base: Base::with_posts(1),
            data_count,
            data: vec![0.0; data_count],
            data_ptr: 0,
            data_full: false,
        }
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
                // (DataRecorderElm.java:78-83).
                self.data_count = value.max(1.0) as usize;
                self.data = vec![0.0; self.data_count];
                self.data_ptr = 0;
                self.data_full = false;
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
    }
}
