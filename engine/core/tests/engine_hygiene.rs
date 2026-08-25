//! Engine hygiene batch: spec parameters that would silently vanish at stamp
//! time are rejected at build (review E3), the capacitor-voltage walk runs on
//! an explicit stack (E1), and non-finite stamps are surfaced instead of
//! dropped (E2). Findings and evidence live in feature/review-engine-core.md.

mod common;

use circuit_core::{Circuit, CircuitSpec};
use common::*;

/// A 10 V source across two 1k resistors: the reusable good circuit for the
/// rejection tests.
fn divider(resistance_a: f64, resistance_b: f64) -> CircuitSpec {
    CircuitSpec {
        preserve_run: false,
        elements: vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 10.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", resistance_a)],
            ),
            elm(
                3,
                "resistor",
                &[[100, 0], [100, 100]],
                &[("resistance", resistance_b)],
            ),
            elm(4, "wire", &[[100, 100], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
        ],
        options: Some(opts(1e-5, false)),
        scopes: Vec::new(),
    }
}

// ─── E3: build-time rejection of values that would stamp as nothing ───

#[test]
fn a_zero_negative_or_nan_resistance_line_is_rejected_at_build() {
    // Upstream computes 1/r and dies loudly (SimulationManager.java:1184-1188);
    // this port's stamper used to drop such a resistor silently, leaving an
    // open circuit that reported zero current. The build must reject it like
    // any other degenerate spec.
    for r in [0.0, -1000.0, f64::NAN] {
        let mut c = Circuit::new();
        let err = c
            .set_circuit(&divider(r, 1000.0))
            .expect_err("a non-positive resistance must be rejected");
        assert!(
            err.contains("resistor") && err.contains("resistance"),
            "rejection of r = {r} should name the element and parameter, got: {err}"
        );
        assert!(
            err.contains("id 2"),
            "rejection should carry the id, got: {err}"
        );
    }
}

#[test]
fn a_rejected_build_keeps_the_previous_circuit_runnable() {
    // set_circuit's per-stage atomicity: the elements are only committed once
    // every one of them built, so a rejected edit leaves the last good
    // circuit stepping and reading exactly Ohm's law.
    let mut c = Circuit::new();
    c.set_circuit(&divider(1000.0, 1000.0))
        .expect("the good divider should analyse");
    assert!(
        c.set_circuit(&divider(0.0, 1000.0)).is_err(),
        "the zero-resistance edit must be rejected"
    );
    c.run(5);
    assert!(
        close(c.element_voltages()[2], 5.0, 1e-9),
        "the kept circuit should still divide 10 V into 5 V, got {}",
        c.element_voltages()[2]
    );
}

#[test]
fn a_zero_resistance_fuse_line_is_rejected_at_build() {
    for r in [0.0, -1.0] {
        let mut c = Circuit::new();
        let err = c
            .set_circuit(&CircuitSpec {
                preserve_run: false,
                elements: vec![
                    elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 3.0)]),
                    elm(
                        2,
                        "fuse",
                        &[[0, 0], [0, 100]],
                        &[("resistance", r), ("i2t", 1e6)],
                    ),
                    elm(3, "ground", &[[0, 100]], &[]),
                ],
                options: Some(opts(1e-3, false)),
                scopes: Vec::new(),
            })
            .expect_err("a non-positive fuse resistance must be rejected");
        assert!(
            err.contains("fuse") && err.contains("id 2"),
            "rejection should name the fuse and its id, got: {err}"
        );
    }
}

