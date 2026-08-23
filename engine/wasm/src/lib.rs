//! WebAssembly surface of the simulation engine.
//!
//! The UI holds one [`Simulator`] and drives it once per animation frame.
//! Everything crossing the boundary is either a plain number or a flat typed
//! array, so a frame costs one call rather than one call per element.

use circuit_core::{Circuit, CircuitSpec, DcOutcome};
use wasm_bindgen::prelude::*;

/// Installs a panic hook that reports Rust panics to the browser console.
/// Called automatically on the first `Simulator`, and safe to call again.
#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

/// What happened while advancing the simulation.
#[wasm_bindgen]
pub struct FrameResult {
    steps: u32,
    iterations: u32,
    time: f64,
    time_step: f64,
    rejected_steps: u32,
    converged: bool,
    error: Option<String>,
    failing_element_ids: Vec<u32>,
}

#[wasm_bindgen]
impl FrameResult {
    #[wasm_bindgen(getter)]
    pub fn steps(&self) -> u32 {
        self.steps
    }
    /// Total Newton iterations across the frame; a useful load indicator.
    #[wasm_bindgen(getter)]
    pub fn iterations(&self) -> u32 {
        self.iterations
    }
    /// Simulated time reached, in seconds.
    #[wasm_bindgen(getter)]
    pub fn time(&self) -> f64 {
        self.time
    }
    /// Timestep the last committed step used, and what the next step will
    /// attempt. The convergence-diagnostics roadmap item surfaces this.
    #[wasm_bindgen(getter)]
    pub fn time_step(&self) -> f64 {
        self.time_step
    }
    /// Timestep attempts rejected by the halve-and-retry path this frame.
    #[wasm_bindgen(getter)]
    pub fn rejected_steps(&self) -> u32 {
        self.rejected_steps
    }
    #[wasm_bindgen(getter)]
    pub fn converged(&self) -> bool {
        self.converged
    }
    #[wasm_bindgen(getter)]
    pub fn error(&self) -> Option<String> {
        self.error.clone()
    }
    /// Ids of the elements still moving when the Newton budget ran out. Empty
    /// on a converged frame. The UI resolves ids to element names.
    #[wasm_bindgen(js_name = failingElementIds)]
    pub fn failing_element_ids(&self) -> Vec<u32> {
        self.failing_element_ids.clone()
    }
}

#[wasm_bindgen]
pub struct Simulator {
    circuit: Circuit,
}

impl Default for Simulator {
    fn default() -> Self {
        Self::new()
    }
}

/// Trigger display anchor for one scope trace (ScopeTrigger.java:66-81).
#[wasm_bindgen]
#[derive(Default)]
pub struct TriggerInfo {
    triggered: bool,
    /// 0 armed, 1 triggered, 2 auto-run.
    state: u8,
    /// True while armed with no trigger yet (the WAIT status text).
    waiting: bool,
    start_index: usize,
    valid_count: usize,
    columns: usize,
    snapshot_start: usize,
    written: usize,
    /// Sim time at the trigger, for anchored time conversions.
    time: f64,
}

#[wasm_bindgen]
impl TriggerInfo {
    #[wasm_bindgen(getter)]
    pub fn triggered(&self) -> bool {
        self.triggered
    }
    #[wasm_bindgen(getter)]
    pub fn state(&self) -> u8 {
        self.state
    }
    #[wasm_bindgen(getter)]
    pub fn waiting(&self) -> bool {
        self.waiting
    }
    /// Ring index where the display window starts.
    #[wasm_bindgen(getter)]
    pub fn start_index(&self) -> usize {
        self.start_index
    }
    /// Columns of valid post-trigger data to draw.
    #[wasm_bindgen(getter)]
    pub fn valid_count(&self) -> usize {
        self.valid_count
    }
    /// Ring capacity.
    #[wasm_bindgen(getter)]
    pub fn columns(&self) -> usize {
        self.columns
    }
    /// Ring index of the first slot returned by `scopeData`.
    #[wasm_bindgen(getter)]
    pub fn snapshot_start(&self) -> usize {
        self.snapshot_start
    }
    /// Columns actually written, capped at capacity.
    #[wasm_bindgen(getter)]
    pub fn written(&self) -> usize {
        self.written
    }
    /// Sim time at the trigger, so the UI anchors time conversions at the
    /// trigger-stabilized window centre (Scope.java:910-915).
    #[wasm_bindgen(getter)]
    pub fn time(&self) -> f64 {
        self.time
    }
}

