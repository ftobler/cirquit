//! Variable-voltage supply rail.

use crate::element::{Base, Element, SimCtx};
use crate::spec::ElementSpec;
use crate::stamp::{Stamper, GROUND};

/// A one-post supply rail whose output is a slider rather than a fixed
/// waveform (upstream's WF_VAR, VarRailElm). The value is the `voltage` param,
/// which the sliders feature edits live through [`Element::set_param`]; the
/// caller's `restamp` then re-stamps the source at the new value, so a slider
/// move takes effect without a rebuild.
///
/// Upstream tracks the slider position in the rail's `frequency` field
/// (VarRailElm.java:36, :72) and stores it in the `frequency` token of the
/// file line. The port names that token `voltage` instead; the TypeScript
/// parse/dump map the file's `frequency` slot to the `voltage` param, so the
/// interchange format is unchanged. `bias` and `maxVoltage` bound the slider
/// range in the UI and are not stamped here, so the engine carries only the
/// value that affects the solve.
pub struct VarRail {
    base: Base,
    /// Current output voltage: the live-set slider value.
    voltage: f64,
}

impl VarRail {
    pub fn new(spec: &ElementSpec) -> Self {
        // `voltage` is what the UI sends; `frequency` is the token slot a
        // legacy save still carries the value in, kept as a fallback so a bare
        // `172` line or an old file resolves to the same value upstream would
        // restore into its slider.
        let voltage = spec.param("voltage", spec.param("frequency", 5.0));
        Self {
            base: Base::with_posts(1),
            voltage,
        }
    }
}

impl Element for VarRail {
    fn kind(&self) -> &'static str {
        "varRail"
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
        // The rail stamps its one terminal against ground, so the source
        // unknown must be assigned to that terminal's closure (RailElm.java:
        // 92-99).
        (GROUND, self.base.nodes[0])
    }

    /// A rail pins a capacitor loop, so the CAP_V walk must be able to cross
    /// one, exactly like the plain rail (VoltageElm.java's family-wide
    /// `isVoltageSource`).
    fn is_voltage_source(&self) -> bool {
        true
    }

    /// The value is constant between edits, so it is stamped once like a DC
    /// source and the matrix stays factored; a live `set_param` re-runs this
    /// through `restamp` with the new value.
    fn stamp(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        s.voltage_source(GROUND, self.base.nodes[0], self.base.vs_base, self.voltage);
    }

    fn calculate_current(&mut self, _ctx: &SimCtx) {
        self.base.current = self.base.vs_currents[0];
    }

    /// The post is the rail's delivery terminal, so the current exits the
    /// source into the node there (see `voltage_source.rs`); without this the
    /// wire-current recovery sees no injection at a rail's post.
    fn current_into_node(&self, post: usize) -> f64 {
        if post == 0 {
            self.base.current
        } else {
            0.0
        }
    }

    fn voltage_diff(&self) -> f64 {
        // One terminal referenced to ground (RailElm.java:92).
        self.base.volts.first().copied().unwrap_or(0.0)
    }

    fn power(&self) -> f64 {
        // The positive-EMF readout above would make a delivering source read
        // positive; upstream negates it (VoltageElm.java:461).
        -self.voltage_diff() * self.base().current
    }

    fn set_param(&mut self, name: &str, value: f64) -> bool {
        match name {
            "voltage" => self.voltage = value,
            _ => return false,
        }
        true
    }

    fn reset(&mut self) {
        self.base_mut().reset();
    }
}
