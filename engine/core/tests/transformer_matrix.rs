//! Transformers, adaptive time-stepping and Newton convergence, and matrix-closure regression tests.

use std::f64::consts::PI;

use circuit_core::{Circuit, CircuitSpec, ElementSpec, ScopeSpec, ScopeValue, SimOptions};

mod common;
use common::*;

/// Peak magnitude seen by scope `i` across the whole run.
fn peak_abs(c: &Circuit, i: usize) -> f64 {
    let snap = c.scopes()[i].snapshot();
    let mut peak: f32 = 0.0;
    for k in (0..snap.len()).step_by(2) {
        peak = peak.max(snap[k].abs()).max(snap[k + 1].abs());
    }
    peak as f64
}

/// A 10 V source across the primary of an open-secondary transformer with the
/// given turns ratio, returning the secondary node voltage. `secondary` is the
/// winding's two posts (the basic transformer's is (1,3); a custom's is (2,3)).
/// The secondary's far post is grounded, the layout real circuits use, so the
/// common mode is referenced and the solve is clean. The companion is exact
/// here: an open secondary carries no current, so `V2 = (M/L1)·V1 = k·ratio·V1`
/// holds from the very first step, which pins the winding polarity and the
/// `M⁻¹` sign.
fn open_secondary_v2(
    kind: &str,
    posts: &[[i32; 2]],
    params: &[(&str, f64)],
    label: Option<&str>,
    secondary: (usize, usize),
) -> f64 {
    open_secondary_v2_opts(kind, posts, params, label, secondary, 0, false)
}

/// [`open_secondary_v2`] with the element flags and the DC operating point
/// selectable. The ratio falls out of the `M⁻¹` companion alone, independent
/// of the integrator (`ts`) and of whether the DC pass or the first transient
/// step solves it, so the same analytic result must hold with the
/// `FLAG_BACK_EULER` bit set and with `dc_operating_point` on.
fn open_secondary_v2_opts(
    kind: &str,
    posts: &[[i32; 2]],
    params: &[(&str, f64)],
    label: Option<&str>,
    secondary: (usize, usize),
    flags: i64,
    dc: bool,
) -> f64 {
    let mut spec = CircuitSpec {
        preserve_run: false,
        elements: vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 10.0)]),
            elm(2, kind, posts, params),
            elm(3, "ground", &[[0, 100]], &[]),
            elm(4, "ground", &[posts[secondary.1]], &[]),
        ],
        options: Some(opts(1e-5, dc)),
        scopes: vec![
            tr_scope(2, ScopeValue::NodeVoltage, secondary.0),
            tr_scope(2, ScopeValue::NodeVoltage, secondary.1),
        ],
    };
    spec.elements[1].flags = flags;
    if let Some(l) = label {
        spec.elements[1].label = Some(l.to_string());
    }
    let mut c = Circuit::new();
    c.set_circuit(&spec).expect("circuit should analyse");
    c.run(5);
    last_sample(&c, 0) - last_sample(&c, 1)
}

#[test]
fn transformer_voltage_ratio_open_secondary() {
    // 1:1 at k = 0.999: the leakage leaves V2 = 0.999·V1 rather than V1.
    let v2 = open_secondary_v2(
        "transformer",
        &[[0, 0], [100, 0], [0, 100], [100, 100]],
        &[("inductance", 4.0), ("ratio", 1.0), ("couplingCoef", 0.999)],
        None,
        (1, 3),
    );
    assert!(
        close(v2, 9.99, 1e-6),
        "open secondary read {v2}, expected 9.99"
    );
}

#[test]
fn transformer_dc_pass_stamps_shorts_not_the_ac_ratio() {
    // Since the transformer family gained its own DC branch, the operating
    // point stamps every winding as a 1e-6 ohm short with the mutual terms
    // dropped (inductor.rs:94-98 precedent), so the AC ratio does NOT
    // appear: a source-driven primary reports its shorted-loop current
    // v/DC_SHORT, and a grounded secondary sits at zero. Reading the solved
    // voltages before any transient step still catches a stamp-guard
    // regression: if nothing were stamped under DC, the secondary would
    // have no DC path, the solve would go singular, and the quiet failure
    // path would zero every element voltage (V1 included).
    let spec = CircuitSpec {
        preserve_run: false,
        elements: vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 10.0)]),
            elm(
                2,
                "transformer",
                &[[0, 0], [100, 0], [0, 100], [100, 100]],
                &[("inductance", 4.0), ("ratio", 1.0), ("couplingCoef", 0.999)],
            ),
            elm(3, "ground", &[[0, 100]], &[]),
            elm(4, "ground", &[[100, 100]], &[]),
        ],
        options: Some(opts(1e-5, true)),
        scopes: Vec::new(),
    };
    let mut c = Circuit::new();
    c.set_circuit(&spec).expect("circuit should analyse");
    assert_eq!(c.error(), None, "the DC operating point did not solve");
    assert!(
        c.warnings()
            .iter()
            .all(|w| !w.contains("no path to ground")),
        "the grounded secondary should not need pinning: {:?}",
        c.warnings()
    );
    // The source holds V1 = 10; the secondary is a near-short to ground.
    let v1 = c.element_voltages()[0];
    let v2 = 10.0 - c.element_voltages()[1];
    assert!(
        close(v1, 10.0, 1e-6),
        "DC solve read V1 = {v1}, expected the source's 10 V"
    );
    assert!(
        close(v2, 0.0, 1e-9),
        "DC solve read V2 = {v2}, expected the shorted steady state"
    );
    // The primary's reported current is its shorted-loop value.
    let ip = c.element_currents()[1];
    assert!(
        close(ip, 10.0 / 1e-6, ip.abs() * 1e-9),
        "primary current read {ip}, expected 10/DC_SHORT"
    );
    // The transient continues from the DC pass without complaint.
    let report = c.run(5);
    assert!(
        report.converged,
        "transient after DC failed: {:?}",
        report.error
    );
}

#[test]
fn transformer_saturation_dc_pass_stamps_shorts_ahead_of_saturation() {
    // The DC branch sits ahead of the saturating early return, exactly as
    // the saturating inductor's own DC branch precedes saturation
    // (inductor.rs:94 before :99): a saturating transformer's operating
    // point is the plain near-short stamp built from the seeded zero
    // currents, not a current-dependent companion. The open secondary
    // carries no current and its grounded far post holds it at zero, so no
    // AC ratio appears. Reading the solved voltages before any transient
    // step still catches a stamp-guard regression: if nothing were stamped
    // under DC, the secondary would have no DC path, the solve would go
    // singular, and the quiet failure path would zero every element voltage
    // (V1 included), while the transient's do_step re-stamp would mask it.
    let spec = CircuitSpec {
        preserve_run: false,
        elements: vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 10.0)]),
            elm(
                2,
                "transformer",
                &[[0, 0], [100, 0], [0, 100], [100, 100]],
                &[
                    ("inductance", 4.0),
                    ("ratio", 2.0),
                    ("couplingCoef", 0.999),
                    ("saturationCurrent", 0.01),
                ],
            ),
            elm(3, "ground", &[[0, 100]], &[]),
            elm(4, "ground", &[[100, 100]], &[]),
        ],
        options: Some(opts(1e-5, true)),
        scopes: Vec::new(),
    };
    let mut c = Circuit::new();
    c.set_circuit(&spec).expect("circuit should analyse");
    assert_eq!(c.error(), None, "the DC operating point did not solve");
    assert!(
        c.warnings()
            .iter()
            .all(|w| !w.contains("no path to ground")),
        "the grounded secondary should not need pinning: {:?}",
        c.warnings()
    );
    // The source reads V(post1) - V(post0) = V1 (VoltageElm.java:462); the
    // transformer reads V(post0) - V(post1) = V1 - V2, so V2 = source -
    // transformer.
    let v1 = c.element_voltages()[0];
    let v2 = v1 - c.element_voltages()[1];
    assert!(
        close(v1, 10.0, 1e-6),
        "DC solve read V1 = {v1}, expected the source's 10 V"
    );
    assert!(
        close(v2, 0.0, 1e-9),
        "DC solve read V2 = {v2}, expected the shorted steady state"
    );
    // The transient continues from the DC pass without complaint.
    let report = c.run(5);
    assert!(
        report.converged,
        "transient after DC failed: {:?}",
        report.error
    );
}

