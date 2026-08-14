//! Waveform capture.
//!
//! Scopes have to sample at full timestep resolution, which is far finer than
//! the frame rate, so the sampling lives in the engine rather than in the UI.
//! Each trace aggregates `steps_per_column` timesteps into a min/max pair, the
//! same way an oscilloscope column works, and keeps a ring of those columns.
//!
//! On top of the min/max ring live three additive extras the UI asked for:
//! a recent-sample ring for X-Y mode, a per-plot DC-blocking filter, and a
//! per-scope trigger state machine. All of them run inside `push`, the same
//! one-value-per-timestep boundary, so the one-call-per-frame contract holds.

use crate::spec::{ScopeSpec, ScopeValue, TriggerEdge, TriggerMode, TriggerSpec};

/// Capacity of the recent-sample ring. The engine samples at most this many
/// values per scope per frame (the default budget is 160), so 512 keeps a full
/// frame of history for the X-Y locus at a fixed memory cost.
pub const RECENT_CAP: usize = 512;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TriggerState {
    Armed,
    Triggered,
    AutoRun,
}

/// The trigger state machine, porting ScopeTrigger.java. It lives in the
/// engine because the ring head is only known here: detection runs once per
/// completed column, on the column mid, exactly like the upstream `check`.
struct TriggerTracker {
    state: TriggerState,
    /// Ring index of the column that fired the trigger.
    trigger_ptr: usize,
    prev_value: f64,
    holdoff: u32,
    auto_timeout: u32,
    waiting: bool,
    fired: bool,
    /// Sim time at the trigger, kept so the UI can anchor time conversions.
    time: f64,
    last_check_ptr: Option<usize>,
}

impl TriggerTracker {
    fn new(columns: usize) -> Self {
        let mut t = Self {
            state: TriggerState::Armed,
            trigger_ptr: 0,
            prev_value: 0.0,
            holdoff: 0,
            auto_timeout: 0,
            waiting: false,
            fired: false,
            time: 0.0,
            last_check_ptr: None,
        };
        t.reset(columns);
        t
    }

    fn reset(&mut self, columns: usize) {
        self.state = TriggerState::Armed;
        self.holdoff = 0;
        self.waiting = false;
        self.fired = false;
        self.last_check_ptr = None;
        self.auto_timeout = (2 * columns.max(1)) as u32;
    }

    fn is_active(&self, mode: TriggerMode) -> bool {
        mode != TriggerMode::FreeRun
    }

    fn is_triggered(&self, mode: TriggerMode) -> bool {
        self.is_active(mode) && self.fired && self.state != TriggerState::AutoRun
    }

    /// Runs once per completed column (ScopeTrigger.check, ScopeTrigger.java:98-170).
    fn check(
        &mut self,
        mid: f64,
        current_ptr: usize,
        sim_time: f64,
        spec: TriggerSpec,
        rect_width: usize,
    ) {
        let mode = spec.mode;
        if mode == TriggerMode::FreeRun {
            return;
        }
        // Only act when the column pointer advances, so a column whose mid sits
        // on the level does not re-trigger on every timestep.
        if self.last_check_ptr == Some(current_ptr) {
            return;
        }
        self.last_check_ptr = Some(current_ptr);

        let edge_crossing = match spec.edge {
            TriggerEdge::Rising => self.prev_value < spec.level && mid >= spec.level,
            TriggerEdge::Falling => self.prev_value > spec.level && mid <= spec.level,
        };

        match self.state {
            TriggerState::Armed => {
                if edge_crossing {
                    self.state = TriggerState::Triggered;
                    self.trigger_ptr = current_ptr;
                    self.time = sim_time;
                    self.holdoff = 0;
                    self.waiting = false;
                    self.fired = true;
                } else {
                    self.waiting = true;
                    if mode == TriggerMode::Auto {
                        self.holdoff += 1;
                        if self.holdoff >= self.auto_timeout {
                            self.state = TriggerState::AutoRun;
                            self.waiting = false;
                        }
                    }
                }
            }
            TriggerState::Triggered => {
                // Hold the display for one screen width, then re-arm.
                self.holdoff += 1;
                if self.holdoff >= rect_width.max(1) as u32 {
                    self.state = TriggerState::Armed;
                    self.holdoff = 0;
                }
            }
            TriggerState::AutoRun => {
                if edge_crossing {
                    self.state = TriggerState::Triggered;
                    self.trigger_ptr = current_ptr;
                    self.time = sim_time;
                    self.holdoff = 0;
                    self.fired = true;
                }
            }
        }

        self.prev_value = mid;
    }

