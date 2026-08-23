//! Lifecycle-hygiene regressions in the Circuit object itself: a rejected
//! build settles like the documented error discipline says, diagnostics are
//! owned by the pass that produces them, and the adaptive timestep reaches
//! the floor upstream reaches.

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
