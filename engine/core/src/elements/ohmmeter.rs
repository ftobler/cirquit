//! Ohmmeter: an ideal current source whose reading is the terminal resistance.

use crate::element::{Base, Element, SimCtx};
use crate::spec::ElementSpec;
use crate::stamp::Stamper;

/// Two-terminal ohmmeter, electrically identical to the ideal current source
/// (OhmMeterElm extends CurrentElm): it pushes a fixed 0.01 A through the
/// device under test and reads the resistance from the terminal voltage
/// (OhmMeterElm.java:59-62). The `current`/`maxVoltage` tokens are inherited
/// from CurrentElm; `getEditInfo` is commented out upstream, so the values
/// only ever come from the file.
pub struct Ohmmeter {
    base: Base,
    current_value: f64,
    /// Voltage compliance; 0 means unlimited (ideal source).
    max_voltage: f64,
    /// The previous iterate's clamped terminal voltage, feeding the step-size
    /// limiter so Newton cannot cross the tanh transition in one move
    /// (`lastVoltDiff`, CurrentElm.java:29).
    last_volt_diff: f64,
    /// True when analysis found no DC path between the terminals
    /// (CurrentElm.java:30).
    broken: bool,
}

impl Ohmmeter {
    /// Resistance stamped for a broken source (CurrentElm.java:110).
    const BROKEN_R: f64 = 1e8;

    pub fn new(spec: &ElementSpec) -> Self {
        Self {
            base: Base::with_posts(2),
            current_value: spec.param("current", 0.01),
            max_voltage: spec.param("maxVoltage", 0.0),
            last_volt_diff: 0.0,
            broken: false,
        }
    }

    fn is_voltage_limited(&self) -> bool {
        self.max_voltage > 0.0
    }
}

impl Element for Ohmmeter {
    fn kind(&self) -> &'static str {
        "ohmmeter"
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

    /// The tanh companion changes every Newton iteration, so the source is
    /// nonlinear whenever it is voltage-limited (CurrentElm.java:47).
    fn nonlinear(&self) -> bool {
        self.is_voltage_limited()
    }

    fn stamp(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        let (n0, n1) = (self.base.nodes[0], self.base.nodes[1]);
        if self.broken {
            // No current path; a current source would drive the floating nodes
            // apart. A 100 M resistor stands in and the source reports zero
            // current (CurrentElm.java:108-111).
            s.resistor(n0, n1, Self::BROKEN_R);
        } else if self.is_voltage_limited() {
            // Nonlinear; do_step stamps the companion each iteration
            // (CurrentElm.java:112-115).
        } else {
            s.current_source(n0, n1, self.current_value);
        }
    }

    fn do_step(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        if self.broken || !self.is_voltage_limited() {
            return;
        }
        let (n0, n1) = (self.base.nodes[0], self.base.nodes[1]);
        let mut vd = self.base.volts[1] - self.base.volts[0];

        // The transition spans [vStart, maxVoltage], centred at 0.975*Vmax
        // (CurrentElm.java:134-137).
        let v_start = 0.95 * self.max_voltage;
        let v_width = self.max_voltage - v_start;
        let v_mid = (v_start + self.max_voltage) / 2.0;
        let vt = (v_width / 5.0).max(1e-3);

        // Step-size limiter: the transition is steep, so Newton must creep
        // through it a fraction of the width at a time or the iteration
        // oscillates (CurrentElm.java:139-158).
        if self.last_volt_diff < v_start && vd > v_start {
            vd = v_start;
            s.not_converged();
        } else if self.last_volt_diff > self.max_voltage && vd < self.max_voltage {
            vd = self.max_voltage;
            s.not_converged();
        } else if self.last_volt_diff >= v_start && self.last_volt_diff <= self.max_voltage {
            let max_step = (v_width / 4.0).max(0.01);
            if vd > self.last_volt_diff + max_step {
                vd = self.last_volt_diff + max_step;
                s.not_converged();
            } else if vd < self.last_volt_diff - max_step {
                vd = self.last_volt_diff - max_step;
                s.not_converged();
            }
        }
        self.last_volt_diff = vd;

        // i(vd) = current * 0.5 * (1 - tanh((vd - vMid)/vt)): full current well
        // below the transition, rolling to zero past maxVoltage.
        let arg = (vd - v_mid) / vt;
        let tanh_arg = arg.tanh();
        let i = self.current_value * 0.5 * (1.0 - tanh_arg);
        let sech2 = 1.0 - tanh_arg * tanh_arg;
        let slope = -self.current_value * 0.5 * sech2 / vt;
        let gres = slope.abs() + 1e-6;
        s.resistor(n0, n1, 1.0 / gres);
        s.current_source(n0, n1, i + gres * vd);
    }

    fn calculate_current(&mut self, _ctx: &SimCtx) {
        if self.broken {
            self.base.current = 0.0;
        } else if !self.is_voltage_limited() {
            self.base.current = self.current_value;
        } else {
            let vd = self.base.volts[1] - self.base.volts[0];
            let v_start = 0.95 * self.max_voltage;
            let v_width = self.max_voltage - v_start;
            let v_mid = (v_start + self.max_voltage) / 2.0;
            let vt = (v_width / 5.0).max(1e-3);
            let arg = (vd - v_mid) / vt;
            self.base.current = self.current_value * 0.5 * (1.0 - arg.tanh());
        }
    }

    fn voltage_diff(&self) -> f64 {
        // The current-source convention, volts[1] - volts[0] (CurrentElm.java:
        // 199-201).
        self.base.volts[1] - self.base.volts[0]
    }

    fn power(&self) -> f64 {
        // Negated so a delivering source reads negative (CurrentElm.java:202).
        -self.voltage_diff() * self.base().current
    }

    /// The instrument reading: the resistance seen at the terminals, the
    /// terminal voltage over the delivered current (OhmMeterElm.java:59-62).
    /// Upstream displays infinity when the current is 0; the port reports a
    /// large finite value (the broken-source current is 0, so `value()`
    /// cannot divide). The frontend suppresses the label at zero current.
    fn value(&self) -> f64 {
        if self.base.current == 0.0 {
            f64::INFINITY
        } else {
            self.voltage_diff() / self.base.current
        }
    }

    fn connects(&self, _a: usize, _b: usize) -> bool {
        false
    }
    /// The Norton companion (and the broken-source resistor) always stamps a
    /// conductance between the terminals, so they must share one closure even
    /// though `connects` is false.
    fn matrix_connects(&self, _a: usize, _b: usize) -> bool {
        true
    }

    fn current_output_nodes(&self) -> Option<(usize, usize)> {
        Some((self.base.nodes[0], self.base.nodes[1]))
    }

    /// Only a source without voltage compliance can be forced broken
    /// (CurrentElm.java:102-104).
    fn set_broken(&mut self, broken: bool) {
        self.broken = broken && !self.is_voltage_limited();
    }

    fn set_param(&mut self, name: &str, value: f64) -> bool {
        match name {
            "current" => self.current_value = value,
            "maxVoltage" => self.max_voltage = value,
            _ => return false,
        }
        true
    }

    fn reset(&mut self) {
        self.base.reset();
        self.last_volt_diff = 0.0;
    }

    /// Re-anchors the tanh step-size limiter from the restored terminal
    /// voltage (see the current source).
    fn restore_iteration(&mut self) {
        self.last_volt_diff = self.base.volts[1] - self.base.volts[0];
    }
}