    /// The ring index where the display starts (ScopeTrigger.displayStartIndex).
    /// The trigger point sits at the centre of the window.
    fn display_start_index(
        &self,
        mode: TriggerMode,
        head: usize,
        w: usize,
        columns: usize,
    ) -> usize {
        if mode == TriggerMode::FreeRun || !self.fired || self.state == TriggerState::AutoRun {
            return head + columns - w;
        }
        self.trigger_ptr + columns - w / 2
    }

    /// How many columns of valid post-trigger data the display may draw
    /// (ScopeTrigger.validDataCount). Data past the write pointer is stale.
    fn valid_data_count(
        &self,
        mode: TriggerMode,
        head: usize,
        ipa: usize,
        w: usize,
        columns: usize,
    ) -> usize {
        if !self.is_triggered(mode) {
            return w;
        }
        let count = (head + columns - ipa) % columns + 1;
        count.min(w)
    }

    fn state_code(&self) -> u8 {
        match self.state {
            TriggerState::Armed => 0,
            TriggerState::Triggered => 1,
            TriggerState::AutoRun => 2,
        }
    }
}

/// The filter coefficient for AC coupling, sized from the capture parameters
/// exactly as upstream (ScopePlot.java:80).
fn ac_alpha_for(steps_per_column: u32, columns: u32) -> f64 {
    1.0 - 1.0 / (1.15 * steps_per_column.max(1) as f64 * columns.max(1) as f64)
}

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
    /// Set when a sample was dropped for not being finite (a diverged node).
    /// The sample itself is unusable, so it is discarded, but the drop must
    /// not be silent: the UI reads this flag and captions the frozen trace as
    /// a warning instead of a healthy flatline. Cleared on reset like the
    /// capture buffers, so a re-run of a healthy circuit stops warning.
    pub diverged: bool,
    acc_count: u32,
    acc_min: f64,
    acc_max: f64,
    /// Per-frame recent samples for X-Y mode, oldest first via
    /// `recent_snapshot`. Rolling ring of the last [`RECENT_CAP`] samples.
    recent: Vec<f32>,
    recent_head: usize,
    recent_len: usize,
    /// AC-coupling filter state (ScopePlot.java:99-121). The filter is primed
    /// on every sample even when DC coupled, so switching coupling mid-run
    /// does not have to settle from scratch.
    ac_last_value: f64,
    ac_last_out: f64,
    ac_alpha: f64,
    trigger: TriggerTracker,
}

impl ScopeTrace {
    pub fn new(spec: ScopeSpec, element_index: Option<usize>) -> Self {
        let cap = spec.columns.clamp(16, 8192) as usize;
        let alpha = ac_alpha_for(spec.steps_per_column, spec.columns);
        Self {
            spec,
            element_index,
            mins: vec![0.0; cap],
            maxs: vec![0.0; cap],
            head: 0,
            columns_written: 0,
            diverged: false,
            acc_count: 0,
            acc_min: f64::INFINITY,
            acc_max: f64::NEG_INFINITY,
            recent: vec![0.0; RECENT_CAP],
            recent_head: 0,
            recent_len: 0,
            ac_last_value: 0.0,
            ac_last_out: 0.0,
            ac_alpha: alpha,
            trigger: TriggerTracker::new(cap),
        }
    }

    pub fn capacity(&self) -> usize {
        self.mins.len()
    }

    pub fn value_kind(&self) -> ScopeValue {
        self.spec.value
    }

    /// Display width the trigger math counts columns against.
    fn display_width(&self) -> usize {
        self.spec.display_width.max(1) as usize
    }