#[test]
fn a_lamp_with_a_zero_rating_is_rejected_at_build() {
    // A lamp's stamped resistance is nomVoltage^2 / nomPower scaled by the
    // filament curve: a zero rating drives that quotient to zero or infinity,
    // both of which used to fall through the stamper's guard as silence.
    for (param, value) in [("nomPower", 0.0), ("nomVoltage", 0.0)] {
        let mut c = Circuit::new();
        let err = c
            .set_circuit(&CircuitSpec {
                preserve_run: false,
                elements: vec![
                    elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 3.0)]),
                    elm(
                        2,
                        "lamp",
                        &[[0, 0], [0, 100]],
                        &[("nomPower", 100.0), ("nomVoltage", 120.0), (param, value)],
                    ),
                    elm(3, "ground", &[[0, 100]], &[]),
                ],
                options: Some(opts(1e-3, false)),
                scopes: Vec::new(),
            })
            .expect_err("a zero lamp rating must be rejected");
        assert!(
            err.contains("lamp") && err.contains(param),
            "rejection should name the lamp and the offending parameter, got: {err}"
        );
    }
}

#[test]
fn a_zero_max_resistance_potentiometer_still_builds() {
    // The potentiometer is deliberately NOT rejected here: its track halves
    // floor at 1e-6 ohm in recompute(), so a zero from a hand-edited file
    // stamps as a near-short rather than vanishing, and the honest report is
    // a working element at an extreme setting, not a build failure.
    let mut c = Circuit::new();
    c.set_circuit(&CircuitSpec {
        preserve_run: false,
        elements: vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 10.0)]),
            elm(
                2,
                "potentiometer",
                &[[0, 0], [100, 0], [50, -32]],
                &[("maxResistance", 0.0), ("position", 0.5)],
            ),
            elm(3, "ground", &[[100, 0]], &[]),
            elm(4, "wire", &[[0, 100], [0, 0]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
        ],
        options: Some(opts(1e-5, false)),
        scopes: Vec::new(),
    })
    .expect("a floored potentiometer must still analyse");
    c.run(5);
    let amps = c.element_currents();
    assert!(amps[1].is_finite(), "track current must stay finite");
}

// ─── E1: the capacitor-voltage walk on an explicit stack ───

/// A ground symbol, a chain of `n` DC voltage sources stacked end to end, and
/// a capacitor from the top of the chain to ground. The capacitor's CAP_V
/// walk can only cross ideal capacitors and voltage sources, so it enters the
/// chain and traverses all of it before concluding there is no loop: the
/// traversal depth equals the chain length. Nothing in the circuit is
/// solvable-interesting; it exists to drive the walk deep.
fn deep_source_chain(n: usize) -> CircuitSpec {
    let mut elements = vec![elm(1, "ground", &[[-16, 0]], &[])];
    let mut id = 2u32;
    for k in 0..n {
        elements.push(elm(
            id,
            "voltage",
            &[[0, 16 * k as i32], [0, 16 * (k + 1) as i32]],
            &[("maxVoltage", 0.0)],
        ));
        id += 1;
    }
    elements.push(elm(
        id,
        "capacitor",
        &[[0, 16 * n as i32], [32, 16 * n as i32]],
        &[],
    ));
    id += 1;
    elements.push(elm(id, "ground", &[[32, 16 * n as i32]], &[]));
    CircuitSpec {
        preserve_run: false,
        elements,
        options: Some(opts(5e-6, false)),
        scopes: Vec::new(),
    }
}

#[test]
fn a_deep_cap_v_chain_walks_without_recursing_the_stack_away() {
    // Before the explicit stack, this walk was the one recursive traversal in
    // the module, and its depth equalled the traversed chain length:
    // MAX_MATRIX_ROWS admits 100k nodes against a ~1 MiB wasm stack, so a few
    // thousand series capacitors aborted instead of erroring. The test runs
    // on a deliberately small thread stack so the recursion (or its absence)
    // is visible on native too: with recursion, 4000 frames do not fit.
    const CHAIN: usize = 4000;
    let result = std::thread::Builder::new()
        .stack_size(256 * 1024)
        .spawn(|| -> Result<(bool, usize, Vec<f64>), String> {
            let mut c = Circuit::new();
            c.set_circuit(&deep_source_chain(CHAIN))?;
            let report = c.run(10);
            Ok((report.converged, c.node_count(), c.node_voltages().to_vec()))
        })
        .expect("test thread spawns")
        .join()
        .expect("deep walk must not panic")
        .expect("the deep circuit must analyse");
    let (converged, nodes, volts) = result;
    assert!(converged, "the chained circuit must step");
    // n sources give n + 1 distinct non-ground nodes plus the reference.
    assert_eq!(nodes, CHAIN + 2);
    assert!(
        volts.iter().all(|v| v.is_finite()),
        "every solved voltage must be finite"
    );
}

