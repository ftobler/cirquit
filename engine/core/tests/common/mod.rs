//! Shared helpers for the engine's end-to-end circuit test suite: building
//! element specs, running a circuit to a fixed point, and comparing floats.
//!
//! Every file in `tests/` is its own test binary, so an item unused by one
//! binary still needs to exist for the others; `dead_code` would otherwise
//! fire per binary depending on which helpers it happens to call.
#![allow(dead_code)]

use std::collections::HashMap;

use circuit_core::{
    Circuit, CircuitSpec, ElementSpec, ScopeSpec, ScopeValue, SimOptions, SolverType,
};

pub fn elm(id: u32, kind: &str, posts: &[[i32; 2]], params: &[(&str, f64)]) -> ElementSpec {
    ElementSpec {
        id,
        kind: kind.into(),
        posts: posts.to_vec(),
        params: params
            .iter()
            .map(|(k, v)| (k.to_string(), *v))
            .collect::<HashMap<_, _>>(),
        label: None,
        model: None,
        flags: 0,
    }
}

/// Like [`elm`], with file-format flags set, for the load-time conversions
/// that only exist on a raw spec.
pub fn elm_flags(
    id: u32,
    kind: &str,
    posts: &[[i32; 2]],
    params: &[(&str, f64)],
    flags: i64,
) -> ElementSpec {
    let mut e = elm(id, kind, posts, params);
    e.flags = flags;
    e
}

/// A controlled source whose expression arrives as the element's label, the
/// string carrier the frontend uses for the `exprString` token.
pub fn elm_expr(
    id: u32,
    kind: &str,
    posts: &[[i32; 2]],
    input_count: f64,
    expr: &str,
) -> ElementSpec {
    ElementSpec {
        id,
        kind: kind.into(),
        posts: posts.to_vec(),
        params: [("inputCount", input_count)]
            .iter()
            .map(|(k, v)| (k.to_string(), *v))
            .collect::<HashMap<_, _>>(),
        label: Some(expr.into()),
        model: None,
        flags: 0,
    }
}

/// A custom-logic element whose model arrives as the serialised JSON blob in
/// `spec.model`, the carrier the frontend uses for the resolved `!`-line model.
/// `rules` is the parsed left/right table; the engine does not re-parse it.
pub fn elm_model(
    id: u32,
    posts: &[[i32; 2]],
    inputs: usize,
    outputs: usize,
    tri_state: bool,
    rules: &[(&str, &str)],
) -> ElementSpec {
    let model = serde_json::json!({
        "inputs": (0..inputs).map(|i| String::from_utf8(vec![b'A' + i as u8]).unwrap()).collect::<Vec<_>>(),
        "outputs": (0..outputs).map(|i| String::from_utf8(vec![b'A' + inputs as u8 + i as u8]).unwrap()).collect::<Vec<_>>(),
        "triState": tri_state,
        "rulesLeft": rules.iter().map(|(l, _)| *l).collect::<Vec<_>>(),
        "rulesRight": rules.iter().map(|(_, r)| *r).collect::<Vec<_>>(),
    });
    ElementSpec {
        id,
        kind: "customLogic".into(),
        posts: posts.to_vec(),
        params: HashMap::new(),
        label: None,
        model: Some(model.to_string()),
        flags: 0,
    }
}

pub fn build(elements: Vec<ElementSpec>, options: SimOptions) -> Circuit {
    build_with(elements, options, Vec::new())
}

pub fn build_with(
    elements: Vec<ElementSpec>,
    options: SimOptions,
    scopes: Vec<ScopeSpec>,
) -> Circuit {
    let spec = CircuitSpec {
        elements,
        options: Some(options),
        scopes,
    };
    let mut c = Circuit::new();
    c.set_circuit(&spec).expect("circuit should analyse");
    c
}

pub fn opts(time_step: f64, dc: bool) -> SimOptions {
    SimOptions {
        solver_type: SolverType::Auto,
        time_step,
        min_time_step: 50e-12,
        adaptive: false,
        steps_per_frame: 1,
        max_subiterations: 100,
        dc_operating_point: dc,
    }
}

/// The fixed `opts` helper with a forced solver backend, for the parity tests
/// that must run the same circuit through the dense and the sparse path.
pub fn opts_solver(time_step: f64, dc: bool, solver_type: SolverType) -> SimOptions {
    SimOptions {
        solver_type,
        time_step,
        min_time_step: 50e-12,
        adaptive: false,
        steps_per_frame: 1,
        max_subiterations: 100,
        dc_operating_point: dc,
    }
}

/// The fixed `opts` helper keeps `adaptive: false` so the 120-odd existing
/// tests stay on the fixed-step path. The adaptive-timestep tests use this
/// instead, selecting the min step and the Newton budget the plan's scenarios
/// need.
pub fn adaptive_opts(max_step: f64, min_step: f64, subiters: u32) -> SimOptions {
    SimOptions {
        solver_type: SolverType::Auto,
        time_step: max_step,
        min_time_step: min_step,
        adaptive: true,
        steps_per_frame: 1,
        max_subiterations: subiters,
        dc_operating_point: false,
    }
}

/// Non-adaptive options at a chosen Newton budget, for the tests that pin the
/// fixed-step path at a small budget. The plan's tuning lever: a circuit that
/// genuinely stalls at the full step must be able to do so within the budget
/// the fixed run hands it.
pub fn opts_budget(time_step: f64, dc: bool, max_sub: u32) -> SimOptions {
    SimOptions {
        solver_type: SolverType::Auto,
        time_step,
        min_time_step: 50e-12,
        adaptive: false,
        steps_per_frame: 1,
        max_subiterations: max_sub,
        dc_operating_point: dc,
    }
}

