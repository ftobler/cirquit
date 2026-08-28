//! Engine hygiene batch: spec parameters that would silently vanish at stamp
//! time are rejected at build (review E3), the capacitor-voltage walk runs on
//! an explicit stack (E1), and non-finite stamps are surfaced instead of
//! dropped (E2). Findings and evidence live in feature/review-engine-core.md.

mod common;

use circuit_core::matrix::MAX_MATRIX_ROWS;
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
fn a_zero_negative_or_nan_total_width_memristor_is_rejected_at_build() {
    // A totalWidth that is non-positive or non-finite makes the dopant blend
    // dopeWidth/totalWidth a 0/0 (NaN) division, stamping a NaN resistance
    // that used to vanish silently. The build must reject it like any other
    // degenerate spec, naming the element and the offending parameter.
    for tw in [0.0, -10.0, f64::NAN] {
        let mut c = Circuit::new();
        let err = c
            .set_circuit(&CircuitSpec {
                preserve_run: false,
                elements: vec![
                    elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 5.0)]),
                    elm(
                        2,
                        "memristor",
                        &[[0, 0], [0, 100]],
                        &[("totalWidth", tw), ("rOn", 100.0), ("rOff", 16000.0)],
                    ),
                    elm(3, "ground", &[[0, 100]], &[]),
                ],
                options: Some(opts(1e-5, false)),
                scopes: Vec::new(),
            })
            .expect_err("a non-positive totalWidth must be rejected");
        assert!(
            err.contains("memristor") && err.contains("totalWidth"),
            "rejection of totalWidth = {tw} should name the element and parameter, got: {err}"
        );
        assert!(
            err.contains("id 2"),
            "rejection should carry the id, got: {err}"
        );
    }
}

#[test]
fn a_valid_total_width_memristor_stamps_finite_resistance() {
    // The guard only rejects degenerate widths: a healthy memristor still
    // builds and stamps a finite (never NaN) resistance from the dopant blend.
    let mut c = Circuit::new();
    c.set_circuit(&CircuitSpec {
        preserve_run: false,
        elements: vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 5.0)]),
            elm(
                2,
                "memristor",
                &[[0, 0], [0, 100]],
                &[("totalWidth", 10e-9), ("rOn", 100.0), ("rOff", 16000.0)],
            ),
            elm(3, "ground", &[[0, 100]], &[]),
        ],
        options: Some(opts(1e-5, false)),
        scopes: Vec::new(),
    })
    .expect("a healthy memristor must analyse");
    c.run(5);
    assert!(
        c.element_currents()[1].is_finite(),
        "memristor current must stay finite, got {}",
        c.element_currents()[1]
    );
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

// ─── StepError routing in the DC phase ───

#[test]
fn a_refused_stamp_during_the_dc_solve_is_an_error_not_a_degraded_start() {
    // solve_operating_point used to collapse every StepError through is_ok(),
    // so a do_step refusal during the operating-point solve was misrouted
    // into the silent-degradation path: elements reset, board cleared, no
    // message. A refused stamp is a condition of the circuit, so it must
    // surface verbatim the way the transient loop surfaces it, and unlike a
    // singular matrix it must not read as "no solution".
    // The voltage-limited current source stamps nothing in the constant pass
    // (its companion lives entirely in do_step), so poisoning its current by
    // a live edit sails past restamp and detonates inside the DC Newton
    // iteration.
    let mut c = Circuit::new();
    c.set_circuit(&CircuitSpec {
        preserve_run: false,
        elements: vec![
            elm(1, "resistor", &[[0, 0], [0, 16]], &[("resistance", 1000.0)]),
            elm(
                2,
                "current",
                &[[0, 0], [0, 16]],
                &[("current", 0.01), ("maxVoltage", 5.0)],
            ),
            elm(3, "ground", &[[0, 16]], &[]),
            elm(4, "ground", &[[0, 0]], &[]),
        ],
        options: Some(opts(1e-5, true)),
        scopes: Vec::new(),
    })
    .expect("the healthy circuit should analyse");
    assert!(c.set_param(2, "current", f64::NAN), "live edit accepted");

    c.reset();
    let msg = c.error().expect("the DC solve must surface the refusal");
    assert!(
        msg.contains("non-finite") && msg.contains("id 2"),
        "the message should name the element and say why, got: {msg}"
    );
    assert!(
        !msg.contains("no solution"),
        "a refused stamp must not read as a singular circuit, got: {msg}"
    );
}