#[test]
fn transformer_open_secondary_ratio_is_integrator_independent() {
    // Backward Euler (FLAG_BACK_EULER, the inductor's bit 2) scales the
    // companion by `ts = dt` instead of `dt/2` and drops the trapezoidal
    // term, but the open-circuit ratio reads out of the `M⁻¹` block alone, so
    // the same 1:1 at k = 0.999 must give 9.99 V from the very first step.
    let v2 = open_secondary_v2_opts(
        "transformer",
        &[[0, 0], [100, 0], [0, 100], [100, 100]],
        &[("inductance", 4.0), ("ratio", 1.0), ("couplingCoef", 0.999)],
        None,
        (1, 3),
        2,
        false,
    );
    assert!(
        close(v2, 9.99, 1e-6),
        "backward-Euler read {v2}, expected 9.99"
    );
}

#[test]
fn transformer_step_down_then_up() {
    // ratio is stored as N2/N1 (secondary/primary), so 10 steps the voltage up
    // and 0.1 steps it down; the two are exact mirrors of each other.
    let up = open_secondary_v2(
        "transformer",
        &[[0, 0], [100, 0], [0, 100], [100, 100]],
        &[
            ("inductance", 1.0),
            ("ratio", 10.0),
            ("couplingCoef", 0.999),
        ],
        None,
        (1, 3),
    );
    let down = open_secondary_v2(
        "transformer",
        &[[0, 0], [100, 0], [0, 100], [100, 100]],
        &[
            ("inductance", 1000.0),
            ("ratio", 0.1),
            ("couplingCoef", 0.999),
        ],
        None,
        (1, 3),
    );
    assert!(
        close(up, 99.9, 1e-4),
        "step-up secondary read {up}, expected 99.9"
    );
    assert!(
        close(down, 0.999, 1e-6),
        "step-down secondary read {down}, expected 0.999"
    );
    assert!(
        close(up / down, 100.0, 1e-4),
        "the two ratios are not mirrors: {up} / {down} = {}",
        up / down
    );
}

#[test]
fn transformer_current_ratio_loaded_secondary() {
    // A 1 kHz sine drives a 2:1 transformer through 1 ohm into a 4 k secondary
    // load, so the reflected load is 1 k. In steady state the magnetising
    // current is quadrature to the load and tiny (R_eff/(omega·L) ~ 1.6%), so
    // the peak current ratio is the ampere-turns ratio I1/I2 = ratio = 2
    // within a couple of percent, and the source delivers exactly the primary
    // current.
    let dt = 5e-6;
    let c = &mut build_with(
        vec![
            elm(
                1,
                "voltage",
                &[[0, 100], [0, 0]],
                &[
                    ("maxVoltage", 10.0),
                    ("waveform", 1.0),
                    ("frequency", 1000.0),
                ],
            ),
            elm(2, "resistor", &[[0, 0], [100, 0]], &[("resistance", 1.0)]),
            elm(
                3,
                "transformer",
                &[[100, 0], [200, 0], [100, 100], [200, 100]],
                &[
                    ("inductance", 10.0),
                    ("ratio", 2.0),
                    ("couplingCoef", 0.999),
                ],
            ),
            elm(
                4,
                "resistor",
                &[[200, 0], [200, 100]],
                &[("resistance", 4000.0)],
            ),
            elm(5, "wire", &[[100, 100], [0, 100]], &[]),
            elm(6, "ground", &[[0, 100]], &[]),
        ],
        opts(dt, false),
        vec![
            tr_scope(1, ScopeValue::Current, 0),
            tr_scope(3, ScopeValue::Current, 0),
            tr_scope(4, ScopeValue::Current, 0),
        ],
    );
    // tau = L/(R1 + R2/ratio^2) ~ 10 ms = 10 periods at 1 kHz; 40 periods is
    // four time constants, plenty for the ampere-turns ratio to settle.
    c.run(40 * 200);

    let i1 = peak_abs(c, 1);
    let i2 = peak_abs(c, 2);
    let isource = peak_abs(c, 0);
    assert!(i1 > 1e-4, "primary current collapsed to {i1}");
    assert!(
        close(i1 / i2, 2.0, 0.04),
        "ampere-turns ratio was I1/I2 = {i1}/{i2} = {}",
        i1 / i2
    );
    assert!(
        close(isource, i1, 0.01),
        "source peak {isource} does not match primary peak {i1}"
    );
}

/// The RL circuit behind the saturation curve: V = 20 through R = 1000 into a
/// driven winding of the basic transformer, the other winding open with its
/// far post grounded so the common mode is referenced (the
/// `open_secondary_v2_opts` layout). `drive_secondary` picks which winding
/// carries the drive; `ratio` and `saturation_current` are the transformer's
/// own tokens.
fn transformer_rl_saturation(
    drive_secondary: bool,
    ratio: f64,
    saturation_current: Option<f64>,
) -> Vec<ElementSpec> {
    let mut params = vec![
        ("inductance", 1e-3),
        ("ratio", ratio),
        ("couplingCoef", 0.999),
    ];
    if let Some(isat) = saturation_current {
        params.push(("saturationCurrent", isat));
    }
    let mut els = vec![
        elm(1, "voltage", &[[0, 200], [0, 0]], &[("maxVoltage", 20.0)]),
        elm(2, "ground", &[[0, 200]], &[]),
    ];
    // Primary-driven: R feeds primary post 0, primary post 2 grounded,
    // secondary post 3 grounded. Secondary-driven: R feeds secondary post 1,
    // secondary post 3 grounded, primary post 2 grounded.
    if drive_secondary {
        els.push(elm(
            3,
            "resistor",
            &[[0, 0], [100, 100]],
            &[("resistance", 1000.0)],
        ));
        els.push(elm(
            4,
            "transformer",
            &[[100, 0], [100, 100], [0, 100], [100, 200]],
            &params,
        ));
        els.push(elm(5, "ground", &[[0, 100]], &[]));
        els.push(elm(6, "ground", &[[100, 200]], &[]));
    } else {
        els.push(elm(
            3,
            "resistor",
            &[[0, 0], [100, 0]],
            &[("resistance", 1000.0)],
        ));
        els.push(elm(
            4,
            "transformer",
            &[[100, 0], [100, 100], [0, 100], [100, 200]],
            &params,
        ));
        els.push(elm(5, "ground", &[[0, 100]], &[]));
        els.push(elm(6, "ground", &[[100, 200]], &[]));
    }
    els
}

