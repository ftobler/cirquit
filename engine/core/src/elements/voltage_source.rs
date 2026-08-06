//! Independent voltage source and supply rail.

use std::f64::consts::PI;

use crate::element::{Base, Element, SimCtx};
use crate::spec::ElementSpec;
use crate::stamp::{Stamper, GROUND};

/// Waveform selector. The numbering is part of the on-disk file format.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Waveform {
    Dc,
    Ac,
    Square,
    Triangle,
    Sawtooth,
    Pulse,
    Noise,
}

impl Waveform {
    pub fn from_code(code: i64) -> Self {
        match code {
            1 => Waveform::Ac,
            2 => Waveform::Square,
            3 => Waveform::Triangle,
            4 => Waveform::Sawtooth,
            5 => Waveform::Pulse,
            6 => Waveform::Noise,
            _ => Waveform::Dc,
        }
    }
}

/// Shared shape generator for the voltage source and the rail.
struct Generator {
    waveform: Waveform,
    frequency: f64,
    max_voltage: f64,
    bias: f64,
    phase_shift: f64,
    duty_cycle: f64,
    rng: u64,
    /// Value a noise source holds for the whole of a step. Set once per
    /// converged step in `step_finished`, so Newton's subiterations all see
    /// the same right-hand side, matching upstream's `stepFinished` cadence
    /// (VoltageElm.java:163-166).
    noise_value: f64,
    /// Finite rise/fall time for square and pulse waves, in seconds. Not part
    /// of the text format: upstream carries it only in XML and the edit dialog
    /// (VoltageElm.java:112-113).
    rise_time: f64,
    /// Phase reference that keeps the waveform continuous across live
    /// frequency edits (VoltageElm.java:497-508). Zero until the first edit,
    /// which makes the phase `frequency * t`, as before.
    freq_time_zero: f64,
}

/// Legacy load-time flag meanings, shared with the TypeScript registry so a
/// loaded file reaches the engine already normalised.
const FLAG_COS: i64 = 2;
const FLAG_PULSE_DUTY: i64 = 4;
/// The duty cycle old pulse files are stuck with, `1/(2*pi)` (VoltageElm.java:51).
const DEFAULT_PULSE_DUTY: f64 = 1.0 / (2.0 * PI);

impl Generator {
    fn from_spec(spec: &ElementSpec) -> Self {
        let waveform = Waveform::from_code(spec.param("waveform", 0.0) as i64);
        let mut phase_shift = spec.param("phaseShift", 0.0);
        let mut duty_cycle = spec.param("dutyCycle", 0.5);
        // Old files flagged a cosine as a sine with FLAG_COS; upstream clears
        // the bit and materialises the pi/2 phase so a save is canonical
        // (VoltageElm.java:80-83).
        if spec.flag(FLAG_COS) {
            phase_shift = PI / 2.0;
        }
        // Old pulse files predate a configurable duty cycle, so upstream forces
        // the legacy value whenever the flag is absent (VoltageElm.java:85-88).
        if !spec.flag(FLAG_PULSE_DUTY) && waveform == Waveform::Pulse {
            duty_cycle = DEFAULT_PULSE_DUTY;
        }
        Self {
            waveform,
            frequency: spec.param("frequency", 40.0),
            max_voltage: spec.param("maxVoltage", 5.0),
            bias: spec.param("bias", 0.0),
            phase_shift,
            duty_cycle,
            // A fixed seed keeps noise sources reproducible across runs, salted
            // by the element id so two noise sources in one circuit do not
            // generate the same sequence.
            rng: 0x9E37_79B9_7F4A_7C15 ^ (spec.id as u64).wrapping_mul(0x2545_F491_4F6C_DD1D),
            noise_value: 0.0,
            rise_time: spec.param("riseTime", 0.0),
            freq_time_zero: 0.0,
        }
    }

    fn next_random(&mut self) -> f64 {
        // xorshift64*, so noise sources do not pull in an RNG dependency.
        self.rng ^= self.rng >> 12;
        self.rng ^= self.rng << 25;
        self.rng ^= self.rng >> 27;
        let v = self.rng.wrapping_mul(0x2545_F491_4F6C_DD1D);
        // Map to [-1, 1).
        ((v >> 11) as f64 / (1u64 << 53) as f64) * 2.0 - 1.0
    }

