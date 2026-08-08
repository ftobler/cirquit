//! Schmitt triggers, inverting and non-inverting, sharing one hysteresis
//! state machine (InvertingSchmittElm.java, SchmittElm.java).

use crate::element::{Base, Element, SimCtx};
use crate::spec::ElementSpec;
use crate::stamp::{Stamper, GROUND};

/// A Schmitt trigger. The output is a slew-rate-limited voltage source to
/// ground whose level `do_step` decides from the input against the two
/// triggers, remembering the last crossing (InvertingSchmittElm.java:120-151).
pub struct Schmitt {
    base: Base,
    slew_rate: f64,
    lower_trigger: f64,
    upper_trigger: f64,
    /// Which way the last threshold crossing set the memory: crossing the
    /// upper trigger clears it, crossing the lower trigger sets it, in both
    /// variants alike. What differs between them is only the output each
    /// transition writes: the inverting trigger goes off above the upper
    /// threshold and on below the lower one, the non-inverting one the other
    /// way round (see `do_step`).
    state: bool,
    logic_on_level: f64,
    logic_off_level: f64,
    /// The inverting variant reads the clamp anchor live from `volts[1]`
    /// (InvertingSchmittElm.java:121); the non-inverting one anchors on the
    /// step-start output like the inverter (SchmittElm.java:37-39).
    inverting: bool,
    last_output_voltage: f64,
}

impl Schmitt {
    pub fn new(spec: &ElementSpec, inverting: bool) -> Self {
        Self {
            base: Base::with_posts(2),
            slew_rate: spec.param("slewRate", 0.5),
            lower_trigger: spec.param("lowerTrigger", 1.66),
            upper_trigger: spec.param("upperTrigger", 3.33),
            state: false,
            logic_on_level: spec.param("logicOnLevel", 5.0),
            logic_off_level: spec.param("logicOffLevel", 0.0),
            inverting,
            last_output_voltage: 0.0,
        }
    }
}

impl Element for Schmitt {
    fn kind(&self) -> &'static str {
        if self.inverting {
            "invertingSchmitt"
        } else {
            "schmitt"
        }
    }
    fn base(&self) -> &Base {
        &self.base
    }
    fn base_mut(&mut self) -> &mut Base {
        &mut self.base
    }
    fn post_count(&self) -> usize {
        2
    }
    fn voltage_source_count(&self) -> usize {
        1
    }
    fn voltage_source_nodes(&self, _k: usize) -> (usize, usize) {
        // The output is a source to ground (InvertingSchmittElm.java:118,
        // :208-211).
        (GROUND, self.base.nodes[1])
    }
    /// No current path through the input (InvertingSchmittElm.java:208).
    fn connects(&self, _a: usize, _b: usize) -> bool {
        false
    }

    fn stamp(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        s.voltage_source(GROUND, self.base.nodes[1], self.base.vs_base, 0.0);
    }

    fn start_iteration(&mut self, _ctx: &SimCtx) {
        self.last_output_voltage = self.base.volts[1];
    }

    fn do_step(&mut self, ctx: &SimCtx, s: &mut Stamper) {
        let v0 = if self.inverting {
            self.base.volts[1]
        } else {
            self.last_output_voltage
        };
        // The state machine's transition outputs are mirror images: the
        // inverting trigger goes low above the upper threshold and high below
        // the lower one, the non-inverting one the other way round.
        let mut out;
        if self.state {
            if self.base.volts[0] > self.upper_trigger {
                self.state = false;
                out = if self.inverting {
                    self.logic_off_level
                } else {
                    self.logic_on_level
                };
            } else {
                out = if self.inverting {
                    self.logic_on_level
                } else {
                    self.logic_off_level
                };
            }
        } else if self.base.volts[0] < self.lower_trigger {
            self.state = true;
            out = if self.inverting {
                self.logic_on_level
            } else {
                self.logic_off_level
            };
        } else {
            out = if self.inverting {
                self.logic_off_level
            } else {
                self.logic_on_level
            };
        }
        // Same slew clamp as the inverter, in volts per step
        // (InvertingSchmittElm.java:148-150).
        let max_step = self.slew_rate * ctx.dt * 1e9;
        out = out.max(v0 - max_step).min(v0 + max_step);
        s.voltage_source_value(self.base.vs_base, out);
    }

    fn calculate_current(&mut self, _ctx: &SimCtx) {
        self.base.current = self.base.vs_currents[0];
    }

    fn current_into_node(&self, post: usize) -> f64 {
        if post == 1 {
            self.base.current
        } else {
            0.0
        }
    }

    /// A scope on a Schmitt trigger plots its input (InvertingSchmittElm.java:152).
    fn voltage_diff(&self) -> f64 {
        self.base.volts[0]
    }

    fn set_param(&mut self, name: &str, value: f64) -> bool {
        match name {
            "slewRate" => self.slew_rate = value,
            "lowerTrigger" => self.lower_trigger = value,
            "upperTrigger" => self.upper_trigger = value,
            "logicOnLevel" => self.logic_on_level = value,
            "logicOffLevel" => self.logic_off_level = value,
            _ => return false,
        }
        true
    }

    fn reset(&mut self) {
        self.base.reset();
        self.last_output_voltage = 0.0;
        // `state` survives a reset exactly as upstream leaves it: the base
        // reset only zeroes the voltages, and the memory is the trigger's
        // defining property (CircuitElm.java:258-263).
    }
}