#[test]
fn transformer_saturation_primary_side_follows_the_analytic_curve() {
    // With the secondary open no secondary current flows, and the companion
    // reduces the primary to a plain saturating inductor (the i2 = 0
    // constraint eliminates the M term: v1 = L1_eff*di1/dt). Reuse the
    // saturating-inductor numbers (reactive.rs:880-919): V = 20 behind
    // R = 1000, L = 1e-3, Isat = 0.01, ratio = 1. At I = Isat the closed
    // form gives t = 0.522103*L/R = 5.22103e-7 s, 522 steps at dt = 1e-9.
    // Measured 9.981e-3 at the same point. The linear twin at the same point
    // reads the plain exponential I = (V/R)(1 - e^(-t/tau)) = 8.14e-3
    // (measured 8.127e-3), the gap the saturation collapse produces.
    let dt = 1e-9;
    let steps = 522;
    let sat = &mut build(
        transformer_rl_saturation(false, 1.0, Some(0.01)),
        opts(dt, false),
    );
    sat.run(steps);
    let amps = sat.element_currents();
    assert!(
        close(amps[3], 0.01, 2e-4),
        "saturating transformer at Isat: got {}, expected 0.01",
        amps[3]
    );

    let lin = &mut build(transformer_rl_saturation(false, 1.0, None), opts(dt, false));
    lin.run(steps);
    let amps = lin.element_currents();
    assert!(
        close(amps[3], 8.14e-3, 1e-4),
        "linear twin at the same point read {}, expected 8.14e-3",
        amps[3]
    );
}

#[test]
fn transformer_saturation_secondary_isat_scales_with_ratio() {
    // Drive the secondary instead (primary open). With ratio = 2 and
    // isat = 0.005, the secondary is a saturating inductor of
    // L2 = L*4 = 4e-3 at Isat2 = isat*2 = 0.01, so x0 = 20/(1000*0.01) = 2
    // and the same closed form gives t = 0.522103*L2/R = 2.088e-6 s, 2088
    // steps at dt = 1e-9, where the winding reads I = Isat2 (measured
    // 9.994e-3, no GMIN perturbation). The point is the isat*|turns|
    // scaling, not the primary, which stays essentially at zero (measured
    // 2e-19).
    let dt = 1e-9;
    let steps = 2088;
    let c = &mut build(
        transformer_rl_saturation(true, 2.0, Some(0.005)),
        opts(dt, false),
    );
    c.run(steps);
    // The secondary winding is posts (1,3) of the 4-post transformer (element
    // index 3, post offset 5: voltage 2 + ground 1 + resistor 2).
    // current_into_node(1) = -currents[1].
    let posts = c.element_post_currents();
    let i2 = -posts[6];
    let i1 = c.element_currents()[3];
    assert!(
        close(i2, 0.01, 3e-4),
        "secondary winding at its ratio-scaled Isat: got {i2}, expected 0.01"
    );
    assert!(
        i1.abs() < 2e-4,
        "open primary carried {i1}, expected near zero"
    );
}

#[test]
fn tapped_transformer_center_tap() {
    // Tapped 1:1 at k = 0.99, secondary open with the centre tap grounded: the
    // tap splits the secondary into two halves of half the turns each, so each
    // half reads k·(ratio/2)·V1 = 4.95 V, one up from ground and one down.
    let spec = CircuitSpec {
        preserve_run: false,
        elements: vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 10.0)]),
            elm(
                2,
                "tappedTransformer",
                &[[0, 0], [0, 100], [100, 0], [100, 100], [100, 200]],
                &[("inductance", 4.0), ("ratio", 1.0), ("couplingCoef", 0.99)],
            ),
            elm(3, "ground", &[[0, 100]], &[]),
            elm(4, "ground", &[[100, 100]], &[]),
        ],
        options: Some(opts(1e-5, false)),
        scopes: vec![
            tr_scope(2, ScopeValue::NodeVoltage, 2),
            tr_scope(2, ScopeValue::NodeVoltage, 3),
            tr_scope(2, ScopeValue::NodeVoltage, 4),
        ],
    };
    let mut c = Circuit::new();
    c.set_circuit(&spec).expect("circuit should analyse");
    c.run(5);

    let (v2, v3, v4) = (last_sample(&c, 0), last_sample(&c, 1), last_sample(&c, 2));
    assert!(
        close(v2 - v3, 4.95, 1e-6),
        "upper half read {} V, expected 4.95",
        v2 - v3
    );
    assert!(
        close(v3 - v4, 4.95, 1e-6),
        "lower half read {} V, expected 4.95",
        v3 - v4
    );
    assert!(
        close(v2 - v4, 9.9, 1e-6),
        "full secondary read {} V, expected 9.9",
        v2 - v4
    );
}

#[test]
fn custom_transformer_two_coils() {
    // The description's number is the turns ratio to the base inductance coil.
    // A 1:1 custom is a plain 1:1 transformer; a 2:1 steps the voltage down by
    // the turns ratio, so the open secondary reads k·(1/2)·V1.
    let v_11 = open_secondary_v2(
        "customTransformer",
        &[[0, 0], [0, 100], [100, 0], [100, 100]],
        &[("inductance", 4.0), ("couplingCoef", 0.999)],
        Some("1:1"),
        (2, 3),
    );
    let v_21 = open_secondary_v2(
        "customTransformer",
        &[[0, 0], [0, 100], [100, 0], [100, 100]],
        &[("inductance", 4.0), ("couplingCoef", 0.999)],
        Some("2:1"),
        (2, 3),
    );
    assert!(
        close(v_11, 9.99, 1e-6),
        "1:1 secondary read {v_11}, expected 9.99"
    );
    assert!(
        close(v_21, 4.995, 1e-6),
        "2:1 secondary read {v_21}, expected 4.995"
    );
}

#[test]
fn transformer_connects_all_posts() {
    // The secondary floats entirely: nothing external touches it. Its common
    // mode is undefined, so the floating-subcircuit detection must pin one of
    // its nodes with a GMIN conductance, exactly as upstream's
    // `connectUnconnectedNodes` ties unconnected nodes to ground with a 1e8
    // resistor (SimulationManager.java). A transformer that reported all its
    // posts as connected would keep the secondary out of that pinning and the
    // solve would go singular. The winding still reads its full ratio: the
    // pinning fixes the absolute potential, not the winding difference. Both
    // secondary nodes are pinned at 1e-8 S each, and the pin current loads
    // the winding a little (measured 9.98992 V, an 8e-5 V drop from the ideal
    // 9.99), so the 1e-4 window covers the pin loading while still pinning the
    // full-ratio reading.
    let spec = CircuitSpec {
        preserve_run: false,
        elements: vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 10.0)]),
            elm(
                2,
                "transformer",
                &[[0, 0], [100, 0], [0, 100], [100, 100]],
                &[("inductance", 4.0), ("ratio", 1.0), ("couplingCoef", 0.999)],
            ),
            elm(3, "ground", &[[0, 100]], &[]),
        ],
        options: Some(opts(1e-5, false)),
        scopes: vec![
            tr_scope(2, ScopeValue::NodeVoltage, 1),
            tr_scope(2, ScopeValue::NodeVoltage, 3),
        ],
    };
    let mut c = Circuit::new();
    c.set_circuit(&spec).expect("circuit should analyse");
    let report = c.run(5);
    assert!(
        report.converged && c.error().is_none(),
        "a floating transformer secondary must still solve: {:?}",
        c.error()
    );
    assert!(
        c.warnings().iter().any(|w| w.contains("no path to ground")),
        "the floating secondary should have been pinned: {:?}",
        c.warnings()
    );
    assert!(
        close(last_sample(&c, 0) - last_sample(&c, 1), 9.99, 1e-4),
        "floating secondary read {} V, expected 9.99",
        last_sample(&c, 0) - last_sample(&c, 1)
    );
}

// ─── Adaptive timestep with step rejection ──────────────────────────────────

