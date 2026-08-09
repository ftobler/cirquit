//! Lossless transmission line, a two-port delay line (TransLineElm.java).
//!
//! Each port is a series resistor of `imped` ohms to an internal node, then a
//! voltage source to the inner post. A ring buffer of forward and backward
//! travelling waves joins the two ports: every timestep stores the wave
//! leaving each end and plays back, negated, the wave that left the other end
//! `len_steps` steps earlier. That playback source is what delays the signal
//! by `delay` seconds (TransLineElm.java:182-221).
//!
//! Node wiring matches upstream: posts 0 and 2 are the left port (the inner
//! signal post and the outer end), posts 1 and 3 the right port, and the two
//! internal nodes 4 and 5 sit between the series resistors and the sources.

use crate::element::{Base, Element, SimCtx};
use crate::spec::ElementSpec;
use crate::stamp::Stamper;

/// Ring-buffer length cap, upstream's limit above which it refuses to allocate
/// the buffers and stops the sim (TransLineElm.java:96-101). The port has no
/// per-element stop, so an over-long delay is clamped to the cap rather than
/// halting the run.
const MAX_STEPS: usize = 100_000;

pub struct TransmissionLine {
    base: Base,
    delay: f64,
    imped: f64,
    /// Nominal timestep the ring is sized against, captured at the first
    /// `stamp`. It is the port's analog of upstream's `sim.maxTimeStep`; the
    /// working `dt` can halve under adaptation, but the ring must not shrink
    /// with it, so the sizing step is fixed after the first pass.
    nominal_dt: f64,
    /// Ring-buffer length, `delay / nominal_dt` clamped to [`MAX_STEPS`].
    len_steps: usize,
    /// Write index into the ring, advanced once per committed step.
    ptr: usize,
    voltage_l: Vec<f64>,
    voltage_r: Vec<f64>,
}

impl TransmissionLine {
    /// Upstream's constructor default for the delay, `1000*maxTimeStep`
    /// (TransLineElm.java:34) evaluated at the port's default timestep.
    const DEFAULT_DELAY: f64 = 1000.0 * 5e-6;

    pub fn new(spec: &ElementSpec) -> Self {
        Self {
            base: Base::with_posts(4),
            delay: spec.param("delay", Self::DEFAULT_DELAY),
            imped: spec.param("imped", 75.0),
            nominal_dt: 0.0,
            len_steps: 0,
            ptr: 0,
            voltage_l: Vec::new(),
            voltage_r: Vec::new(),
        }
    }

    /// Sizes the ring for `delay` against the nominal timestep and clears it.
    /// The 1-step floor keeps a sub-timestep delay from producing an empty
    /// ring, which upstream would crash on (`(ptr + 1) % lenSteps` with a zero
    /// divisor).
    fn size_ring(&mut self, delay: f64) {
        let steps = if self.nominal_dt > 0.0 {
            (delay / self.nominal_dt).round() as usize
        } else {
            1
        };
        self.len_steps = steps.clamp(1, MAX_STEPS);
        self.voltage_l = vec![0.0; self.len_steps];
        self.voltage_r = vec![0.0; self.len_steps];
        self.ptr = 0;
    }
}