    /// Source value at time `t`. During DC analysis every non-DC waveform
    /// collapses to its bias, exactly as upstream's `doDcAnalysis()` branch
    /// does (VoltageElm.java:168-169), so an AC-driven circuit has a
    /// well-defined operating point rather than one frozen mid-cycle.
    fn voltage(&mut self, ctx: &SimCtx) -> f64 {
        if ctx.dc_analysis {
            return match self.waveform {
                Waveform::Dc => self.max_voltage + self.bias,
                _ => self.bias,
            };
        }
        if self.waveform == Waveform::Dc {
            return self.max_voltage + self.bias;
        }
        // `freq_time_zero` keeps the phase continuous across live frequency
        // edits; it stays 0 until the first edit, so a fixed frequency is
        // identical to the old `frequency * t` form.
        let w = (2.0 * PI * self.frequency * (ctx.time - self.freq_time_zero) + self.phase_shift)
            .rem_euclid(2.0 * PI);
        let duty = self.duty_cycle.clamp(0.0, 1.0);
        match self.waveform {
            Waveform::Dc => self.max_voltage + self.bias,
            Waveform::Ac => self.bias + self.max_voltage * w.sin(),
            Waveform::Square => {
                if self.rise_time > 0.0 {
                    self.square_with_rise(w, duty)
                } else {
                    self.bias
                        + if w > 2.0 * PI * duty {
                            -self.max_voltage
                        } else {
                            self.max_voltage
                        }
                }
            }
            Waveform::Triangle => {
                let shape = if w < PI {
                    w * (2.0 / PI) - 1.0
                } else {
                    1.0 - (w - PI) * (2.0 / PI)
                };
                self.bias + self.max_voltage * shape
            }
            Waveform::Sawtooth => self.bias + w * (self.max_voltage / PI) - self.max_voltage,
            Waveform::Pulse => {
                if self.rise_time > 0.0 {
                    self.pulse_with_rise(w, duty)
                } else if w < 2.0 * PI * duty {
                    self.max_voltage + self.bias
                } else {
                    self.bias
                }
            }
            Waveform::Noise => self.noise_value,
        }
    }

    /// Square wave with finite rise/fall ramps, ported from
    /// `VoltageElm.java:179-203`. The square swings between `bias + maxVoltage`
    /// and `bias - maxVoltage`; the rising edge is centred at phase 0 (wrapping
    /// the cycle boundary) and the falling edge at `dutyPhase`.
    fn square_with_rise(&self, w: f64, duty: f64) -> f64 {
        let duty_phase = 2.0 * PI * duty;
        let rise_phase = self.rise_time * self.frequency * 2.0 * PI;
        let half_rise = rise_phase / 2.0;
        if w < half_rise {
            let t = (w + half_rise) / rise_phase;
            self.bias + self.max_voltage * (2.0 * t - 1.0)
        } else if w < duty_phase - half_rise {
            self.bias + self.max_voltage
        } else if w < duty_phase + half_rise {
            let t = (w - duty_phase + half_rise) / rise_phase;
            self.bias + self.max_voltage * (1.0 - 2.0 * t)
        } else if w < 2.0 * PI - half_rise {
            self.bias - self.max_voltage
        } else {
            let t = (w - (2.0 * PI - half_rise)) / rise_phase;
            self.bias + self.max_voltage * (2.0 * t - 1.0)
        }
    }

    /// Pulse wave with finite rise/fall ramps, ported from
    /// `VoltageElm.java:214-238`. The pulse is low at `bias` and high at
    /// `bias + maxVoltage`, ramping between them in phase.
    fn pulse_with_rise(&self, w: f64, duty: f64) -> f64 {
        let duty_phase = 2.0 * PI * duty;
        let rise_phase = self.rise_time * self.frequency * 2.0 * PI;
        let half_rise = rise_phase / 2.0;
        if w < half_rise {
            let t = (w + half_rise) / rise_phase;
            self.bias + self.max_voltage * t
        } else if w < duty_phase - half_rise {
            self.bias + self.max_voltage
        } else if w < duty_phase + half_rise {
            let t = (w - duty_phase + half_rise) / rise_phase;
            self.bias + self.max_voltage * (1.0 - t)
        } else if w < 2.0 * PI - half_rise {
            self.bias
        } else {
            let t = (w - (2.0 * PI - half_rise)) / rise_phase;
            self.bias + self.max_voltage * t
        }
    }

    fn set_param(&mut self, name: &str, value: f64) -> bool {
        match name {
            "waveform" => self.waveform = Waveform::from_code(value as i64),
            "frequency" => self.frequency = value,
            "maxVoltage" => self.max_voltage = value,
            "bias" => self.bias = value,
            "phaseShift" => self.phase_shift = value,
            "dutyCycle" => self.duty_cycle = value,
            "riseTime" => self.rise_time = value,
            _ => return false,
        }
        true
    }
}