#[test]
fn adaptive_step_rescues_a_stubborn_circuit() {
    // The fixed-step run has no way forward once a step needs more Newton
    // iterations than its budget, so it stops on the first compliance
    // crossing. The adaptive run gives the same budget the chance to retry at
    // a halved step, and that smaller step settles, so the whole run
    // completes and the clock advances past where the fixed run froze.
    let mut fixed = build(compliance_circuit(0.0), opts_budget(5e-6, false, 5));
    let report = fixed.run(200);
    assert!(!report.converged, "the fixed-step run should stall");

    let mut c = build_with(
        compliance_circuit(0.0),
        adaptive_opts(5e-6, 50e-12, 5),
        vec![ScopeSpec {
            element_id: 3,
            value: ScopeValue::Current,
            post: 0,
            steps_per_column: 1,
            columns: 1024,
            ac_coupled: false,
            trigger: Default::default(),
            display_width: 0,
        }],
    );
    let report = c.run(200);
    assert!(report.converged, "adaptive run failed: {:?}", report.error);
    assert!(report.rejected_steps >= 1, "nothing was ever rejected");
    assert!(
        report.time > 5e-4,
        "the sim advanced only to {} s",
        report.time
    );
    assert!(
        close(report.time_step, 5e-6, 1e-15),
        "the step should have recovered to the maximum, got {}",
        report.time_step
    );
    // The compliance holds the delivered current to its rating: at a
    // conducting phase the source pushes its full 10 mA, never more, which is
    // the tanh roll-off doing its job. This is the fixed run's frozen
    // alternative: it dies before ever producing a settled state.
    let cur = c.scopes()[0].snapshot();
    let mut cur_max: f32 = 0.0;
    for k in (0..cur.len()).step_by(2) {
        cur_max = cur_max.max(cur[k]).max(cur[k + 1]);
    }
    assert!(
        (0.009..=0.0105).contains(&(cur_max as f64)),
        "delivered current peaked at {cur_max}, expected it capped at the 10 mA rating"
    );
}

#[test]
fn rejected_step_commits_no_state_and_no_time() {
    // Phase-shifting the sine by 7.5 degrees puts the first step's endpoint
    // (t = 5e-6) inside the compliance transition, so the first attempt
    // exhausts its budget of 5 and must halve to 2.5e-6, where the endpoint
    // sits below the transition and settles. Exactly one halving, which makes
    // the committed trajectory easy to pin: two committed steps at 2.5e-6.
    let phase = 7.5f64 * PI / 180.0;
    let mut c = build(compliance_circuit(phase), adaptive_opts(5e-6, 50e-12, 5));
    let r1 = c.run(1);
    assert_eq!(r1.rejected_steps, 1, "expected exactly one rejection");
    assert!(
        close(r1.time_step, 2.5e-6, 1e-15),
        "working step after the halve was {}",
        r1.time_step
    );
    // With the pre-adaptive bug the rejected attempt advanced the clock to
    // 5e-6 and committed garbage to reactive history; the clock must only
    // ever move by committed steps.
    assert!(close(c.time(), 2.5e-6, 1e-15), "clock was {}", c.time());

    c.run(1);
    assert!(close(c.time(), 5e-6, 1e-15), "clock was {}", c.time());

    // Reference: a non-adaptive circuit stepping the whole way at 2.5e-6. The
    // adaptive run's rejected first step must leave no trace, so after two
    // committed steps both circuits sit at the same time with the same node
    // voltages, down to floating-point noise. The current source's terminal
    // voltage is the observable: it would differ if the rejected attempt had
    // corrupted `last_volt_diff`.
    let mut reference = build(compliance_circuit(phase), opts_budget(2.5e-6, false, 5));
    let rr = reference.run(2);
    assert!(rr.converged, "reference did not converge: {:?}", rr.error);
    assert!(close(reference.time(), 5e-6, 1e-15));
    assert!(
        close(
            c.element_voltages()[2],
            reference.element_voltages()[2],
            1e-9
        ),
        "adaptive state {} differs from the reference {}",
        c.element_voltages()[2],
        reference.element_voltages()[2]
    );
}

#[test]
fn easy_steps_double_the_timestep_back_to_max() {
    // The compliance crossing at the cold start rejects at the full step and
    // halves, then the long stretches of the sine well away from the
    // transition settle in two subiterations, so after three easy steps the
    // step doubles back toward 5e-6. By the end of 200 steps (twenty periods)
    // the working step must have recovered to the maximum.
    let mut c = build(compliance_circuit(0.0), adaptive_opts(5e-6, 50e-12, 5));
    let report = c.run(200);
    assert!(report.converged, "did not converge: {:?}", report.error);
    assert!(report.rejected_steps >= 1, "nothing was ever rejected");
    assert!(
        close(report.time_step, 5e-6, 1e-15),
        "step did not double back to the maximum, it is {}",
        report.time_step
    );
}

#[test]
fn step_hitting_the_floor_falls_back_to_5000_and_stops_cleanly() {
    // A BJT with its base forced to a 100 V square wave. The cold start's vbe
    // is deep in exponential saturation and even the relaxed 5000-iteration
    // budget cannot settle the first step (probing measured >5000 iterations
    // needed at every step size the halving chain reaches), so the run must
    // stop with the error set and the clock still at zero. min_time_step =
    // 1.25e-6 walks both halvings down to the floor, 5e-6 then 2.5e-6 then
    // 1.25e-6, and it is the floor attempt that gets the 5000 budget,
    // because no smaller step exists behind it.
    let els = vec![
        elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 5.0)]),
        elm(
            2,
            "resistor",
            &[[0, 0], [100, 0]],
            &[("resistance", 47000.0)],
        ),
        elm(
            3,
            "resistor",
            &[[0, 0], [200, 0]],
            &[("resistance", 1000.0)],
        ),
        elm(
            4,
            "transistor",
            &[[100, 0], [200, 0], [200, 100]],
            &[("pnp", 1.0), ("beta", 100.0)],
        ),
        elm(5, "ground", &[[200, 100]], &[]),
        elm(
            6,
            "voltage",
            &[[100, 100], [100, 0]],
            &[
                ("waveform", 2.0),
                ("frequency", 100000.0),
                ("maxVoltage", 100.0),
            ],
        ),
        elm(7, "ground", &[[100, 100]], &[]),
    ];
    let mut c = build(els, adaptive_opts(5e-6, 1.25e-6, 5));
    let report = c.run(10);
    assert!(
        report.rejected_steps >= 1,
        "the full step should be rejected"
    );
    assert!(
        report.iterations > 1000,
        "the 5000 fallback did not engage, iterations was {}",
        report.iterations
    );
    assert!(!report.converged, "the run should stop as non-convergent");
    assert!(c.error().is_some(), "no error was recorded");
    assert!(
        close(c.time(), 0.0, 1e-15),
        "a rejected step advanced the clock to {}",
        c.time()
    );
}

/// Test A: the Schmitt trigger whose differential repeatedly crosses the
/// saturation knees, the comparator case that two-cycles with a tight
/// tolerance and no branch tie-break.
#[test]
fn opamp_comparator_converges_within_the_iteration_budget() {
    // The sine drives V+ through 1k; a 10k feedback resistor feeds the railed
    // output back into V+. With V- grounded, V+ = (10*Vin + Vout)/11 and the
    // trip points sit at Vin = +-1.5 V (where V+ crosses 0 with Vout railed at
    // +-15), so every period the input differential crosses both saturation
    // knees twice. Each step must settle within the 100-iteration budget,
    // railed outputs included.
    let dt = 1e-6; // period (1 ms) / 1000
    let c = &mut build(
        vec![
            elm(
                1,
                "voltage",
                &[[0, 200], [0, 0]],
                &[
                    ("maxVoltage", 3.0),
                    ("waveform", 1.0),
                    ("frequency", 1000.0),
                ],
            ),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(
                3,
                "resistor",
                &[[300, 0], [100, 0]],
                &[("resistance", 10_000.0)],
            ),
            elm(
                4,
                "opamp",
                &[[100, 100], [100, 0], [300, 0]],
                &[("gain", 100_000.0), ("maxOut", 15.0), ("minOut", -15.0)],
            ),
            elm(5, "ground", &[[100, 100]], &[]),
            elm(6, "ground", &[[0, 200]], &[]),
        ],
        opts(dt, false),
    );

    let mut worst = 0u32;
    for _ in 0..2000 {
        let r = c.run(1);
        assert!(
            r.converged,
            "comparator step failed: {}",
            r.error.unwrap_or_default()
        );
        worst = worst.max(r.iterations);
    }
    assert!(worst < 100, "worst comparator step took {worst} iterations");
}

