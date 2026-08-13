//! Circuit simulation engine.
//!
//! The solver is modified nodal analysis with a Newton-Raphson loop around it
//! for nonlinear devices, integrating reactive elements with companion models.
//! It is deliberately free of any UI or platform concern: geometry, drawing and
//! file handling live in the TypeScript side of the project, and the engine
//! only ever sees node connectivity and device parameters.
//!
//! ```
//! use circuit_core::{Circuit, CircuitSpec};
//!
//! let spec: CircuitSpec = serde_json::from_str(r#"{
//!   "elements": [
//!     {"id": 1, "kind": "voltage", "posts": [[0, 100], [0, 0]],
//!      "params": {"maxVoltage": 10.0}},
//!     {"id": 2, "kind": "resistor", "posts": [[0, 0], [100, 0]],
//!      "params": {"resistance": 100.0}},
//!     {"id": 3, "kind": "wire", "posts": [[100, 0], [100, 100]]},
//!     {"id": 4, "kind": "wire", "posts": [[100, 100], [0, 100]]},
//!     {"id": 5, "kind": "ground", "posts": [[0, 100]]}
//!   ]
//! }"#).unwrap();
//!
//! let mut circuit = Circuit::new();
//! circuit.set_circuit(&spec).unwrap();
//! circuit.run(10);
//! // 10 V across 100 ohms.
//! assert!((circuit.element_currents()[1] - 0.1).abs() < 1e-9);
//! ```

pub mod circuit;
pub mod closure;
pub mod element;
pub mod elements;
pub mod expr;
pub mod matrix;
pub mod scope;
pub mod sparse;
pub mod spec;
pub mod stamp;

pub use circuit::{Circuit, StepReport};
pub use element::{Element, SimCtx};
pub use elements::KINDS;
pub use matrix::SolverBackend;
pub use scope::ScopeTrace;
pub use spec::{CircuitSpec, ElementSpec, ScopeSpec, ScopeValue, SimOptions, SolverType};