impl Element for TransmissionLine {
    fn kind(&self) -> &'static str {
        "transmissionLine"
    }
    fn base(&self) -> &Base {
        &self.base
    }
    fn base_mut(&mut self) -> &mut Base {
        &mut self.base
    }
    fn post_count(&self) -> usize {
        4
    }

    fn internal_node_count(&self) -> usize {
        2
    }
    fn voltage_source_count(&self) -> usize {
        2
    }

    fn voltage_source_nodes(&self, k: usize) -> (usize, usize) {
        // Source 0 constrains `V(post 0) - V(internal 4)`, source 1
        // `V(post 1) - V(internal 5)`, upstream's `setVoltageSource` pairing
        // (TransLineElm.java:166-174). Stamping the inner post as the first
        // terminal makes the current unknown read positive internal -> post,
        // which is upstream's `current1`/`current2`.
        if k == 0 {
            (self.base.nodes[4], self.base.nodes[0])
        } else {
            (self.base.nodes[5], self.base.nodes[1])
        }
    }

    /// No DC path through the line: each port's two posts couple only through
    /// the wave delay, so the ports are separate islands for the floating-node
    /// and broken-source walks (getConnection, TransLineElm.java:230-232).
    fn connects(&self, _a: usize, _b: usize) -> bool {
        false
    }

    /// The stamps couple each port's outer post, inner post and internal node
    /// into one matrix closure, which the parity split captures exactly as
    /// upstream's `getMatrixConnection` does (TransLineElm.java:234-237).
    fn matrix_connects(&self, a: usize, b: usize) -> bool {
        a % 2 == b % 2
    }

    fn stamp(&mut self, ctx: &SimCtx, s: &mut Stamper) {
        if self.len_steps == 0 {
            // The first stamp runs at the nominal `options.time_step`, which
            // is the size the ring keeps for the whole run.
            self.nominal_dt = ctx.dt;
            self.size_ring(self.delay);
        }
        let n = &self.base.nodes;
        s.voltage_source(n[4], n[0], self.base.vs_base, 0.0);
        s.voltage_source(n[5], n[1], self.base.vs_base + 1, 0.0);
        s.resistor(n[2], n[4], self.imped);
        s.resistor(n[3], n[5], self.imped);
    }

    fn start_iteration(&mut self, ctx: &SimCtx) {
        if ctx.dc_analysis || self.len_steps == 0 {
            return;
        }
        // The wave leaving each end is the sum of the drops across its series
        // resistor and its source (TransLineElm.java:195-196). The DC
        // operating point does not integrate the line, so the ring fills only
        // during the transient and the DC solve sees the sources at zero.
        let v = &self.base.volts;
        self.voltage_l[self.ptr] = v[2] - v[0] + v[2] - v[4];
        self.voltage_r[self.ptr] = v[3] - v[1] + v[3] - v[5];
    }

    fn do_step(&mut self, ctx: &SimCtx, s: &mut Stamper) {
        if ctx.dc_analysis || self.len_steps == 0 {
            return;
        }
        // Each end plays back, negated, the wave that left the other end one
        // ring length earlier: the slot ahead of the write pointer holds the
        // oldest sample (TransLineElm.java:207-209). The negated sign is the
        // port's `voltage_source` convention `V(n2) - V(n1) = v`, which makes
        // this identical to upstream's `updateVoltageSource(nodes[4],
        // nodes[0], voltSource1, -voltageR[nextPtr])`.
        let next = (self.ptr + 1) % self.len_steps;
        s.voltage_source_value(self.base.vs_base, -self.voltage_r[next]);
        s.voltage_source_value(self.base.vs_base + 1, -self.voltage_l[next]);
    }

    fn step_finished(&mut self, ctx: &SimCtx) {
        if ctx.dc_analysis || self.len_steps == 0 {
            return;
        }
        // One ring slot per committed step: `step_finished` runs exactly once
        // per accepted timestep here, so upstream's `lastStepCount` guard
        // (TransLineElm.java:216-221) has nothing to defend against.
        self.ptr = (self.ptr + 1) % self.len_steps;
    }

    fn calculate_current(&mut self, _ctx: &SimCtx) {
        // `base.current` is the left source's current, so a Current scope on
        // the line follows port 1's signal; the right source stays a separate
        // quantity, like the transformer keeping only the primary in
        // `base.current`.
        self.base.current = self.base.vs_currents[0];
    }

    fn current_into_node(&self, post: usize) -> f64 {
        // Per upstream's getCurrentIntoNode (TransLineElm.java:264-272): the
        // inner posts carry the sources' currents and the outer ends carry the
        // same currents in the opposite direction.
        match post {
            0 => self.base.vs_currents[0],
            2 => -self.base.vs_currents[0],
            3 => -self.base.vs_currents[1],
            _ => self.base.vs_currents[1],
        }
    }

    fn body_samples(&self, segments: usize) -> Vec<f32> {
        // The strip walk of TransLineElm.draw (TransLineElm.java:126-149),
        // done next to the ring it reads: `ix0` anchors the read to the write
        // cursor so the picture stays still while the buffer rotates, `ix1`
        // walks the left ring forward and `ix2` the right ring backward, which
        // is what superimposes a left-travelling wave on a right-travelling
        // one. Averaging the two slots is the displayed voltage. Empty before
        // the first stamp (upstream's `voltageL != null` guard) and when the
        // element is shorter than two units (`segments = dn/2` is 0).
        if self.voltage_l.is_empty() || segments == 0 {
            return Vec::new();
        }
        // `u64` products so a long buffer times a long element cannot wrap the
        // 32-bit wasm `usize`; the division truncates like the Java's `int`
        // arithmetic, and the quotient is always < `len`, so `ix0` minus it
        // never underflows.
        let len = self.len_steps as u64;
        let segs = segments as u64;
        let ix0 = self.ptr as u64 + len - 1;
        let mut out = Vec::with_capacity(segments);
        for i in 0..segs {
            let ix1 = ((ix0 - len * i / segs) % len) as usize;
            let ix2 = ((ix0 - len * (segs - 1 - i) / segs) % len) as usize;
            out.push(((self.voltage_l[ix1] + self.voltage_r[ix2]) / 2.0) as f32);
        }
        out
    }

    fn set_param(&mut self, name: &str, value: f64) -> bool {
        match name {
            // A delay edit re-sizes the ring from the fixed nominal step;
            // `Circuit::set_param` restamps after this, so the new buffer is
            // in place before the next step.
            "delay" if value > 0.0 => {
                self.delay = value;
                self.size_ring(value);
            }
            "imped" if value > 0.0 => self.imped = value,
            _ => return false,
        }
        true
    }

    fn reset(&mut self) {
        self.base.reset();
        self.voltage_l.iter_mut().for_each(|v| *v = 0.0);
        self.voltage_r.iter_mut().for_each(|v| *v = 0.0);
        self.ptr = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    /// A line with its ring forced to `len_steps` slots, bypassing `stamp` so
    /// a test can place samples by hand. The `delay`/`imped` params are the
    /// constructor defaults; the fields are set directly after.
    fn line(len_steps: usize) -> TransmissionLine {
        let spec = ElementSpec {
            id: 1,
            kind: "transmissionLine".into(),
            posts: vec![[0, 0], [0, 0], [0, 0], [0, 0]],
            params: HashMap::new(),
            label: None,
            model: None,
            flags: 0,
        };
        let mut e = TransmissionLine::new(&spec);
        e.len_steps = len_steps;
        e.voltage_l = vec![0.0; len_steps];
        e.voltage_r = vec![0.0; len_steps];
        e
    }

    #[test]
    fn empty_buffers_report_no_wave() {
        // A freshly built line has no ring yet (upstream's `voltageL != null`
        // guard); the readout must be empty, not a panic. A zero `segments`
        // (an element shorter than two units, `dn/2 = 0`) is empty too.
        let spec = ElementSpec {
            id: 1,
            kind: "transmissionLine".into(),
            posts: vec![[0, 0], [0, 0], [0, 0], [0, 0]],
            params: HashMap::new(),
            label: None,
            model: None,
            flags: 0,
        };
        assert!(TransmissionLine::new(&spec).body_samples(10).is_empty());
        assert!(line(100).body_samples(0).is_empty());
    }

    #[test]
    fn wave_travels_with_the_write_cursor() {
        // A lone left-ring sample reads at half its value (averaged with the
        // right ring's zero). With 100 slots and 10 strips the strip walk
        // covers 10 slots per strip, so ten committed steps move the spike
        // exactly one strip forward.
        let mut e = line(100);
        e.voltage_l[0] = 5.0;
        e.ptr = 1;
        let wave = e.body_samples(10);
        assert_eq!(wave.len(), 10);
        assert_eq!(wave[0], 2.5, "spike should sit at strip 0");
        assert!(wave[1..].iter().all(|&v| v == 0.0));
        e.ptr = 11;
        let wave = e.body_samples(10);
        assert_eq!(wave[1], 2.5, "ten committed steps move the spike one strip");
        assert_eq!(wave[0], 0.0);
        e.ptr = 31;
        let wave = e.body_samples(10);
        assert_eq!(
            wave[3], 2.5,
            "thirty committed steps move the spike three strips"
        );
    }

    #[test]
    fn left_and_right_ring_waves_superimpose_at_the_mirrored_strip() {
        // The two rings walk in opposite directions: the strip whose left-ring
        // read is slot 70 reads slot 40 on the right ring, so a forward wave
        // and a backward wave meet at the same place and add to the full
        // value. A lone spike in each ring averages to 5 V at that strip and
        // nothing anywhere else.
        let mut e = line(100);
        e.voltage_l[70] = 5.0;
        e.voltage_r[40] = 5.0;
        e.ptr = 1;
        let wave = e.body_samples(10);
        assert_eq!(wave.len(), 10);
        assert_eq!(wave[3], 5.0, "both half-waves should add at strip 3");
        assert!(wave
            .iter()
            .enumerate()
            .filter(|&(i, _)| i != 3)
            .all(|(_, &v)| v == 0.0));
    }

    #[test]
    fn resamples_to_any_segment_count() {
        // The draw resamples the ring to the on-screen length, so segments
        // finer and coarser than the buffer both return exactly `segments`
        // values, and the `% len` wrap must never index out of range at the
        // ring end (`ix0` at `ptr = 0` and `ptr = len - 1`).
        let mut e = line(10);
        e.ptr = 5;
        assert_eq!(e.body_samples(100).len(), 100);
        assert_eq!(e.body_samples(3).len(), 3);
        e.ptr = 0;
        assert_eq!(e.body_samples(17).len(), 17);
        e.ptr = 9;
        assert_eq!(e.body_samples(4).len(), 4);
    }
}
