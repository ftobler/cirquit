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
    let left: Vec<&str> = rules.iter().map(|(l, _)| *l).collect();
    let right: Vec<&str> = rules.iter().map(|(_, r)| *r).collect();
    elm_model_rules(id, posts, inputs, outputs, tri_state, &left, &right)
}

/// Like [`elm_model`], with the left and right rule tables supplied
/// separately, for the malformed-shape tests that need unbalanced counts.
pub fn elm_model_rules(
    id: u32,
    posts: &[[i32; 2]],
    inputs: usize,
    outputs: usize,
    tri_state: bool,
    rules_left: &[&str],
    rules_right: &[&str],
) -> ElementSpec {
    let model = serde_json::json!({
        "inputs": (0..inputs).map(|i| String::from_utf8(vec![b'A' + i as u8]).unwrap()).collect::<Vec<_>>(),
        "outputs": (0..outputs).map(|i| String::from_utf8(vec![b'A' + inputs as u8 + i as u8]).unwrap()).collect::<Vec<_>>(),
        "triState": tri_state,
        "rulesLeft": rules_left,
        "rulesRight": rules_right,
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
        simplify: true,
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
        simplify: true,
    }
}

/// Like [`opts`] with constant-row elimination disabled, for the tests that
/// pin the simplified path against the unsimplified one.
pub fn opts_no_simplify(time_step: f64, dc: bool) -> SimOptions {
    SimOptions {
        solver_type: SolverType::Auto,
        time_step,
        min_time_step: 50e-12,
        adaptive: false,
        steps_per_frame: 1,
        max_subiterations: 100,
        dc_operating_point: dc,
        simplify: false,
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
        simplify: true,
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
        simplify: true,
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

// ─── Grid, fan and chain builders (shared by the benchmark and the solver tests) ───

/// `chains` resistor chains of `len` 1 ohm resistors fanning out from one
/// driven node (0,0) to ground, driven by a `drive` volt source. Mirrors the
/// grid the closure section describes, parameterised. Chain `c`'s far corner
/// (junction after its `len - 1`-th resistor) sits at coordinate
/// `(c*16, 16*(len-1))` and node `1 + (len-1)*(c+1)`, at `drive/len` V.
pub fn fan(chains: usize, len: usize, drive: f64, base: u32) -> Vec<ElementSpec> {
    let mut v = vec![
        // The source's grounded terminal sits off the grid: for `len` over 25
        // the chains' junction coordinates reach y = 400 and would merge the
        // driven node with ground through a stray junction.
        elm(
            base,
            "voltage",
            &[[-100, 400], [0, 0]],
            &[("maxVoltage", drive)],
        ),
        elm(base + 1, "ground", &[[-100, 400]], &[]),
    ];
    let mut id = base + 2;
    for c in 0..chains {
        let cx = c as i32 * 16;
        v.push(elm(
            id,
            "resistor",
            &[[0, 0], [cx, 16]],
            &[("resistance", 1.0)],
        ));
        id += 1;
        for k in 1..len {
            v.push(elm(
                id,
                "resistor",
                &[[cx, 16 * k as i32], [cx, 16 * (k + 1) as i32]],
                &[("resistance", 1.0)],
            ));
            id += 1;
        }
        v.push(elm(id, "ground", &[[cx, 16 * len as i32]], &[]));
        id += 1;
    }
    v
}

/// The 20x20 fan with a diode and a diode-connected transistor dropped onto
/// chain 0's far corner. The corner clamps through the two junctions, which
/// makes the whole circuit nonlinear: every closure refactors every Newton
/// iteration, exercising the monotone pair set and the per-iteration restore
/// on the sparse path.
pub fn fan_with_nonlinear_arm() -> Vec<ElementSpec> {
    let mut v = fan(20, 20, 20.0, 1);
    // Chain 0's far corner is at (0, 304). The diode drops from the corner to
    // a fresh grounded coordinate; the transistor is diode-connected (base
    // and collector both on the corner) with its emitter grounded.
    v.push(elm(423, "diode", &[[0, 304], [0, 480]], &[]));
    v.push(elm(424, "ground", &[[0, 480]], &[]));
    v.push(elm(
        425,
        "transistor",
        &[[0, 304], [0, 304], [100, 304]],
        &[("beta", 100.0)],
    ));
    v.push(elm(426, "ground", &[[100, 304]], &[]));
    v
}

/// A chain of `n` equal 1000 ohm resistors in series from a 10 V source to
/// ground, placed at x offset `off`. `base_id` gives unique element ids so
/// several chains can share one circuit. `n` resistors give `n` junction
/// nodes plus one voltage-source row, so a 60-node chain is one closure of
/// 61 rows.
pub fn resistor_chain(n: usize, off: i32, base_id: u32) -> Vec<ElementSpec> {
    let mut v = Vec::new();
    let mut id = base_id;
    v.push(elm(
        id,
        "voltage",
        &[[off, 100], [off, 0]],
        &[("maxVoltage", 10.0)],
    ));
    id += 1;
    v.push(elm(id, "ground", &[[off, 100]], &[]));
    id += 1;
    for k in 0..n {
        v.push(elm(
            id,
            "resistor",
            &[[off + 16 * k as i32, 0], [off + 16 * (k + 1) as i32, 0]],
            &[("resistance", 1000.0)],
        ));
        id += 1;
    }
    v.push(elm(id, "ground", &[[off + 16 * n as i32, 0]], &[]));
    v
}

/// An (n+1) x (n+1) lattice of 1 ohm resistors: 2n(n+1) edges, a 10 V source
/// driving corner (0,0) (ground terminal off-grid) and a ground symbol at the
/// far corner (n,n). Horizontal edges are emitted row-major (y outer, x
/// inner) before vertical edges, which makes the node ids deterministic:
/// `node(x, y) = y*(n+1) + x + 1`, so the driven corner is node 1 and the
/// center (n/2, n/2) of an even-n mesh is node `(n/2)*(n+1) + n/2 + 1`.
///
/// Two analytic facts fall out of the symmetry: V(i, j) == V(j, i) (the
/// square lattice and its drive are symmetric under the transpose) and
/// V(center) = 10/2 = 5.0 V exactly (a 180 degree rotation swaps the driven
/// corner with the grounded one, so the antisymmetric drive has a midpoint
/// at the center). Re-verify the node formula if `assign_nodes` numbering
/// ever changes; the driven-corner read (node 1) is order-independent because
/// the source is element 1.
pub fn resistor_mesh(n: usize) -> Vec<ElementSpec> {
    let step = 16i32;
    let mut v = vec![
        elm(
            1,
            "voltage",
            &[[-100, 400], [0, 0]],
            &[("maxVoltage", 10.0)],
        ),
        elm(2, "ground", &[[-100, 400]], &[]),
    ];
    let mut id = 3;
    for y in 0..=n {
        for x in 0..n {
            v.push(elm(
                id,
                "resistor",
                &[
                    [step * x as i32, step * y as i32],
                    [step * (x + 1) as i32, step * y as i32],
                ],
                &[("resistance", 1.0)],
            ));
            id += 1;
        }
    }
    for x in 0..=n {
        for y in 0..n {
            v.push(elm(
                id,
                "resistor",
                &[
                    [step * x as i32, step * y as i32],
                    [step * x as i32, step * (y + 1) as i32],
                ],
                &[("resistance", 1.0)],
            ));
            id += 1;
        }
    }
    v.push(elm(
        id,
        "ground",
        &[[step * n as i32, step * n as i32]],
        &[],
    ));
    v
}

/// A `drive` volt source, one `r` ohm resistor from the driven node, then `n`
/// diodes in series to ground along the x axis. `n` junction nodes plus the
/// driven node plus one voltage-source row, so the closure has `n + 2` rows.
/// Under the default diode model each junction sits near 0.8 V, so with drive
/// 10 V and r 1k the chain current is a few mA. The resistor is element 3,
/// so `element_currents()[2]` reads the chain current.
pub fn diode_chain(n: usize, drive: f64, r: f64) -> Vec<ElementSpec> {
    let step = 16i32;
    let mut v = vec![
        elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", drive)]),
        elm(2, "ground", &[[0, 100]], &[]),
        elm(3, "resistor", &[[0, 0], [step, 0]], &[("resistance", r)]),
    ];
    let mut id = 4;
    for k in 0..n {
        v.push(elm(
            id,
            "diode",
            &[[step * (k + 1) as i32, 0], [step * (k + 2) as i32, 0]],
            &[],
        ));
        id += 1;
    }
    v.push(elm(id, "ground", &[[step * (n + 1) as i32, 0]], &[]));
    v
}

/// A `len`x`len` resistor fan with a diode clamped onto chain 0's far corner.
/// The far corner (one resistor from ground) sits at (0, 16*(len-1)). For
/// `len` up to 12 the closure stays under the sparse threshold, so Auto gives
/// it the dense backend, and the diode is the only changing element: the
/// constant-row elimination should cache the whole passive network.
pub fn fan_with_diode(len: usize) -> Vec<ElementSpec> {
    let mut v = fan(len, len, 20.0, 1);
    v.push(elm(
        400,
        "diode",
        &[[0, 16 * (len as i32 - 1)], [0, 320]],
        &[],
    ));
    v.push(elm(401, "ground", &[[0, 320]], &[]));
    v
}