/// Test B: a full-wave bridge started from all-zero voltages, whose output
/// nodes are defined only through the junction conductances until a diode
/// conducts.
#[test]
fn diode_bridge_startup_converges_within_a_tight_iteration_budget() {
    // Nothing conducts initially, and once the capacitor has charged the
    // bridge's diode switching used to lock into a Newton limit cycle that
    // no budget under the ramp start could settle. That was with a fixed
    // 1e-12 S junction conductance; since the family tracks its model's
    // saturation current instead (leakage * 0.01, Diode.java:147), the
    // conductance damps the cycle from the first iteration and the whole
    // window settles in a handful of iterations per step, without ever
    // reaching for the geometric ramp. The tight budget is the point: it is
    // far below the old stall's appetite (the worst step used to burn past
    // 100 iterations), so any regression back toward the limit cycle trips.
    let bridge = vec![
        elm(
            1,
            "voltage",
            &[[0, 160], [0, 320]],
            &[
                ("maxVoltage", 12.0),
                ("waveform", 1.0),
                ("frequency", 1000.0),
            ],
        ),
        elm(2, "diode", &[[0, 160], [160, 160]], &[]),
        elm(3, "diode", &[[0, 320], [160, 160]], &[]),
        elm(4, "diode", &[[160, 320], [0, 160]], &[]),
        elm(5, "diode", &[[160, 320], [0, 320]], &[]),
        elm(
            6,
            "capacitor",
            &[[160, 160], [160, 320]],
            &[("capacitance", 100e-6)],
        ),
        elm(
            7,
            "resistor",
            &[[160, 160], [320, 160]],
            &[("resistance", 1000.0)],
        ),
        elm(8, "wire", &[[320, 160], [320, 320]], &[]),
        elm(9, "wire", &[[320, 320], [160, 320]], &[]),
        elm(10, "ground", &[[0, 320]], &[]),
    ];
    // dt = 1e-6 (period 1 ms / 1000); 500 steps cover the former step-366
    // switching stall with margin on both sides.
    let mut c = build(bridge, opts_budget(1e-6, false, 80));
    let mut worst = 0u32;
    for _ in 0..500 {
        let r = c.run(1);
        assert!(
            r.converged,
            "bridge startup step failed: {}",
            r.error.unwrap_or_default()
        );
        worst = worst.max(r.iterations);
    }
    assert!(
        worst <= 10,
        "bridge startup regressed toward the old limit cycle, worst step \
         took {worst} iterations"
    );
}

/// Test C: two ideal voltage sources between the same node pair, duplicate MNA
/// constraint rows and a textbook singular matrix.
#[test]
fn singular_linear_circuit_is_rejected_at_set_circuit() {
    // The circuit is linear, so with the DC operating point off it used to be
    // accepted at set_circuit (factorisation is lazy) and only tripped on the
    // first run. It must now be rejected at build time with an error.
    let spec = CircuitSpec {
        preserve_run: false,
        elements: vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 5.0)]),
            elm(2, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 3.0)]),
            elm(3, "ground", &[[0, 0]], &[]),
        ],
        options: Some(opts(1e-5, false)),
        scopes: Vec::new(),
    };
    let mut c = Circuit::new();
    assert!(
        c.set_circuit(&spec).is_err(),
        "singular circuit accepted at set_circuit"
    );
}

/// Test D: a voltage source whose two posts both sit on the ground symbol's
/// coordinate. Both terminals merge onto node 0, so the whole circuit has no
/// non-ground node at all; `build_closures` used to index its empty closure
/// list with the source's fallback closure 0 and panic.
#[test]
fn all_ground_voltage_source_is_rejected_at_set_circuit() {
    let spec = CircuitSpec {
        preserve_run: false,
        elements: vec![
            elm(1, "voltage", &[[0, 0], [0, 0]], &[("maxVoltage", 5.0)]),
            elm(2, "ground", &[[0, 0]], &[]),
        ],
        options: Some(opts(1e-5, false)),
        scopes: Vec::new(),
    };
    let mut c = Circuit::new();
    assert!(
        c.set_circuit(&spec).is_err(),
        "voltage source shorted to ground on both posts accepted at set_circuit"
    );
    // The rejected build must also leave nothing behind for a subsequent
    // frame to trip over: `closure_rows` must be empty, matching the
    // no-circuit-built state, so `run` takes the harmless empty-closures
    // path (a no-op that reports trivially converged) instead of indexing a
    // stale, larger closure list against the shrunk node voltages.
    assert!(
        c.closure_rows().is_empty(),
        "closures survived a rejected set_circuit"
    );
    let report = c.run(3);
    assert!(
        report.converged,
        "the empty-closures no-op path should not report a failed step"
    );
}