#[wasm_bindgen]
impl Simulator {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Simulator {
        console_error_panic_hook::set_once();
        Simulator {
            circuit: Circuit::new(),
        }
    }

    /// Loads a circuit. `json` is a serialised `CircuitSpec`: elements with
    /// their post coordinates and parameters, plus options and scope requests.
    #[wasm_bindgen(js_name = setCircuit)]
    pub fn set_circuit(&mut self, json: &str) -> Result<(), JsError> {
        let spec: CircuitSpec =
            serde_json::from_str(json).map_err(|e| JsError::new(&format!("bad circuit: {e}")))?;
        self.circuit
            .set_circuit(&spec)
            .map_err(|e| JsError::new(&e))
    }

    /// Advances `steps` timesteps.
    pub fn run(&mut self, steps: u32) -> FrameResult {
        let r = self.circuit.run(steps);
        FrameResult {
            steps: r.steps,
            iterations: r.iterations,
            time: r.time,
            time_step: r.time_step,
            rejected_steps: r.rejected_steps,
            converged: r.converged,
            error: r.error,
            failing_element_ids: r.failing,
        }
    }

    pub fn reset(&mut self) {
        self.circuit.reset();
    }

    /// Runs the one-shot Find DC Operating Point command: a whole reset under
    /// a temporarily-true DC option, upstream's dcAnalysisFlag plus
    /// resetAction (CommandManager.java:361-364). Returns "found" or
    /// "degraded"; a hard engine failure throws with the engine message, the
    /// `setCircuit` precedent for the only crossings that carry a rich error.
    #[wasm_bindgen(js_name = findDcOperatingPoint)]
    pub fn find_dc_operating_point(&mut self) -> Result<String, JsError> {
        match self.circuit.find_dc_operating_point() {
            Ok(DcOutcome::Found) => Ok("found".into()),
            Ok(DcOutcome::Degraded) => Ok("degraded".into()),
            Err(e) => Err(JsError::new(&e)),
        }
    }

    /// Re-arms the stop triggers so a simulation paused by one can resume
    /// without rewinding time. The frame loop calls it on the pause -> run
    /// transition; stepping alone must not clear the latches.
    #[wasm_bindgen(js_name = clearStops)]
    pub fn clear_stops(&mut self) {
        self.circuit.clear_stops();
    }

    #[wasm_bindgen(getter)]
    pub fn time(&self) -> f64 {
        self.circuit.time()
    }

    /// Voltage at every node, indexed by node number. Node 0 is ground.
    #[wasm_bindgen(js_name = nodeVoltages)]
    pub fn node_voltages(&self) -> Vec<f64> {
        self.circuit.node_voltages().to_vec()
    }

    /// Current through each element, in the order they were supplied.
    #[wasm_bindgen(js_name = elementCurrents)]
    pub fn element_currents(&self) -> Vec<f64> {
        self.circuit.element_currents()
    }

    /// Current each terminal exchanges with its node, flattened in element
    /// order then post order, indexed like `elementNodes` so the renderer can
    /// animate each lead on its own current.
    #[wasm_bindgen(js_name = elementPostCurrents)]
    pub fn element_post_currents(&self) -> Vec<f64> {
        self.circuit.element_post_currents()
    }

    /// Voltage across each element, in the order they were supplied.
    #[wasm_bindgen(js_name = elementVoltages)]
    pub fn element_voltages(&self) -> Vec<f64> {
        self.circuit.element_voltages()
    }

