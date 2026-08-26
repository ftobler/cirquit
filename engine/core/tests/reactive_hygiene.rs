//! Reactive-value hygiene batch: file-borne non-positive capacitance,
//! inductance and transformer winding values are rejected at build instead
//! of stamping an active negative resistance (review 2026-08-26 finding 1).
//! The live-edit path already refuses these values (capacitor.rs/inductor.rs
//! `set_param` require > 0); this pins the same rule onto the load path.

mod common;

use circuit_core::{Circuit, CircuitSpec};
use common::*;

/// A 10 V source behind 1 k into a reactive element to ground: the reusable
/// shape for the rejection tests.
fn rc_like(kind: &str, params: &[(&str, f64)]) -> CircuitSpec {
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
            elm(3, kind, &[[100, 0], [100, 100]], params),
            elm(4, "wire", &[[100, 100], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
        ],
        options: Some(opts(1e-6, false)),
        scopes: Vec::new(),
    }
}

fn transformer_like(inductance: f64, ratio: f64) -> CircuitSpec {
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
                "transformer",
                &[[100, 0], [200, 0], [100, 100], [200, 100]],
                &[
                    ("inductance", inductance),
                    ("ratio", ratio),
                    ("couplingCoef", 0.999),
                ],
            ),
            elm(4, "ground", &[[0, 100]], &[]),
        ],
        options: Some(opts(1e-6, false)),
        scopes: Vec::new(),
    }
}

// ─── Build-time rejection of non-positive reactive values ───

#[test]
fn a_zero_negative_or_nan_capacitance_line_is_rejected_at_build() {
    // A negative companion conductance stamps as an active negative
    // resistance whose trapezoidal step is positive feedback: node voltages
    // grow until the scopes report divergence, with nothing naming the
    // element. Zero is silent too: the stamper skips g == 0, so the part
    // became an invisible open. Both must be refused like upstream's loud
    // failure would be.
    for c_value in [0.0, -1e-6, f64::NAN] {
        let mut c = Circuit::new();
        let err = c
            .set_circuit(&rc_like(
                "capacitor",
                &[("capacitance", c_value), ("initialVoltage", 0.0)],
            ))
            .expect_err("a non-positive capacitance must be rejected");
        assert!(
            err.contains("capacitor") && err.contains("capacitance"),
            "rejection of C = {c_value} should name the element and parameter, got: {err}"
        );
        assert!(
            err.contains("id 3"),
            "rejection should carry the id, got: {err}"
        );
    }
}

#[test]
fn a_polarized_capacitor_line_names_its_own_kind_when_rejected() {
    let mut c = Circuit::new();
    let err = c
        .set_circuit(&rc_like("polarizedCapacitor", &[("capacitance", -1e-6)]))
        .expect_err("a non-positive polarised capacitance must be rejected");
    assert!(
        err.contains("polarizedCapacitor") && err.contains("capacitance") && err.contains("id 3"),
        "rejection should name the polarised kind, got: {err}"
    );
}

#[test]
fn a_zero_negative_or_nan_inductance_line_is_rejected_at_build() {
    // dt/L through a negative L stamps the same active negative resistance;
    // the plan's value: `l ... -0.5`.
    for l_value in [0.0, -0.5, f64::NAN] {
        let mut c = Circuit::new();
        let err = c
            .set_circuit(&rc_like("inductor", &[("inductance", l_value)]))
            .expect_err("a non-positive inductance must be rejected");
        assert!(
            err.contains("inductor") && err.contains("inductance"),
            "rejection of L = {l_value} should name the element and parameter, got: {err}"
        );
        assert!(
            err.contains("id 3"),
            "rejection should carry the id, got: {err}"
        );
    }
}

#[test]
fn a_transformer_with_a_non_positive_base_inductance_is_rejected_at_build() {
    // Every winding's self-inductance is n_i^2 * L, so a non-positive base
    // inductance makes each winding a negative or zero inductor: winding 0
    // is the plan's case.
    for l_value in [0.0, -4.0] {
        let mut c = Circuit::new();
        let err = c
            .set_circuit(&transformer_like(l_value, 2.0))
            .expect_err("a non-positive transformer inductance must be rejected");
        assert!(
            err.contains("transformer") && err.contains("inductance") && err.contains("id 3"),
            "rejection of L = {l_value} should name the element and parameter, got: {err}"
        );
    }
}

