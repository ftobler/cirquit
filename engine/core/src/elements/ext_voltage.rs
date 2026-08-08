//! External voltage: a supply rail whose output comes from outside the file.

use crate::element::{Base, Element, SimCtx};
use crate::spec::ElementSpec;
use crate::stamp::{Stamper, GROUND};

/// A one-post rail whose value is injected rather than generated. Upstream's
/// `ExtVoltageElm` is a `RailElm` in WF_AC that overrides `getVoltage()` to
/// return whatever `setVoltage()` was last handed (ExtVoltageElm.java:50-55),
/// and its text format is the inherited `VoltageElm` token list plus an
/// escaped name. The port has no injection channel across the engine
/// boundary, so the frontend's "external" value is a plain `voltage` param
/// instead, and the name is label state the engine never reads.
///
/// The value is stamped in `do_step`, not `stamp`, so a live edit only
/// touches the right-hand side and the LU factors stay cached: the same
/// constant-matrix pattern the AC voltage source uses.
pub struct ExtVoltage {
    base: Base,
    voltage: f64,
}

impl ExtVoltage {
    pub fn new(spec: &ElementSpec) -> Self {
        // The injected value is not part of the text format: upstream's text
        // dump inherits VoltageElm's and never writes the `voltage` field
        // (ExtVoltageElm.java has no dump() override). A loaded `418` line
        // only carries the inherited `maxVoltage` token, so it stands in for
        // the value here; a freshly placed element sends `voltage` directly.
        let voltage = spec.param("voltage", spec.param("maxVoltage", 5.0));
        Self {
            base: Base::with_posts(1),
            voltage,
        }
    }
}

impl Element for ExtVoltage {
    fn kind(&self) -> &'static str {
        "extVoltage"
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
    fn voltage_source_count(&self) -> usize {
        1
    }
    fn voltage_source_nodes(&self, _k: usize) -> (usize, usize) {
        // A rail is a one-post source to ground (RailElm.java:93-99).
        (GROUND, self.base.nodes[0])
    }
    /// A voltage source pins a capacitor loop, so the CAP_V walk can cross
    /// this rail like any other source.
    fn is_voltage_source(&self) -> bool {
        true
    }
    fn stamp(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        // Topology now with a zero value; `do_step` supplies the value, so
        // the matrix (and its factors) never depend on the injected voltage.
        s.voltage_source(GROUND, self.base.nodes[0], self.base.vs_base, 0.0);
    }
    fn do_step(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        s.voltage_source_value(self.base.vs_base, self.voltage);
    }
    fn calculate_current(&mut self, _ctx: &SimCtx) {
        self.base.current = self.base.vs_currents[0];
    }
    fn voltage_diff(&self) -> f64 {
        // One terminal referenced to ground (RailElm.java:92).
        self.base.volts.first().copied().unwrap_or(0.0)
    }
    fn power(&self) -> f64 {
        // Negated so a delivering source reads negative (VoltageElm.java:461).
        -self.voltage_diff() * self.base().current
    }
    fn set_param(&mut self, name: &str, value: f64) -> bool {
        // Both names drive the one value: the file stores the amplitude as
        // `maxVoltage`, the frontend injects it as `voltage`, and either edit
        // must take effect live.
        match name {
            "voltage" | "maxVoltage" => self.voltage = value,
            _ => return false,
        }
        true
    }
}