pub fn close(a: f64, b: f64, tol: f64) -> bool {
    (a - b).abs() <= tol
}

/// A freshly drawn parallel pair of ideal capacitors with unequal stored
/// charges (1 V and 0 V). This is the loop `CapacitorElm.validate()`
/// (CapacitorElm.java:274-291) dampens: the trapezoidal companion on an
/// ideal-cap loop rings at the Nyquist rate, the per-cap currents alternating
/// sign every step at full amplitude and never decaying (CapacitorElm.java:
/// 163-165). The validate pass gives one member a 0.1 ohm series resistance
/// and the ring dies within a few dozen steps, leaving the charge-weighted
/// average on the common node.
pub fn parallel_ideal_pair(dt: f64) -> Circuit {
    build(
        vec![
            elm(
                1,
                "capacitor",
                &[[0, 0], [0, 100]],
                &[("capacitance", 1e-6), ("voltDiff", 1.0)],
            ),
            elm(
                2,
                "capacitor",
                &[[100, 0], [100, 100]],
                &[("capacitance", 1e-6), ("voltDiff", 0.0)],
            ),
            elm(3, "wire", &[[0, 0], [100, 0]], &[]),
            elm(4, "wire", &[[0, 100], [100, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
        ],
        opts(dt, false),
    )
}

/// 10 V behind 1 k into a capacitor whose file said it was charged to 5 V.
pub fn restored_charge_circuit(dt: f64, dc: bool) -> Circuit {
    build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 10.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(
                3,
                "capacitor",
                &[[100, 0], [100, 100]],
                &[("capacitance", 1e-6), ("voltDiff", 5.0)],
            ),
            elm(4, "wire", &[[100, 100], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
        ],
        opts(dt, dc),
    )
}

/// Ports Diode.java's forward/reverse current law independently, the same
/// "default" model diode_knee_matches_upstream_default_model pins (Is =
/// 1.7143528192808883e-7, n = 2, vscale = 2*vt). The varactor test below
/// uses it to separate the diode branch's own contribution from the
/// capacitive one it sits beside.
pub fn diode_current(v: f64) -> f64 {
    const VT: f64 = 0.025_865;
    const FWDROP: f64 = 0.805_904_783;
    let vscale = 2.0 * VT;
    let leakage = 1.0 / ((FWDROP / vscale).exp() - 1.0);
    leakage * ((v / vscale).exp() - 1.0)
}

/// One scope trace: the transformer family's tests read node voltages and
/// current peaks back through scopes rather than the per-element readout,
/// because a transformer's secondary voltage is `V(post1) - V(post3)`, not the
/// default `V(post0) - V(post1)`.
pub fn tr_scope(id: u32, value: ScopeValue, post: usize) -> ScopeSpec {
    ScopeSpec {
        element_id: id,
        value,
        post,
        steps_per_column: 1,
        columns: 4096,
        ac_coupled: false,
        trigger: Default::default(),
        display_width: 0,
    }
}

/// Average of the newest min/max column of scope `i`.
pub fn last_sample(c: &Circuit, i: usize) -> f64 {
    let snap = c.scopes()[i].snapshot();
    let (min, max) = (snap[snap.len() - 2], snap[snap.len() - 1]);
    (min as f64 + max as f64) / 2.0
}

/// A 20 kHz, 10 V sine drives a node through 200 ohm that also carries a
/// voltage-limited current source (0.01 A, 5 V compliance), post 0 on ground.
/// When the source pushes the node through the compliance transition, the
/// tanh companion's step-size limiter refuses to settle in a handful of
/// iterations (CurrentElm.java:139-158): at dt = 5e-6 the transition needs
/// 8, more than the budget of 5, so a fixed-step run stalls there. The exact
/// iteration counts were tuned by probing: 8 at 5e-6, 5 at 2.5e-6, 4 at
/// 1.25e-6, which is what makes the halve-and-retry tests below robust.
pub fn compliance_circuit(phase_shift: f64) -> Vec<ElementSpec> {
    vec![
        elm(
            1,
            "voltage",
            &[[0, 100], [0, 0]],
            &[
                ("waveform", 1.0),
                ("frequency", 20000.0),
                ("maxVoltage", 10.0),
                ("phaseShift", phase_shift),
            ],
        ),
        elm(2, "resistor", &[[0, 0], [100, 0]], &[("resistance", 200.0)]),
        elm(
            3,
            "current",
            &[[100, 100], [100, 0]],
            &[("current", 0.01), ("maxVoltage", 5.0)],
        ),
        elm(4, "ground", &[[0, 100]], &[]),
        elm(5, "ground", &[[100, 100]], &[]),
    ]
}

/// Exact backward-Euler response of a series `RL` stepped at `dt` from rest:
/// `I_n = (V/R)·(1 - (1 + R·dt/L)^-n)`. Under a balanced three-phase drive the
/// motor's stator phases reduce to exactly this: equal stator currents couple
/// into each rotor coil as `(Lm - Lm/2 - Lm/2)·i = 0`, so the rotor stays at
/// zero current and every phase sees only its own `Ls` in series with `Rs`.
pub fn rl_backward_euler_step(v: f64, r: f64, l: f64, dt: f64, n: u32) -> f64 {
    let decay = (1.0 + r * dt / l).powi(-(n as i32));
    (v / r) * (1.0 - decay)
}

/// One full clock cycle: raise the clock, let the level settle, drop it, let
/// that settle. A `set_state` reanalyzes the circuit and zeroes every element
/// voltage, so the first step after each change still sees the old level and
/// the edge fires a step later; three steps cover the settling either way.
pub fn clock_cycle(c: &mut Circuit, clock_id: u32) {
    c.set_state(clock_id, 1);
    c.run(3);
    c.set_state(clock_id, 0);
    c.run(3);
}
