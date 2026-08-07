//! The wire format the UI uses to hand a circuit to the engine.
//!
//! Geometry stays on the TypeScript side; the engine only needs post
//! coordinates so it can work out which terminals touch, plus each element's
//! type and parameters.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// A single element as posted by the UI.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ElementSpec {
    /// Stable identity, echoed back with results so the UI can match them up.
    pub id: u32,
    /// Element type name, matching [`crate::element::Element::kind`].
    pub kind: String,
    /// Terminal coordinates in circuit space. Terminals sharing a coordinate
    /// share a node.
    pub posts: Vec<[i32; 2]>,
    /// Model parameters, keyed by name.
    #[serde(default)]
    pub params: HashMap<String, f64>,
    /// Free-form label, used by named-node elements.
    #[serde(default)]
    pub label: Option<String>,
    /// Bit flags carried through from the original file format.
    #[serde(default)]
    pub flags: i64,
}

impl ElementSpec {
    /// Parameter lookup with a fallback.
    pub fn param(&self, name: &str, default: f64) -> f64 {
        self.params.get(name).copied().unwrap_or(default)
    }

    pub fn flag(&self, bit: i64) -> bool {
        self.flags & bit != 0
    }
}

/// Global simulation settings.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SimOptions {
    /// Nominal (maximum) timestep in seconds.
    pub time_step: f64,
    /// Floor for adaptive step shrinking, in seconds. The working step can
    /// halve down to `2 * min_time_step` before the at-the-floor fallback
    /// budget applies; below that a shrink is impossible and a non-convergent
    /// step stops the run.
    pub min_time_step: f64,
    /// Enable step doubling after easy steps and halve-and-retry on a
    /// non-convergent step.
    pub adaptive: bool,
    /// Timesteps to advance per requested frame.
    pub steps_per_frame: u32,
    /// Newton iterations allowed before a timestep is declared non-convergent.
    pub max_subiterations: u32,
    /// Solve a DC operating point before the first timestep and on every
    /// reset, with reactive elements held at steady state (a capacitor open,
    /// an inductor short) and every non-DC source frozen at its bias
    /// (VoltageElm.java:168-169). The solved reactive state carries into the
    /// transient, so the first step starts from the operating point.
    pub dc_operating_point: bool,
}

impl Default for SimOptions {
    fn default() -> Self {
        Self {
            time_step: 5e-6,
            // Upstream's new-circuit default (CircuitLoader.java:50).
            min_time_step: 50e-12,
            // Off by default, matching upstream's `adjustTimeStep` (a plain
            // boolean; the header's flag bit 64 and UnijunctionElm are the
            // only things that turn it on, CircuitLoader.java:277).
            adaptive: false,
            steps_per_frame: 160,
            max_subiterations: 100,
            // Off by default, matching upstream's `autoDCOnReset` for a new
            // circuit (CircuitLoader.java:56): a fresh circuit keeps its
            // charging transients and an LC tank its self-start seed. The
            // frontend sets it from `settings.autoDC`, which honours the
            // loaded file's header flag bit 128.
            dc_operating_point: false,
        }
    }
}

/// A whole circuit, as handed over by the UI.
#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct CircuitSpec {
    #[serde(default)]
    pub elements: Vec<ElementSpec>,
    #[serde(default)]
    pub options: Option<SimOptions>,
    /// Signals the UI wants sampled at full timestep resolution.
    #[serde(default)]
    pub scopes: Vec<ScopeSpec>,
}

/// Which quantity a scope trace follows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ScopeValue {
    /// Voltage across the element (post 0 relative to post 1).
    Voltage,
    /// Current into post 0.
    Current,
    /// Instantaneous power dissipated.
    Power,
    /// Absolute voltage at one node of the element.
    NodeVoltage,
}

/// One scope trace.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopeSpec {
    /// Element being probed.
    pub element_id: u32,
    pub value: ScopeValue,
    /// Which post, for [`ScopeValue::NodeVoltage`].
    #[serde(default)]
    pub post: usize,
    /// Timesteps aggregated into one min/max column.
    #[serde(default = "default_steps_per_column")]
    pub steps_per_column: u32,
    /// Number of columns retained.
    #[serde(default = "default_columns")]
    pub columns: u32,
}

fn default_steps_per_column() -> u32 {
    1
}

fn default_columns() -> u32 {
    1024
}