/// Two elements sharing an id make `set_param`/`set_state`/`indexOf` pick the
/// wrong element, so `set_circuit` must reject the spec instead of silently
/// keeping only the last element under that id in `id_index`.
#[test]
fn duplicate_element_id_is_rejected_at_set_circuit() {
    let spec = CircuitSpec {
        preserve_run: false,
        elements: vec![
            elm(
                1,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(
                1,
                "resistor",
                &[[0, 100], [100, 100]],
                &[("resistance", 2000.0)],
            ),
        ],
        options: Some(opts(1e-5, false)),
        scopes: Vec::new(),
    };
    let mut c = Circuit::new();
    let err = c
        .set_circuit(&spec)
        .expect_err("duplicate element id accepted at set_circuit");
    assert!(
        err.contains("duplicate element id 1"),
        "error does not name the duplicate id: {err}"
    );
    assert!(
        err.contains("resistor") && err.contains("element 0") && err.contains("element 1"),
        "error does not name both elements: {err}"
    );
}

/// A spec with unique ids still builds, and `element_ids` reports exactly the
/// ids the spec supplied, in element order.
#[test]
fn unique_ids_build_and_element_ids_match() {
    let spec = CircuitSpec {
        preserve_run: false,
        elements: vec![
            elm(7, "voltage", &[[0, 0], [0, 100]], &[("maxVoltage", 5.0)]),
            elm(
                3,
                "resistor",
                &[[0, 100], [100, 100]],
                &[("resistance", 1000.0)],
            ),
            elm(9, "ground", &[[0, 0]], &[]),
        ],
        options: Some(opts(1e-5, false)),
        scopes: Vec::new(),
    };
    let c = build(spec.elements, spec.options.expect("opts"));
    assert_eq!(c.element_ids(), &[7, 3, 9]);
}

/// A hand-edited netlist can carry tens of thousands of elements whose posts
/// sit at absurd coordinates (1e9, far outside any canvas); the terminal
/// count and node count blow past the sanity cap. `set_circuit` must reject
/// the circuit as invalid rather than attempt the unbounded matrix
/// allocation, and a rejected build must leave nothing behind for a later
/// frame to trip over.
#[test]
fn absurd_coordinates_are_rejected_at_set_circuit() {
    let mut elements = Vec::with_capacity(60_000);
    let base: i32 = 1_000_000_000;
    for i in 0..60_000usize {
        elements.push(elm(
            i as u32 + 1,
            "resistor",
            &[[base + i as i32, 0], [base + i as i32 + 1, 0]],
            &[("resistance", 1000.0)],
        ));
    }
    let spec = CircuitSpec {
        preserve_run: false,
        elements,
        options: Some(opts(1e-5, false)),
        scopes: Vec::new(),
    };
    let mut c = Circuit::new();
    let err = c
        .set_circuit(&spec)
        .expect_err("oversized netlist accepted at set_circuit");
    assert!(
        err.contains("too large"),
        "oversized netlist reported a different error: {err}"
    );
    assert!(
        c.closure_rows().is_empty(),
        "closures survived a rejected set_circuit"
    );
    let report = c.run(3);
    assert!(
        report.converged,
        "the empty-closures no-op path should not report a failed step"
    );
}

/// A minimal circuit whose validity does not depend on the timestep, so
/// these tests isolate the `timeStep`/`minTimeStep` guard from every other
/// `set_circuit` rejection path above.
fn simple_resistor_spec(options: SimOptions) -> CircuitSpec {
    CircuitSpec {
        preserve_run: false,
        elements: vec![
            elm(1, "voltage", &[[0, 0], [0, 100]], &[("maxVoltage", 5.0)]),
            elm(
                2,
                "resistor",
                &[[0, 100], [100, 100]],
                &[("resistance", 1000.0)],
            ),
            elm(3, "ground", &[[0, 0]], &[]),
        ],
        options: Some(options),
        scopes: Vec::new(),
    }
}

/// A negative, NaN or infinite `timeStep` reaches the reactive companions
/// (capacitor.rs, inductor.rs) as `geq = 2*C/dt`, a negative or NaN
/// conductance that stamps without complaint and produces garbage output.
/// `set_circuit` must reject it before anything downstream consumes it.
#[test]
fn negative_time_step_is_rejected_at_set_circuit() {
    let spec = simple_resistor_spec(opts(-1e-5, false));
    let mut c = Circuit::new();
    assert!(
        c.set_circuit(&spec).is_err(),
        "negative timeStep accepted at set_circuit"
    );
}

#[test]
fn nan_time_step_is_rejected_at_set_circuit() {
    let spec = simple_resistor_spec(opts(f64::NAN, false));
    let mut c = Circuit::new();
    assert!(
        c.set_circuit(&spec).is_err(),
        "NaN timeStep accepted at set_circuit"
    );
}

#[test]
fn infinite_time_step_is_rejected_at_set_circuit() {
    let spec = simple_resistor_spec(opts(f64::INFINITY, false));
    let mut c = Circuit::new();
    assert!(
        c.set_circuit(&spec).is_err(),
        "infinite timeStep accepted at set_circuit"
    );
}

#[test]
fn negative_min_time_step_is_rejected_at_set_circuit() {
    let mut options = opts(1e-5, false);
    options.min_time_step = -50e-12;
    let spec = simple_resistor_spec(options);
    let mut c = Circuit::new();
    assert!(
        c.set_circuit(&spec).is_err(),
        "negative minTimeStep accepted at set_circuit"
    );
}

#[test]
fn non_finite_min_time_step_is_rejected_at_set_circuit() {
    let mut options = opts(1e-5, false);
    options.min_time_step = f64::NAN;
    let spec = simple_resistor_spec(options);
    let mut c = Circuit::new();
    assert!(
        c.set_circuit(&spec).is_err(),
        "NaN minTimeStep accepted at set_circuit"
    );

    let mut options = opts(1e-5, false);
    options.min_time_step = f64::INFINITY;
    let spec = simple_resistor_spec(options);
    let mut c = Circuit::new();
    assert!(
        c.set_circuit(&spec).is_err(),
        "infinite minTimeStep accepted at set_circuit"
    );
}

/// The guard must not reject the ordinary case: a normal positive, finite
/// timestep still builds and steps cleanly.
#[test]
fn positive_finite_time_step_is_accepted_at_set_circuit() {
    let spec = simple_resistor_spec(opts(1e-5, false));
    let mut c = Circuit::new();
    assert!(
        c.set_circuit(&spec).is_ok(),
        "ordinary positive finite timeStep rejected at set_circuit"
    );
    let report = c.run(3);
    assert!(report.converged, "ordinary circuit failed to step");
}

/// A rejected `set_circuit` must not leave `self.options` holding the bad
/// value it just rejected: `reset()` reads `self.options.time_step` directly
/// (bypassing `set_time_step`) and restamps immediately, so a bad value that
/// slipped into `self.options` on a rejected call would resurrect the
/// original negative/NaN-conductance bug on the very next `reset()`, on the
/// same long-lived `Circuit` a real frontend keeps across edits.
#[test]
fn rejected_set_circuit_does_not_corrupt_options_for_a_later_reset() {
    let good_spec = simple_resistor_spec(opts(1e-5, false));
    let mut c = Circuit::new();
    c.set_circuit(&good_spec)
        .expect("good circuit should build");

    let bad_spec = simple_resistor_spec(opts(-1e-5, false));
    assert!(
        c.set_circuit(&bad_spec).is_err(),
        "negative timeStep accepted on a live instance"
    );
    assert_eq!(
        c.options().time_step,
        1e-5,
        "a rejected set_circuit overwrote the last good timeStep"
    );

    // reset() stamps against self.options.time_step directly; if the guard
    // had let the bad value through, this call is exactly where the negative
    // conductance would resurface.
    c.reset();
    let report = c.run(3);
    assert!(
        report.converged,
        "reset() after a rejected set_circuit failed to step cleanly"
    );
    assert!(
        report.time_step.is_finite() && report.time_step > 0.0,
        "reset() stepped with a corrupted timestep: {}",
        report.time_step
    );
}

// ─── Matrix simplification (per-closure dense systems) ───

#[test]
fn large_resistor_grid_keeps_the_analytic_far_corner() {
    // 400 nodes in one closure, driven at 20 V. Each chain of 20 equal 1 ohm
    // resistors drops 1 V per resistor, so every far corner sits at exactly
    // 1 V. This is the "big linear circuit stays exact" guard: the closure
    // split must not change any solved value.
    let c = &mut build(fan(20, 20, 20.0, 1), opts(1e-5, false));
    let report = c.run(5);
    assert!(report.converged, "did not converge: {:?}", report.error);
    assert!(
        close(c.node_voltages()[1], 20.0, 1e-9),
        "driven node was {}",
        c.node_voltages()[1]
    );
    // Chain c's far corner (junction after its 19th resistor) is node 20+19c
    // in id order, and carries 1 V.
    for c_idx in 0..20 {
        let v = c.node_voltages()[20 + 19 * c_idx];
        assert!(close(v, 1.0, 1e-9), "far corner of chain {c_idx} was {v}");
    }
}

#[test]
fn two_independent_dividers_stay_independent() {
    // Two disjoint ground-referenced dividers are separate closures, so each
    // solves to the analytic divider value 10 * 2/3 = 6.6667, and neither
    // feels the other. The closure solve is bit-identical to the lone
    // divider's because the matrices are the same, which no global solve can
    // guarantee.
    let divider = |base: i32, id_base: u32| {
        vec![
            elm(
                id_base,
                "voltage",
                &[[base, 200], [base, 0]],
                &[("maxVoltage", 10.0)],
            ),
            elm(
                id_base + 1,
                "resistor",
                &[[base, 0], [base + 100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(
                id_base + 2,
                "resistor",
                &[[base + 100, 0], [base + 100, 100]],
                &[("resistance", 2000.0)],
            ),
            elm(id_base + 3, "ground", &[[base, 200]], &[]),
            elm(id_base + 4, "ground", &[[base + 100, 100]], &[]),
        ]
    };
    // The two dividers used to reuse the same id block 1-5, which the
    // duplicate-id guard now rejects; each gets its own id block instead.
    let mut full = build(
        [divider(0, 1), divider(400, 100)].concat(),
        opts(1e-5, false),
    );
    full.run(5);
    // element_voltages: [VS, R1, R2, VS, R1, R2]; R2 reads the junction.
    assert!(
        close(full.element_voltages()[2], 6.6666666667, 1e-9),
        "divider 1 junction was {}",
        full.element_voltages()[2]
    );
    assert!(
        close(full.element_voltages()[7], 6.6666666667, 1e-9),
        "divider 2 junction was {}",
        full.element_voltages()[7]
    );

    // Deleting one network leaves the other's solve unchanged, exactly.
    let mut single = build(divider(0, 1), opts(1e-5, false));
    single.run(5);
    assert_eq!(
        single.element_voltages()[2],
        full.element_voltages()[2],
        "closure coupling through ground changed the divider"
    );
}

#[test]
fn split_closures_factor_fewer_flops_than_one_global_matrix() {
    // Two 60-node chains are two closures; the same 120 nodes as one chain is
    // a single closure. LU flops scale like n^3 per system, so the split must
    // be strictly cheaper, measured by the deterministic multiply-add counter
    // rather than a wall clock.
    let two = build(
        [resistor_chain(60, 0, 1), resistor_chain(60, 4000, 200)].concat(),
        opts(1e-5, false),
    );
    let one = build(resistor_chain(120, 0, 1), opts(1e-5, false));
    assert_eq!(two.node_count(), one.node_count(), "node counts must match");
    let f_two = two.factor_flops();
    let f_one = one.factor_flops();
    assert!(
        f_two < f_one,
        "two closures factored {f_two} flops, a single {f_one}-row system only {f_one}"
    );
}

#[test]
fn opamp_matrix_connects_keeps_inputs_and_output_in_one_closure() {
    // The op-amp's do_step stamps the input columns into the output VS row.
    // With no feedback the input and output are separate closures unless
    // matrix_connects forces them together, and a torn stamp lands in the
    // wrong system. The inverting input held at +1 V with the non-inverting
    // grounded saturates the output to minOut = -15 V.
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 200], [0, 0]], &[("maxVoltage", 1.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(
                3,
                "opamp",
                &[[100, 0], [100, 100], [300, 0]],
                &[("gain", 100_000.0), ("maxOut", 15.0), ("minOut", -15.0)],
            ),
            elm(
                4,
                "resistor",
                &[[300, 0], [300, 100]],
                &[("resistance", 1000.0)],
            ),
            elm(5, "ground", &[[100, 100]], &[]),
            elm(6, "ground", &[[0, 200]], &[]),
            elm(7, "ground", &[[300, 100]], &[]),
        ],
        opts(1e-5, true),
    );
    let report = c.run(30);
    assert!(report.converged, "did not converge: {:?}", report.error);
    let out = c.element_voltages()[2];
    assert!(close(out, -15.0, 0.1), "op-amp output was {out}");
}

#[test]
fn mosfet_matrix_connects_keeps_the_gate_in_the_channel_closure() {
    // Source follower: the gm column stamps the gate into the source/drain
    // rows, so a gate torn into another closure starves the channel of gm*vgs.
    // In saturation Vs = Rs * 0.5 * beta * (Vg - Vs - Vt)^2, closed form
    // Vs = 1.5 - (-1 + sqrt(61))/20 = 1.15949 V.
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 5.0)]),
            elm(
                2,
                "mosfet",
                &[[200, 0], [100, 100], [0, 0]],
                &[("pnp", 1.0), ("threshold", 1.5), ("beta", 0.02)],
            ),
            elm(
                3,
                "voltage",
                &[[200, 100], [200, 0]],
                &[("maxVoltage", 3.0)],
            ),
            elm(
                4,
                "resistor",
                &[[100, 100], [100, 200]],
                &[("resistance", 1000.0)],
            ),
            elm(5, "ground", &[[0, 100]], &[]),
            elm(6, "ground", &[[200, 100]], &[]),
            elm(7, "ground", &[[100, 200]], &[]),
        ],
        opts(1e-5, true),
    );
    let report = c.run(20);
    assert!(report.converged, "did not converge: {:?}", report.error);
    let vs = c.element_voltages()[3];
    assert!(close(vs, 1.15949, 1e-3), "follower source voltage was {vs}");
}

