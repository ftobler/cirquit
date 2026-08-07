//! WebAssembly surface of the simulation engine.
//!
//! The UI holds one [`Simulator`] and drives it once per animation frame.
//! Everything crossing the boundary is either a plain number or a flat typed
//! array, so a frame costs one call rather than one call per element.

use circuit_core::{Circuit, CircuitSpec};
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
        }
    }

    pub fn reset(&mut self) {
        self.circuit.reset();
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
