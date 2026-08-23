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
    /// A serialised model definition, for the element types whose behaviour
    /// comes from a named model in the file rather than numeric params. The
    /// custom-logic element (208) carries its resolved `!`-line model here as
    /// JSON: the input/output counts and the parsed rule table. Kept separate
    /// from `label` because the label is that element's model name, a plain
    /// string the engine never interprets.
    #[serde(default)]
    pub model: Option<String>,
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

/// Which linear-solver backend a closure uses. Upstream's `solverType`
/// selection (SimulationManager.java:1013-1017); the frontend sends nothing
/// and gets [`SolverType::Auto`]. A future Options>Simulation row can expose
/// it directly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SolverType {
    /// Dense below the sparse threshold, sparse at or above it.
    #[default]
    Auto,
    /// Always the dense LU, whatever the closure size.
    Dense,
    /// Always the sparse LU, whatever the closure size.
    Sparse,
}

/// Global simulation settings.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SimOptions {
    /// Solver backend selection. See [`SolverType`]; the sparse path exists
    /// for closures whose dense `O(n^3)` LU would not fit in a frame.
    #[serde(default)]
    pub solver_type: SolverType,
    /// Nominal (maximum) timestep in seconds.
    #[serde(default = "default_time_step")]
    pub time_step: f64,
    /// Floor for adaptive step shrinking, in seconds. Halving stops once the
    /// result would drop below this value, so the floor itself is the
    /// smallest attempted step, and it is where the relaxed 5000-iteration
    /// budget applies; a non-convergent step there stops the run.
    #[serde(default = "default_min_time_step")]
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
    /// Constant-row elimination for nonlinear dense closures (see
    /// [`crate::simplified`]): rows `do_step` never rewrites are factored
    /// once at build and the per-iteration solve works on a small reduced
    /// system. On by default; the frontend sends nothing and gets the win.
    /// Disabling it is a solver-internal lever for the tests that pin the
    /// simplified path against the unsimplified one.
    #[serde(default = "default_simplify")]
    pub simplify: bool,
}

fn default_simplify() -> bool {
    true
}

impl Default for SimOptions {
    fn default() -> Self {
        Self {
            solver_type: SolverType::Auto,
            time_step: 5e-6,
            // Upstream's new-circuit default (CircuitLoader.java:50).
            min_time_step: 50e-12,
            // Off by default, matching upstream's `adjustTimeStep` (a plain
            // boolean; the header's flag bit 64 and UnijunctionElm are the
            // only things that turn it on, CircuitLoader.java:277).
            adaptive: false,
            steps_per_frame: 160,
            // 1000, not upstream's 5000: the gmin ramps engage at subiter
            // 100 and need room to climb (Diode.java:150 triggers at
            // `subIterations > 100`), while a pathological frame stays
            // bounded. Normal circuits settle in 2 to 5 iterations, so the
            // cost is zero for well-behaved circuits.
            max_subiterations: 1000,
            // Off by default, matching upstream's `autoDCOnReset` for a new
            // circuit (CircuitLoader.java:56): a fresh circuit keeps its
            // charging transients and an LC tank its self-start seed. The
            // frontend sets it from `settings.autoDC`, which honours the
            // loaded file's header flag bit 128.
            dc_operating_point: false,
            simplify: true,
        }
    }
}

/// A whole circuit, as handed over by the UI.
#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CircuitSpec {
    #[serde(default)]
    pub elements: Vec<ElementSpec>,
    #[serde(default)]
    pub options: Option<SimOptions>,
    /// Signals the UI wants sampled at full timestep resolution.
    #[serde(default)]
    pub scopes: Vec<ScopeSpec>,
    /// True when this build continues the run already in progress, which is
    /// every rebuild caused by an edit: moving, adding or deleting an element
    /// renumbers nodes, but the wall clock, the adaptive step and the scope
    /// captures are not node-indexed, so they carry across. Upstream's
    /// `analyzeCircuit` behaves this way by construction, and only
    /// `resetAction` rewinds (UIManager.java:1349-1360). Defaults to false so
    /// a fresh document (a load, New, or a caller that says nothing) starts at
    /// t = 0.
    #[serde(default)]
    pub preserve_run: bool,
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
    /// Absolute voltage at one node of the element. Serialised as
    /// `nodeVoltage`, the camelCase the TS side would spell a node-voltage
    /// scope value (`web/src/engine/simulator.ts`), which is the contract
    /// this enum's wire strings follow. The enum-level `rename_all =
    /// "lowercase"` would otherwise spell it `nodevoltage`.
    #[serde(rename = "nodeVoltage")]
    NodeVoltage,
    /// Stored charge (a capacitor's `C * Vplate`), upstream's `VAL_CHARGE`
    /// (CapacitorElm.java:225-229). Only elements with a meaningful charge
    /// return non-zero (capacitor.rs); the default is 0.
    Charge,
    /// Lamp filament resistance for this step, upstream's VAL_R
    /// (LampElm.java:218-219). Only the lamp answers it; the default is 0.
    Resistance,
    /// A transistor's terminal currents and junction voltages, upstream's
    /// VAL_IB/IC/IE/VBE/VBC/VCE (TransistorElm.java:582-593). Only the
    /// transistor answers them; the default is 0.
    Ib,
    Ic,
    Ie,
    Vbe,
    Vbc,
    Vce,
}

/// Which edge fires the trigger.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TriggerEdge {
    #[default]
    Rising,
    Falling,
}