#[test]
fn spdt_voltage_source_closure_follows_the_selected_throw() {
    // A 2-throw SPDT whose common post is grounded: its voltage source runs
    // from ground to the *selected* throw, so the unknown must join the
    // selected throw's closure even though the element's first non-ground post
    // is the other throw. Position 1 selects throw 2, which hangs off a 10 V
    // source through a load resistor; throw 1 hangs off a 5 V source through
    // an idle resistor. The grounded common pins the selected throw to 0 V, so
    // the load carries 10 mA and the idle throw's network stays at rest.
    let c = &mut build(
        vec![
            elm(
                1,
                "switch2",
                &[[0, 100], [100, 100], [200, 100]],
                &[("throwCount", 2.0), ("position", 1.0)],
            ),
            elm(2, "ground", &[[0, 100]], &[]),
            // Independent network on throw 1: no current can flow, so the idle
            // resistor holds both its ends at the source potential.
            elm(
                3,
                "voltage",
                &[[100, 300], [100, 200]],
                &[("maxVoltage", 5.0)],
            ),
            elm(
                4,
                "resistor",
                &[[100, 300], [100, 100]],
                &[("resistance", 1000.0)],
            ),
            elm(5, "ground", &[[100, 200]], &[]),
            // Loaded network on throw 2.
            elm(
                6,
                "voltage",
                &[[300, 300], [300, 200]],
                &[("maxVoltage", 10.0)],
            ),
            elm(
                7,
                "resistor",
                &[[300, 300], [200, 100]],
                &[("resistance", 1000.0)],
            ),
            elm(8, "ground", &[[300, 200]], &[]),
        ],
        opts(1e-5, true),
    );
    let report = c.run(5);
    assert!(report.converged, "did not converge: {:?}", report.error);
    // The selected throw is pinned to the grounded common (0 V), so the load
    // resistor carries the full 10 mA of the 10 V source.
    assert!(
        close(c.element_currents()[6], -0.01, 1e-9),
        "load current was {}, expected -10 mA",
        c.element_currents()[6]
    );
    assert!(
        close(c.element_voltages()[6], -10.0, 1e-9),
        "load voltage was {}, expected -10 V",
        c.element_voltages()[6]
    );
    // The idle throw's network is untouched: the resistor carries no current.
    assert!(
        close(c.element_currents()[3], 0.0, 1e-12),
        "idle resistor carried {}, expected none",
        c.element_currents()[3]
    );
}

/// The cross-switch divider: a 10 V rail driving one pole, a 5 V rail the
/// other, each feeding its own load through the switch. Throwing the lever
/// swaps which rail drives which load, with each closed pole an ideal short.
fn cross_switch_divider_circuit() -> Circuit {
    build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 10.0)]),
            elm(2, "ground", &[[0, 100]], &[]),
            elm(
                3,
                "crossSwitch",
                &[[0, 0], [112, -16], [0, 48], [112, 64]],
                &[("position", 0.0)],
            ),
            elm(
                4,
                "resistor",
                &[[112, -16], [112, -64]],
                &[("resistance", 1000.0)],
            ),
            elm(5, "ground", &[[112, -64]], &[]),
            elm(6, "voltage", &[[0, 80], [0, 48]], &[("maxVoltage", 5.0)]),
            elm(7, "ground", &[[0, 80]], &[]),
            elm(
                8,
                "resistor",
                &[[112, 64], [112, 128]],
                &[("resistance", 2000.0)],
            ),
            elm(9, "ground", &[[112, 128]], &[]),
        ],
        opts(1e-5, true),
    )
}