// ─── B1: a rejecting adaptive schedule converges without wasted iterations ───

/// A 10 V square through 200 ohm into the mosfet's body diode: source post
/// driven, drain and gate grounded. The diode is the stiff element here: on
/// every rising edge Newton must climb its exponential knee to the clamp
/// level, which a two-pass budget cannot settle, so each edge rejects
/// deterministically (`try_step` floors a nonlinear circuit's budget at two
/// passes so the confirming subiteration exists, circuit.rs's `budget.max(2)`
/// guard) and halves.
#[test]
fn mosfet_rejecting_schedule_converges_without_wasted_iterations() {
    // restore_committed rewinds the solution vector and every element's
    // Newton anchors. The MOSFET's embedded body diode owns its own anchor,
    // invisible to that walk: left stale, the retry's first stamp compares
    // against the failed attempt's final junction iterate (measured at
    // hundreds of mV away from the committed state on this schedule), one
    // spurious `not_converged` past the 10 mV bar plus one mislimiting step
    // per retry. The JFET already re-anchors its identical gate diode; this
    // pins the MOSFET to the same discipline without moving any converged
    // result.
    //
    // A plain common-source stage also rejects under this budget, but there
    // the body diode idles near zero volts and its stale anchor never trips
    // the bar, masking the defect; the diode must be the element doing the
    // work for the wasted passes to show up in the count.
    let mut c = build(
        vec![
            elm(
                1,
                "voltage",
                &[[0, 100], [0, 0]],
                &[
                    ("waveform", 2.0),
                    ("frequency", 1000.0),
                    ("maxVoltage", 10.0),
                ],
            ),
            elm(2, "resistor", &[[0, 0], [100, 0]], &[("resistance", 200.0)]),
            elm(
                3,
                "mosfet",
                &[[200, 0], [100, 0], [100, 100]],
                &[("pnp", 1.0), ("threshold", 1.5)],
            ),
            elm(4, "ground", &[[100, 100]], &[]),
            elm(5, "ground", &[[200, 0]], &[]),
            elm(6, "ground", &[[0, 100]], &[]),
        ],
        adaptive_opts(5e-6, 1.25e-6, 1),
    );
    let report = c.run(120);
    assert!(
        report.converged,
        "the rejecting schedule must still converge: {:?}",
        report.error
    );
    assert!(
        report.rejected_steps >= 1,
        "the schedule must actually reject steps to exercise the rewind"
    );
    // Recorded from the fixed build: 120 steps cost 262 Newton passes. With
    // the stale anchor each of the four edges' retries burns extra passes;
    // the unfixed build costs 264, above this bound.
    assert!(
        report.iterations <= 262,
        "120 steps burned {} Newton passes, above the fixed-build bound",
        report.iterations
    );

    // Analytic companion at DC: with the drive held high the diode clamps
    // the node where the resistor current and the Shockley law agree. For
    // the default model (Is = 1/(exp(fwdrop/vscale)-1), vscale = 2*vt) that
    // is the hand-solved root of (10 - v)/200 = Is*(exp(v/vscale)-1):
    // v ~= 0.6475 V at I ~= 46.8 mA.
    let dc = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 10.0)]),
            elm(2, "resistor", &[[0, 0], [100, 0]], &[("resistance", 200.0)]),
            elm(
                3,
                "mosfet",
                &[[200, 0], [100, 0], [100, 100]],
                &[("pnp", 1.0), ("threshold", 1.5)],
            ),
            elm(4, "ground", &[[100, 100]], &[]),
            elm(5, "ground", &[[200, 0]], &[]),
            elm(6, "ground", &[[0, 100]], &[]),
        ],
        opts(5e-6, true),
    );
    dc.run(20);
    // The resistor reads supply minus clamp level.
    let clamp_level = 10.0 - dc.element_voltages()[1];
    assert!(
        close(clamp_level, 0.6475, 2e-3),
        "the body diode must clamp the node on its Shockley knee, got {clamp_level}"
    );
}

// ─── Composite child expressions are load-checked, never aborts ───

/// A one-child composite whose vccs child carries `expr` as its dump-token
/// expression (the fields after flags and input count), the shape a
/// hand-edited `.` model line or corrupted save produces.
fn composite_with_child_expr(expr: &str) -> CircuitSpec {
    let model = serde_json::json!({
        "model": "VCCSElm 1 2 3",
        "external": [1, 2, 3],
        "dumps": [format!("0_1_{expr}")],
    });
    CircuitSpec {
        preserve_run: false,
        elements: vec![{
            let mut e = elm(1, "composite", &[[0, 0], [100, 0], [100, 100]], &[]);
            e.model = Some(model.to_string());
            e
        }],
        options: Some(opts(1e-5, false)),
        scopes: Vec::new(),
    }
}

