//! Wattmeter: a two-channel sense element reporting voltage and current power.

use crate::element::{Base, Element, SimCtx};
use crate::spec::ElementSpec;
use crate::stamp::Stamper;

/// Meter modes (WattmeterElm.java:31-32).
const PM_INST: i32 = 0;
const PM_AVG: i32 = 1;

/// Four-post power meter. Channel 0 spans posts (0,1) and channel 1 posts
/// (2,3), each a zero-volt voltage source so the per-channel current is
/// reportable (WattmeterElm.java:136-145). The measured voltage is
/// volts[2]-volts[0] and the measured current is the channel-1 one
/// (WattmeterElm.java:281, :280), so the instantaneous power is their product
/// (WattmeterElm.java:257). The average-power tracker integrates whole cycles
/// delimited by rising crossings of the running mean (WattmeterElm.java:147-
/// 215).
pub struct Wattmeter {
    base: Base,
    width: i32,
    meter: i32,
    avg_power: f64,
    total_energy: f64,
    cycle_time: f64,
    last_cycle_time: f64,
    run_energy: f64,
    run_time: f64,
    zero_time: f64,
    peak: f64,
    trough: f64,
    was_above_mid: bool,
    have_full_cycle: bool,
}

impl Wattmeter {
    pub fn new(spec: &ElementSpec) -> Self {
        Self {
            base: Base::with_posts(4),
            width: spec.param("width", 16.0) as i32, // gridSize (WattmeterElm.java:78-79)
            meter: spec.param("meter", PM_INST as f64) as i32,
            avg_power: 0.0,
            total_energy: 0.0,
            cycle_time: 0.0,
            last_cycle_time: 0.0,
            run_energy: 0.0,
            run_time: 0.0,
            zero_time: 0.0,
            peak: 0.0,
            trough: 0.0,
            was_above_mid: false,
            have_full_cycle: false,
        }
    }

    fn instantaneous_power(&self) -> f64 {
        self.voltage_diff() * self.base.vs_currents[1]
    }
}

impl Element for Wattmeter {
    fn kind(&self) -> &'static str {
        "wattmeter"
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
    fn voltage_source_count(&self) -> usize {
        2
    }

    /// The closure builder assigns each source's unknown to the closure of the
    /// terminal it actually stamps: source `k` spans `nodes[2k], nodes[2k+1]`,
    /// not the two-terminal default of `nodes[0], nodes[1]`.
    fn voltage_source_nodes(&self, k: usize) -> (usize, usize) {
        (self.base.nodes[2 * k], self.base.nodes[2 * k + 1])
    }

    fn stamp(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        // Two zero-valued voltage sources so we can measure the current of
        // each channel (WattmeterElm.java:136-139).
        s.voltage_source(
            self.base.nodes[0],
            self.base.nodes[1],
            self.base.vs_base,
            0.0,
        );
        s.voltage_source(
            self.base.nodes[2],
            self.base.nodes[3],
            self.base.vs_base + 1,
            0.0,
        );
    }

    fn calculate_current(&mut self, _ctx: &SimCtx) {
        // Upstream's getCurrent() is the channel-1 (voltage-side) current
        // (WattmeterElm.java:280).
        self.base.current = self.base.vs_currents[1];
    }

    fn current_into_node(&self, post: usize) -> f64 {
        // Each channel's source delivers its own current: even posts drain
        // it, odd posts inject it (WattmeterElm.java:262-267).
        let c = self.base.vs_currents[post / 2];
        if post.is_multiple_of(2) {
            -c
        } else {
            c
        }
    }

    fn connects(&self, a: usize, b: usize) -> bool {
        // Each channel is independent (WattmeterElm.java:269).
        a / 2 == b / 2
    }

    fn power(&self) -> f64 {
        self.instantaneous_power()
    }

    fn voltage_diff(&self) -> f64 {
        // The voltage side is channel 1, posts 2 and 0 (WattmeterElm.java:281).
        self.base.volts[2] - self.base.volts[0]
    }

    fn set_param(&mut self, name: &str, value: f64) -> bool {
        match name {
            "width" => self.width = value as i32,
            "meter" => self.meter = value as i32,
            _ => return false,
        }
        true
    }

    fn step_finished(&mut self, ctx: &SimCtx) {
        // The operating-point solve is a DC snapshot, not a transient step;
        // integrating it would poison the cycle tracker with a steady-state
        // reading.
        if ctx.dc_analysis {
            return;
        }
        let p = self.instantaneous_power();
        let dt = ctx.dt;
        self.cycle_time += dt;
        self.total_energy += p * dt;
        self.run_time += dt;
        self.run_energy += p * dt;

        // Average over whole cycles, delimited by rising crossings of the
        // long-run mean (WattmeterElm.java:155-160).
        let mid = self.run_energy / self.run_time;

        // Compare against the threshold with hysteresis, so a constant power
        // (which equals its own running mean) does not chatter on rounding
        // noise (WattmeterElm.java:162-172).
        if p > self.peak {
            self.peak = p;
        }
        if p < self.trough {
            self.trough = p;
        }
        let band = (self.peak - self.trough) * 0.05 + self.peak.abs() * 1e-9;
        let above = if self.was_above_mid {
            p > mid - band
        } else {
            p > mid + band
        };

        if above && !self.was_above_mid {
            if self.have_full_cycle {
                self.avg_power = self.total_energy / self.cycle_time;
                if self.avg_power.is_nan() {
                    self.avg_power = 0.0;
                }
                self.last_cycle_time = self.cycle_time;
            } else {
                // The run up to the first crossing is a partial cycle; leaving
                // its measurement out keeps the first period honest
                // (WattmeterElm.java:180-184).
                self.have_full_cycle = true;
            }
            self.total_energy = 0.0;
            self.cycle_time = 0.0;
        } else if self.last_cycle_time > 0.0 && self.cycle_time > self.last_cycle_time * 8.0 {
            // The waveform stopped or changed shape; don't freeze on a stale
            // reading (WattmeterElm.java:187-194).
            self.avg_power = self.total_energy / self.cycle_time;
            if self.avg_power.is_nan() {
                self.avg_power = 0.0;
            }
            self.total_energy = 0.0;
            self.cycle_time = 0.0;
        }
        self.was_above_mid = above;

        // Constant power never crosses its own mean, so no period is ever
        // measured. Report the running mean until one is, which is the right
        // answer for DC anyway (WattmeterElm.java:199-200).
        if self.last_cycle_time == 0.0 {
            self.avg_power = mid;
        }

        // Clear the reading once the power has been off for longer than a
        // period (WattmeterElm.java:205-214).
        if p == 0.0 {
            self.zero_time += dt;
            if self.last_cycle_time > 0.0 && self.zero_time > self.last_cycle_time * 1.5 {
                self.avg_power = 0.0;
                self.total_energy = 0.0;
                self.cycle_time = 0.0;
            }
        } else {
            self.zero_time = 0.0;
        }
    }

    /// The instrument reading: instantaneous power, or the running average
    /// over whole cycles (WattmeterElm.java:236-239).
    fn value(&self) -> f64 {
        if self.meter == PM_AVG {
            self.avg_power
        } else {
            self.instantaneous_power()
        }
    }

    fn reset(&mut self) {
        self.base.reset();
        self.avg_power = 0.0;
        self.total_energy = 0.0;
        self.cycle_time = 0.0;
        self.last_cycle_time = 0.0;
        self.run_energy = 0.0;
        self.run_time = 0.0;
        self.zero_time = 0.0;
        self.peak = 0.0;
        self.trough = 0.0;
        self.was_above_mid = false;
        self.have_full_cycle = false;
    }
}