#[test]
fn cross_switch_crosses_the_pole_pairs_on_throw() {
    // A cross switch is two independent pole pairs whose throw pairing swaps
    // with the lever: posts (0,1)+(2,3) straight through at position 0,
    // crossed to (0,3)+(2,1) at position 1. Each pole is an ideal short
    // (a 0 V voltage source), so position 0 ties the 10 V rail to the 1k
    // load and the 5 V rail to the 2k load, each load sitting at its rail's
    // full potential; throwing the lever swaps which rail drives which load.
    let c = &mut cross_switch_divider_circuit();
    c.run(5);
    assert!(
        close(c.element_voltages()[3], 10.0, 1e-9),
        "1k load at position 0 was {} V, expected 10 V",
        c.element_voltages()[3]
    );
    assert!(
        close(c.element_voltages()[7], 5.0, 1e-9),
        "2k load at position 0 was {} V, expected 5 V",
        c.element_voltages()[7]
    );
    assert!(
        close(c.element_currents()[3], 0.01, 1e-9),
        "1k load current at position 0 was {} A, expected 10 mA",
        c.element_currents()[3]
    );
    assert!(
        close(c.element_currents()[7], 0.0025, 1e-9),
        "2k load current at position 0 was {} A, expected 2.5 mA",
        c.element_currents()[7]
    );

    // Position 1 crosses the throws, so the 10 V rail now drives the 2k load
    // and the 5 V rail the 1k.
    assert!(c.set_state(3, 1), "cross switch refused position 1");
    c.run(5);
    assert!(
        close(c.element_voltages()[3], 5.0, 1e-9),
        "1k load at position 1 was {} V, expected 5 V",
        c.element_voltages()[3]
    );
    assert!(
        close(c.element_voltages()[7], 10.0, 1e-9),
        "2k load at position 1 was {} V, expected 10 V",
        c.element_voltages()[7]
    );
    assert!(
        close(c.element_currents()[3], 0.005, 1e-9),
        "1k load current at position 1 was {} A, expected 5 mA",
        c.element_currents()[3]
    );
    assert!(
        close(c.element_currents()[7], 0.005, 1e-9),
        "2k load current at position 1 was {} A, expected 5 mA",
        c.element_currents()[7]
    );

    // And back to straight-through, exercising the re-analyse path in both
    // directions.
    assert!(c.set_state(3, 0), "cross switch refused position 0");
    c.run(5);
    assert!(
        close(c.element_voltages()[3], 10.0, 1e-9),
        "1k load after re-throw was {} V, expected 10 V",
        c.element_voltages()[3]
    );
    assert!(
        close(c.element_voltages()[7], 5.0, 1e-9),
        "2k load after re-throw was {} V, expected 5 V",
        c.element_voltages()[7]
    );
}

#[test]
fn transformer_matrix_connects_couples_a_loaded_secondary_at_dc() {
    // The DC operating point stays well posed with a heavy load on the
    // secondary: since the family gained its own DC branch every winding is
    // a 1e-6 ohm short there and the mutual VCCS terms are dropped, so the
    // 1 ohm load divides against the near-short and reads zero. The solve
    // must still converge without pinning or singularity, which is what a
    // broken stamp guard would break. The coupled divider itself is AC
    // behaviour now, covered by the loaded-secondary transient ratio in
    // `transformer_current_ratio_loaded_secondary`; `matrix_connects` keeps
    // every winding in one closure for that transient's per-closure solves.
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 10.0)]),
            elm(
                2,
                "transformer",
                &[[0, 0], [100, 0], [0, 100], [100, 100]],
                &[("inductance", 4.0), ("ratio", 0.1), ("couplingCoef", 0.999)],
            ),
            elm(3, "ground", &[[0, 100]], &[]),
            elm(4, "ground", &[[100, 100]], &[]),
            elm(
                5,
                "resistor",
                &[[100, 0], [100, 100]],
                &[("resistance", 1.0)],
            ),
        ],
        opts(1e-5, true),
    );
    assert_eq!(c.error(), None, "the DC operating point did not solve");
    // The transformer reads V(post0) - V(post1) = V1 - V2, so V2 = 10 - that.
    let v2 = 10.0 - c.element_voltages()[1];
    assert!(
        close(v2, 0.0, 1e-9),
        "loaded secondary operating point was {v2}, expected the shorted steady state"
    );
}

// ─── Three-phase motor ───────────────────────────────────────────────────────

// ─── Custom transformer coil cap ───

/// A 32-coil custom transformer: every coil one turn, coil `i` spanning posts
/// `(2i, 2i+1)` at x = 32i and 32i+16, spaced so neighbouring coils cannot
/// merge at a shared coordinate. Coil 0 hangs across the 10 V source, the
/// remaining far posts are grounded, so each open winding reads k·V1 = 9.99 V
/// exactly as the two-coil case does.
fn at_cap_spec() -> CircuitSpec {
    let mut posts: Vec<[i32; 2]> = Vec::new();
    for i in 0..32usize {
        posts.push([(32 * i) as i32, 0]);
        posts.push([(32 * i + 16) as i32, 0]);
    }
    let mut elements = vec![elm(
        1,
        "customTransformer",
        &posts,
        &[("inductance", 4.0), ("couplingCoef", 0.999)],
    )];
    elements[0].label = Some(vec!["1"; 32].join(","));
    elements.push(elm(
        2,
        "voltage",
        &[[0, 200], [0, 0]],
        &[("maxVoltage", 10.0)],
    ));
    elements.push(elm(3, "ground", &[[0, 200]], &[]));
    for i in 0..32usize {
        elements.push(elm(
            10 + i as u32,
            "ground",
            &[[(32 * i + 16) as i32, 0]],
            &[],
        ));
    }
    CircuitSpec {
        preserve_run: false,
        elements,
        options: Some(opts(1e-5, false)),
        scopes: vec![
            tr_scope(1, ScopeValue::NodeVoltage, 2),
            tr_scope(1, ScopeValue::NodeVoltage, 4),
            tr_scope(1, ScopeValue::NodeVoltage, 30),
            tr_scope(1, ScopeValue::NodeVoltage, 62),
        ],
    }
}

#[test]
fn custom_transformer_over_the_coil_cap_is_rejected_by_name() {
    // 33 comma coils sits just above MAX_CUSTOM_COILS; the rejection must
    // name kind, id and both counts.
    let mut spec = at_cap_spec();
    spec.elements[0].label = Some(vec!["1"; 33].join(","));
    let err = Circuit::new()
        .set_circuit(&spec)
        .expect_err("33 coils must be rejected");
    assert_eq!(
        err,
        "custom transformer (id 1) has 33 coils, above the limit of 32"
    );
}

#[test]
fn custom_transformer_at_the_coil_cap_builds_and_solves() {
    // The boundary-legal case: set_circuit accepting the element is itself
    // the post-count proof (the build compares the model's posts against this
    // spec's 64), and the open windings must still read their k-scaled
    // secondary voltage after stepping.
    let mut c = Circuit::new();
    c.set_circuit(&at_cap_spec()).expect("32 coils must build");
    let report = c.run(5);
    assert!(
        report.converged && c.error().is_none(),
        "the capped transformer failed to step: {:?}",
        c.error()
    );
    for scope in 0..4 {
        let v = last_sample(&c, scope);
        assert!(
            close(v, 9.99, 1e-4),
            "open winding behind scope {scope} read {v}, expected 9.99"
        );
        let snap = c.scopes()[scope].snapshot();
        assert!(snap.iter().all(|s| s.is_finite()), "non-finite sample");
    }
}
