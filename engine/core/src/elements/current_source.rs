//! Independent current source.

use crate::element::{Base, Element, SimCtx};
use crate::spec::ElementSpec;
use crate::stamp::Stamper;

/// Two-terminal current source pushing `current` from post 0 to post 1.
///
/// `max_voltage` is the voltage compliance (upstream's `maxVoltage`): at 0 the
/// source is ideal, above 0 the delivered current rolls off smoothly as the
/// terminal voltage approaches `maxVoltage`, modelled with the tanh companion
/// from CurrentElm.java. A source whose terminals have no DC current path is
/// marked broken by the analyser and replaced by a 100 M resistor reporting
/// zero current.
pub struct CurrentSource {
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

impl CurrentSource {
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

impl Element for CurrentSource {
    fn kind(&self) -> &'static str {
        "current"
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
        // The previous iterate: `write_back` refreshes `volts` between Newton
        // subiterations.
        let mut vd = self.base.volts[1] - self.base.volts[0];

        // The transition spans [vStart, maxVoltage], centred at 0.975*Vmax
        // (CurrentElm.java:134-137).
        let v_start = 0.95 * self.max_voltage;
        let v_width = self.max_voltage - v_start;
        let v_mid = (v_start + self.max_voltage) / 2.0;
        let vt = (v_width / 5.0).max(1e-3);

        // Step-size limiter: the transition is steep, so Newton must creep
        // through it a fraction of the width at a time or the iteration
        // oscillates (CurrentElm.java:139-158). A clamped move is not settled,
        // so the step keeps iterating.
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
        // Norton companion: a conductance of |slope| (the floor keeps the
        // matrix non-singular where sech^2 vanishes, like upstream's `absG`
        // at CurrentElm.java:172) in parallel with a source that pins the
        // operating point at `i` (CurrentElm.java:173-174).
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
            // Re-evaluate the delivered current at the solved terminal voltage
            // (CurrentElm.java:176).
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
        // Upstream's current source reads out volts[1] - volts[0]
        // (CurrentElm.java:199-201), the same positive-EMF convention as the
        // voltage source.
        self.base.volts[1] - self.base.volts[0]
    }

    fn power(&self) -> f64 {
        // Negated so a delivering source reads negative (CurrentElm.java:202).
        -self.voltage_diff() * self.base().current
    }

    /// An ideal current source does not tie its terminals together, so it
    /// cannot rescue a node from floating.
    fn connects(&self, _a: usize, _b: usize) -> bool {
        false
    }
    /// The Norton companion (and the broken-source resistor) always stamps a
    /// conductance between the terminals, so they must share one closure even
    /// though `connects` is false. Upstream's CurrentElm inherits the default
    /// `getConnection = true` (CircuitElm.java:1283).
    fn matrix_connects(&self, _a: usize, _b: usize) -> bool {
        true
    }

    /// Only a source without voltage compliance can be forced broken: a
    /// voltage-limited one carries its own path through the companion
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
    /// voltage. `do_step` writes `last_volt_diff` on every subiteration, so a
    /// rejected step would otherwise leave the retry creeping from a stale
    /// anchor instead of the committed operating point.
    fn restore_iteration(&mut self) {
        self.last_volt_diff = self.base.volts[1] - self.base.volts[0];
    }
}