#[test]
fn a_custom_transformer_with_a_non_positive_inductance_is_rejected_at_build() {
    // The 406 row shares the base inductance token, so its constructor must
    // refuse it the same way.
    let mut e = elm(
        3,
        "customTransformer",
        &[[100, 0], [150, 0], [100, 100], [150, 100]],
        &[("inductance", 0.0)],
    );
    e.label = Some("1,1:1".into());
    let mut c = Circuit::new();
    let err = c
        .set_circuit(&CircuitSpec {
            preserve_run: false,
            elements: vec![e],
            options: Some(opts(1e-6, false)),
            scopes: Vec::new(),
        })
        .expect_err("a non-positive custom-transformer inductance must be rejected");
    assert!(
        err.contains("customTransformer") && err.contains("inductance"),
        "rejection should name the element and parameter, got: {err}"
    );
}

#[test]
fn a_transformer_with_a_non_finite_ratio_is_rejected_at_build() {
    // A non-finite turns ratio would put non-finite terms into the mutual
    // matrix the build inverts; reject it where the value arrives.
    for ratio in [f64::NAN, f64::INFINITY] {
        let mut c = Circuit::new();
        let err = c
            .set_circuit(&transformer_like(4.0, ratio))
            .expect_err("a non-finite ratio must be rejected");
        assert!(
            err.contains("ratio") && err.contains("id 3"),
            "rejection of ratio = {ratio} should name the parameter and id, got: {err}"
        );
    }
}

#[test]
fn embedded_coil_lines_refuse_non_positive_windings_by_name() {
    // The relay coil and the dc motor's two windings are embedded inductors
    // sharing Inductor::new, so a hostile line must be refused naming the
    // carrying element, not an anonymous internal id.
    for (kind, param, value, label) in [
        ("relay", "inductance", 0.0, "relay"),
        ("relayCoil", "inductance", -0.2, "relayCoil"),
        ("dcMotor", "J", 0.0, "dcMotor"),
    ] {
        let mut e = elm(
            7,
            kind,
            &[[0, 0], [100, 0]],
            &[(param, value), ("resistance", 10.0)],
        );
        if kind == "relayCoil" {
            e.label = Some("label".into());
        }
        let mut c = Circuit::new();
        let err = c
            .set_circuit(&CircuitSpec {
                preserve_run: false,
                elements: vec![e],
                options: Some(opts(1e-6, false)),
                scopes: Vec::new(),
            })
            .unwrap_err();
        assert!(
            err.contains(label) && err.contains(param),
            "{kind} with {param} = {value} should be rejected by name, got: {err}"
        );
    }
}

// ─── Controls: valid values still build and solve ───

#[test]
fn valid_reactive_values_still_build_and_solve() {
    // The positive control over the whole guard set: every guarded kind at
    // ordinary values builds and steps cleanly, so the rejections above
    // cannot be explained by a broken constructor.
    let mut c = Circuit::new();
    c.set_circuit(&CircuitSpec {
        preserve_run: false,
        elements: vec![
            // RC leg: 10 V behind 1 k into 1 uF.
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 10.0)]),
            elm(2, "ground", &[[0, 100]], &[]),
            elm(
                3,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(
                4,
                "capacitor",
                &[[100, 0], [100, 100]],
                &[("capacitance", 1e-6), ("initialVoltage", 0.0)],
            ),
            elm(5, "ground", &[[100, 100]], &[]),
            // RL leg: the same node into 1 mH to ground.
            elm(
                6,
                "inductor",
                &[[200, 0], [300, 0]],
                &[("inductance", 1e-3)],
            ),
            elm(7, "wire", &[[200, 0], [0, 0]], &[]),
            elm(8, "ground", &[[300, 0]], &[]),
            // A 1:2 transformer driven by its own 5 V source into a 1 k load.
            elm(
                9,
                "transformer",
                &[[400, 0], [500, 0], [400, 100], [500, 100]],
                &[("inductance", 4.0), ("ratio", 2.0), ("couplingCoef", 0.999)],
            ),
            elm(10, "voltage", &[[350, 0], [400, 0]], &[("maxVoltage", 5.0)]),
            elm(11, "ground", &[[350, 0]], &[]),
            elm(12, "ground", &[[400, 100]], &[]),
            elm(
                13,
                "resistor",
                &[[500, 0], [550, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(14, "ground", &[[550, 0]], &[]),
            elm(15, "ground", &[[500, 100]], &[]),
        ],
        options: Some(opts(1e-6, false)),
        scopes: Vec::new(),
    })
    .expect("ordinary reactive values must analyse");
    assert_eq!(c.error(), None, "control circuit must solve cleanly");
    let report = c.run(5);
    assert!(
        report.converged,
        "control circuit did not step: {:?}",
        report.error
    );
}