/// Two-terminal voltage source. Post 0 is the negative terminal.
pub struct VoltageSource {
    base: Base,
    gen: Generator,
    /// One terminal only, referenced to ground (a supply rail).
    rail: bool,
}

impl VoltageSource {
    pub fn new(spec: &ElementSpec) -> Self {
        Self {
            base: Base::with_posts(2),
            gen: Generator::from_spec(spec),
            rail: false,
        }
    }

    pub fn new_rail(spec: &ElementSpec) -> Self {
        Self {
            base: Base::with_posts(1),
            gen: Generator::from_spec(spec),
            rail: true,
        }
    }

    fn terminals(&self) -> (usize, usize) {
        if self.rail {
            (GROUND, self.base.nodes[0])
        } else {
            (self.base.nodes[0], self.base.nodes[1])
        }
    }
}

impl Element for VoltageSource {
    fn kind(&self) -> &'static str {
        if self.rail {
            "rail"
        } else {
            "voltage"
        }
    }
    fn base(&self) -> &Base {
        &self.base
    }
    fn base_mut(&mut self) -> &mut Base {
        &mut self.base
    }
    fn post_count(&self) -> usize {
        if self.rail {
            1
        } else {
            2
        }
    }
    fn voltage_source_count(&self) -> usize {
        1
    }

    fn stamp(&mut self, ctx: &SimCtx, s: &mut Stamper) {
        // Stamp the topology now with a zero value; `do_step` supplies the
        // value each timestep. That keeps the matrix constant, so a circuit
        // driven by an AC source still only factors once.
        let (n0, n1) = self.terminals();
        let vs = self.base.vs_base;
        let v = if self.gen.waveform == Waveform::Dc {
            self.gen.voltage(ctx)
        } else {
            0.0
        };
        s.voltage_source(n0, n1, vs, v);
    }

    fn do_step(&mut self, ctx: &SimCtx, s: &mut Stamper) {
        if self.gen.waveform == Waveform::Dc {
            return;
        }
        let v = self.gen.voltage(ctx);
        s.voltage_source_value(self.base.vs_base, v);
    }

    fn calculate_current(&mut self, _ctx: &SimCtx) {
        self.base.current = self.base.vs_currents[0];
    }

    fn reset(&mut self) {
        self.base_mut().reset();
        // Upstream's reset() also rewinds the phase reference (VoltageElm.java:
        // 130-133), so a reset after a frequency edit restarts from phase 0
        // rather than carrying the old edit's offset.
        self.gen.freq_time_zero = 0.0;
    }

    fn step_finished(&mut self, _ctx: &SimCtx) {
        // Upstream samples noise once per converged step, not per Newton
        // subiteration (VoltageElm.java:163-166), so a noise source in a
        // nonlinear circuit converges: the right-hand side it feeds is
        // constant across the subiterations of a step.
        if self.gen.waveform == Waveform::Noise {
            self.gen.noise_value = self.gen.bias + self.gen.max_voltage * self.gen.next_random();
        }
    }

    fn set_frequency(&mut self, ctx: &SimCtx, new_freq: f64) -> bool {
        let old_freq = self.gen.frequency;
        self.gen.frequency = new_freq;
        // Upstream clamps to the largest frequency the timestep can resolve
        // (1/(8*sim.maxTimeStep), VoltageElm.java:500) and silently declines
        // past it; the port has no confirm dialogs, so silent clamping is the
        // matching behaviour. `ctx.dt` is the fixed `options.time_step`.
        let max_freq = 1.0 / (8.0 * ctx.dt);
        if self.gen.frequency > max_freq {
            self.gen.frequency = max_freq;
        }
        // Rewind the phase reference so the waveform is continuous at the edit
        // instant (VoltageElm.java:507).
        self.gen.freq_time_zero = if self.gen.frequency == 0.0 {
            0.0
        } else {
            ctx.time - old_freq * (ctx.time - self.gen.freq_time_zero) / self.gen.frequency
        };
        true
    }

    fn display_voltage_diff(&self) -> f64 {
        if self.rail {
            // One terminal referenced to ground (RailElm.java:92).
            self.base.volts.first().copied().unwrap_or(0.0)
        } else {
            // Upstream's source reads out volts[1] - volts[0], so its EMF
            // comes up positive (VoltageElm.java:462).
            self.base.volts[1] - self.base.volts[0]
        }
    }

    fn set_param(&mut self, name: &str, value: f64) -> bool {
        // AC values are applied per step, so any recognised parameter takes
        // effect without a rebuild; a DC value lives in the constant matrix
        // and the caller's restamp picks it up.
        self.gen.set_param(name, value)
    }
}