    /// Dissipated power per element, in the order they were supplied, using
    /// the same convention as a scope Power trace.
    #[wasm_bindgen(js_name = elementPowers)]
    pub fn element_powers(&self) -> Vec<f64> {
        self.circuit.element_powers()
    }

    /// Instrument reading per element, in the order they were supplied.
    /// Probes report their selected meter mode, everything else its voltage
    /// difference.
    #[wasm_bindgen(js_name = elementValues)]
    pub fn element_values(&self) -> Vec<f64> {
        self.circuit.element_values()
    }

    /// Live render state per element, in the order they were supplied. Each
    /// element defines its own scalar: a fuse's melt fraction (>= 1 blown), a
    /// lamp's filament temperature in kelvin; everything else reports 0.
    #[wasm_bindgen(js_name = elementStates)]
    pub fn element_states(&self) -> Vec<f64> {
        self.circuit.element_states()
    }

    /// Live file-format operating-point tokens per element, as the JSON string
    /// `[{ "id": <id>, "tokens": { name: value } }, ...]` in the order the
    /// elements were supplied. Symmetric with `setCircuit`'s JSON-in: the
    /// frontend overlays these onto copies of its `params` at save/rebuild
    /// time, never per frame.
    #[wasm_bindgen(js_name = elementStateTokens)]
    pub fn element_state_tokens(&self) -> String {
        let ids = self.circuit.element_ids();
        let tokens = self.circuit.state_tokens();
        let out: Vec<serde_json::Value> = ids
            .iter()
            .zip(tokens.iter())
            .map(|(id, toks)| {
                let map: std::collections::HashMap<&str, f64> =
                    toks.iter().map(|(k, v)| (k.as_str(), *v)).collect();
                serde_json::json!({ "id": id, "tokens": map })
            })
            .collect();
        serde_json::to_string(&out).unwrap_or_else(|_| "[]".into())
    }

    /// Node index for every element terminal, flattened in element order, so
    /// the renderer can colour each terminal by node voltage.
    #[wasm_bindgen(js_name = elementNodes)]
    pub fn element_nodes(&self) -> Vec<u32> {
        self.circuit.element_nodes()
    }

    /// Scope columns, oldest first, interleaved `[min, max, ...]`.
    #[wasm_bindgen(js_name = scopeData)]
    pub fn scope_data(&self, index: usize) -> Vec<f32> {
        self.circuit
            .scopes()
            .get(index)
            .map(|s| s.snapshot())
            .unwrap_or_default()
    }

    /// Total columns ever written to a scope. Lets the UI place the trace in
    /// time and notice wrap-around.
    #[wasm_bindgen(js_name = scopeColumnsWritten)]
    pub fn scope_columns_written(&self, index: usize) -> f64 {
        self.circuit
            .scopes()
            .get(index)
            .map(|s| s.columns_written as f64)
            .unwrap_or(0.0)
    }

    /// Whether a scope trace has dropped a non-finite sample since the last
    /// reset (a diverged node). The sample is unusable and is discarded, but
    /// the drop must not be silent: the UI reads this flag and captions the
    /// frozen trace as a warning instead of a healthy flatline.
    #[wasm_bindgen(js_name = scopeDiverged)]
    pub fn scope_diverged(&self, index: usize) -> bool {
        self.circuit
            .scopes()
            .get(index)
            .map(|s| s.diverged)
            .unwrap_or(false)
    }

    /// This frame's recent raw samples for a scope (X-Y mode), oldest first.
    #[wasm_bindgen(js_name = recentSamples)]
    pub fn recent_samples(&self, index: usize) -> Vec<f32> {
        self.circuit.recent_samples(index)
    }

    /// Strip voltages for a transmission line's body wave, already averaged
    /// from the two travelling waves and resampled to `segments` samples (one
    /// per drawn strip, `segments = dn/2` like the upstream draw loop). Empty
    /// before the first stamp and for ids that are not transmission lines. An
    /// on-demand per-element array like `recentSamples`, so no other element
    /// pays for the crossing.
    #[wasm_bindgen(js_name = transmissionLineWave)]
    pub fn transmission_line_wave(&self, id: u32, segments: usize) -> Vec<f32> {
        self.circuit.body_samples(id, segments)
    }

