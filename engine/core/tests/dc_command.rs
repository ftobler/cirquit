//! The one-shot Find DC Operating Point command: found / degraded outcomes
//! through the option-true reset dance, and where the singular cases land.

use circuit_core::{Circuit, CircuitSpec, DcOutcome, ElementSpec};

mod common;
use common::*;

/// The divider plus capacitor the found case runs against, built with the
/// DC option OFF so only the command itself can solve.
fn rc_divider() -> Circuit {
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
                &[("capacitance", 1e-6), ("initialVoltage", 0.0)],
            ),
            elm(4, "wire", &[[100, 100], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
        ],
        opts(1e-6, false),
    )
}

fn token<'a>(toks: &'a [(String, f64)], name: &str) -> &'a f64 {
    toks.iter()
        .find(|(k, _)| k == name)
        .map(|(_, v)| v)
        .expect("token missing")
}

#[test]
fn rc_operating_point_found_via_command() {
    let c = &mut rc_divider();
    c.run(10);
    assert!(c.time() > 0.0, "the run should have moved the clock");
    assert!(!c.options().dc_operating_point);

    // The command must solve even though the option is off, rewind the clock
    // like any reset, and put the option back the way it found it.
    let outcome = c.find_dc_operating_point();
    assert_eq!(outcome, Ok(DcOutcome::Found));
    assert_eq!(c.time(), 0.0);
    assert!(!c.options().dc_operating_point);

    // Under the DC stamp the capacitor is a 1e8 ohm stand-in for an open, so
    // the junction sits at the divider's 10 V less the tiny open's drop:
    // 10 * 1e8 / (1e3 + 1e8).
    let expected = 10.0 * 1e8 / (1e3 + 1e8);
    let va = c.node_voltages()[2];
    assert!(close(va, expected, 1e-6), "junction read {va}");

    // The solve commits its reactive state: the capacitor's plate voltage is
    // the solved steady value, so the transient resumes charged.
    let vd = *token(&c.state_tokens()[2], "voltDiff");
    assert!(close(vd, expected, 1e-6), "committed charge read {vd}");
}

#[test]
fn linear_singular_errors() {
    // Two ideal sources fighting over one node carry two identical voltage
    // constraint rows with different values, the classic singular matrix.
    // As a linear build it never reaches the command: set_circuit factors
    // linear matrices eagerly and rejects the circuit up front, with the
    // same engine message the command's Err arm carries to the banner.
    let singular = || {
        vec![
            elm(1, "rail", &[[0, 0]], &[("maxVoltage", 5.0)]),
            elm(2, "voltage", &[[0, 0], [0, 100]], &[("maxVoltage", 10.0)]),
            elm(3, "ground", &[[0, 100]], &[]),
        ]
    };
    let mut c = Circuit::new();
    let err = c
        .set_circuit(&CircuitSpec {
            preserve_run: false,
            elements: singular(),
            options: Some(opts(1e-6, false)),
            scopes: Vec::new(),
        })
        .expect_err("a singular linear pair must be rejected at build");
    assert!(err.contains("no solution"), "unexpected build error: {err}");

    // Wrapped in one nonlinear element the same singular pair builds (the
    // eager factor is skipped) and reaches the command. The failed solve
    // lands on the degradation path there: the guard cannot tell a singular
    // closure from an ordinary non-convergence once any nonlinear element
    // exists, which is exactly upstream's silent-degradation shape.
    let mut wrapped = singular();
    wrapped.push(elm(4, "diode", &[[0, 0], [100, 0]], &[]));
    wrapped.push(elm(5, "ground", &[[100, 0]], &[]));
    let mut c = Circuit::new();
    c.set_circuit(&CircuitSpec {
        preserve_run: false,
        elements: wrapped,
        options: Some(opts(1e-5, false)),
        scopes: Vec::new(),
    })
    .expect("the nonlinear-wrapped pair should build");
    let outcome = c.find_dc_operating_point();
    assert_eq!(outcome, Ok(DcOutcome::Degraded));

    // Degradation leaves the uncharged start, not the last iterate.
    assert!(c.node_voltages().iter().all(|&v| v == 0.0));
}

#[test]
fn nonlinear_degradation_equals_reset() {
    // A current source pushing into a node whose only load is a reverse
    // diode has no operating point: Newton diverges. The command must report
    // that distinctly and leave the circuit exactly as a plain reset would:
    // every element reset, node voltages cleared.
    let specs = || {
        vec![
            elm(1, "current", &[[0, 0], [100, 0]], &[("current", 1e-2)]),
            elm(2, "diode", &[[200, 0], [100, 0]], &[]),
            elm(3, "ground", &[[0, 0]], &[]),
            elm(4, "ground", &[[200, 0]], &[]),
        ] as Vec<ElementSpec>
    };
    let mut commanded = build(specs(), opts(1e-5, false));
    commanded.run(5);
    let outcome = commanded.find_dc_operating_point();
    assert_eq!(outcome, Ok(DcOutcome::Degraded));

    let mut plain = build(specs(), opts(1e-5, false));
    plain.reset();

    assert_eq!(
        commanded.node_voltages(),
        plain.node_voltages(),
        "degraded state must match a plain reset"
    );
    assert!(commanded.node_voltages().iter().all(|&v| v == 0.0));
    assert_eq!(commanded.element_voltages(), plain.element_voltages());

    // And the transient continues identically from either starting point.
    let a = commanded.run(1);
    let b = plain.run(1);
    assert_eq!(a.converged, b.converged);
    assert_eq!(a.error, b.error);
}

#[test]
fn empty_circuit_is_a_no_op() {
    // Nothing to solve: the command converges trivially and leaves the
    // option restored.
    let c = &mut build(Vec::new(), opts(1e-6, false));
    let outcome = c.find_dc_operating_point();
    assert_eq!(outcome, Ok(DcOutcome::Found));
    assert_eq!(c.time(), 0.0);
    assert!(!c.options().dc_operating_point);
    assert!(c.error().is_none());
}