#[test]
fn the_walk_still_damps_exactly_one_of_a_parallel_ideal_pair() {
    // Visit-order semantics are reachability here, so the conversion to an
    // explicit stack must not move the damping decision: of two parallel
    // ideal capacitors, exactly one gains a series resistance (one internal
    // node), and the charge shared between 1 V and 0 V settles on the common
    // node at the charge-weighted average, 0.5 V.
    let dt = 5e-9;
    let mut c = parallel_ideal_pair(dt);
    assert_eq!(c.node_count(), 3, "exactly one capacitor may be damped");
    c.run(200);
    let v = c.node_voltages()[1];
    assert!(
        close(v, 0.5, 1e-6),
        "the pair should settle at the charge-weighted 0.5 V, got {v}"
    );
}

// ─── E2: a non-finite stamp is surfaced, never dropped into silence ───

#[test]
fn a_non_finite_current_source_value_is_surfaced_at_build() {
    // The stamper's guard used to return early on a non-finite value, so the
    // contribution vanished, GMIN pinned the orphaned node, and the circuit
    // solved to a plausible wrong answer nothing downstream could see. The
    // build must now refuse it loudly.
    // The source sits in parallel with a resistor, so its terminals have a
    // DC path and the element stamps as a real current source rather than
    // falling into the broken-source stand-in resistor.
    let mut c = Circuit::new();
    let err = c
        .set_circuit(&CircuitSpec {
            preserve_run: false,
            elements: vec![
                elm(1, "resistor", &[[0, 0], [0, 16]], &[("resistance", 1000.0)]),
                elm(2, "current", &[[0, 0], [0, 16]], &[("current", f64::NAN)]),
                elm(3, "ground", &[[0, 16]], &[]),
            ],
            options: Some(opts(1e-5, false)),
            scopes: Vec::new(),
        })
        .expect_err("a NaN source current must not load");
    assert!(
        err.contains("non-finite") && err.contains("id 2"),
        "rejection should name the element and say why, got: {err}"
    );
}

#[test]
fn a_lamp_computing_an_out_of_range_resistance_fails_the_step_loudly() {
    // A hand-edited `temp` token below about 190 K drives the filament curve
    // negative. The stamper's resistor guard drops such a stamp, which used
    // to make the lamp simply vanish from the matrix mid-run; now the step
    // fails and names the element instead of committing a plausible lie.
    let mut c = Circuit::new();
    c.set_circuit(&CircuitSpec {
        preserve_run: false,
        elements: vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 10.0)]),
            elm(2, "lamp", &[[0, 0], [0, 100]], &[("temp", 150.0)]),
            elm(3, "ground", &[[0, 100]], &[]),
        ],
        options: Some(opts(1e-3, false)),
        scopes: Vec::new(),
    })
    .expect("the lamp's bad temperature cannot be seen until it stamps");
    let report = c.run(1);
    assert!(!report.converged, "the step must not report success");
    let msg = report.error.expect("the failure must carry a message");
    assert!(
        msg.contains("non-finite") || msg.contains("dropped"),
        "the message should explain the dropped stamp, got: {msg}"
    );
    assert!(
        msg.contains("lamp") && msg.contains("id 2"),
        "the message should name the offending element, got: {msg}"
    );
    assert!(c.error().is_some(), "the side channel must carry it too");
}