    /// A data recorder's recorded samples, oldest first, for the frontend's
    /// export button. Empty for ids that are not data recorders. An on-demand
    /// per-element array like `transmissionLineWave`, so no other element pays
    /// for the crossing.
    #[wasm_bindgen(js_name = dataRecorderData)]
    pub fn data_recorder_data(&self, id: u32) -> Vec<f64> {
        self.circuit.data_recorder_data(id)
    }

    /// One element's live scope-value table in the order its kind declares
    /// (a transistor's Ib, Ic, Ie, Vbe, Vbc, Vce), so a multi-row info
    /// readout costs one crossing. Empty for ids whose kind answers nothing.
    /// An on-demand per-element array like `transmissionLineWave`, so only
    /// the hovered element pays for the crossing.
    #[wasm_bindgen(js_name = elementScopeValues)]
    pub fn element_scope_values(&self, id: u32) -> Vec<f64> {
        self.circuit.element_scope_values(id)
    }

    /// Trigger display info for a scope. `width` is the display width in
    /// pixels; the UI passes the canvas width so the anchor counts against the
    /// same window the drawing does.
    #[wasm_bindgen(js_name = triggerInfo)]
    pub fn trigger_info(&self, index: usize, width: usize) -> TriggerInfo {
        self.circuit
            .trigger_info(index, width)
            .map(|t| TriggerInfo {
                triggered: t.triggered,
                state: t.state,
                waiting: t.waiting,
                start_index: t.start_index,
                valid_count: t.valid_count,
                columns: t.columns,
                snapshot_start: t.snapshot_start,
                written: t.written,
                time: t.time,
            })
            .unwrap_or_default()
    }

    /// Resizes a scope's capture ring without rebuilding the circuit, so a
    /// speed or width change does not rewind the simulation. Returns false
    /// when the index is out of range; the caller then reloads.
    #[wasm_bindgen(js_name = setScopeParams)]
    pub fn set_scope_params(&mut self, index: usize, steps_per_column: u32, columns: u32) -> bool {
        self.circuit
            .set_scope_params(index, steps_per_column, columns)
    }

    /// Toggles a scope's AC coupling without rebuilding the circuit, so the
    /// coupling radio does not rewind the simulation. Returns false when the
    /// index is out of range; the caller then reloads.
    #[wasm_bindgen(js_name = setScopeAcCoupling)]
    pub fn set_scope_ac_coupling(&mut self, index: usize, ac_coupled: bool) -> bool {
        self.circuit.set_scope_ac_coupled(index, ac_coupled)
    }

    #[wasm_bindgen(js_name = scopeCount)]
    pub fn scope_count(&self) -> usize {
        self.circuit.scopes().len()
    }

    /// Non-fatal problems found during analysis, one per line.
    pub fn warnings(&self) -> String {
        self.circuit.warnings().join("\n")
    }

    /// The last solver error, if the circuit is currently unsolvable.
    pub fn error(&self) -> Option<String> {
        self.circuit.error().map(|s| s.to_string())
    }

    #[wasm_bindgen(js_name = nodeCount)]
    pub fn node_count(&self) -> usize {
        self.circuit.node_count()
    }

    /// Changes a model parameter without rebuilding the circuit.
    #[wasm_bindgen(js_name = setParam)]
    pub fn set_param(&mut self, id: u32, name: &str, value: f64) -> bool {
        self.circuit.set_param(id, name, value)
    }

    /// Changes interactive state, such as a switch position.
    #[wasm_bindgen(js_name = setState)]
    pub fn set_state(&mut self, id: u32, state: i32) -> bool {
        self.circuit.set_state(id, state)
    }
}

/// Element type names this build can simulate, newline separated. The UI uses
/// it to grey out types it can draw but not yet solve.
#[wasm_bindgen(js_name = supportedKinds)]
pub fn supported_kinds() -> String {
    circuit_core::KINDS.join("\n")
}
