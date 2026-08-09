//! Shared machinery for the expression-driven controlled sources.
//!
//! The VCVS and VCCS are the same chip: `inputCount` inputs A.. on the west,
//! an output pair on the east, and a value string evaluated against the input
//! voltages on every Newton iteration. Upstream models this as
//! `VCVSElm extends VCCSElm`; here the two share [`ExprSource`] and the
//! per-input numerical derivative the element stamps as its slope.
//!
//! The expression string arrives as the element's label, the same string
//! carrier the transformer description and scope config use: the file carries
//! it as one escaped token and the frontend unescapes it before the spec
//! reaches the engine (VCCSElm.java:38, CustomLogicModel.unescape).

use crate::expr::{parse, Expr, ExprState};

/// Convergence limit for the input voltages and output quantity. It grows more
/// lenient as the Newton iteration grinds on, so a slow-settling input does not
/// burn the whole budget (VCCSElm.getConvergeLimit, VCCSElm.java:91-98).
pub fn converge_limit(subiter: usize) -> f64 {
    if subiter < 10 {
        0.001
    } else if subiter < 200 {
        0.01
    } else {
        0.1
    }
}

/// Upstream's `sign(a, b)`: `b` with the sign of `a`, the floor for a
/// numerical derivative that vanished (VCCSElm.java:87-89).
pub fn sign(a: f64, b: f64) -> f64 {
    if a > 0.0 {
        b
    } else {
        -b
    }
}

/// The numerical derivative `d(expr)/dv` with respect to input `i`, clamped to
/// `1e-6` magnitude so a flat expression still gives Newton a slope
/// (VCCSElm.java:138-148). Callers apply their own sign: the VCCS
/// differentiates `-expr`, the VCVS plain `expr`. Takes the tree and the state
/// separately so an element can hold the tree borrowed while it mutates the
/// state around the two evaluations.
pub fn input_derivative(expr: &Expr, state: &mut ExprState, last_volts: &[f64], i: usize) -> f64 {
    let v = state.values[i];
    let dv = v - last_volts[i];
    let dv = if dv.abs() < 1e-6 { 1e-6 } else { dv };
    let hi = expr.eval(state);
    state.values[i] = v - dv;
    let lo = expr.eval(state);
    state.values[i] = v;
    let dx = (hi - lo) / dv;
    if dx.abs() < 1e-6 {
        sign(dx, 1e-6)
    } else {
        dx
    }
}

/// The parsed expression plus the evaluator's per-iteration state.
///
/// `expr` sits next to `state` and `last_volts` as a sibling field so the
/// element's `do_step` can hold an immutable borrow of the tree while writing
/// the state and last-voltage snapshots: the three are never mutated together.
pub struct ExprSource {
    pub input_count: usize,
    pub expr: Option<Expr>,
    pub state: ExprState,
    /// The previous Newton iterate's input voltages, feeding the convergence
    /// test and the numerical derivative (`lastVolts`, VCCSElm.java:63).
    pub last_volts: Vec<f64>,
    /// The value the element stamped last step, re-reported by
    /// `calculate_current` and zeroed for a broken source.
    pub output: f64,
}

impl ExprSource {
    pub fn new(input_count: usize, expr_string: &str) -> Self {
        Self {
            input_count,
            // A bad expression stays `None`, so the element simulates as a
            // passive stub rather than refusing to build; the parse error
            // reaches the user through the edit dialog, not the solver.
            expr: parse(expr_string).ok(),
            state: ExprState::new(),
            last_volts: vec![0.0; input_count],
            output: 0.0,
        }
    }

    /// Zeroes the evaluator history on circuit reset (VCCSElm.java:236-239).
    pub fn reset(&mut self) {
        self.state.reset();
        self.last_volts.fill(0.0);
        self.output = 0.0;
    }
}
