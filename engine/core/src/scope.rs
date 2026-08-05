//! Waveform capture.
//!
//! Scopes have to sample at full timestep resolution, which is far finer than
//! the frame rate, so the sampling lives in the engine rather than in the UI.
//! Each trace aggregates `steps_per_column` timesteps into a min/max pair, the
//! same way an oscilloscope column works, and keeps a ring of those columns.

use crate::spec::{ScopeSpec, ScopeValue};

pub struct ScopeTrace {
    pub spec: ScopeSpec,
    /// Index into the circuit's element list, resolved at analysis time.
    pub element_index: Option<usize>,
    mins: Vec<f32>,
    maxs: Vec<f32>,
    /// Next column to write, modulo capacity.
    head: usize,
    /// Total columns ever completed. Lets the UI align traces in time and
    /// detect wrap-around.
    pub columns_written: u64,
    acc_count: u32,
    acc_min: f64,
    acc_max: f64,
}

impl ScopeTrace {
    pub fn new(spec: ScopeSpec, element_index: Option<usize>) -> Self {
        let cap = spec.columns.clamp(16, 8192) as usize;
        Self {
            spec,
            element_index,
            mins: vec![0.0; cap],
            maxs: vec![0.0; cap],
            head: 0,
            columns_written: 0,
            acc_count: 0,
            acc_min: f64::INFINITY,
            acc_max: f64::NEG_INFINITY,
        }
    }

    pub fn capacity(&self) -> usize {
        self.mins.len()
    }

    pub fn value_kind(&self) -> ScopeValue {
        self.spec.value
    }

    pub fn clear(&mut self) {
        self.mins.iter_mut().for_each(|v| *v = 0.0);
        self.maxs.iter_mut().for_each(|v| *v = 0.0);
        self.head = 0;
        self.columns_written = 0;
        self.acc_count = 0;
        self.acc_min = f64::INFINITY;
        self.acc_max = f64::NEG_INFINITY;
    }

    /// Feeds one timestep's sample in.
    pub fn push(&mut self, value: f64) {
        if !value.is_finite() {
            return;
        }
        self.acc_min = self.acc_min.min(value);
        self.acc_max = self.acc_max.max(value);
        self.acc_count += 1;
        if self.acc_count >= self.spec.steps_per_column.max(1) {
            self.flush();
        }
    }

    fn flush(&mut self) {
        if self.acc_count == 0 {
            return;
        }
        let cap = self.mins.len();
        self.mins[self.head] = self.acc_min as f32;
        self.maxs[self.head] = self.acc_max as f32;
        self.head = (self.head + 1) % cap;
        self.columns_written += 1;
        self.acc_count = 0;
        self.acc_min = f64::INFINITY;
        self.acc_max = f64::NEG_INFINITY;
    }

    /// Columns in chronological order, oldest first, interleaved `[min, max, ...]`.
    ///
    /// Before the ring has filled, only the columns actually written are
    /// returned, so the UI can draw a partial trace.
    pub fn snapshot(&self) -> Vec<f32> {
        let cap = self.mins.len();
        let filled = (self.columns_written as usize).min(cap);
        let mut out = Vec::with_capacity(filled * 2);
        let start = if self.columns_written as usize > cap {
            self.head
        } else {
            0
        };
        for k in 0..filled {
            let i = (start + k) % cap;
            out.push(self.mins[i]);
            out.push(self.maxs[i]);
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(steps_per_column: u32, columns: u32) -> ScopeSpec {
        ScopeSpec {
            element_id: 0,
            value: ScopeValue::Voltage,
            post: 0,
            steps_per_column,
            columns,
        }
    }

    #[test]
    fn aggregates_min_and_max_per_column() {
        let mut t = ScopeTrace::new(spec(4, 16), Some(0));
        for v in [1.0, -2.0, 3.0, 0.5] {
            t.push(v);
        }
        let snap = t.snapshot();
        assert_eq!(snap.len(), 2);
        assert_eq!(snap[0], -2.0);
        assert_eq!(snap[1], 3.0);
    }

    #[test]
    fn ring_keeps_the_most_recent_columns_in_order() {
        let mut t = ScopeTrace::new(spec(1, 16), Some(0));
        let cap = t.capacity();
        for i in 0..(cap + 3) {
            t.push(i as f64);
        }
        let snap = t.snapshot();
        assert_eq!(snap.len(), cap * 2);
        // Oldest retained sample is (cap + 3) - cap = 3.
        assert_eq!(snap[0], 3.0);
        assert_eq!(snap[snap.len() - 1], (cap + 2) as f32);
    }
}