/// Trigger acquisition mode. Free Run disables the trigger entirely.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TriggerMode {
    #[default]
    FreeRun,
    Normal,
    Auto,
}

/// Trigger configuration for one scope trace (ScopeTrigger.java).
#[derive(Debug, Clone, Copy, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TriggerSpec {
    #[serde(default)]
    pub mode: TriggerMode,
    #[serde(default)]
    pub edge: TriggerEdge,
    #[serde(default)]
    pub level: f64,
}

impl Default for TriggerSpec {
    fn default() -> Self {
        Self {
            mode: TriggerMode::FreeRun,
            edge: TriggerEdge::Rising,
            level: 0.0,
        }
    }
}

/// One scope trace.
///
/// `PartialEq` is what a preserving rebuild matches on: a trace whose spec
/// came back identical keeps its captured columns instead of starting a new,
/// empty ring.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
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
    /// DC-blocking high-pass filter on the raw sample (voltage plots only).
    #[serde(default)]
    pub ac_coupled: bool,
    /// Trigger acquisition settings.
    #[serde(default)]
    pub trigger: TriggerSpec,
    /// Display width in pixels. The trigger holdoff and display anchor count
    /// columns against it, and only the frontend knows the canvas width.
    #[serde(default)]
    pub display_width: u32,
}

fn default_steps_per_column() -> u32 {
    1
}

fn default_columns() -> u32 {
    1024
}

/// Serde default for [`SimOptions::time_step`].
///
/// A plain `#[serde(default)]` on an `f64` would hand a missing `timeStep` a
/// 0.0, and a zero step is a footgun: the closure would advance nothing and
/// the simulation would stall or spin. A missing field must mean the same as
/// [`SimOptions::default()`], so delegate to it and stay in lockstep.
fn default_time_step() -> f64 {
    SimOptions::default().time_step
}

/// Serde default for [`SimOptions::min_time_step`]; see [`default_time_step`].
fn default_min_time_step() -> f64 {
    SimOptions::default().min_time_step
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn circuit_spec_defaults_missing_timing_options() {
        // A frontend that omits `options.timeStep` and `options.minTimeStep`
        // must not fail the whole `set_circuit` with "bad circuit": the
        // missing fields take the simulation defaults, not a footgun 0.0.
        let spec: CircuitSpec = serde_json::from_str(
            r#"{"elements":[],"options":{"solverType":"auto","adaptive":false,"stepsPerFrame":160,"maxSubiterations":1000,"dcOperatingPoint":false},"scopes":[]}"#,
        )
        .expect("omitting the timing fields must not fail deserialisation");
        let options = spec.options.expect("options block present");
        assert_eq!(options.time_step, 5e-6);
        assert_eq!(options.min_time_step, 50e-12);
    }

    #[test]
    fn scope_value_node_voltage_serialises_as_camel_case() {
        // The TS side spells scope strings camelCase
        // (`web/src/engine/simulator.ts`), so the node-voltage wire string
        // must be `nodeVoltage`. The `rename_all = "lowercase"` on the enum
        // would produce `nodevoltage`; the variant-level rename overrides it.
        // The round-trip guards both directions against drifting apart.
        let json = serde_json::to_string(&ScopeValue::NodeVoltage).expect("should serialise");
        assert_eq!(json, "\"nodeVoltage\"");
        let back: ScopeValue = serde_json::from_str(&json).expect("should deserialise");
        assert_eq!(back, ScopeValue::NodeVoltage);
    }

    #[test]
    fn per_element_scope_values_serialise_as_the_frontend_union_members() {
        // The lamp's VAL_R and the transistor's pin plots ride the same wire
        // strings the TS `ScopeValue` union spells (`web/src/engine/simulator.ts`);
        // a drift would deserialise every such scope spec as "bad circuit".
        for (value, name) in [
            (ScopeValue::Resistance, "resistance"),
            (ScopeValue::Ib, "ib"),
            (ScopeValue::Ic, "ic"),
            (ScopeValue::Ie, "ie"),
            (ScopeValue::Vbe, "vbe"),
            (ScopeValue::Vbc, "vbc"),
            (ScopeValue::Vce, "vce"),
        ] {
            let json = serde_json::to_string(&value).expect("should serialise");
            assert_eq!(json, format!("\"{name}\""));
            let back: ScopeValue = serde_json::from_str(&json).expect("should deserialise");
            assert_eq!(back, value);
        }
    }

    #[test]
    fn sim_options_round_trips_present_timing_fields() {
        // A full JSON with both timing fields present must survive a
        // deserialise/reserialise cycle unchanged. Compared as serde_json
        // values, not bytes: a float like 1e-5 round-trips through the same
        // binary value but may print as "0.00001".
        let json = r#"{"solverType":"auto","timeStep":1e-5,"minTimeStep":1e-10,"adaptive":true,"stepsPerFrame":320,"maxSubiterations":500,"dcOperatingPoint":true,"simplify":true}"#;
        let options: SimOptions = serde_json::from_str(json).expect("full JSON should deserialise");
        let out = serde_json::to_string(&options).expect("should re-serialise");
        let expected: serde_json::Value =
            serde_json::from_str(json).expect("expected JSON is valid");
        let actual: serde_json::Value =
            serde_json::from_str(&out).expect("re-serialised JSON is valid");
        assert_eq!(actual, expected);
    }
}