#[test]
fn composite_child_bad_expression_is_a_named_build_error() {
    // A corrupt child-dump expression used to panic! and take the whole wasm
    // instance with it; it must refuse the load instead, naming the child.
    let mut c = Circuit::new();
    let err = c
        .set_circuit(&composite_with_child_expr("not an expression"))
        .expect_err("an unparseable child expression must fail the build");
    assert!(
        err.contains("unparseable expression"),
        "rejection should say why, got: {err}"
    );
    assert!(
        err.contains("vccs"),
        "rejection should name the offending child kind, got: {err}"
    );
}

#[test]
fn a_refused_composite_leaves_the_engine_working() {
    // set_circuit commits nothing on a rejected element, so the same engine
    // object keeps building circuits after the refusal.
    let mut c = Circuit::new();
    assert!(c.set_circuit(&composite_with_child_expr("?")).is_err());
    c.set_circuit(&divider(1000.0, 1000.0))
        .expect("the engine must keep building circuits afterwards");
    c.run(3);
    assert!(
        close(c.element_voltages()[2], 5.0, 1e-9),
        "the fresh divider should divide 10 V into 5 V, got {}",
        c.element_voltages()[2]
    );
}

// ─── Composite child counts are bounded ahead of the global row gate ───

/// A single generic composite whose model string holds `children` two-post
/// resistor lines sharing one pair of model nodes. Every accepted child adds
/// exactly 2 terminal slots to `from_model`'s budget, so the count that
/// crosses [`MAX_MATRIX_ROWS`] is exact and predictable.
fn sized_composite_spec(children: usize) -> CircuitSpec {
    let mut model = String::new();
    for _ in 0..children {
        model.push_str("ResistorElm 3 4\r");
    }
    let m = serde_json::json!({
        "model": model,
        "external": [1, 2],
        "dumps": [],
    });
    CircuitSpec {
        preserve_run: false,
        elements: vec![{
            let mut e = elm(1, "composite", &[[0, 0], [100, 0]], &[]);
            e.model = Some(m.to_string());
            e
        }],
        options: Some(opts(1e-5, false)),
        scopes: Vec::new(),
    }
}

#[test]
fn a_composite_model_exactly_at_the_row_limit_still_builds() {
    // 2 posts + 2 slots per child: 49,999 children land on MAX_MATRIX_ROWS
    // exactly, so a boundary-legal composite must go through, build and step.
    // Sharing one node pair keeps the eventual matrix tiny while the child
    // count rides the boundary, which is precisely the shape the budget has
    // to admit.
    let children = (MAX_MATRIX_ROWS - 2) / 2;
    assert_eq!(2 + 2 * children, MAX_MATRIX_ROWS);
    let mut c = Circuit::new();
    c.set_circuit(&sized_composite_spec(children))
        .expect("a composite exactly at the row limit must build");
    c.run(1);
}

#[test]
fn a_hostile_composite_model_is_refused_once_past_the_row_limit() {
    // One `.` line used to buy unbounded child construction: the composite
    // enters set_circuit as ONE spec element, so the global row gate only saw
    // it after every child existed. The tally must stop the build at the
    // first crossing, naming the element, and the reported need must be the
    // first over-limit value (100,002), not the full 400k the model names,
    // proving construction halted early instead of running to completion.
    let mut c = Circuit::new();
    let err = c
        .set_circuit(&sized_composite_spec(200_000))
        .expect_err("a model past the row limit must be refused");
    assert!(
        err.contains("element 'composite' (id 1)")
            && err.contains("exceeds its terminal-slots budget"),
        "rejection should name the element and the budget, got: {err}"
    );
    assert!(
        err.contains("its terminal slots total 100002"),
        "rejection should report the first crossing, not the full tally, got: {err}"
    );
}

#[test]
fn composite_child_good_expression_still_builds_and_runs() {
    // Positive control over the same model shape: a valid expression builds
    // and steps cleanly.
    let mut c = Circuit::new();
    c.set_circuit(&composite_with_child_expr("a*0"))
        .expect("a valid child expression must build");
    let report = c.run(3);
    assert!(report.converged, "did not converge: {:?}", report.error);
}
