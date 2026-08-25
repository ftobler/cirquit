//! Engine hygiene batch: spec parameters that would silently vanish at stamp
//! time are rejected at build (review E3), the capacitor-voltage walk runs on
//! an explicit stack (E1), and non-finite stamps are surfaced instead of
//! dropped (E2). Findings and evidence live in feature/review-engine-core.md.

mod common;

use common::*;
use circuit_core::{Circuit, CircuitSpec};

/// A 10 V source across two 1k resistors: the reusable good circuit for the
/// rejection tests.
fn divider(resistance_a: f64, resistance_b: f64) -> CircuitSpec {
    CircuitSpec {
        preserve_run: false,
        elements: vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 10.0)]),
            elm(2, "resistor", &[[0, 0], [100, 0]], &[("resistance", resistance_a)]),
            elm(3, "resistor", &[[100, 0], [100, 100]], &[("resistance", resistance_b)]),
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
        assert!(err.contains("id 2"), "rejection should carry the id, got: {err}");
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
                    elm(2, "fuse", &[[0, 0], [0, 100]], &[("resistance", r), ("i2t", 1e6)]),
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
