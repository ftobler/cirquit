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
}

impl Generator {
    fn from_spec(spec: &ElementSpec) -> Self {
        Self {
            waveform: Waveform::from_code(spec.param("waveform", 0.0) as i64),
            frequency: spec.param("frequency", 40.0),
            max_voltage: spec.param("maxVoltage", 5.0),
            bias: spec.param("bias", 0.0),
            phase_shift: spec.param("phaseShift", 0.0),
            duty_cycle: spec.param("dutyCycle", 0.5),
            // Any odd constant works as an xorshift seed; a fixed one keeps
            // noise sources reproducible across runs.
            rng: 0x9E37_79B9_7F4A_7C15,
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

    /// Source value at time `t`. During DC analysis the waveform is frozen at
    /// t = 0 so the operating point is well defined.
    fn voltage(&mut self, ctx: &SimCtx) -> f64 {
        let t = if ctx.dc_analysis { 0.0 } else { ctx.time };
        if self.waveform == Waveform::Dc {
            return self.max_voltage + self.bias;
        }
        let w = (2.0 * PI * self.frequency * t + self.phase_shift).rem_euclid(2.0 * PI);
        let duty = self.duty_cycle.clamp(0.0, 1.0);
        match self.waveform {
            Waveform::Dc => self.max_voltage + self.bias,
            Waveform::Ac => self.bias + self.max_voltage * w.sin(),
            Waveform::Square => {
                self.bias
                    + if w > 2.0 * PI * duty {
                        -self.max_voltage
                    } else {
                        self.max_voltage
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
                if w < 2.0 * PI * duty {
                    self.max_voltage + self.bias
                } else {
                    self.bias
                }
            }
            Waveform::Noise => self.bias + self.max_voltage * self.next_random(),
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

    fn set_param(&mut self, name: &str, value: f64) -> bool {
        // AC values are applied per step, so any recognised parameter takes
        // effect without a rebuild; a DC value lives in the constant matrix
        // and the caller's restamp picks it up.
        self.gen.set_param(name, value)
    }
}