    pub fn clear(&mut self) {
        self.mins.iter_mut().for_each(|v| *v = 0.0);
        self.maxs.iter_mut().for_each(|v| *v = 0.0);
        self.head = 0;
        self.columns_written = 0;
        self.diverged = false;
        self.acc_count = 0;
        self.acc_min = f64::INFINITY;
        self.acc_max = f64::NEG_INFINITY;
        self.recent_head = 0;
        self.recent_len = 0;
        self.ac_last_value = 0.0;
        self.ac_last_out = 0.0;
        self.trigger.reset(self.mins.len());
    }

    /// Resizes the capture ring to a new speed/width without touching the
    /// simulation clock. The buffer is thrown away, matching upstream's
    /// `Scope.setSpeed` -> `resetGraph` (ScopePlot.java:75-76).
    pub fn set_params(&mut self, steps_per_column: u32, columns: u32) {
        let columns = columns.clamp(16, 8192);
        self.spec.steps_per_column = steps_per_column.max(1);
        self.spec.columns = columns;
        let cap = columns as usize;
        if self.mins.len() != cap {
            self.mins = vec![0.0; cap];
            self.maxs = vec![0.0; cap];
        }
        self.ac_alpha = ac_alpha_for(self.spec.steps_per_column, columns);
        self.clear();
    }

    /// Flips the AC-coupling flag without rebuilding the circuit or clearing
    /// the buffer. Upstream's `setAcCoupled` is just a flag flip
    /// (ScopePlot.java:162-168); the filter itself keeps running either way,
    /// so the first AC column after the switch is already settled.
    pub fn set_ac_coupled(&mut self, ac_coupled: bool) {
        // AC coupling is permitted only for voltage plots (ScopePlot.canAcCouple).
        self.spec.ac_coupled = ac_coupled && self.spec.value == ScopeValue::Voltage;
    }

    /// Feeds one timestep's sample in.
    pub fn push(&mut self, value: f64, sim_time: f64) {
        if !value.is_finite() {
            // The sample is unusable, so it is dropped, but the drop must not
            // be silent: flag the trace so the UI can caption it as diverged
            // instead of drawing a frozen trace that reads as healthy.
            self.diverged = true;
            return;
        }
        // Recent-sample ring first, so X-Y mode shows the raw signal.
        self.recent[self.recent_head] = value as f32;
        self.recent_head = (self.recent_head + 1) % RECENT_CAP;
        if self.recent_len < RECENT_CAP {
            self.recent_len += 1;
        }

        // AC-coupling filter (ScopePlot.java:99-121): a first-order IIR high
        // pass, applied to the raw value before min/max aggregation. Always
        // computed so the filter is primed if coupling is switched on later.
        let new_ac_out = self.ac_alpha * (self.ac_last_out + value - self.ac_last_value);
        self.ac_last_value = value;
        self.ac_last_out = new_ac_out;
        let v = if self.spec.ac_coupled {
            new_ac_out
        } else {
            value
        };

        self.acc_min = self.acc_min.min(v);
        self.acc_max = self.acc_max.max(v);
        self.acc_count += 1;
        if self.acc_count >= self.spec.steps_per_column.max(1) {
            self.flush(sim_time);
        }
    }

