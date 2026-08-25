//! Lifecycle-hygiene regressions in the Circuit object itself: a rejected
//! build settles like the documented error discipline says, diagnostics are
//! owned by the pass that produces them, and the adaptive timestep reaches
//! the floor upstream reaches.

use circuit_core::matrix::MAX_MATRIX_ROWS;
use circuit_core::{Circuit, CircuitSpec, ElementSpec};

mod common;
use common::*;

/// A 10 V source into a 1k/1k divider with both ends grounded: five
/// elements, one closure, midpoint at 5 V. Enough of a live circuit that
/// "still runs what it had" means real work, not a no-op.
fn divider() -> CircuitSpec {
    CircuitSpec {
        preserve_run: false,
        elements: vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 10.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(
                3,
                "resistor",
                &[[100, 0], [100, 100]],
                &[("resistance", 1000.0)],
            ),
            elm(4, "ground", &[[0, 100]], &[]),
            elm(5, "ground", &[[100, 100]], &[]),
        ],
        options: Some(opts(1e-6, false)),
        scopes: Vec::new(),
    }
}

#[test]
fn rejected_set_circuit_keeps_the_previous_circuit_running() {
    let mut c = Circuit::new();
    c.set_circuit(&divider()).expect("the divider should build");
    assert_eq!(c.element_count(), 5);

    // Every case fails partway through the build loop, after the element
    // list, ids and index have started filling: an unknown kind, a post
    // count that does not match the model, and a duplicate id. Each used
    // to commit its partial list while the closures and node voltages
    // still described the old circuit, so the next run stepped against a
    // mixture of the two.
    let head = || {
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 10.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
        ]
    };
    let mut unknown_kind = head();
    unknown_kind.push(elm(9, "nope", &[[0, 0], [64, 0]], &[]));
    let mut bad_post_count = head();
    bad_post_count.push(elm(9, "ground", &[[0, 0], [64, 0]], &[]));
    let mut duplicate_id = head();
    duplicate_id.push(elm(
        2,
        "resistor",
        &[[200, 0], [300, 0]],
        &[("resistance", 1000.0)],
    ));
    let cases: Vec<Vec<ElementSpec>> = vec![unknown_kind, bad_post_count, duplicate_id];

    for bad in &cases {
        let spec = CircuitSpec {
            preserve_run: false,
            elements: bad.clone(),
            options: Some(opts(1e-6, false)),
            scopes: Vec::new(),
        };
        c.set_circuit(&spec)
            .expect_err("a malformed element list must be rejected");

        // The accepted circuit survives untouched and still solves its own
        // operating point, rather than stepping against a half-built list.
        assert_eq!(c.element_count(), 5);
        assert_eq!(c.element_ids(), &[1, 2, 3, 4, 5]);
        let report = c.run(1);
        assert!(
            report.converged,
            "run after a rejected build failed: {:?}",
            report.error
        );
        assert!(
            close(c.node_voltages()[2], 5.0, 1e-9),
            "midpoint read {}",
            c.node_voltages()[2]
        );
    }
}

#[test]
fn an_element_list_over_the_terminal_limit_is_rejected_before_reserving() {
    // The three build reservations used to size themselves from
    // spec.elements.len() before any bound check ran, so a spec claiming an
    // absurd count died in the allocator instead of failing validation. The
    // guard is a deliberate pathological-input rejection rather than a tight
    // bound: terminal-carrying kinds are covered by assign_nodes' limit,
    // annotation-only kinds by the cap itself. It rejects with a message,
    // and because it sits before anything commits, per-stage atomicity keeps
    // both the previous circuit and its options in force.
    let mut c = Circuit::new();
    c.set_circuit(&divider()).expect("the divider should build");
    let bloated = CircuitSpec {
        preserve_run: false,
        elements: vec![elm(1, "ground", &[[0, 0]], &[]); MAX_MATRIX_ROWS + 1],
        options: Some(opts(2e-6, false)),
        scopes: Vec::new(),
    };
    let err = c
        .set_circuit(&bloated)
        .expect_err("an over-limit element list must be rejected");
    assert!(
        err.contains("too large") && err.contains("elements"),
        "rejection should say why, got: {err}"
    );
    assert_eq!(c.element_count(), 5);
    assert_eq!(
        c.options().time_step,
        1e-6,
        "the rejected spec's options must not commit either"
    );
    assert!(
        c.run(1).converged,
        "the kept circuit must still step after a rejected oversized spec"
    );
}