    fn flush(&mut self, sim_time: f64) {
        if self.acc_count == 0 {
            return;
        }
        let cap = self.mins.len();
        self.mins[self.head] = self.acc_min as f32;
        self.maxs[self.head] = self.acc_max as f32;
        let mid = (self.acc_min + self.acc_max) * 0.5;
        self.head = (self.head + 1) % cap;
        self.columns_written += 1;
        self.acc_count = 0;
        self.acc_min = f64::INFINITY;
        self.acc_max = f64::NEG_INFINITY;

        // Trigger detection runs on the column mid once per completed column.
        let trigger_spec = self.spec.trigger;
        self.trigger.check(
            mid,
            (self.head + cap - 1) % cap,
            sim_time,
            trigger_spec,
            self.display_width(),
        );
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

    /// This frame's recent samples, oldest first.
    pub fn recent_snapshot(&self) -> Vec<f32> {
        let mut out = Vec::with_capacity(self.recent_len);
        for k in 0..self.recent_len {
            let i = if self.recent_len < RECENT_CAP {
                k
            } else {
                (self.recent_head + k) % RECENT_CAP
            };
            out.push(self.recent[i]);
        }
        out
    }

    /// Trigger display info, mirroring ScopeTrigger.displayStartIndex and
    /// validDataCount. `snapshot_start` is the ring index of `snapshot()[0]`,
    /// which the UI needs to map anchored ring indices back to snapshot slots.
    pub fn trigger_info(&self, w: usize) -> TriggerInfo {
        let cap = self.mins.len();
        let w = w.max(1).min(cap);
        let mode = self.spec.trigger.mode;
        let ipa = self.trigger.display_start_index(mode, self.head, w, cap);
        TriggerInfo {
            triggered: self.trigger.is_triggered(mode),
            state: self.trigger.state_code(),
            // The WAIT/ARMED status text needs the tracker's own `waiting`
            // flag: `triggered` stays latched across a re-arm (as upstream's
            // `fired` does, ScopeTrigger.java:103-150), so it cannot tell
            // "waiting for the first edge" from "re-armed after a trigger".
            waiting: self.trigger.waiting,
            start_index: ipa,
            valid_count: self.trigger.valid_data_count(mode, self.head, ipa, w, cap),
            columns: cap,
            snapshot_start: if self.columns_written as usize > cap {
                self.head
            } else {
                0
            },
            written: (self.columns_written as usize).min(cap),
            time: self.trigger.time,
        }
    }
}

/// What the UI needs to draw a triggered scope (ScopeTrigger.java:66-81).
#[derive(Debug, Clone, Copy)]
pub struct TriggerInfo {
    pub triggered: bool,
    /// 0 armed, 1 triggered, 2 auto-run: drives the WAIT/TRIG/AUTO status text.
    pub state: u8,
    /// True while armed without a trigger yet; distinguishes WAIT from the
    /// re-armed ARMED state (ScopeTrigger.drawIndicator, ScopeTrigger.java:198-204).
    pub waiting: bool,
    /// Ring index where the display window starts.
    pub start_index: usize,
    /// Columns of valid data the display may draw.
    pub valid_count: usize,
    /// Ring capacity.
    pub columns: usize,
    /// Ring index of `snapshot()[0]`.
    pub snapshot_start: usize,
    /// Columns actually written, capped at capacity.
    pub written: usize,
    /// Sim time at the trigger, so the UI can anchor time conversions at the
    /// trigger-stabilized window centre (Scope.java:910-915).
    pub time: f64,
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
            ac_coupled: false,
            trigger: Default::default(),
            display_width: 0,
        }
    }

    fn trigger_spec(
        steps_per_column: u32,
        columns: u32,
        mode: TriggerMode,
        level: f64,
    ) -> ScopeSpec {
        let mut s = spec(steps_per_column, columns);
        s.trigger.mode = mode;
        s.trigger.level = level;
        s.trigger.edge = TriggerEdge::Rising;
        // A column count clamps to a 16-column minimum; a display width of
        // `columns` gives the holdoff a full ring to re-arm in.
        s.display_width = columns;
        s
    }

    #[test]
    fn non_finite_samples_set_the_diverged_flag_and_are_still_dropped() {
        let mut t = ScopeTrace::new(spec(1, 16), Some(0));
        for v in [1.0, f64::NAN, 2.0, f64::INFINITY, -f64::INFINITY] {
            t.push(v, 0.0);
        }
        assert!(t.diverged, "a dropped non-finite sample must flag the trace");
        // The unusable samples are still dropped: only the two finite ones
        // aggregate, one single-sample column each.
        let snap = t.snapshot();
        assert_eq!(snap.len(), 4);
        assert_eq!(snap[0], 1.0);
        assert_eq!(snap[1], 1.0);
        assert_eq!(snap[2], 2.0);
        assert_eq!(snap[3], 2.0);
    }

    #[test]
    fn healthy_trace_never_sets_diverged_and_reset_clears_it() {
        let mut t = ScopeTrace::new(spec(1, 16), Some(0));
        for v in [1.0, -2.0, 3.0, 0.5] {
            t.push(v, 0.0);
        }
        assert!(!t.diverged, "finite samples must not flag the trace");
        t.push(f64::NAN, 0.0);
        assert!(t.diverged);
        t.clear();
        assert!(!t.diverged, "reset clears the diverged flag like the buffers");
    }

    #[test]
    fn aggregates_min_and_max_per_column() {
        let mut t = ScopeTrace::new(spec(4, 16), Some(0));
        for v in [1.0, -2.0, 3.0, 0.5] {
            t.push(v, 0.0);
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
            t.push(i as f64, 0.0);
        }
        let snap = t.snapshot();
        assert_eq!(snap.len(), cap * 2);
        // Oldest retained sample is (cap + 3) - cap = 3.
        assert_eq!(snap[0], 3.0);
        assert_eq!(snap[snap.len() - 1], (cap + 2) as f32);
    }

    #[test]
    fn set_params_resizes_and_clears_and_reaggregates_at_the_new_rate() {
        let mut t = ScopeTrace::new(spec(1, 16), Some(0));
        for i in 0..8 {
            t.push(i as f64, 0.0);
        }
        assert_eq!(t.capacity(), 16);
        assert_eq!(t.snapshot().len(), 16);

        t.set_params(4, 32);
        assert_eq!(t.capacity(), 32);
        // The old data is thrown away, matching upstream's resetGraph.
        assert!(t.snapshot().is_empty());
        assert_eq!(t.columns_written, 0);

        // Four pushes now aggregate into a single column of 0..3.
        for i in 0..4 {
            t.push(i as f64, 0.0);
        }
        let snap = t.snapshot();
        assert_eq!(snap.len(), 2);
        assert_eq!(snap[0], 0.0);
        assert_eq!(snap[1], 3.0);
    }

    #[test]
    fn set_params_clamps_columns_and_steps() {
        let mut t = ScopeTrace::new(spec(1, 16), Some(0));
        t.set_params(0, 2);
        assert_eq!(t.capacity(), 16);
        assert_eq!(t.spec.steps_per_column, 1);
        t.set_params(999999, 100000);
        assert_eq!(t.capacity(), 8192);
        assert_eq!(t.spec.steps_per_column, 999999);
    }

    #[test]
    fn recent_ring_keeps_the_last_n_in_order() {
        let mut t = ScopeTrace::new(spec(1, 16), Some(0));
        let n = RECENT_CAP;
        for i in 0..(n + 5) {
            t.push(i as f64, 0.0);
        }
        let snap = t.recent_snapshot();
        assert_eq!(snap.len(), n);
        assert_eq!(snap[0], 5.0);
        assert_eq!(snap[n - 1], (n + 4) as f32);
    }

    #[test]
    fn recent_ring_matches_column_aggregation() {
        // With one step per column, the column min and max both equal the
        // latest sample, so the column mid equals the latest recent sample.
        let mut t = ScopeTrace::new(spec(1, 16), Some(0));
        for v in [2.0, 4.0, -1.0, 7.0] {
            t.push(v, 0.0);
        }
        let recent = t.recent_snapshot();
        let snap = t.snapshot();
        assert_eq!(snap.len(), 8);
        let mid = (snap[snap.len() - 2] + snap[snap.len() - 1]) * 0.5;
        assert_eq!(mid, *recent.last().unwrap());
    }

    #[test]
    fn rising_edge_trigger_fires_and_records_the_column() {
        let mut t = ScopeTrace::new(trigger_spec(1, 64, TriggerMode::Normal, 2.0), Some(0));
        // Stay below the level, then cross it. The trigger fires on the first
        // column whose mid crosses 2.0, column 3.
        for v in [0.0, 0.0, 0.0] {
            t.push(v, 0.0);
        }
        for v in [3.0, 3.0, 3.0] {
            t.push(v, 0.0);
        }
        let info = t.trigger_info(64);
        assert!(info.triggered);
        assert_eq!(info.state, 1);
        // Trigger point sits at the centre of the window: the display starts
        // `w/2` columns before the trigger column and extends `w` wide.
        assert_eq!(info.start_index, 3 + 64 - 32);
        assert_eq!(info.valid_count, (6 + 64 - info.start_index) % 64 + 1);
    }

    #[test]
    fn trigger_waiting_drives_the_wait_status_text() {
        // The WAIT/ARMED status text (ScopeTrigger.java:198-204) keys off the
        // tracker's `waiting` flag, never off `fired`: `fired` latches on the
        // first trigger and survives a re-arm, so `triggered` cannot tell
        // "waiting for the first edge" from "re-armed". Before any edge the
        // armed tracker is waiting; after a trigger it is not.
        let mut t = ScopeTrace::new(trigger_spec(1, 64, TriggerMode::Normal, 2.0), Some(0));
        for _ in 0..3 {
            t.push(0.0, 0.0);
        }
        let info = t.trigger_info(64);
        assert_eq!(info.state, 0);
        assert!(info.waiting, "first arm should read WAIT");
        assert!(!info.triggered);
        // Cross the level: triggered, no longer waiting.
        for _ in 0..3 {
            t.push(3.0, 0.0);
        }
        let info = t.trigger_info(64);
        assert_eq!(info.state, 1);
        assert!(!info.waiting);
        assert!(info.triggered);
        // One screen width of holdoff re-arms, then the signal still sitting
        // above the level means the next armed checks find no edge and the
        // tracker is waiting again, so the UI reads WAIT while `triggered`
        // stays latched (upstream-faithful; do not clear `fired` on re-arm).
        for _ in 0..70 {
            t.push(3.0, 0.0);
        }
        let info = t.trigger_info(64);
        assert_eq!(info.state, 0);
        assert!(info.waiting, "re-armed without an edge reads WAIT");
        assert!(info.triggered);
        // A fresh edge re-triggers and clears the waiting state.
        for _ in 0..3 {
            t.push(0.0, 0.0);
        }
        for _ in 0..3 {
            t.push(4.0, 0.0);
        }
        let info = t.trigger_info(64);
        assert_eq!(info.state, 1);
        assert!(!info.waiting);
    }

    #[test]
    fn falling_edge_trigger_respects_the_edge() {
        let mut t = ScopeTrace::new(trigger_spec(1, 64, TriggerMode::Normal, 2.0), Some(0));
        t.spec.trigger.edge = TriggerEdge::Falling;
        for v in [3.0, 3.0, 3.0] {
            t.push(v, 0.0);
        }
        for v in [0.0, 0.0, 0.0] {
            t.push(v, 0.0);
        }
        assert!(t.trigger_info(64).triggered);

        // A rising crossing must not fire a falling-edge trigger.
        let mut t2 = ScopeTrace::new(trigger_spec(1, 64, TriggerMode::Normal, 2.0), Some(0));
        t2.spec.trigger.edge = TriggerEdge::Falling;
        for v in [0.0, 0.0, 0.0] {
            t2.push(v, 0.0);
        }
        for v in [3.0, 3.0, 3.0] {
            t2.push(v, 0.0);
        }
        assert!(!t2.trigger_info(64).triggered);
    }

    #[test]
    fn auto_trigger_times_out_into_auto_run_without_an_edge() {
        // columns clamp to a 16-column minimum, so the timeout is 2*16 = 32
        // completed columns without an edge crossing.
        let mut t = ScopeTrace::new(trigger_spec(1, 16, TriggerMode::Auto, 2.0), Some(0));
        for _ in 0..40 {
            t.push(0.0, 0.0);
        }
        let info = t.trigger_info(16);
        assert_eq!(info.state, 2);
        // Auto-run is not "triggered", so the display falls back to the plain
        // most-recent window.
        assert!(!info.triggered);
    }

    #[test]
    fn triggered_holdoff_rearms_after_one_screen_width() {
        let mut t = ScopeTrace::new(trigger_spec(1, 64, TriggerMode::Normal, 2.0), Some(0));
        for _ in 0..3 {
            t.push(0.0, 0.0);
        }
        for v in [3.0, 3.0, 3.0] {
            t.push(v, 0.0);
        }
        let info = t.trigger_info(64);
        assert!(info.triggered);
        assert_eq!(info.state, 1);
        // One screen width (display_width = 64) of columns re-arms the
        // detector: the state machine returns to ARMED so a new edge fires.
        for _ in 0..64 {
            t.push(3.0, 0.0);
        }
        assert_eq!(t.trigger_info(64).state, 0);
        // A fresh rising edge fires a new trigger and updates the anchor.
        for _ in 0..3 {
            t.push(0.0, 0.0);
        }
        for v in [4.0, 4.0, 4.0] {
            t.push(v, 0.0);
        }
        let info = t.trigger_info(64);
        assert_eq!(info.state, 1);
        assert!(info.triggered);
    }

    #[test]
    fn ac_coupling_blocks_dc_and_passes_the_ac_component() {
        // A DC offset plus a sine: after settling, the output mean is ~0 and
        // the peak swing matches the AC amplitude (slightly attenuated).
        let mut t = ScopeTrace::new(spec(1, 256), Some(0));
        t.spec.ac_coupled = true;
        t.spec.steps_per_column = 1;
        for k in 0..(RECENT_CAP * 4) {
            let v = 5.0 + (k as f64 * 0.2).sin();
            t.push(v, 0.0);
        }
        let snap = t.snapshot();
        let n = snap.len() / 2;
        // The filter settles in a few samples; average the settled half.
        let mut mean = 0.0;
        let mut min = f64::INFINITY;
        let mut max = f64::NEG_INFINITY;
        for k in (n / 2)..n {
            let lo = snap[k * 2] as f64;
            let hi = snap[k * 2 + 1] as f64;
            mean += (lo + hi) * 0.5;
            min = min.min(lo);
            max = max.max(hi);
        }
        let mean = mean / (n - n / 2) as f64;
        // The 5 V DC offset is removed to well within the filter tolerance.
        assert!(mean.abs() < 0.05, "ac output mean was {mean}");
        // And the AC component still moves.
        assert!(max - min > 1.0, "ac output swing was {}", max - min);
    }

    #[test]
    fn ac_filter_stays_primed_when_dc_coupled() {
        // Switching coupling mid-run should not need to settle: the filter ran
        // the whole time, so the first AC column is already small.
        let mut t = ScopeTrace::new(spec(1, 256), Some(0));
        t.spec.steps_per_column = 1;
        for k in 0..(RECENT_CAP * 2) {
            t.push(5.0 + (k as f64 * 0.2).sin(), 0.0);
        }
        t.spec.ac_coupled = true;
        t.push(5.0, 0.0);
        let snap = t.snapshot();
        let n = snap.len() / 2;
        let last = (snap[(n - 1) * 2] as f64 + snap[(n - 1) * 2 + 1] as f64) * 0.5;
        assert!(last.abs() < 1.0, "first ac column after switch was {last}");
    }

    #[test]
    fn set_ac_coupled_flips_the_flag_without_clearing_the_buffer() {
        // The fast path must not throw away the capture: it only toggles the
        // filter flag (ScopePlot.setAcCoupled). Run DC coupled long enough for
        // the always-primed filter to settle on the constant input.
        let mut t = ScopeTrace::new(spec(1, 64), Some(0));
        for _ in 0..(RECENT_CAP * 2) {
            t.push(5.0, 0.0);
        }
        t.set_ac_coupled(true);
        assert!(t.spec.ac_coupled);
        // The data survives the toggle: the ring still holds a full capture.
        let snap = t.snapshot();
        assert_eq!(snap.len(), 64 * 2);
        assert_eq!(t.columns_written, RECENT_CAP as u64 * 2);
        // And the filter now blocks the DC: a fresh 5 V sample reads ~0.
        t.push(5.0, 0.0);
        let snap = t.snapshot();
        let n = snap.len() / 2;
        let last = (snap[(n - 1) * 2] as f64 + snap[(n - 1) * 2 + 1] as f64) * 0.5;
        assert!(
            last.abs() < 1e-3,
            "filter did not block dc after toggle: {last}"
        );
    }

    #[test]
    fn set_ac_coupled_is_refused_for_current_plots() {
        let mut s = spec(1, 64);
        s.value = ScopeValue::Current;
        let mut t = ScopeTrace::new(s, Some(0));
        t.set_ac_coupled(true);
        assert!(!t.spec.ac_coupled, "AC coupling is voltage-only");
    }
}