/// A closed series loop with no ground symbol anywhere, so every analysis
/// pass re-derives the reference from the first node and re-raises the
/// no-ground notice.
fn groundless_loop() -> CircuitSpec {
    CircuitSpec {
        preserve_run: false,
        elements: vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 10.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(3, "switch", &[[100, 0], [100, 100]], &[("position", 0.0)]),
            elm(4, "wire", &[[100, 100], [0, 100]], &[]),
        ],
        options: Some(opts(1e-6, false)),
        scopes: Vec::new(),
    }
}

#[test]
fn switch_throws_do_not_grow_the_warning_vector() {
    let mut c = Circuit::new();
    c.set_circuit(&groundless_loop())
        .expect("the groundless loop should build");
    assert_eq!(c.warnings().len(), 1, "expected the no-ground notice");

    // Every throw re-runs assign_nodes through reanalyze, which used to
    // append a fresh copy of the same notice; ten toggles left eleven.
    // The vector belongs to the latest analysis pass, so each throw
    // replaces rather than appends.
    for k in 0..10 {
        assert!(c.set_state(3, i32::from(k % 2 == 0)));
    }
    assert_eq!(c.warnings().len(), 1);
    assert!(c.warnings()[0].contains("No ground symbol"));
}

#[test]
fn resets_do_not_grow_the_warning_vector() {
    // A grounded divider plus a resistor whose both posts dangle: its node
    // has no path to ground, so every analysis pass pins it with GMIN and
    // raises the floating-node notice.
    let spec = CircuitSpec {
        preserve_run: false,
        elements: vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 10.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(3, "ground", &[[0, 100]], &[]),
            elm(
                4,
                "resistor",
                &[[500, 0], [600, 0]],
                &[("resistance", 1000.0)],
            ),
        ],
        options: Some(opts(1e-6, false)),
        scopes: Vec::new(),
    };
    let mut c = Circuit::new();
    c.set_circuit(&spec)
        .expect("the dangling tail should build");
    assert_eq!(c.warnings().len(), 1, "expected the floating-node notice");
    assert!(c.warnings()[0].contains("floating"));

    // reset() re-runs allocate_and_stamp, which used to append another
    // copy of the notice on every call; ten resets left eleven.
    for _ in 0..10 {
        c.reset();
    }
    assert_eq!(c.warnings().len(), 1);
}

#[test]
fn the_floor_timestep_is_attempted_before_giving_up() {
    // A compliance crossing whose endpoint sits deep in the tanh roll-off
    // needs more Newton iterations than the budget of 4 allows at 5e-6 and
    // again at 2.5e-6, and settles at the fourth attempt value, 1.25e-6.
    // With min_time_step = 1.25e-6 the old strict shrink guard refused
    // that last halving: 2.5e-6 was the smallest step ever attempted, it
    // got the relaxed 5000 budget, and the run recovered there, so no step
    // ever reported two rejections. Upstream halves first and stops only
    // when the halved value drops below the minimum
    // (SimulationManager.java:1391-1400), so the floor value itself gets
    // tried, and the corrected guard reproduces that: two rejections,
    // every halving counted, committing at exactly the floor.
    let mut c = build(compliance_circuit(0.0), adaptive_opts(5e-6, 1.25e-6, 4));
    // Crossings recur over the 20 kHz period; 200 steps span plenty.
    let mut floored = None;
    for _ in 0..200 {
        let report = c.run(1);
        assert!(
            report.converged,
            "a halving chain must end in a commit: {:?}",
            report.error
        );
        if report.rejected_steps >= 2 {
            floored = Some(report);
            break;
        }
    }
    let report = floored.expect("no step ever walked both halvings down");
    assert_eq!(
        report.rejected_steps, 2,
        "both halvings should count as rejected attempts"
    );
    assert!(
        close(report.time_step, 1.25e-6, 1e-15),
        "the committed step was {}",
        report.time_step
    );
}
