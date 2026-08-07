//! End-to-end checks against circuits with known analytic answers.
//!
//! These are the real regression net for the solver: if stamping signs,
//! companion models or Newton limiting break, one of these stops matching
//! theory.

use std::collections::HashMap;
use std::f64::consts::PI;

use circuit_core::{Circuit, CircuitSpec, ElementSpec, ScopeSpec, ScopeValue, SimOptions};

fn elm(id: u32, kind: &str, posts: &[[i32; 2]], params: &[(&str, f64)]) -> ElementSpec {
    ElementSpec {
        id,
        kind: kind.into(),
        posts: posts.to_vec(),
        params: params
            .iter()
            .map(|(k, v)| (k.to_string(), *v))
            .collect::<HashMap<_, _>>(),
        label: None,
        flags: 0,
    }
}

/// Like [`elm`], with file-format flags set, for the load-time conversions
/// that only exist on a raw spec.
fn elm_flags(
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

fn build(elements: Vec<ElementSpec>, options: SimOptions) -> Circuit {
    build_with(elements, options, Vec::new())
}

fn build_with(elements: Vec<ElementSpec>, options: SimOptions, scopes: Vec<ScopeSpec>) -> Circuit {
    let spec = CircuitSpec {
        elements,
        options: Some(options),
        scopes,
    };
    let mut c = Circuit::new();
    c.set_circuit(&spec).expect("circuit should analyse");
    c
}

fn opts(time_step: f64, dc: bool) -> SimOptions {
    SimOptions {
        time_step,
        steps_per_frame: 1,
        max_subiterations: 100,
        dc_operating_point: dc,
    }
}

fn close(a: f64, b: f64, tol: f64) -> bool {
    (a - b).abs() <= tol
}

#[test]
fn resistive_divider_splits_the_supply() {
    // 10 V across two equal resistors: the midpoint sits at half the supply,
    // and the loop current is V/(R1+R2).
    let c = &mut build(
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
                "resistor",
                &[[100, 0], [100, 100]],
                &[("resistance", 1000.0)],
            ),
            elm(4, "wire", &[[100, 100], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
        ],
        opts(1e-5, true),
    );
    c.run(5);

    let volts = c.element_voltages();
    let amps = c.element_currents();
    assert!(close(volts[2], 5.0, 1e-9), "midpoint was {}", volts[2]);
    assert!(close(amps[1], 5e-3, 1e-12), "current was {}", amps[1]);
}

#[test]
fn fuse_below_its_rating_behaves_like_a_resistor() {
    // Same divider as above, but the second leg is a fuse rated so far past
    // any current this circuit can draw (I2t = 1e6) that it never blows: it
    // must match plain Ohm's law exactly, like a resistor of the same value.
    let c = &mut build(
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
                "fuse",
                &[[100, 0], [100, 100]],
                &[("resistance", 1000.0), ("i2t", 1e6)],
            ),
            elm(4, "wire", &[[100, 100], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
        ],
        opts(1e-5, true),
    );
    c.run(5);

    let volts = c.element_voltages();
    let amps = c.element_currents();
    assert!(close(volts[2], 5.0, 1e-9), "midpoint was {}", volts[2]);
    assert!(
        close(amps[1], 5e-3, 1e-12),
        "resistor current was {}",
        amps[1]
    );
    assert!(close(amps[2], 5e-3, 1e-12), "fuse current was {}", amps[2]);
}

#[test]
fn fuse_blows_under_sustained_overcurrent() {
    // A 1 ohm fuse straight across a 3 V source draws 3 A, which is well past
    // a 1 A^2*s rating: heat accumulates as i^2*dt every timestep and only
    // bleeds off at i2t/3 per second (FuseElm.java:153-162), so at 3 A it
    // nets +8.667 per second and crosses the 1.0 rating in well under a
    // second of simulated time. Once blown, the fuse is a ~1 GOhm resistor,
    // so the current collapses toward zero.
    let dt = 1e-3;
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 3.0)]),
            elm(
                2,
                "fuse",
                &[[0, 0], [0, 100]],
                &[("resistance", 1.0), ("i2t", 1.0)],
            ),
            elm(3, "ground", &[[0, 100]], &[]),
        ],
        opts(dt, false),
    );

    // One warm-up step: startIteration's first call sees the fuse's initial
    // current (0), so heat cannot have moved yet and the fuse should still
    // read as a plain 1 ohm resistor here.
    c.run(1);
    let amps = c.element_currents();
    assert!(
        close(amps[1], 3.0, 1e-6),
        "expected the intact fuse to draw 3 A, got {}",
        amps[1]
    );

    // Comfortably past the ~116 further steps the heat integral needs to
    // cross its 1.0 A^2*s rating at a steady 3 A.
    c.run(300);
    let amps = c.element_currents();
    assert!(
        amps[1].abs() < 1e-6,
        "expected the blown fuse's current to have collapsed toward zero, got {}",
        amps[1]
    );
}

/// Ports LampElm.java's resistance-vs-temperature curve
/// (`startIteration`, LampElm.java:168-184) so the expected value in each
/// assertion below comes from literally the same formula the engine runs,
/// not a hand-rounded constant. `dt` and the applied voltage must match the
/// circuit built alongside it exactly, since the discrete update is only
/// reproducible if both replicas take identical steps.
fn lamp_resistance_after(dt: f64, steps: u32, applied_v: f64, nom_pow: f64, nom_v: f64) -> f64 {
    const ROOM_TEMP: f64 = 300.0;
    let mut temp = ROOM_TEMP;
    let mut prev_power = 0.0;
    let mut resistance = 0.0;
    let cap = 1.57e-4 * nom_pow;
    let capw = cap; // warmTime/coolTime default to 0.4, same as the 0.4 baseline.
    let capc = cap;
    let cr = 2600.0 / nom_pow;
    for _ in 0..steps {
        let nom_r = nom_v * nom_v / nom_pow;
        let tp = temp.min(5390.0);
        resistance = nom_r
            * (1.26104 - 4.90662 * (17.1839 / tp - 0.00318794).sqrt() - 7.8569 / (tp - 187.56));
        temp += prev_power * dt / capw;
        temp -= dt * (temp - ROOM_TEMP) / (capc * cr);
        prev_power = applied_v * (applied_v / resistance);
    }
    resistance
}

#[test]
fn lamp_reads_its_cold_resistance_on_the_first_step() {
    // A default lamp (100 W @ 120 V) starts at room temperature, and
    // startIteration computes each step's resistance from `temp` *before*
    // advancing it, so the very first step must stamp exactly the
    // room-temperature point on the curve — about 7.2 ohms, roughly 1/20th
    // of the 144 ohm resistor a plain 100W/120V load would be. In series
    // with a 1k resistor, the divider current is V/(R1+R_cold).
    let dt = 1e-3;
    let r_cold = lamp_resistance_after(dt, 1, 10.0, 100.0, 120.0);
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 10.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(3, "lamp", &[[100, 0], [100, 100]], &[]),
            elm(4, "wire", &[[100, 100], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
        ],
        opts(dt, false),
    );
    c.run(1);
    let expected = 10.0 / (1000.0 + r_cold);
    let amps = c.element_currents();
    assert!(
        close(amps[1], expected, 1e-9),
        "expected {} A through the cold divider (R_cold = {} ohm), got {}",
        expected,
        r_cold,
        amps[1]
    );
    assert!(
        close(amps[2], expected, 1e-9),
        "lamp current should match the resistor's, got {}",
        amps[2]
    );
}

#[test]
fn lamp_settles_toward_its_warm_resistance_under_sustained_voltage() {
    // Drive a default lamp (100 W @ 120 V, 0.4 s warm-up and cool-down) at
    // its own rated voltage for 5 simulated seconds — more than ten times
    // the thermal time constant — and its resistance should have settled
    // close to its steady state (numerically, the discrete update above
    // converges to ~144.09 ohms, a hair above the 144 ohm a plain resistor
    // at the same rated power/voltage would be).
    let dt = 1e-3;
    let steps = 5000;
    let expected_r = lamp_resistance_after(dt, steps, 120.0, 100.0, 120.0);
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 120.0)]),
            elm(2, "lamp", &[[0, 0], [0, 100]], &[]),
            elm(3, "ground", &[[0, 100]], &[]),
        ],
        opts(dt, false),
    );
    c.run(steps);
    let expected_current = 120.0 / expected_r;
    let amps = c.element_currents();
    assert!(
        close(amps[1], expected_current, 1e-6),
        "expected {} A once warm (R = {} ohm), got {}",
        expected_current,
        expected_r,
        amps[1]
    );
}

/// Ports ThermistorNTCElm.java's temperature-to-resistance chain
/// (`calcB25100`/`temprFromSliderPos`/`calcResistance`,
/// ThermistorNTCElm.java:247-262) independently, so each assertion below
/// checks the engine against the same formula rather than a hand-rounded
/// constant.
fn thermistor_resistance(r25: f64, r50: f64, min_tempr: f64, max_tempr: f64, position: f64) -> f64 {
    const T0: f64 = 273.15;
    let b25100 = (r25.ln() - r50.ln()) / (1.0 / (T0 + 25.0) - 1.0 / (T0 + 50.0));
    let temperature = (position * (max_tempr - min_tempr) + min_tempr).round();
    (r25 * (b25100 * (1.0 / (temperature + T0) - 1.0 / (T0 + 25.0))).exp()).round()
}

#[test]
fn thermistor_at_its_default_position_reads_its_r25_rating() {
    // Default slider position (0.34 on -40..150) lands on 25 C exactly
    // (0.34*190-40 = 24.6, rounds to 25), which is the thermistor's own
    // calibration point, so its resistance should come back as exactly the
    // default r25 of 10000 ohm. In series with a 1k resistor across 10 V,
    // the divider current is V/(R1+R_thermistor).
    let expected_r = thermistor_resistance(10000.0, 3605.0, -40.0, 150.0, 0.34);
    assert!(
        close(expected_r, 10000.0, 1e-9),
        "sanity: default position should read the r25 point, got {expected_r}"
    );
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 10.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(3, "thermistor", &[[100, 0], [100, 100]], &[]),
            elm(4, "wire", &[[100, 100], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
        ],
        opts(1e-5, true),
    );
    c.run(5);
    let expected = 10.0 / (1000.0 + expected_r);
    let amps = c.element_currents();
    assert!(
        close(amps[1], expected, 1e-9),
        "expected {} A through the divider (R = {} ohm), got {}",
        expected,
        expected_r,
        amps[1]
    );
    assert!(
        close(amps[2], expected, 1e-9),
        "thermistor current should match the resistor's, got {}",
        amps[2]
    );
}

#[test]
fn thermistor_position_at_the_r50_calibration_point() {
    // Slider position that lands exactly on 50 C ((50-(-40))/190) should
    // read back the other calibration point, r50 = 3605 ohm, and the whole
    // NTC curve moves with `position` alone: nothing here depends on
    // current or a prior timestep, unlike Fuse/Lamp.
    let position = (50.0 - -40.0) / (150.0 - -40.0);
    let expected_r = thermistor_resistance(10000.0, 3605.0, -40.0, 150.0, position);
    assert!(
        close(expected_r, 3605.0, 1e-9),
        "sanity: 50C position should read the r50 point, got {expected_r}"
    );
    let c = &mut build(
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
                "thermistor",
                &[[100, 0], [100, 100]],
                &[("position", position)],
            ),
            elm(4, "wire", &[[100, 100], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
        ],
        opts(1e-5, true),
    );
    c.run(5);
    let expected = 10.0 / (1000.0 + expected_r);
    let amps = c.element_currents();
    assert!(
        close(amps[1], expected, 1e-9),
        "expected {} A through the divider (R = {} ohm), got {}",
        expected,
        expected_r,
        amps[1]
    );
}

/// Ports `LDRElm.java`'s `LuxFromSliderPos()`/`calcResistance()`
/// (`LDRElm.java`:219-222, :206-218) independently, so each assertion below
/// checks the engine against the same formula rather than a hand-rounded
/// constant.
fn ldr_resistance(position: f64) -> f64 {
    const MIN_LUX: f64 = 0.1;
    const MAX_LUX: f64 = 10000.0;
    let lux = MAX_LUX * position + MIN_LUX;
    ((MAX_LUX - lux + 1.0) * 10.0).round()
}

#[test]
fn ldr_at_its_default_position_is_dim_and_high_resistance() {
    // Default slider position 0.34 (LDRElm.java:29): lux = 10000*0.34+0.1 =
    // 3400.1, resistance = round((10000-3400.1+1)*10) = 66009 ohm. In series
    // with a 1k resistor across 10 V, the divider current is
    // V/(R1+R_ldr).
    let expected_r = ldr_resistance(0.34);
    assert!(
        close(expected_r, 66009.0, 1e-9),
        "sanity: default position should read 66009 ohm, got {expected_r}"
    );
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 10.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(3, "ldr", &[[100, 0], [100, 100]], &[]),
            elm(4, "wire", &[[100, 100], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
        ],
        opts(1e-5, true),
    );
    c.run(5);
    let expected = 10.0 / (1000.0 + expected_r);
    let amps = c.element_currents();
    assert!(
        close(amps[1], expected, 1e-9),
        "expected {} A through the divider (R = {} ohm), got {}",
        expected,
        expected_r,
        amps[1]
    );
    assert!(
        close(amps[2], expected, 1e-9),
        "ldr current should match the resistor's, got {}",
        amps[2]
    );
}

#[test]
fn ldr_at_full_brightness_is_low_resistance() {
    // Slider at position 1.0 (upstream's slider tops out at 0.9901, but 1.0
    // keeps this a round number, matching the default-position test's use of
    // 0.34): lux = 10000*1+0.1 = 10000.1, giving the lowest resistance the
    // model produces (round((10000-10000.1+1)*10) = round(9.0) = 9 ohm).
    // Confirms resistance moves with `position` alone, in the opposite
    // direction from lux, and nothing here depends on current or a prior
    // timestep, unlike Fuse/Lamp.
    let expected_r = ldr_resistance(1.0);
    assert!(
        close(expected_r, 9.0, 1e-9),
        "sanity: position 1.0 (brightest) should read 9 ohm, got {expected_r}"
    );
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 10.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(3, "ldr", &[[100, 0], [100, 100]], &[("position", 1.0)]),
            elm(4, "wire", &[[100, 100], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
        ],
        opts(1e-5, true),
    );
    c.run(5);
    let expected = 10.0 / (1000.0 + expected_r);
    let amps = c.element_currents();
    assert!(
        close(amps[1], expected, 1e-9),
        "expected {} A through the divider (R = {} ohm), got {}",
        expected,
        expected_r,
        amps[1]
    );
}

#[test]
fn unequal_divider_matches_the_ratio() {
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 9.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 2000.0)],
            ),
            elm(
                3,
                "resistor",
                &[[100, 0], [100, 100]],
                &[("resistance", 1000.0)],
            ),
            elm(4, "wire", &[[100, 100], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
        ],
        opts(1e-5, true),
    );
    c.run(5);
    // 9 V * 1k / 3k = 3 V.
    assert!(close(c.element_voltages()[2], 3.0, 1e-9));
}

#[test]
fn rc_network_charges_on_its_time_constant() {
    // tau = 1 k * 1 uF = 1 ms. After one tau a step response reaches
    // 1 - 1/e of the supply.
    let dt = 1e-6;
    let c = &mut build(
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
        opts(dt, false),
    );

    c.run(1000); // one time constant
    let v = c.element_voltages()[2];
    let expected = 10.0 * (1.0 - (-1.0f64).exp());
    assert!(close(v, expected, 0.02), "got {v}, expected {expected}");

    c.run(4000); // five time constants total
    let v = c.element_voltages()[2];
    assert!(close(v, 10.0, 0.1), "got {v} after 5 tau");
}

/// 10 V behind 900 ohm into a capacitor with a 100 ohm ESR, built either with
/// the DC operating point on or off. Both matter: `circuits.rs` defaults to
/// off, but the app hardcodes `dcOperatingPoint: true`
/// (`web/src/engine/simulator.ts`), and the internal node exists for the whole
/// run either way, so the DC pass is the only place this port has to stamp
/// something upstream does not (upstream's `getInternalNodeCount()` returns 0
/// under DC and the node simply is not there).
fn esr_rc_circuit(dt: f64, series_r: f64, dc: bool) -> Circuit {
    build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 10.0)]),
            elm(2, "resistor", &[[0, 0], [100, 0]], &[("resistance", 900.0)]),
            elm(
                3,
                "capacitor",
                &[[100, 0], [100, 100]],
                &[
                    ("capacitance", 1e-6),
                    ("seriesResistance", series_r),
                    ("initialVoltage", 0.0),
                ],
            ),
            elm(4, "wire", &[[100, 100], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
        ],
        opts(dt, dc),
    )
}

/// The step response `esr_rc_circuit` must produce, whichever way it was
/// built. A capacitor's ESR is a real resistor to a real internal plate node
/// (CapacitorElm.java:159, :173-174), so it lands in series with the rest of
/// the loop: tau = (R + R_s)*C = 1 k * 1 uF = 1 ms, unchanged in shape from an
/// ideal cap behind a 1 k resistor.
///
/// The element's *terminal* voltage is the plate voltage plus the i*R_s drop,
/// which makes the response start at 1 V rather than 0:
///   V(t) = V_c + i*R_s = 10(1 - e^-t/tau) + (10/1000)e^-t/tau * 100
///        = 10 - 9*e^(-t/tau)
/// Folding R_s into the companion conductance instead, as this port used to,
/// gives C_eff = C/(1 + 2*C*R_s/dt) = C/201: the cap would be fully charged
/// with zero current long before the first assertion here.
fn assert_esr_step_response(c: &mut Circuit, series_r: f64) {
    let tau = (900.0 + series_r) * 1e-6;

    c.run(1000); // one time constant
    let v = c.element_voltages()[2];
    let expected_v = 10.0 - 9.0 * (-1.0f64).exp();
    assert!(close(v, expected_v, 0.02), "got {v}, expected {expected_v}");

    // The branch current is the same through the ESR and the plates.
    let i = c.element_currents()[2];
    let expected_i = 10.0 * 1e-6 / tau * (-1.0f64).exp();
    assert!(
        close(i, expected_i, 1e-4),
        "got {i} A, expected {expected_i}"
    );

    c.run(5000); // six time constants total
    let v = c.element_voltages()[2];
    assert!(v > 9.9, "got {v} after 6 tau");
}

#[test]
fn capacitor_series_resistance_controls_charging() {
    assert_esr_step_response(&mut esr_rc_circuit(1e-6, 100.0, false), 100.0);
}

#[test]
fn capacitor_series_resistance_survives_the_dc_operating_point() {
    // The same circuit on the path the app actually takes: the frontend
    // hardcodes `dcOperatingPoint: true`. Node assignment runs once, before
    // the DC solve, so the internal plate node is allocated for the DC matrix
    // too and its row would be all zeros without the `resistor(n1, cap_node,
    // R_s)` this port adds, which the dense LU rejects as singular. Upstream
    // never meets this: its `getInternalNodeCount()` returns 0 under DC, so
    // the node is simply not there.
    //
    // The failure is quiet, which is why it needs its own test.
    // `solve_operating_point` discards its step report and `simulator.ts`
    // never reads `error()` after a build, so a singular DC solve surfaces
    // nowhere: the transient still runs, just from an operating point that was
    // never solved.
    let c = &mut esr_rc_circuit(1e-6, 100.0, true);
    assert_eq!(c.error(), None, "the DC operating point did not solve");
    assert!(c.warnings().is_empty(), "warnings: {:?}", c.warnings());
    assert_esr_step_response(c, 100.0);
}

/// 10 V behind 1 k into a capacitor whose file said it was charged to 5 V.
fn restored_charge_circuit(dt: f64, dc: bool) -> Circuit {
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

#[test]
fn capacitor_restores_saved_volt_diff_on_load() {
    // The `voltDiff` token is the charge a file was saved with
    // (CapacitorElm.java:44), so the very first solve must already see it.
    // With v_prev = 5 the trapezoidal companion is geq = 2C/dt = 2 S and
    // ieq = geq*v_prev = 10 A, which holds the node at
    // (10/1000 + 10)/(1/1000 + 2) = 5.0025 V. Starting from an uncharged cap
    // instead would put it near (10/1000)/2 = 5 mV.
    let c = &mut restored_charge_circuit(1e-6, false);
    c.run(1);
    let v = c.element_voltages()[2];
    assert!(close(v, 5.0, 0.05), "restored charge read back as {v}");
}

#[test]
fn capacitor_restored_charge_survives_the_dc_operating_point() {
    // The path the app actually takes, and the reason `step_finished` skips
    // its state update while `ctx.dc_analysis` is set. The DC pass solves the
    // capacitor as a 100 M open, so it puts this node at nearly the full 10 V;
    // without the guard that solve would be written straight into `v_prev` and
    // the restored 5 V would be gone before the first transient step. Delete
    // the guard and this is the only test that notices.
    let c = &mut restored_charge_circuit(1e-6, true);
    c.run(1);
    let v = c.element_voltages()[2];
    assert!(close(v, 5.0, 0.05), "restored charge read back as {v}");
}

#[test]
fn capacitor_default_initial_voltage_starts_an_lc_tank() {
    // No initialVoltage token at all: the default is upstream's 1e-3, not 0,
    // precisely so a fresh tank oscillates instead of sitting dead
    // (CapacitorElm.java:38, :46 and the comment in `reset()` at :60).
    // With L = C = 1 uF, sqrt(C/L) = 1, so a quarter period in the whole
    // 1 mV of charge is inductor current: I = V0*sqrt(C/L) = 1 mA.
    let l: f64 = 1e-6;
    let cap: f64 = 1e-6;
    let period = 2.0 * PI * (l * cap).sqrt();
    let dt = period / 2000.0;

    let c = &mut build(
        vec![
            elm(1, "capacitor", &[[0, 0], [0, 100]], &[("capacitance", cap)]),
            elm(2, "inductor", &[[0, 0], [100, 0]], &[("inductance", l)]),
            elm(3, "wire", &[[100, 0], [100, 100]], &[]),
            elm(4, "wire", &[[100, 100], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
        ],
        opts(dt, false),
    );

    c.run(500); // a quarter period
    let i = c.element_currents()[1];
    let expected = 1e-3 * (cap / l).sqrt();
    assert!(
        close(i, expected, 3e-4),
        "quarter-period inductor current {i}, expected {expected}"
    );
}

#[test]
fn polarized_capacitor_charges_like_the_plain_one() {
    // PolarCapacitorElm is electrically identical to CapacitorElm; the
    // maxNegativeVoltage rating is a UI-only warning threshold, so the same
    // tau = 1 k * 1 uF = 1 ms step response must come out unchanged.
    let dt = 1e-6;
    let c = &mut build(
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
                "polarizedCapacitor",
                &[[100, 0], [100, 100]],
                &[
                    ("capacitance", 1e-6),
                    ("initialVoltage", 0.0),
                    ("maxNegativeVoltage", 1.0),
                ],
            ),
            elm(4, "wire", &[[100, 100], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
        ],
        opts(dt, false),
    );

    c.run(1000); // one time constant
    let v = c.element_voltages()[2];
    let expected = 10.0 * (1.0 - (-1.0f64).exp());
    assert!(close(v, expected, 0.02), "got {v}, expected {expected}");

    c.run(4000); // five time constants total
    let v = c.element_voltages()[2];
    assert!(close(v, 10.0, 0.1), "got {v} after 5 tau");
}

#[test]
fn param_change_preserves_sim_time() {
    // Changing a resistance takes the live set_param path, which must not
    // rewind the clock; only a full set_circuit may.
    let dt = 1e-6;
    let c = &mut build(
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
        opts(dt, false),
    );
    c.run(1000); // one time constant, t = 1 ms
    let t = c.time();
    assert!(t > 0.0, "circuit never advanced");

    assert!(c.set_param(2, "resistance", 2000.0));
    assert_eq!(c.time(), t, "param edit rewound the clock");
}

#[test]
fn capacitor_charge_survives_a_param_change() {
    // Doubling the resistance must leave the capacitor voltage untouched
    // (the charge is state, not re-derived) while the continued charging
    // follows the new tau = 2 ms instead of the old 1 ms.
    let dt = 1e-6;
    let c = &mut build(
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
        opts(dt, false),
    );

    c.run(1000); // one old time constant
    let v_before = c.element_voltages()[2];
    let expected = 10.0 * (1.0 - (-1.0f64).exp());
    assert!(close(v_before, expected, 0.02), "got {v_before}");

    assert!(c.set_param(2, "resistance", 2000.0));
    let v_after = c.element_voltages()[2];
    assert!(
        close(v_after, v_before, 1e-12),
        "charge moved on edit: {v_after} vs {v_before}"
    );

    // One old-tau more (1 ms) at the new tau (2 ms): the remaining gap to the
    // supply shrinks by exp(-1/2) instead of exp(-1).
    c.run(1000);
    let v = c.element_voltages()[2];
    let expected = 10.0 - (10.0 - v_before) * (-0.5f64).exp();
    assert!(close(v, expected, 0.02), "got {v}, expected {expected}");
}

#[test]
fn set_param_rejects_unknown_ids_and_names() {
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 10.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(3, "ground", &[[0, 100]], &[]),
        ],
        opts(1e-5, true),
    );
    // No element carries this id.
    assert!(!c.set_param(99, "resistance", 2000.0));
    // The resistor has no such parameter; the UI falls back to a full reload.
    assert!(!c.set_param(2, "bogus", 2000.0));
}

#[test]
fn rl_network_settles_to_ohms_law() {
    // An inductor is a short at DC, so the steady-state current is V/R.
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 5.0)]),
            elm(2, "resistor", &[[0, 0], [100, 0]], &[("resistance", 100.0)]),
            elm(
                3,
                "inductor",
                &[[100, 0], [100, 100]],
                &[("inductance", 1e-3)],
            ),
            elm(4, "wire", &[[100, 100], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
        ],
        opts(1e-7, false),
    );
    // tau = L/R = 10 us; run well past it.
    c.run(2000);
    let i = c.element_currents()[1];
    assert!(close(i, 0.05, 1e-4), "settled current was {i}");
}

#[test]
fn saturating_inductor_follows_the_analytic_curve() {
    // A saturating inductor substitutes L_eff = L/(1 + (I/Isat)^2) for L
    // (Inductor.java:54-60), so the RL step response is no longer a simple
    // exponential. With x = I/Isat and x0 = V0/(R*Isat), the curve separates
    // to dt' = (x0-x)(1+x^2) dx with t' = t*R/L0, which integrates to
    // t' = 1/(1+x0^2) * [ln x0 - ln(x0-x) + (1/2)ln(1+x^2) + x0 atan x].
    // At x = 1 (I = Isat), with x0 = 2 (20 V behind 1000 ohm, Isat = 0.01):
    // t' = (1/5) * [ln2 + (1/2)ln2 + 2*atan(1)] = 0.522103, so
    // t = 0.522103 * L0/R = 5.22103e-7 s, which is 522 steps at dt = 1e-9.
    let dt = 1e-9;
    let steps = 522;
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 20.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(
                3,
                "inductor",
                &[[100, 0], [100, 100]],
                &[("inductance", 1e-3), ("saturationCurrent", 0.01)],
            ),
            elm(4, "wire", &[[100, 100], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
        ],
        opts(dt, false),
    );
    c.run(steps);
    let amps = c.element_currents();
    assert!(
        close(amps[2], 0.01, 2e-4),
        "saturating inductor at Isat: got {}, expected 0.01",
        amps[2]
    );
}

#[test]
fn linear_inductor_still_follows_v_over_l() {
    // The same RL network without a saturation current stays linear, so at
    // the same time the saturating test reaches Isat it must still read the
    // plain exponential I = (V/R)(1 - e^(-t/tau)), tau = L/R = 1e-6. The gap
    // between the 0.01 and this 8.14e-3 is what the saturation collapse
    // produces; on the old linear-only code the saturating assertion above
    // would read this value instead.
    let dt = 1e-9;
    let steps = 522;
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 20.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(
                3,
                "inductor",
                &[[100, 0], [100, 100]],
                &[("inductance", 1e-3)],
            ),
            elm(4, "wire", &[[100, 100], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
        ],
        opts(dt, false),
    );
    c.run(steps);
    let expected = 0.02 * (1.0 - (-0.522103f64).exp());
    let amps = c.element_currents();
    assert!(
        close(amps[2], expected, 2e-4),
        "linear inductor: got {}, expected {}",
        amps[2],
        expected
    );
}

#[test]
fn inductor_restores_saved_current_on_load() {
    // The saved `current` token is the running state the file was saved with
    // (InductorElm.java:42), so a loaded circuit continues from it instead of
    // from zero. With i_prev = 0.03 the trapezoidal companion source holds
    // the current near 0.03 on the first step (the DC target is 5/100 = 0.05,
    // so it only climbs (dt/L)*V = 3e-4), while seeding from initialCurrent
    // = 0 would leave it near (dt/2L)*V = 2.5e-4.
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 5.0)]),
            elm(2, "resistor", &[[0, 0], [100, 0]], &[("resistance", 100.0)]),
            elm(
                3,
                "inductor",
                &[[100, 0], [100, 100]],
                &[("inductance", 1e-3), ("current", 0.03)],
            ),
            elm(4, "wire", &[[100, 100], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
        ],
        opts(1e-7, false),
    );
    c.run(1);
    let amps = c.element_currents();
    assert!(
        close(amps[2], 0.03, 1e-3),
        "saved current not restored: got {}, expected 0.03",
        amps[2]
    );
}

#[test]
fn inductor_uses_initial_current_when_no_saved_state() {
    // Old files predate the running `current` token, so the initial current
    // has to stand in as the load-time state, exactly as upstream's `reset()`
    // does (InductorElm.java:95-99). Same circuit and same expected value as
    // the saved-state test, via a different param.
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 5.0)]),
            elm(2, "resistor", &[[0, 0], [100, 0]], &[("resistance", 100.0)]),
            elm(
                3,
                "inductor",
                &[[100, 0], [100, 100]],
                &[("inductance", 1e-3), ("initialCurrent", 0.03)],
            ),
            elm(4, "wire", &[[100, 100], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
        ],
        opts(1e-7, false),
    );
    c.run(1);
    let amps = c.element_currents();
    assert!(
        close(amps[2], 0.03, 1e-3),
        "initial current not used: got {}, expected 0.03",
        amps[2]
    );
}

#[test]
fn lc_tank_oscillates_at_its_resonant_frequency() {
    // A charged capacitor across an inductor rings at 1/(2*pi*sqrt(LC)).
    // Trapezoidal integration conserves energy well enough that the peak
    // returns close to its starting value after a full period.
    let l: f64 = 1e-3;
    let cap: f64 = 1e-6;
    let period = 2.0 * PI * (l * cap).sqrt();
    let dt = period / 2000.0;

    let c = &mut build(
        vec![
            elm(
                1,
                "capacitor",
                &[[0, 0], [0, 100]],
                &[("capacitance", cap), ("initialVoltage", 1.0)],
            ),
            elm(2, "inductor", &[[0, 0], [100, 0]], &[("inductance", l)]),
            elm(3, "wire", &[[100, 0], [100, 100]], &[]),
            elm(4, "wire", &[[100, 100], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
        ],
        opts(dt, false),
    );

    // A quarter period in, the energy should have moved into the inductor.
    c.run(500);
    let v_quarter = c.element_voltages()[0];
    assert!(v_quarter.abs() < 0.1, "quarter-period voltage {v_quarter}");

    // A full period in, it should be back on the capacitor.
    c.run(1500);
    let v_full = c.element_voltages()[0];
    assert!(close(v_full, 1.0, 0.05), "full-period voltage {v_full}");
}

#[test]
fn diode_conducts_forward_and_blocks_reverse() {
    let forward = |source_volts: f64| {
        let c = &mut build(
            vec![
                elm(
                    1,
                    "voltage",
                    &[[0, 100], [0, 0]],
                    &[("maxVoltage", source_volts)],
                ),
                elm(
                    2,
                    "resistor",
                    &[[0, 0], [100, 0]],
                    &[("resistance", 1000.0)],
                ),
                elm(3, "diode", &[[100, 0], [100, 100]], &[]),
                elm(4, "wire", &[[100, 100], [0, 100]], &[]),
                elm(5, "ground", &[[0, 100]], &[]),
            ],
            opts(1e-5, true),
        );
        c.run(20);
        (c.element_voltages()[2], c.element_currents()[1])
    };

    let (vd, i) = forward(5.0);
    // A silicon diode passing a few mA sits near its rated forward drop.
    assert!((0.5..0.9).contains(&vd), "forward drop was {vd}");
    assert!(close(i, (5.0 - vd) / 1000.0, 1e-5), "current was {i}");

    let (vd, i) = forward(-5.0);
    assert!(vd < -4.9, "reverse voltage was {vd}");
    assert!(i.abs() < 1e-6, "reverse leakage was {i}");
}

#[test]
fn zener_clamps_in_breakdown() {
    let c = &mut build(
        vec![
            // Reverse-bias a 5.6 V zener through 1 k from a 12 V supply.
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 12.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(
                3,
                "zener",
                &[[100, 100], [100, 0]],
                &[("breakdownVoltage", 5.6)],
            ),
            elm(4, "wire", &[[100, 100], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
        ],
        opts(1e-5, true),
    );
    c.run(30);
    // Cathode-to-anode voltage and the loop current are both analytic here:
    // solving 12 = 1000*I + zoffset + vt*ln(I/Is + 1) gives 6.394 mA at
    // 5.606 V, just above the rated knee because 6.4 mA is past the 5 mA the
    // offset was placed for.
    let v = -c.element_voltages()[2];
    assert!(close(v, 5.606, 0.05), "zener clamped at {v}");
    let ma = c.element_currents()[1] * 1000.0;
    assert!(close(ma, 6.394, 0.1), "loop current was {ma} mA");
}

#[test]
fn zener_breaks_down_at_its_rated_current() {
    // A current source drives the zener reverse at a known current. With the
    // breakdown branch on `vt` (not the emission-scaled vscale), the curve is
    // v = zoffset + vt*ln(I/Is + 1) with zoffset chosen so 5 mA sits at 5.6 V.
    // The 100 uA point is the discriminating one: the old vscale-based branch
    // puts it at 5.398 V, outside the 0.02 window. The 5 mA point checks the
    // offset formula is self-consistent.
    let reverse = |i: f64| {
        let c = &mut build(
            vec![
                elm(1, "current", &[[100, 100], [100, 0]], &[("current", i)]),
                elm(
                    2,
                    "zener",
                    &[[100, 100], [100, 0]],
                    &[("breakdownVoltage", 5.6)],
                ),
                elm(3, "wire", &[[100, 0], [0, 0]], &[]),
                elm(4, "ground", &[[0, 0]], &[]),
            ],
            opts(1e-5, true),
        );
        c.run(20);
        -c.element_voltages()[1]
    };

    let knee = reverse(1e-4);
    assert!(close(knee, 5.499, 0.02), "at 100 uA reverse got {knee}");
    let rated = reverse(5e-3);
    assert!(close(rated, 5.6, 0.01), "at 5 mA reverse got {rated}");
}

#[test]
fn zener_forward_branch_matches_the_diode() {
    // 1 mA forward through the zener. Forward, a zener is a plain Shockley
    // diode, so the drop is vscale*ln(I/Is + 1) = 0.4486 V, the same value the
    // bare diode's knee test asserts at the same current. That pins the
    // forward branch to `vscale` and the derived `leakage`: putting the
    // breakdown branch's `vt` on the forward exponential would halve it to
    // 0.2243 V. It does not pin the `v < 0` gate, which is unobservable here
    // because the breakdown exponential is ~e^-206 at a positive drop.
    let c = &mut build(
        vec![
            elm(1, "current", &[[0, 0], [100, 0]], &[("current", 1e-3)]),
            elm(
                2,
                "zener",
                &[[100, 0], [100, 100]],
                &[("breakdownVoltage", 5.6)],
            ),
            elm(3, "wire", &[[100, 100], [0, 0]], &[]),
            elm(4, "ground", &[[0, 0]], &[]),
        ],
        opts(1e-5, true),
    );
    c.run(20);
    let drop = c.element_voltages()[1];
    assert!(close(drop, 0.4486, 5e-3), "forward drop was {drop}");
}

#[test]
fn diode_knee_matches_upstream_default_model() {
    // A current source forces a known current through a bare diode, so the
    // terminal voltage is vscale*ln(I/Is + 1) with the upstream "default"
    // model: Is = 1.7143528192808883e-7, n = 2, vscale = 2*vt = 0.05173.
    // Three points pin both Is and n; the old port model (Is = 1e-14,
    // n ~ 0.97) misses all three.
    let knee = |i: f64| {
        let c = &mut build(
            vec![
                elm(1, "current", &[[0, 0], [100, 0]], &[("current", i)]),
                elm(2, "diode", &[[100, 0], [100, 100]], &[]),
                elm(3, "wire", &[[100, 100], [0, 0]], &[]),
                elm(4, "ground", &[[0, 0]], &[]),
            ],
            opts(1e-5, true),
        );
        c.run(20);
        c.element_voltages()[1]
    };

    assert!(
        close(knee(1e-4), 0.32954, 5e-3),
        "at 100 uA got {}",
        knee(1e-4)
    );
    assert!(
        close(knee(1e-3), 0.4486, 5e-3),
        "at 1 mA got {}",
        knee(1e-3)
    );
    assert!(
        close(knee(1e-2), 0.56768, 5e-3),
        "at 10 mA got {}",
        knee(1e-2)
    );
}

#[test]
fn diode_series_resistance_drops_the_voltage() {
    // Same current-source loop with a 1 k series resistance inside the diode.
    // The junction still sits at 0.4486 V (1 mA through the default model), so
    // the terminal drop is 0.4486 + 1e-3*1000 = 1.4486 V and the current is
    // still 1 mA. Without the internal node + resistor path the terminal
    // voltage would read 0.4486 V.
    let c = &mut build(
        vec![
            elm(1, "current", &[[0, 0], [100, 0]], &[("current", 1e-3)]),
            elm(
                2,
                "diode",
                &[[100, 0], [100, 100]],
                &[("seriesResistance", 1000.0)],
            ),
            elm(3, "wire", &[[100, 100], [0, 0]], &[]),
            elm(4, "ground", &[[0, 0]], &[]),
        ],
        opts(1e-5, true),
    );
    c.run(20);
    assert!(
        close(c.element_voltages()[1], 1.4486, 1e-2),
        "terminal drop was {}",
        c.element_voltages()[1]
    );
    assert!(
        close(c.element_currents()[1], 1e-3, 1e-6),
        "current was {}",
        c.element_currents()[1]
    );
}

#[test]
fn diode_param_edits_take_the_live_path() {
    // A forward-drop edit must apply via set_param without rewinding the
    // clock, while seriesResistance changes internal_node_count and must be
    // rejected so the caller falls back to a full rebuild.
    let c = &mut build(
        vec![
            elm(1, "current", &[[0, 0], [100, 0]], &[("current", 1e-3)]),
            elm(2, "diode", &[[100, 0], [100, 100]], &[]),
            elm(3, "wire", &[[100, 100], [0, 0]], &[]),
            elm(4, "ground", &[[0, 0]], &[]),
        ],
        opts(1e-5, true),
    );
    c.run(20);
    let t = c.time();
    assert!(t > 0.0, "circuit never advanced");

    assert!(c.set_param(2, "forwardVoltage", 1.0));
    assert_eq!(c.time(), t, "param edit rewound the clock");
    c.run(20);
    // Raising the forward drop to 1 V drops Is and lifts the knee.
    assert!(
        c.element_voltages()[1] > 0.5,
        "knee was {}",
        c.element_voltages()[1]
    );

    assert!(!c.set_param(2, "seriesResistance", 1000.0));
    assert!(!c.set_param(2, "bogus", 1.0));
}

#[test]
fn varactor_conducts_forward_and_blocks_reverse() {
    // VaractorElm extends DiodeElm and adds a capacitance in parallel
    // (VaractorElm.java:6); its own I-V behaviour should read the same as
    // the bare diode's, so this mirrors diode_conducts_forward_and_blocks_reverse
    // exactly, just with "varactor" swapped in for "diode". The forward
    // assertion keeps the diode test's tolerance: the 1 k resistor's
    // conductance (1e-3 S) dwarfs both the diode's forward conductance and
    // the varactor's own default capacitance's companion conductance
    // (2*4e-12/1e-5 = 8e-7 S). The reverse assertion also matches the bare
    // diode's tolerance (1e-6): the capacitance's own Norton current source
    // settles the branch back to the diode-only reverse leakage well within
    // the 20 steps this test runs, so it needs no extra slack over the plain
    // diode test.
    let forward = |source_volts: f64| {
        let c = &mut build(
            vec![
                elm(
                    1,
                    "voltage",
                    &[[0, 100], [0, 0]],
                    &[("maxVoltage", source_volts)],
                ),
                elm(
                    2,
                    "resistor",
                    &[[0, 0], [100, 0]],
                    &[("resistance", 1000.0)],
                ),
                elm(3, "varactor", &[[100, 0], [100, 100]], &[]),
                elm(4, "wire", &[[100, 100], [0, 100]], &[]),
                elm(5, "ground", &[[0, 100]], &[]),
            ],
            opts(1e-5, true),
        );
        c.run(20);
        (c.element_voltages()[2], c.element_currents()[1])
    };

    let (vd, i) = forward(5.0);
    assert!((0.5..0.9).contains(&vd), "forward drop was {vd}");
    assert!(close(i, (5.0 - vd) / 1000.0, 1e-5), "current was {i}");

    let (vd, i) = forward(-5.0);
    assert!(vd < -4.9, "reverse voltage was {vd}");
    assert!(i.abs() < 1e-6, "reverse leakage was {i}");
}

/// Ports VaractorElm.java:107-111's capacitance law independently, so the
/// test below checks the engine against the same formula rather than a
/// hand-rounded constant. `fwdrop` is the diode's own forward drop, reused
/// as the junction potential: upstream has no separate field for it either.
fn varactor_capacitance(base_capacitance: f64, v: f64, fwdrop: f64) -> f64 {
    if v > 0.0 {
        base_capacitance
    } else {
        base_capacitance / (1.0 - v / fwdrop).sqrt()
    }
}

/// Ports Diode.java's forward/reverse current law independently, the same
/// "default" model diode_knee_matches_upstream_default_model pins (Is =
/// 1.7143528192808883e-7, n = 2, vscale = 2*vt). The varactor test below
/// uses it to separate the diode branch's own contribution from the
/// capacitive one it sits beside.
fn diode_current(v: f64) -> f64 {
    const VT: f64 = 0.025_865;
    const FWDROP: f64 = 0.805_904_783;
    let vscale = 2.0 * VT;
    let leakage = 1.0 / ((FWDROP / vscale).exp() - 1.0);
    leakage * ((v / vscale).exp() - 1.0)
}

#[test]
fn varactor_capacitance_shrinks_with_reverse_bias() {
    // Isolates the capacitance law from the diode branch beside it: seed the
    // varactor's persisted state (capVoltDiff) to a known reverse bias with
    // zero prior branch current -- exactly what a freshly loaded varactor
    // carries, since capCurrent is never dumped upstream either -- then
    // force the terminal voltage a further `delta` into reverse for exactly
    // one timestep on a freshly built circuit (opts' dc_operating_point is
    // off, so nothing runs before this step to disturb the seeded state).
    //
    // With no simulated history before this single step, the result is an
    // exact closed form: i = diode_current(v_new) + cap_geq*(v_new-v_prev),
    // where cap_geq = 2*C(v_prev)/dt is evaluated at the *previous* voltage,
    // matching start_iteration fixing the capacitance at the top of the
    // timestep, before Newton (and the voltage move) happens.
    let dt = 1e-5;
    let delta = 1e-3;
    let base_capacitance = 4e-12; // VaractorElm.java:11 default

    let probe = |v_bias: f64| {
        let v_prev = -v_bias;
        let c = &mut build(
            vec![
                elm(
                    1,
                    "voltage",
                    &[[0, 100], [0, 0]],
                    &[("maxVoltage", v_bias + delta)],
                ),
                elm(
                    2,
                    "varactor",
                    &[[0, 100], [0, 0]],
                    &[("capVoltDiff", v_prev)],
                ),
                elm(3, "ground", &[[0, 100]], &[]),
            ],
            opts(dt, false),
        );
        c.run(1);
        c.element_currents()[1]
    };

    let expected = |v_bias: f64| {
        let v_prev = -v_bias;
        let v_new = -(v_bias + delta);
        let cap_geq = 2.0 * varactor_capacitance(base_capacitance, v_prev, 0.805_904_783) / dt;
        diode_current(v_new) + cap_geq * (v_new - v_prev)
    };

    // Sanity check on the formula itself: more reverse bias should mean less
    // capacitance.
    let c1 = varactor_capacitance(base_capacitance, -1.0, 0.805_904_783);
    let c3 = varactor_capacitance(base_capacitance, -3.0, 0.805_904_783);
    assert!(
        c3 < c1,
        "sanity: C(-3V)={c3} should be less than C(-1V)={c1}"
    );

    for v_bias in [1.0, 3.0] {
        let sim = probe(v_bias);
        let exp = expected(v_bias);
        assert!(
            close(sim, exp, 1e-12),
            "v_bias={v_bias}: simulated {sim}, expected {exp}"
        );
    }

    // Direction check on the simulated circuit itself, with the diode
    // branch's own (bias-insensitive, at these depths) reverse leakage
    // subtracted out: current through a capacitor is C*dV/dt, so for the
    // same dV over the same dt, less capacitance at the deeper reverse bias
    // means *less* current through the capacitive branch alone, not more.
    // The raw totals cannot show this directly -- the diode's ~171 nA
    // leakage dwarfs the sub-nanoamp capacitive difference between the two
    // bias points -- which is exactly why the closed-form check above, not
    // this one, is the test's real assertion.
    let cap_only = |v_bias: f64| probe(v_bias) - diode_current(-(v_bias + delta));
    let cap1 = cap_only(1.0);
    let cap3 = cap_only(3.0);
    assert!(
        cap1.abs() > cap3.abs(),
        "less capacitance at the deeper reverse bias should draw less current for the same \
         delta step: cap1={cap1}, cap3={cap3}"
    );
}

/// Regression for the varactor's Norton current-source stamp's node order
/// (`do_step`'s `s.current_source(p0, p1, vc.ieq)` vs. the `Capacitor`
/// pattern it should mirror, `s.current_source(p1, p0, self.ieq)`).
///
/// `varactor_capacitance_shrinks_with_reverse_bias` above cannot see a node
/// order bug: it drives the varactor directly off an ideal voltage source,
/// so the terminal voltage is dictated by the source regardless of the
/// stamp, and `calculate_current` recomputes the reported current off that
/// same pinned voltage using the correct `geq*v - ieq` convention,
/// independent of how the matrix was stamped. This test instead puts a 1k
/// resistor between the source and the varactor, so the terminal voltage is
/// a genuine unknown the matrix has to solve for. Swapping the current
/// source's node order flips the sign of the `ieq` history term in the KCL
/// equation the matrix actually solves, which visibly moves the solved
/// voltage away from the correct trapezoidal-companion answer -- especially
/// on the second step, once `v_prev`/`i_prev` hold genuine history from a
/// step that was itself solved (not seeded).
#[test]
fn varactor_terminal_voltage_matches_the_matrix_solve_through_a_resistor() {
    // Both the source and the seeded initial state sit deep enough in
    // reverse bias (|v|/vscale > 40, vscale = 2*VT = 0.05173) that
    // exp(v/vscale) underflows below f64's ULP at 1.0, so `diode_current`
    // evaluates to *exactly* -leakage in floating point there (checked
    // below) rather than merely approximately -- turning the diode branch
    // into a plain constant current sink for this whole run. With the
    // capacitor's `geq`/`ieq` also fixed for the step (by `start_iteration`,
    // before Newton runs), the per-step KCL equation at the varactor's
    // ungrounded post is then exactly linear in the unknown terminal
    // voltage `v`, the same "I(p0->p1) = geq*v - ieq" convention as
    // `Capacitor::calculate_current`:
    //
    //   (vs - v)/r = -leakage + geq*(v - v_prev) - i_prev
    //
    // Solving for v:
    //
    //   v = (vs/r + geq*v_prev + i_prev + leakage) / (1/r + geq)
    //
    // (dropping the diode's own tiny JUNCTION_GMIN conductance is valid
    // here too: at ~1e-12 S against the resistor's 1e-3 S it biases v by
    // roughly 1 part in 1e9, ~3 nV -- utterly below both this test's
    // tolerance and the multi-millivolt shift the node-order bug causes.)
    let dt = 1e-5;
    let r = 1000.0;
    let vs = -3.0;
    let v0 = -2.5; // seeded capVoltDiff
    let base_capacitance = 4e-12; // VaractorElm.java:11 default
    let fwdrop = 0.805_904_783;

    let leakage = -diode_current(-100.0); // saturated reverse leakage, exact in f64 this deep
    for v in [vs, v0] {
        assert_eq!(
            diode_current(v),
            -leakage,
            "v={v} is not deep enough in reverse for the constant-leakage closed form"
        );
    }

    // One trapezoidal step of the closed form above. Returns the solved
    // terminal voltage, the capacitor branch's own current (which becomes
    // the next step's `i_prev`, mirroring `step_finished`), and the total
    // branch current (diode + capacitor) through the device.
    let step = |v_prev: f64, i_prev: f64| -> (f64, f64, f64) {
        let geq = 2.0 * varactor_capacitance(base_capacitance, v_prev, fwdrop) / dt;
        let v = (vs / r + geq * v_prev + i_prev + leakage) / (1.0 / r + geq);
        assert_eq!(diode_current(v), -leakage, "v={v} left deep reverse bias");
        let i_total = (vs - v) / r;
        let i_branch_next = geq * (v - v_prev) - i_prev;
        (v, i_branch_next, i_total)
    };

    let (v1, i_prev1, i_total1) = step(v0, 0.0);
    let (v2, _i_prev2, i_total2) = step(v1, i_prev1);

    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", vs)]),
            elm(2, "resistor", &[[0, 0], [100, 0]], &[("resistance", r)]),
            elm(
                3,
                "varactor",
                &[[100, 0], [100, 100]],
                &[("capVoltDiff", v0)],
            ),
            elm(4, "wire", &[[100, 100], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
        ],
        opts(dt, false),
    );

    c.run(1);
    assert!(
        close(c.element_voltages()[2], v1, 1e-7),
        "step 1 voltage: simulated {}, expected {v1}",
        c.element_voltages()[2]
    );
    assert!(
        close(c.element_currents()[2], i_total1, 1e-9),
        "step 1 current: simulated {}, expected {i_total1}",
        c.element_currents()[2]
    );

    c.run(1);
    assert!(
        close(c.element_voltages()[2], v2, 1e-7),
        "step 2 voltage: simulated {}, expected {v2}",
        c.element_voltages()[2]
    );
    assert!(
        close(c.element_currents()[2], i_total2, 1e-9),
        "step 2 current: simulated {}, expected {i_total2}",
        c.element_currents()[2]
    );
}

#[test]
fn inverting_opamp_has_the_textbook_gain() {
    // Vout = -Rf/Rin * Vin, with the non-inverting input grounded.
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 200], [0, 0]], &[("maxVoltage", 0.5)]),
            // Input resistor into the inverting node.
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            // Feedback resistor from output back to the inverting node.
            elm(
                3,
                "resistor",
                &[[100, 0], [300, 0]],
                &[("resistance", 10_000.0)],
            ),
            // Posts: inverting in, non-inverting in, output.
            elm(
                4,
                "opamp",
                &[[100, 0], [100, 100], [300, 0]],
                &[("gain", 100_000.0), ("maxOut", 15.0), ("minOut", -15.0)],
            ),
            elm(5, "ground", &[[100, 100]], &[]),
            elm(6, "ground", &[[0, 200]], &[]),
        ],
        opts(1e-5, true),
    );
    c.run(30);

    // The inverting input is a virtual ground, so the whole output swing
    // appears across the feedback resistor: 0.5 V * 10k/1k = 5 V.
    let out = c.element_voltages()[2];
    assert!(close(out, 5.0, 0.01), "feedback drop was {out}");
}

#[test]
fn asymmetric_rails_idle_at_the_midpoint() {
    // The linear region centres on (maxOut+minOut)/2 (OpAmpElm.java:167,
    // :174-181), so a 5 V / 0 V op-amp with both inputs grounded idles at
    // 2.5 V instead of the old zero-offset 0 V. The output is read through a
    // 1k resistor to ground.
    let c = &mut build(
        vec![
            elm(
                1,
                "opamp",
                &[[100, 0], [100, 100], [300, 0]],
                &[("gain", 1e5), ("maxOut", 5.0), ("minOut", 0.0)],
            ),
            elm(
                2,
                "resistor",
                &[[300, 0], [300, 100]],
                &[("resistance", 1000.0)],
            ),
            elm(3, "ground", &[[100, 0]], &[]),
            elm(4, "ground", &[[100, 100]], &[]),
            elm(5, "ground", &[[300, 100]], &[]),
        ],
        opts(1e-5, true),
    );
    let report = c.run(30);
    assert!(report.converged, "did not converge: {:?}", report.error);
    assert!(
        close(c.element_voltages()[1], 2.5, 1e-3),
        "idle output was {}",
        c.element_voltages()[1]
    );
}

#[test]
fn asymmetric_opamp_amplifies_about_the_midpoint() {
    // Same rails, non-inverting input driven by 1e-5 V. The upper knee sits at
    // (5-2.5)/1e5 = 2.5e-5, so vd = 1e-5 is linear and the output is
    // 2.5 + 1e5*1e-5 = 3.5 (the old zero-offset code returned 1.0).
    let c = &mut build(
        vec![
            elm(
                1,
                "voltage",
                &[[0, 100], [100, 100]],
                &[("maxVoltage", 1e-5)],
            ),
            elm(
                2,
                "opamp",
                &[[100, 0], [100, 100], [300, 0]],
                &[("gain", 1e5), ("maxOut", 5.0), ("minOut", 0.0)],
            ),
            elm(
                3,
                "resistor",
                &[[300, 0], [300, 100]],
                &[("resistance", 1000.0)],
            ),
            elm(4, "ground", &[[100, 0]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
            elm(6, "ground", &[[300, 100]], &[]),
        ],
        opts(1e-5, true),
    );
    let report = c.run(30);
    assert!(report.converged, "did not converge: {:?}", report.error);
    assert!(
        close(c.element_voltages()[2], 3.5, 1e-3),
        "output was {}",
        c.element_voltages()[2]
    );
}

#[test]
fn opamp_scope_plots_output_minus_non_inverting_input() {
    // The inverting amplifier from inverting_opamp_has_the_textbook_gain:
    // Vout = -Rf/Rin * Vin = -10 * 0.5 = -5. A voltage scope on the op-amp
    // samples volts[2] - volts[1] = -5 - 0 (OpAmpElm.java:206), not the
    // generic volts[0] - volts[1] = 0 - 0 the old formula returned.
    let c = &mut build_with(
        vec![
            elm(1, "voltage", &[[0, 200], [0, 0]], &[("maxVoltage", 0.5)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(
                3,
                "resistor",
                &[[100, 0], [300, 0]],
                &[("resistance", 10_000.0)],
            ),
            elm(
                4,
                "opamp",
                &[[100, 0], [100, 100], [300, 0]],
                &[("gain", 100_000.0), ("maxOut", 15.0), ("minOut", -15.0)],
            ),
            elm(5, "ground", &[[100, 100]], &[]),
            elm(6, "ground", &[[0, 200]], &[]),
        ],
        opts(1e-5, true),
        vec![ScopeSpec {
            element_id: 4,
            value: ScopeValue::Voltage,
            post: 0,
            steps_per_column: 1,
            columns: 1024,
        }],
    );
    c.run(30);
    let snap = c.scopes()[0].snapshot();
    let (min, max) = (snap[snap.len() - 2] as f64, snap[snap.len() - 1] as f64);
    assert!(
        close(min, -5.0, 1e-3) && close(max, -5.0, 1e-3),
        "last scope column was {min}/{max}, expected -5"
    );
}

#[test]
fn opamp_output_current_and_power_match_upstream() {
    // Voltage follower: 5 V into the non-inverting input, the output wired to
    // the inverting input, a 1k load from the output node to ground. The
    // op-amp sources ~5 mA into the load. Upstream's positive current leaves
    // the pin (getCurrentIntoNode(2) == -current, OpAmpElm.java:227-231),
    // while the port's voltage_source(GROUND, node2) unknown is positive into
    // the pin, so the reported current is -5e-3 and the power
    // volts[2]*current = 5 * -5e-3 = -0.025 (OpAmpElm.java:109). The finite
    // open-loop gain drops the follower output to 5 - 5e-5, a deviation the
    // tolerances below cover.
    let c = &mut build_with(
        vec![
            elm(
                1,
                "voltage",
                &[[0, 100], [100, 100]],
                &[("maxVoltage", 5.0)],
            ),
            elm(
                2,
                "resistor",
                &[[200, 0], [200, 100]],
                &[("resistance", 1000.0)],
            ),
            // The inverting input shares the output node, so the follower holds
            // it at the non-inverting voltage.
            elm(
                3,
                "opamp",
                &[[200, 0], [100, 100], [200, 0]],
                &[("gain", 1e5), ("maxOut", 15.0), ("minOut", -15.0)],
            ),
            elm(4, "ground", &[[0, 100]], &[]),
            elm(5, "ground", &[[200, 100]], &[]),
        ],
        opts(1e-5, true),
        vec![
            ScopeSpec {
                element_id: 3,
                value: ScopeValue::Power,
                post: 0,
                steps_per_column: 1,
                columns: 1024,
            },
            ScopeSpec {
                element_id: 3,
                value: ScopeValue::Voltage,
                post: 0,
                steps_per_column: 1,
                columns: 1024,
            },
        ],
    );
    let report = c.run(30);
    assert!(report.converged, "did not converge: {:?}", report.error);
    assert!(
        close(c.element_currents()[2], -5e-3, 1e-6),
        "op-amp current was {}",
        c.element_currents()[2]
    );
    let power = c.scopes()[0].snapshot();
    let (pmin, pmax) = (power[power.len() - 2] as f64, power[power.len() - 1] as f64);
    assert!(
        close(pmin, -0.025, 1e-6) && close(pmax, -0.025, 1e-6),
        "power scope last column was {pmin}/{pmax}, expected -0.025"
    );
    // And the follower's voltage scope is Vout - V+ = 0, pinning the step-4
    // semantics: the plot is output minus non-inverting input, not the input
    // differential.
    let volt = c.scopes()[1].snapshot();
    let (vmin, vmax) = (volt[volt.len() - 2] as f64, volt[volt.len() - 1] as f64);
    assert!(
        close(vmin, 0.0, 1e-4) && close(vmax, 0.0, 1e-4),
        "follower voltage scope last column was {vmin}/{vmax}, expected 0"
    );
}

#[test]
fn gain_flags_select_the_open_loop_gain() {
    // The flags decide the gain on load (OpAmpElm.java:63-70): FLAG_GAIN (8)
    // keeps the stored value, FLAG_LOWGAIN (4) forces 1000, and no flag forces
    // 100000. Symmetric rails put the midpoint offset at zero, so the linear
    // output is gain*vd, and every vd used here sits below its knee.
    let linear_out = |flags: i64, file_gain: f64, vd: f64| {
        let c = &mut build(
            vec![
                elm(1, "voltage", &[[0, 100], [100, 100]], &[("maxVoltage", vd)]),
                elm_flags(
                    2,
                    "opamp",
                    &[[100, 0], [100, 100], [300, 0]],
                    &[("gain", file_gain), ("maxOut", 15.0), ("minOut", -15.0)],
                    flags,
                ),
                elm(
                    3,
                    "resistor",
                    &[[300, 0], [300, 100]],
                    &[("resistance", 1000.0)],
                ),
                elm(4, "ground", &[[100, 0]], &[]),
                elm(5, "ground", &[[0, 100]], &[]),
                elm(6, "ground", &[[300, 100]], &[]),
            ],
            opts(1e-5, true),
        );
        let report = c.run(30);
        assert!(report.converged, "did not converge: {:?}", report.error);
        c.element_voltages()[2]
    };

    let flagged = linear_out(8, 12345.0, 1e-4);
    assert!(
        close(flagged, 1.2345, 1e-3),
        "FLAG_GAIN did not keep the file gain: {flagged}"
    );
    let low = linear_out(4, 12345.0, 1e-3);
    assert!(close(low, 1.0, 1e-3), "FLAG_LOWGAIN gain was {low}");
    let legacy = linear_out(0, 12345.0, 1e-4);
    assert!(close(legacy, 10.0, 1e-3), "unflagged gain was {legacy}");
}

#[test]
fn common_emitter_stage_amplifies_base_current() {
    // Ib set by a 470 k base resistor, Ic = beta * Ib through a 1 k load.
    let beta = 100.0;
    let c = &mut build(
        vec![
            elm(1, "rail", &[[0, 0]], &[("maxVoltage", 5.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 470_000.0)],
            ),
            elm(
                3,
                "resistor",
                &[[0, 0], [200, 0]],
                &[("resistance", 1000.0)],
            ),
            // Posts: base, collector, emitter.
            elm(
                4,
                "transistor",
                &[[100, 0], [200, 0], [200, 100]],
                &[("beta", beta)],
            ),
            elm(5, "ground", &[[200, 100]], &[]),
        ],
        opts(1e-5, true),
    );
    c.run(50);

    let currents = c.element_currents();
    let ib = currents[1]; // through the base resistor
    let ic = currents[2]; // through the collector load
    assert!(ib > 5e-6 && ib < 1.5e-5, "base current was {ib}");
    let measured_beta = ic / ib;
    assert!(
        (70.0..130.0).contains(&measured_beta),
        "current gain was {measured_beta}"
    );
}

#[test]
fn npn_common_emitter_matches_upstream_default_model() {
    // Ib set by a 470 k base resistor, Ic = beta * Ib through a 1 k load, with
    // the default model (sat = 1e-13). This is the discriminating test: the
    // old 1e-16 default sat at Vbe ~ 0.77, and the old polarity bug read the
    // pnp = 1 sign as a PNP, off in this orientation.
    let beta = 100.0;
    let c = &mut build(
        vec![
            elm(1, "rail", &[[0, 0]], &[("maxVoltage", 5.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 470_000.0)],
            ),
            elm(
                3,
                "resistor",
                &[[0, 0], [200, 0]],
                &[("resistance", 1000.0)],
            ),
            // Posts: base, collector, emitter.
            elm(
                4,
                "transistor",
                &[[100, 0], [200, 0], [200, 100]],
                &[("pnp", 1.0), ("beta", beta)],
            ),
            elm(5, "ground", &[[200, 100]], &[]),
        ],
        opts(1e-5, true),
    );
    c.run(50);

    let currents = c.element_currents();
    let ib = currents[1]; // through the base resistor
    let ic = currents[2]; // through the collector load
    assert!(ic > 0.0, "collector load current was {ic}");
    let measured_beta = ic / ib;
    assert!(
        (90.0..110.0).contains(&measured_beta),
        "current gain was {measured_beta}"
    );
    assert!(
        currents[3] > 0.0,
        "reported transistor current was {}",
        currents[3]
    );

    // The transistor's three posts start at flattened index 5 (1 + 2 + 2
    // posts precede them).
    let nodes = c.element_nodes();
    let v = c.node_voltages();
    let (nb, nc, ne) = (nodes[5] as usize, nodes[6] as usize, nodes[7] as usize);
    let vbe = v[nb] - v[ne];
    assert!((0.585..0.605).contains(&vbe), "Vbe was {vbe}");
    let vc = v[nc];
    assert!((4.0..4.15).contains(&vc), "collector was {vc}");
    let ic_from_vc = (5.0 - vc) / 1000.0;
    assert!(
        (8.5e-4..1.0e-3).contains(&ic_from_vc),
        "Ic from Vc was {ic_from_vc}"
    );
}

#[test]
fn pnp_common_emitter_mirrors_the_npn() {
    // The PNP mirror of the NPN stage: emitter on the rail, base via 470 k to
    // ground, collector via 1 k to ground. A PNP conducts with its base pulled
    // a diode drop below the emitter, and its base current exits the base, so
    // the base resistor has to sink it; tying it to the same rail as the
    // emitter would leave the device off.
    let beta = 100.0;
    let c = &mut build(
        vec![
            elm(1, "rail", &[[0, 0]], &[("maxVoltage", 5.0)]),
            elm(
                2,
                "resistor",
                &[[100, 0], [100, 200]],
                &[("resistance", 470_000.0)],
            ),
            elm(
                3,
                "resistor",
                &[[100, 100], [0, 100]],
                &[("resistance", 1000.0)],
            ),
            // Posts: base, collector, emitter; emitter shares the rail node.
            elm(
                4,
                "transistor",
                &[[100, 0], [100, 100], [0, 0]],
                &[("pnp", -1.0), ("beta", beta)],
            ),
            elm(5, "ground", &[[0, 100]], &[]),
            elm(6, "ground", &[[100, 200]], &[]),
        ],
        opts(1e-5, true),
    );
    c.run(50);

    let currents = c.element_currents();
    let ib = currents[1]; // through the base resistor
    let ic = currents[2]; // through the collector load
    assert!(ib > 0.0 && ic > 0.0, "PNP currents were ib={ib} ic={ic}");
    let measured_beta = ic / ib;
    assert!(
        (90.0..110.0).contains(&measured_beta),
        "current gain was {measured_beta}"
    );
    assert!(
        currents[3] < 0.0,
        "reported transistor current was {}",
        currents[3]
    );

    let nodes = c.element_nodes();
    let v = c.node_voltages();
    let (nb, nc, _ne) = (nodes[5] as usize, nodes[6] as usize, nodes[7] as usize);
    assert!((4.40..4.52).contains(&v[nb]), "base was {}", v[nb]);
    assert!((0.85..1.05).contains(&v[nc]), "collector was {}", v[nc]);
    let ic_from_vc = v[nc] / 1000.0;
    assert!(
        (8.5e-4..1.05e-3).contains(&ic_from_vc),
        "Ic from Vc was {ic_from_vc}"
    );
}

#[test]
fn transistor_type_flips_conduction_for_the_same_geometry() {
    // Same common-emitter layout, pnp = 1 and pnp = -1. The file sign, not a
    // nonzero test, decides the device: the PNP in the NPN orientation is
    // reverse biased and off.
    let make = |pnp: f64| {
        build(
            vec![
                elm(1, "rail", &[[0, 0]], &[("maxVoltage", 5.0)]),
                elm(
                    2,
                    "resistor",
                    &[[0, 0], [100, 0]],
                    &[("resistance", 470_000.0)],
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
                    &[("pnp", pnp), ("beta", 100.0)],
                ),
                elm(5, "ground", &[[200, 100]], &[]),
            ],
            opts(1e-5, true),
        )
    };

    let mut npn = make(1.0);
    npn.run(50);
    let npn_ic = npn.element_currents()[3];
    assert!(
        npn_ic > 8e-4 && npn_ic < 1.1e-3,
        "NPN collector current was {npn_ic}"
    );

    let mut pnp = make(-1.0);
    pnp.run(50);
    let nodes = pnp.element_nodes();
    let v = pnp.node_voltages();
    let (nb, nc, _ne) = (nodes[5] as usize, nodes[6] as usize, nodes[7] as usize);
    assert!(
        (4.5..5.1).contains(&v[nb]) && (4.5..5.1).contains(&v[nc]),
        "PNP base and collector were {} and {}",
        v[nb],
        v[nc]
    );
    assert!(
        pnp.element_currents()[3].abs() < 1e-9,
        "PNP leaked {} A",
        pnp.element_currents()[3]
    );
}

#[test]
fn transistor_initial_state_is_seeded_on_load() {
    // lastVbe/lastVbc are restored as the initial node voltages, upstream's
    // swap: collector -lastVbe, emitter -lastVbc (TransistorElm.java:65-67).
    // No solve runs before the assertion, so the seed is still visible.
    let seed = |tokens: &[(&str, f64)]| {
        build(
            vec![
                elm(1, "transistor", &[[0, 0], [100, 0], [200, 0]], tokens),
                elm(2, "ground", &[[0, 0]], &[]),
            ],
            opts(1e-5, false),
        )
    };

    let c = &mut seed(&[("pnp", 1.0), ("lastVbe", 0.6), ("lastVbc", -3.4)]);
    let nodes = c.element_nodes();
    let v = c.node_voltages();
    let (nc, ne) = (nodes[1] as usize, nodes[2] as usize);
    assert!(close(v[nc], -0.6, 1e-12), "collector seeded at {}", v[nc]);
    assert!(close(v[ne], 3.4, 1e-12), "emitter seeded at {}", v[ne]);

    // A control circuit without the tokens seeds both terminals to zero.
    let c0 = &mut seed(&[("pnp", 1.0)]);
    let nodes = c0.element_nodes();
    let v = c0.node_voltages();
    let (nc, ne) = (nodes[1] as usize, nodes[2] as usize);
    assert!(
        close(v[nc], 0.0, 1e-12) && close(v[ne], 0.0, 1e-12),
        "control seeded at {} and {}",
        v[nc],
        v[ne]
    );

    // And the seeded point still converges on the first run.
    let report = c.run(1);
    assert!(report.converged, "seeded start did not converge");
}

#[test]
fn open_switch_breaks_the_loop() {
    let make = |position: f64| {
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
                    "switch",
                    &[[100, 0], [100, 100]],
                    &[("position", position)],
                ),
                elm(4, "wire", &[[100, 100], [0, 100]], &[]),
                elm(5, "ground", &[[0, 100]], &[]),
            ],
            opts(1e-5, true),
        )
    };

    let mut closed = make(0.0);
    closed.run(5);
    assert!(close(closed.element_currents()[1], 0.01, 1e-9));

    let mut open = make(1.0);
    open.run(5);
    assert!(open.element_currents()[1].abs() < 1e-6);
}

#[test]
fn switch_can_be_toggled_at_runtime() {
    let mut c = build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 10.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(3, "switch", &[[100, 0], [100, 100]], &[("position", 0.0)]),
            elm(4, "wire", &[[100, 100], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
        ],
        opts(1e-5, true),
    );
    c.run(5);
    assert!(close(c.element_currents()[1], 0.01, 1e-9));

    // Opening un-merges the switch's terminals, so this exercises the
    // reanalyze path as well as the stamp.
    assert!(c.set_state(3, 1));
    c.run(5);
    assert!(c.element_currents()[1].abs() < 1e-6);

    assert!(c.set_state(3, 0));
    c.run(5);
    assert!(close(c.element_currents()[1], 0.01, 1e-9));
}

#[test]
fn set_state_on_a_switch_preserves_time() {
    // Opening a switch un-merges its terminals, so set_state re-runs the
    // topology pass; that path must not reset the clock either.
    let dt = 1e-5;
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 10.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(3, "switch", &[[100, 0], [100, 100]], &[("position", 0.0)]),
            elm(4, "wire", &[[100, 100], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
        ],
        opts(dt, true),
    );
    c.run(5);
    assert!(close(c.element_currents()[1], 0.01, 1e-9));
    let t = c.time();
    assert!(t > 0.0, "circuit never advanced");

    assert!(c.set_state(3, 1));
    assert_eq!(c.time(), t, "switch throw rewound the clock");

    c.run(5);
    assert!(
        c.element_currents()[1].abs() < 1e-6,
        "current still flows with the switch open"
    );
}

#[test]
fn set_circuit_rewinds_to_zero() {
    let spec = CircuitSpec {
        elements: vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 10.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(3, "ground", &[[0, 100]], &[]),
        ],
        options: Some(opts(1e-5, true)),
        scopes: Vec::new(),
    };
    let mut c = Circuit::new();
    c.set_circuit(&spec).unwrap();
    c.run(5);
    assert!(c.time() > 0.0, "circuit never advanced");

    // Topology edits take the slow path and restart from zero on purpose, so
    // the contract stays pinned while the value path changes around it.
    c.set_circuit(&spec).unwrap();
    assert_eq!(c.time(), 0.0, "full reload must restart the clock");
}

#[test]
fn ac_source_tracks_its_waveform() {
    // Peak of a sine into a resistor is Vpeak/R, and a quarter period in the
    // source is at its maximum.
    let freq = 1000.0;
    let dt = 1.0 / (freq * 4000.0);
    let c = &mut build(
        vec![
            elm(
                1,
                "voltage",
                &[[0, 100], [0, 0]],
                &[("waveform", 1.0), ("frequency", freq), ("maxVoltage", 10.0)],
            ),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(3, "wire", &[[100, 0], [100, 100]], &[]),
            elm(4, "wire", &[[100, 100], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
        ],
        opts(dt, false),
    );
    c.run(1000); // quarter period
    let i = c.element_currents()[1];
    assert!(close(i, 0.01, 1e-4), "peak current was {i}");

    c.run(2000); // three-quarter point
    let i = c.element_currents()[1];
    assert!(close(i, -0.01, 1e-4), "trough current was {i}");
}

#[test]
fn potentiometer_divides_by_wiper_position() {
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 10.0)]),
            // Posts: track end A, track end B, wiper.
            elm(
                2,
                "potentiometer",
                &[[0, 0], [0, 100], [200, 0]],
                &[("maxResistance", 1000.0), ("position", 0.25)],
            ),
            // High-impedance tap so the wiper is not loaded.
            elm(
                3,
                "resistor",
                &[[200, 0], [200, 100]],
                &[("resistance", 1e9)],
            ),
            elm(4, "wire", &[[200, 100], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
        ],
        opts(1e-5, true),
    );
    c.run(5);
    // Wiper at 25% from end A means 75% of the track sits below it.
    let v = c.element_voltages()[2];
    assert!(close(v, 7.5, 0.05), "wiper voltage was {v}");
}

#[test]
fn labeled_nodes_connect_by_name() {
    // Two disconnected halves joined only by matching node labels.
    let mut spec = CircuitSpec {
        elements: vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 6.0)]),
            elm(2, "labeledNode", &[[0, 0]], &[]),
            elm(3, "labeledNode", &[[500, 0]], &[]),
            elm(
                4,
                "resistor",
                &[[500, 0], [500, 100]],
                &[("resistance", 600.0)],
            ),
            elm(5, "wire", &[[500, 100], [0, 100]], &[]),
            elm(6, "ground", &[[0, 100]], &[]),
        ],
        options: Some(opts(1e-5, true)),
        scopes: Vec::new(),
    };
    spec.elements[1].label = Some("vcc".into());
    spec.elements[2].label = Some("vcc".into());

    let mut c = Circuit::new();
    c.set_circuit(&spec).unwrap();
    c.run(5);
    assert!(close(c.element_currents()[3], 0.01, 1e-9));
    // A one-post element reads out its node voltage (LabeledNodeElm.java:243),
    // so a voltage scope or readout on a labeled node shows the rail it sits
    // on rather than 0.
    assert!(
        close(c.element_voltages()[1], 6.0, 1e-9),
        "labeled node readout was {}",
        c.element_voltages()[1]
    );
}

#[test]
fn ungrounded_circuit_still_solves_with_a_warning() {
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 10.0)]),
            elm(2, "resistor", &[[0, 0], [0, 100]], &[("resistance", 500.0)]),
        ],
        opts(1e-5, true),
    );
    c.run(5);
    assert!(!c.warnings().is_empty(), "expected a no-ground warning");
    assert!(close(c.element_currents()[1], 0.02, 1e-9));
}

#[test]
fn reset_returns_the_circuit_to_its_initial_state() {
    let c = &mut build(
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
                &[("capacitance", 1e-6)],
            ),
            elm(4, "wire", &[[100, 100], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
        ],
        opts(1e-6, false),
    );
    c.run(3000);
    assert!(c.element_voltages()[2] > 5.0);

    c.reset();
    assert_eq!(c.time(), 0.0);
    c.run(1);
    assert!(
        c.element_voltages()[2].abs() < 0.1,
        "capacitor did not discharge on reset"
    );
}

#[test]
fn parallel_wires_do_not_singularise_the_matrix() {
    // Two wires in parallel used to stamp two identical 0 V source rows and
    // make the matrix singular. The analyser now merges both into the ground
    // node, and the recovery splits the resistor current between them.
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 5.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(3, "wire", &[[100, 0], [0, 100]], &[]),
            elm(4, "wire", &[[100, 0], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
        ],
        opts(1e-5, true),
    );
    let report = c.run(5);
    assert!(report.converged, "parallel wires made the matrix singular");
    assert!(report.error.is_none());
    assert!(close(c.element_voltages()[1], 5.0, 1e-9));
    assert!(close(c.element_currents()[1], 5e-3, 1e-9));
    assert!(
        close(c.element_currents()[2], 2.5e-3, 1e-9),
        "first wire took {}",
        c.element_currents()[2]
    );
    assert!(
        close(c.element_currents()[3], 2.5e-3, 1e-9),
        "second wire took {}",
        c.element_currents()[3]
    );
}

#[test]
fn pure_wire_ring_solves() {
    // A closed ring of wires has no drive and used to stamp three 0 V rows,
    // rank 2 of 3. All three merge into a single node, the matrix is empty,
    // and every wire reports zero.
    let c = &mut build(
        vec![
            elm(1, "wire", &[[0, 0], [100, 0]], &[]),
            elm(2, "wire", &[[100, 0], [100, 100]], &[]),
            elm(3, "wire", &[[100, 100], [0, 0]], &[]),
        ],
        opts(1e-5, true),
    );
    let report = c.run(5);
    assert!(report.converged, "wire ring did not solve");
    assert!(report.error.is_none());
    assert_eq!(c.node_count(), 1);
    for (i, iw) in c.element_currents().iter().enumerate() {
        assert!(close(*iw, 0.0, 1e-12), "wire {i} current was {iw}");
    }
}

#[test]
fn closed_switch_in_parallel_with_wire_solves() {
    // A closed switch stamps the same constraint as a wire, so the two in
    // parallel used to be a duplicate row. Both merge into the ground node;
    // the recovery pins the split at half the resistor current each.
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 5.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(3, "switch", &[[100, 0], [0, 100]], &[("position", 0.0)]),
            elm(4, "wire", &[[100, 0], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
        ],
        opts(1e-5, true),
    );
    let report = c.run(5);
    assert!(
        report.converged,
        "switch in parallel with a wire went singular"
    );
    assert!(report.error.is_none());
    assert!(close(c.element_currents()[1], 5e-3, 1e-9));
    let switch_i = c.element_currents()[2];
    let wire_i = c.element_currents()[3];
    assert!(close(switch_i + wire_i, 5e-3, 1e-9));
    assert!(close(switch_i, 2.5e-3, 1e-9), "switch took {switch_i}");
    assert!(close(wire_i, 2.5e-3, 1e-9), "wire took {wire_i}");
}

#[test]
fn zero_length_wire_solves() {
    // A wire with both posts at one coordinate stamped an all-zero row. It now
    // stamps nothing, and the recovery derives a finite current from the
    // neighbour sum at its single coordinate.
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 5.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(3, "wire", &[[100, 0], [100, 0]], &[]),
            // The divider's return path, so the source's negative terminal is
            // grounded through the same node the zero-length wire sits on.
            elm(4, "wire", &[[0, 100], [100, 0]], &[]),
            elm(5, "ground", &[[100, 0]], &[]),
        ],
        opts(1e-5, true),
    );
    let report = c.run(5);
    assert!(report.converged, "zero-length wire went singular");
    assert!(report.error.is_none());
    assert!(close(c.element_currents()[1], 5e-3, 1e-9));
    let wire_i = c.element_currents()[2];
    assert!(wire_i.is_finite(), "zero-length wire current was {wire_i}");
}

#[test]
fn wire_current_keeps_its_sign() {
    // The recovered wire current must match the old 0 V stamp's convention:
    // positive when current enters post 0, so the UI dots do not reverse.
    let make = |flipped: bool| {
        let posts = if flipped {
            [[0, 100], [100, 100]]
        } else {
            [[100, 100], [0, 100]]
        };
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
                    "resistor",
                    &[[100, 0], [100, 100]],
                    &[("resistance", 1000.0)],
                ),
                elm(4, "wire", &posts, &[]),
                elm(5, "ground", &[[0, 100]], &[]),
            ],
            opts(1e-5, true),
        )
    };

    let mut c = make(false);
    c.run(5);
    assert!(
        close(c.element_currents()[3], 5e-3, 1e-9),
        "wire current was {}",
        c.element_currents()[3]
    );

    let mut c = make(true);
    c.run(5);
    assert!(
        close(c.element_currents()[3], -5e-3, 1e-9),
        "flipped wire current was {}",
        c.element_currents()[3]
    );
}

#[test]
fn wire_merge_shrinks_the_matrix() {
    // The divider's bottom rail was four nodes plus two voltage-source
    // unknowns. The wire merge folds the wire's two coordinates into the
    // ground node, so the matrix drops to three nodes and one source unknown.
    let c = &mut build(
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
                "resistor",
                &[[100, 0], [100, 100]],
                &[("resistance", 1000.0)],
            ),
            elm(4, "wire", &[[100, 100], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
        ],
        opts(1e-5, true),
    );
    c.run(5);
    assert_eq!(c.node_count(), 3);
    assert_eq!(c.vs_count(), 1);
}

/// A sine source into a grounded resistor, the shape every source test below
/// shares. Post 0 sits on a ground symbol and the resistor's far end is
/// grounded too, so the described circuit "post 0 grounded, post 1 through a
/// resistor to ground" is real: the source's EMF appears as
/// `V(post1) - V(post0)`, which `element_voltages` reports with the upstream
/// sign, and the resistor carries `EMF/1000`.
fn source_into_resistor(id: u32, params: &[(&str, f64)], dt: f64, dc: bool, flags: i64) -> Circuit {
    build_with(
        vec![
            elm_flags(id, "voltage", &[[0, 100], [0, 0]], params, flags),
            elm(
                id + 1,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(id + 2, "ground", &[[0, 100]], &[]),
            elm(id + 3, "ground", &[[100, 0]], &[]),
        ],
        opts(dt, dc),
        Vec::new(),
    )
}

#[test]
fn legacy_cos_flag_loads_as_cosine() {
    // A file that flagged a sine source with FLAG_COS (2) means "cosine":
    // upstream clears the bit and sets phaseShift = pi/2 on load
    // (VoltageElm.java:80-83). The port used to ignore the flag and evaluate
    // the line as a plain sine, a full pi/2 of phase off.
    let c = &mut source_into_resistor(
        1,
        &[
            ("waveform", 1.0),
            ("frequency", 1000.0),
            ("maxVoltage", 10.0),
            ("phaseShift", 0.0),
            ("dutyCycle", 0.5),
        ],
        1e-4,
        false,
        2,
    );
    c.run(1); // t = 1e-4, phase 2*pi*freq*t = 0.6283 rad
    let v = c.element_voltages()[0];
    let phase = 2.0 * PI * 1000.0 * 1e-4;
    let expected = 10.0 * phase.cos();
    assert!(close(v, expected, 0.05), "got {v}, expected {expected}");
    assert!(
        !close(v, 10.0 * phase.sin(), 0.05),
        "the FLAG_COS line still evaluated as a sine ({v})"
    );
}

#[test]
fn legacy_pulse_without_flag_uses_legacy_duty() {
    // Old pulse files predate a configurable duty cycle, so upstream forces
    // the legacy 1/(2*pi) whenever FLAG_PULSE_DUTY (4) is absent
    // (VoltageElm.java:85-88). At a quarter period (phase pi/2) the legacy
    // 0.159 duty pulse has already fallen, while the 0.5 default would still
    // be high.
    let pulse = |flags: i64| {
        let mut c = source_into_resistor(
            1,
            &[
                ("waveform", 5.0),
                ("frequency", 1000.0),
                ("maxVoltage", 10.0),
                ("bias", 0.0),
                ("dutyCycle", 0.5),
            ],
            1e-6,
            false,
            flags,
        );
        c.run(250); // t = 2.5e-4 = a quarter period, phase pi/2
        c.element_voltages()[0]
    };

    let legacy = pulse(0);
    assert!(close(legacy, 0.0, 0.01), "legacy pulse read {legacy}");
    let flagged = pulse(4);
    assert!(
        close(flagged, 10.0, 0.01),
        "pulse with FLAG_PULSE_DUTY read {flagged}"
    );
}

#[test]
fn noise_holds_constant_across_subiterations() {
    // Upstream samples noise once per converged step in stepFinished, so the
    // value is constant across a step's Newton subiterations
    // (VoltageElm.java:163-166). The port used to draw a fresh sample in
    // do_step, so a noise source in a nonlinear circuit changed the
    // right-hand side every subiteration and Newton could never converge.
    let c = &mut build_with(
        vec![
            elm(
                1,
                "voltage",
                &[[0, 100], [0, 0]],
                &[("waveform", 6.0), ("maxVoltage", 5.0)],
            ),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(3, "diode", &[[100, 0], [100, 100]], &[]),
            elm(4, "wire", &[[100, 100], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
        ],
        opts(1e-5, false),
        vec![ScopeSpec {
            element_id: 1,
            value: ScopeValue::Voltage,
            post: 0,
            steps_per_column: 1,
            columns: 1024,
        }],
    );
    let report = c.run(50);
    assert!(report.converged, "noise source broke Newton convergence");
    assert!(c.error().is_none(), "error: {:?}", c.error());

    let snap = c.scopes()[0].snapshot();
    assert!(
        snap.len() >= 50,
        "expected one column per step, got {}",
        snap.len()
    );
    for v in snap {
        assert!(v.is_finite(), "non-finite noise sample {v}");
        assert!((-5.0..=5.0).contains(&v), "noise sample {v} left [-5, 5]");
    }
}

#[test]
fn noise_is_deterministic_and_uncorrelated() {
    // Two builds of the same circuit (same element ids, so the same per-source
    // seeds) must reproduce the identical trace, and two noise sources with
    // different ids in one circuit must not generate the same sequence.
    let noise_circuit = || {
        build_with(
            vec![
                elm(
                    1,
                    "voltage",
                    &[[0, 100], [0, 0]],
                    &[("waveform", 6.0), ("maxVoltage", 5.0)],
                ),
                elm(
                    2,
                    "resistor",
                    &[[0, 0], [100, 0]],
                    &[("resistance", 1000.0)],
                ),
                elm(3, "diode", &[[100, 0], [100, 100]], &[]),
                elm(4, "wire", &[[100, 100], [0, 100]], &[]),
                elm(5, "ground", &[[0, 100]], &[]),
            ],
            opts(1e-5, false),
            vec![ScopeSpec {
                element_id: 1,
                value: ScopeValue::Voltage,
                post: 0,
                steps_per_column: 1,
                columns: 1024,
            }],
        )
    };
    let mut a = noise_circuit();
    a.run(100);
    let trace_a = a.scopes()[0].snapshot();
    let mut b = noise_circuit();
    b.run(100);
    assert_eq!(
        trace_a,
        b.scopes()[0].snapshot(),
        "noise drifted run to run"
    );

    // Two noise sources in one circuit. Each branch is an independent source
    // into a grounded resistor; the wire ties both negative terminals to the
    // shared ground node.
    let mut two = build_with(
        vec![
            elm(
                1,
                "voltage",
                &[[0, 100], [0, 0]],
                &[("waveform", 6.0), ("maxVoltage", 5.0)],
            ),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(
                3,
                "voltage",
                &[[200, 100], [200, 0]],
                &[("waveform", 6.0), ("maxVoltage", 5.0)],
            ),
            elm(
                4,
                "resistor",
                &[[200, 0], [300, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(5, "wire", &[[300, 0], [300, 100]], &[]),
            elm(6, "wire", &[[300, 100], [200, 100]], &[]),
            elm(7, "wire", &[[200, 100], [0, 100]], &[]),
            elm(8, "ground", &[[0, 100]], &[]),
        ],
        opts(1e-5, false),
        vec![
            ScopeSpec {
                element_id: 1,
                value: ScopeValue::Voltage,
                post: 0,
                steps_per_column: 1,
                columns: 1024,
            },
            ScopeSpec {
                element_id: 3,
                value: ScopeValue::Voltage,
                post: 0,
                steps_per_column: 1,
                columns: 1024,
            },
        ],
    );
    let report = two.run(100);
    assert!(report.converged, "two noise sources did not converge");
    let first = two.scopes()[0].snapshot();
    let second = two.scopes()[1].snapshot();
    assert!(
        first != second,
        "two noise sources with different ids produced the same trace"
    );
}

#[test]
fn frequency_edit_preserves_phase() {
    // A live frequency edit must not jump the waveform to a new phase: the
    // phase reference rewinds so the edit instant is continuous
    // (VoltageElm.java:497-508). Without freqTimeZero the value after the edit
    // snaps to the phase-jumped answer, about -5.88 here.
    let c = &mut source_into_resistor(
        1,
        &[
            ("waveform", 1.0),
            ("frequency", 1000.0),
            ("maxVoltage", 10.0),
            ("bias", 0.0),
        ],
        1e-6,
        false,
        0,
    );
    c.run(400); // t = 4e-4, phase 0.8*pi
    let v_before = c.element_voltages()[0];
    let expected_before = 10.0 * (0.8 * PI).sin();
    assert!(close(v_before, expected_before, 0.05), "got {v_before}");

    assert!(c.set_param(1, "frequency", 4000.0));
    c.run(1); // t = 4.01e-4
    let v = c.element_voltages()[0];
    // Phase at the edit was 0.8*pi; one 1 us step at 4 kHz advances it by
    // 2*pi*4000*1e-6 = 0.008*pi.
    let expected = 10.0 * (0.808 * PI).sin();
    assert!(close(v, expected, 0.05), "got {v}, expected {expected}");
    let jumped = 10.0 * (2.0 * PI * 4000.0 * 4.01e-4).sin();
    assert!(
        !close(v, jumped, 0.05),
        "frequency edit jumped the phase: {v} vs the phase-jumped {jumped}"
    );
}

#[test]
fn frequency_clamps_to_a_solvable_max() {
    // The port has no confirm dialogs, so a frequency the timestep cannot
    // resolve clamps silently to 1/(8*dt) (VoltageElm.java:500). With
    // dt = 1e-5 the bound is 12500 Hz, and one step later the source must
    // still read the clamped waveform rather than the requested 1e9.
    let c = &mut source_into_resistor(
        1,
        &[
            ("waveform", 1.0),
            ("frequency", 1000.0),
            ("maxVoltage", 10.0),
            ("bias", 0.0),
        ],
        1e-5,
        false,
        0,
    );
    assert!(c.set_param(1, "frequency", 1e9));
    c.run(1); // t = 1e-5
    let v = c.element_voltages()[0];
    let expected = 10.0 * (2.0 * PI * 12500.0 * 1e-5).sin();
    assert!(close(v, expected, 0.05), "got {v}, expected {expected}");
    let unclamped = 10.0 * (2.0 * PI * 1e9 * 1e-5).sin();
    assert!(
        !close(v, unclamped, 0.05),
        "frequency was not clamped: {v} matches the 1e9 waveform"
    );
}

#[test]
fn square_and_pulse_honour_rise_time() {
    // With riseTime set, the square ramps its edges instead of switching
    // instantly (VoltageElm.java:179-203) and the pulse ramps between its low
    // and high levels (VoltageElm.java:214-238). At t = 1e-6 the phase is
    // 0.00628 rad, well inside the rising edge centred at phase 0: halfRise =
    // riseTime*freq*pi = 0.314, so both waves sit a fraction t =
    // (phase + halfRise) / (2*halfRise) up their ramp.
    let dt = 1e-6;
    let freq = 1000.0;
    let rise_time = 1e-4;
    let half_rise = rise_time * freq * PI;
    let phase = 2.0 * PI * freq * dt;
    let t = (phase + half_rise) / (2.0 * half_rise);

    let square = &mut source_into_resistor(
        1,
        &[
            ("waveform", 2.0),
            ("frequency", freq),
            ("maxVoltage", 5.0),
            ("bias", 0.0),
            ("dutyCycle", 0.5),
            ("riseTime", rise_time),
        ],
        dt,
        false,
        0,
    );
    square.run(1);
    let v = square.element_voltages()[0];
    let expected = 5.0 * (2.0 * t - 1.0);
    assert!(close(v, expected, 0.05), "square ramp read {v}");
    assert!(
        !close(v, 5.0, 0.05),
        "square still had an instantaneous edge ({v})"
    );

    let pulse = &mut source_into_resistor(
        1,
        &[
            ("waveform", 5.0),
            ("frequency", freq),
            ("maxVoltage", 5.0),
            ("bias", 0.0),
            ("dutyCycle", 0.5),
            ("riseTime", rise_time),
        ],
        dt,
        false,
        0,
    );
    pulse.run(1);
    let v = pulse.element_voltages()[0];
    assert!(close(v, 5.0 * t, 0.05), "pulse ramp read {v}");
    assert!(
        !close(v, 5.0, 0.05),
        "pulse still had an instantaneous edge ({v})"
    );
}

#[test]
fn source_scope_and_readout_use_upstream_sign() {
    // Upstream's sources read out volts[1] - volts[0] (VoltageElm.java:462),
    // so a 5 V source with its negative post grounded displays +5, not the
    // -5 the generic V(post0) - V(post1) convention gives. The scope trace
    // must agree with the Options-panel readout.
    let c = &mut build_with(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 5.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(3, "ground", &[[0, 100]], &[]),
            elm(4, "ground", &[[100, 0]], &[]),
        ],
        opts(1e-5, false),
        vec![ScopeSpec {
            element_id: 1,
            value: ScopeValue::Voltage,
            post: 0,
            steps_per_column: 1,
            columns: 1024,
        }],
    );
    c.run(1);
    assert!(
        close(c.element_voltages()[0], 5.0, 1e-9),
        "source readout was {}",
        c.element_voltages()[0]
    );
    let snap = c.scopes()[0].snapshot();
    assert_eq!(snap.len(), 2, "expected one min/max column");
    assert!(
        close(snap[0] as f64, 5.0, 1e-9),
        "scope min was {}",
        snap[0]
    );
    assert!(
        close(snap[1] as f64, 5.0, 1e-9),
        "scope max was {}",
        snap[1]
    );
}

#[test]
fn element_powers_use_the_scope_convention() {
    // `element_powers` must match what a Power scope samples, so the Options
    // panel readout and the scope agree for a source. The 5 V source delivers
    // 5 mA into the 1 k load: (V(post0) - V(post1)) * current is -25 mW for
    // the source (delivering) and +25 mW for the resistor (dissipating),
    // which is upstream's own -getVoltageDiff()*current.
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 5.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(3, "ground", &[[0, 100]], &[]),
            elm(4, "ground", &[[100, 0]], &[]),
        ],
        opts(1e-5, false),
    );
    c.run(1);
    let powers = c.element_powers();
    assert!(
        close(powers[0], -25e-3, 1e-12),
        "source power was {}",
        powers[0]
    );
    assert!(
        close(powers[1], 25e-3, 1e-12),
        "resistor power was {}",
        powers[1]
    );
    // And a Power scope on the source must sample the same value the readout
    // shows, not the positive EMF*I the display sign would give.
    let mut c = build_with(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 5.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(3, "ground", &[[0, 100]], &[]),
            elm(4, "ground", &[[100, 0]], &[]),
        ],
        opts(1e-5, false),
        vec![ScopeSpec {
            element_id: 1,
            value: ScopeValue::Power,
            post: 0,
            steps_per_column: 1,
            columns: 1024,
        }],
    );
    c.run(1);
    let snap = c.scopes()[0].snapshot();
    assert!(
        close(snap[0] as f64, -25e-3, 1e-9),
        "power scope min was {}",
        snap[0]
    );
}

#[test]
fn voltage_limited_current_source_clips() {
    // A 0.01 A source with 5 V compliance into a 1 M load must settle just
    // above 5 V, where the tanh transition has rolled the current off, instead
    // of driving the node to i*R = 1e4 V like an ideal source. The transition
    // spans 0.95*Vmax to Vmax (CurrentElm.java:134-137), so the operating
    // point lands just past 5 V.
    let c = &mut build(
        vec![
            elm(
                1,
                "current",
                &[[0, 100], [0, 0]],
                &[("current", 0.01), ("maxVoltage", 5.0)],
            ),
            elm(2, "resistor", &[[0, 0], [100, 0]], &[("resistance", 1e6)]),
            elm(3, "ground", &[[0, 100]], &[]),
            elm(4, "ground", &[[100, 0]], &[]),
        ],
        opts(1e-5, true),
    );
    let report = c.run(20);
    assert!(report.converged, "did not converge: {:?}", report.error);
    let v = c.element_voltages()[0];
    assert!(
        (4.5..=6.0).contains(&v.abs()),
        "source terminal voltage was {v}, expected it clipped near 5 V"
    );
    let i = c.element_currents()[1];
    assert!(
        i.abs() < 1e-3,
        "resistor current was {i}, the ideal source would push 0.01 A"
    );
}

#[test]
fn current_source_in_series_with_capacitor_settles() {
    // A source with no DC path (series capacitor) used to drive its bare
    // terminal to i/GMIN = 1e7 V through the floating-node pin. Analysis now
    // marks the source broken: it stamps a 100 M resistor and reports zero
    // current, so every node stays near ground.
    let c = &mut build(
        vec![
            elm(1, "current", &[[0, 0], [100, 0]], &[("current", 0.01)]),
            elm(2, "capacitor", &[[100, 0], [100, 100]], &[]),
            elm(3, "ground", &[[100, 100]], &[]),
        ],
        opts(1e-5, true),
    );
    let report = c.run(20);
    assert!(report.converged, "did not converge: {:?}", report.error);
    for (i, v) in c.node_voltages().iter().enumerate() {
        assert!(v.abs() < 1e3, "node {i} reached {} V", v);
    }
    assert!(
        close(c.element_currents()[0], 0.0, 1e-9),
        "broken source reported {} A",
        c.element_currents()[0]
    );
}

#[test]
fn voltage_limited_source_is_never_forced_broken() {
    // Same no-DC-path topology as the broken-source test, but with a 5 V
    // compliance: `setBroken` excludes voltage-limited sources
    // (CurrentElm.java:102-104), so the companion model drives the terminal
    // voltage up near 5 V instead of the source being replaced by a 100 M
    // resistor and sitting near 0 V.
    let c = &mut build(
        vec![
            elm(
                1,
                "current",
                &[[0, 0], [100, 0]],
                &[("current", 0.01), ("maxVoltage", 5.0)],
            ),
            elm(2, "capacitor", &[[100, 0], [100, 100]], &[]),
            elm(3, "ground", &[[100, 100]], &[]),
        ],
        opts(1e-5, true),
    );
    let report = c.run(20);
    assert!(report.converged, "did not converge: {:?}", report.error);
    let v = c.element_voltages()[0];
    assert!(
        (4.0..=6.5).contains(&v.abs()),
        "terminal voltage was {v}, expected it clipped near 5 V rather than being forced broken"
    );
}

#[test]
fn broken_state_tracks_switch_toggles() {
    // A current source driving a loop through a resistor and a switch is fine
    // while the switch is closed and broken once it opens; the check runs from
    // `set_state`'s restamp, so the flag tracks the toggle without a rebuild.
    let c = &mut build(
        vec![
            elm(1, "current", &[[0, 0], [100, 0]], &[("current", 0.01)]),
            elm(
                2,
                "resistor",
                &[[100, 0], [200, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(3, "switch", &[[200, 0], [200, 100]], &[("position", 0.0)]),
            elm(4, "wire", &[[200, 100], [0, 100]], &[]),
            elm(5, "wire", &[[0, 100], [0, 0]], &[]),
            elm(6, "ground", &[[0, 100]], &[]),
        ],
        opts(1e-5, true),
    );
    c.run(5);
    assert!(
        close(c.element_currents()[0], 0.01, 1e-9),
        "closed switch: source reported {} A",
        c.element_currents()[0]
    );

    assert!(c.set_state(3, 1));
    let report = c.run(5);
    assert!(report.converged, "did not converge: {:?}", report.error);
    for (i, v) in c.node_voltages().iter().enumerate() {
        assert!(v.abs() < 1e3, "node {i} reached {} V", v);
    }
    assert!(
        close(c.element_currents()[0], 0.0, 1e-9),
        "open switch: source reported {} A",
        c.element_currents()[0]
    );

    assert!(c.set_state(3, 0));
    c.run(5);
    assert!(
        close(c.element_currents()[0], 0.01, 1e-9),
        "re-closed switch: source reported {} A",
        c.element_currents()[0]
    );
}

#[test]
fn zero_current_source_is_inert_at_engine_level() {
    // A 0 A current source given directly to the engine stays 0 A: the
    // load-time 0 -> 0.01 normalisation is the frontend's job
    // (CurrentElm.java:43-44), and this pins that the model itself does not
    // force it. With nothing driving the load, the divider current is 0.
    let c = &mut build(
        vec![
            elm(1, "current", &[[0, 100], [0, 0]], &[("current", 0.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(3, "ground", &[[0, 100]], &[]),
            elm(4, "ground", &[[100, 0]], &[]),
        ],
        opts(1e-5, true),
    );
    c.run(5);
    assert!(
        close(c.element_currents()[1], 0.0, 1e-12),
        "load current was {}",
        c.element_currents()[1]
    );
}

#[test]
fn probe_series_resistance_loads_the_divider() {
    // A probe across the lower leg of a 10 V / 10k divider puts its series
    // resistance in parallel with that leg (ProbeElm.java:347-350). With
    // resistance 10k the lower leg becomes 5k and the midpoint falls to
    // 10 * 5/(10+5) = 3.333 V, while the reported current is that voltage
    // over the resistance, 3.333e-4 A (ProbeElm.java:343-345). An ideal probe
    // (resistance 0) must leave the divider at 5 V and report zero current.
    let dt = 1e-5;
    let expected_midpoint = 10.0 * 5000.0 / 15000.0;
    let ideal = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 10.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 10_000.0)],
            ),
            elm(
                3,
                "resistor",
                &[[100, 0], [100, 100]],
                &[("resistance", 10_000.0)],
            ),
            elm(4, "wire", &[[100, 100], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
            elm(6, "probe", &[[100, 0], [100, 100]], &[("resistance", 0.0)]),
        ],
        opts(dt, true),
    );
    ideal.run(5);
    assert!(
        close(ideal.element_voltages()[2], 5.0, 1e-9),
        "ideal probe moved the midpoint to {}",
        ideal.element_voltages()[2]
    );
    assert!(
        close(ideal.element_currents()[5], 0.0, 1e-12),
        "ideal probe reported {} A",
        ideal.element_currents()[5]
    );

    // The live edit path: raising the resistance makes the same probe load the
    // divider without a rebuild, and the next steps settle on the loaded point.
    assert!(ideal.set_param(6, "resistance", 10_000.0));
    ideal.run(5);
    assert!(
        close(ideal.element_voltages()[2], expected_midpoint, 1e-3),
        "edited probe left the midpoint at {}",
        ideal.element_voltages()[2]
    );
    assert!(
        close(
            ideal.element_currents()[5],
            expected_midpoint / 10_000.0,
            1e-7
        ),
        "probe current was {}",
        ideal.element_currents()[5]
    );

    // And a probe built with the resistance already set reaches the same point
    // straight off the file.
    let loaded = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 10.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 10_000.0)],
            ),
            elm(
                3,
                "resistor",
                &[[100, 0], [100, 100]],
                &[("resistance", 10_000.0)],
            ),
            elm(4, "wire", &[[100, 100], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
            elm(
                6,
                "probe",
                &[[100, 0], [100, 100]],
                &[("resistance", 10_000.0)],
            ),
        ],
        opts(dt, true),
    );
    loaded.run(5);
    assert!(
        close(loaded.element_voltages()[2], expected_midpoint, 1e-3),
        "loaded probe left the midpoint at {}",
        loaded.element_voltages()[2]
    );
}

/// A 1 kHz, 10 V peak sine into a 1k resistor with a probe across the source
/// terminals, the shape the three measurement tests share. `probe_index` is
/// where the probe lands in the element list.
fn probe_on_sine(meter: f64) -> Circuit {
    build(
        vec![
            elm(
                1,
                "voltage",
                &[[0, 100], [0, 0]],
                &[
                    ("waveform", 1.0),
                    ("frequency", 1000.0),
                    ("maxVoltage", 10.0),
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
                "probe",
                &[[0, 100], [0, 0]],
                &[("resistance", 0.0), ("meter", meter)],
            ),
            elm(4, "ground", &[[0, 100]], &[]),
            elm(5, "ground", &[[100, 0]], &[]),
        ],
        opts(1e-6, false),
    )
}

#[test]
fn probe_measures_rms_on_a_sine() {
    // Two full periods of a 1 kHz sine at dt = 1e-6 is 2000 steps. The last
    // direction change (the peak, half a period earlier) finalised the RMS
    // over a complete half-cycle, so `value()` reads the sine RMS, 10/sqrt(2),
    // within the one-sample discretisation error at the turning point.
    let c = &mut probe_on_sine(1.0);
    c.run(2000);
    let values = c.element_values();
    let expected = 10.0 / 2.0f64.sqrt();
    assert!(
        close(values[2], expected, 0.05),
        "RMS read {}, expected {expected}",
        values[2]
    );
}

#[test]
fn probe_zero_stall_clears_the_reading() {
    // A signal parked at zero for more than five samples zeroes the RMS,
    // average and the peaks (ProbeElm.java:328-340). Kill the drive after two
    // full periods and the accumulator must not keep the stale value.
    let c = &mut probe_on_sine(1.0);
    c.run(2000);
    assert!(
        close(c.element_values()[2], 10.0 / 2.0f64.sqrt(), 0.05),
        "RMS before the stall was {}",
        c.element_values()[2]
    );

    assert!(c.set_param(1, "maxVoltage", 0.0));
    c.run(10);
    assert!(
        close(c.element_values()[2], 0.0, 1e-12),
        "RMS after the stall was {}",
        c.element_values()[2]
    );
}

#[test]
fn each_probe_meter_mode_reads_the_right_quantity() {
    // Seven ideal probes across the source terminals, one per selectable mode
    // (ProbeElm.java:444-446): VOL, RMS, AVG, MAX, MIN, P2P, BIN. After two
    // full periods the last direction changes captured a complete half-cycle
    // of peaks and troughs, and the last sample sits at t = 2 ms.
    let c = &mut build(
        vec![
            elm(
                1,
                "voltage",
                &[[0, 100], [0, 0]],
                &[
                    ("waveform", 1.0),
                    ("frequency", 1000.0),
                    ("maxVoltage", 10.0),
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
                "probe",
                &[[0, 100], [0, 0]],
                &[("resistance", 0.0), ("meter", 0.0)],
            ),
            elm(
                4,
                "probe",
                &[[0, 100], [0, 0]],
                &[("resistance", 0.0), ("meter", 1.0)],
            ),
            elm(
                5,
                "probe",
                &[[0, 100], [0, 0]],
                &[("resistance", 0.0), ("meter", 10.0)],
            ),
            elm(
                6,
                "probe",
                &[[0, 100], [0, 0]],
                &[("resistance", 0.0), ("meter", 2.0)],
            ),
            elm(
                7,
                "probe",
                &[[0, 100], [0, 0]],
                &[("resistance", 0.0), ("meter", 3.0)],
            ),
            elm(
                8,
                "probe",
                &[[0, 100], [0, 0]],
                &[("resistance", 0.0), ("meter", 4.0)],
            ),
            elm(
                9,
                "probe",
                &[[0, 100], [0, 0]],
                &[("resistance", 0.0), ("meter", 5.0)],
            ),
            elm(10, "ground", &[[0, 100]], &[]),
            elm(11, "ground", &[[100, 0]], &[]),
        ],
        opts(1e-6, false),
    );
    c.run(2000);
    let values = c.element_values();
    assert!(close(values[2], 0.0, 1e-6), "VOL read {}", values[2]);
    assert!(
        close(values[3], 10.0 / 2.0f64.sqrt(), 0.05),
        "RMS read {}",
        values[3]
    );
    assert!(close(values[4], 0.0, 0.1), "AVG read {}", values[4]);
    assert!(close(values[5], 10.0, 0.05), "MAX read {}", values[5]);
    assert!(close(values[6], -10.0, 0.05), "MIN read {}", values[6]);
    assert!(close(values[7], 20.0, 0.1), "P2P read {}", values[7]);
    assert!(close(values[8], 0.0, 1e-12), "BIN read {}", values[8]);
}

#[test]
fn probe_series_resistance_rescues_a_floating_node() {
    // The far end of a probe with a series resistor is a node whose only path
    // to the rest of the circuit runs through that resistor, so the probe's
    // `connects()` must tie it to the ground side for the floating-node
    // analysis (ProbeElm.java:397). With an ideal probe (resistance 0) the
    // same node is its own component, flagged and pinned with GMIN instead.
    let dt = 1e-5;
    let circuit = |resistance: f64| {
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
                    "probe",
                    &[[100, 0], [100, 100]],
                    &[("resistance", resistance)],
                ),
                elm(4, "ground", &[[0, 100]], &[]),
            ],
            opts(dt, true),
        )
    };

    let ideal = &mut circuit(0.0);
    assert!(
        ideal
            .warnings()
            .iter()
            .any(|w| w.contains("no path to ground")),
        "an ideal probe should leave the node floating"
    );

    let mut tied = circuit(1e6);
    assert!(
        tied.warnings()
            .iter()
            .all(|w| !w.contains("no path to ground")),
        "warnings: {:?}",
        tied.warnings()
    );
    tied.run(5);
    // The dangling node sits at the source-side 10 V through the 1 M tie, so
    // no current flows and the probe reads zero differential.
    assert!(
        close(tied.element_voltages()[2], 0.0, 1e-6),
        "probe differential was {}",
        tied.element_voltages()[2]
    );
}

/// An N-channel with the gate held above Vt and the drain fed through a
/// resistor from 5 V, the shared shape of the triode and saturation cases.
/// Posts are gate, source, drain; the source sits on a ground symbol.
fn n_mosfet_drain(r: f64, dc: bool) -> Circuit {
    build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 5.0)]),
            elm(2, "resistor", &[[0, 0], [100, 0]], &[("resistance", r)]),
            elm(
                3,
                "mosfet",
                &[[200, 0], [100, 100], [100, 0]],
                &[("pnp", 1.0), ("threshold", 1.5), ("beta", 0.02)],
            ),
            elm(
                4,
                "voltage",
                &[[200, 100], [200, 0]],
                &[("maxVoltage", 3.0)],
            ),
            elm(5, "ground", &[[0, 100]], &[]),
            elm(6, "ground", &[[100, 100]], &[]),
            elm(7, "ground", &[[200, 100]], &[]),
        ],
        opts(1e-5, dc),
    )
}

#[test]
fn n_mosfet_triode_and_saturation() {
    // vgs = 3 V, vt = 1.5 V, beta = 0.02, lambda = 0. With the drain fed
    // through R from 5 V the operating point is closed form:
    //   triode:     ids = beta*((vgs-vt)*vds - vds^2/2) = (5 - Vd)/R
    //   saturation: ids = .5*beta*(vgs-vt)^2             = (5 - Vd)/R
    // R = 360 lands in triode at Vd = 0.5 V (ids = 12.5 mA); R = 100 in
    // saturation at Vd = 2.75 V (ids = 22.5 mA). The drain node is the
    // mosfet's voltage_diff, volts[2] - volts[1] = Vd - 0.
    let triode = &mut n_mosfet_drain(360.0, true);
    let report = triode.run(20);
    assert!(report.converged, "did not converge: {:?}", report.error);
    assert!(
        close(triode.element_voltages()[2], 0.5, 1e-3),
        "triode drain was {}",
        triode.element_voltages()[2]
    );
    assert!(
        close(triode.element_currents()[2], 0.0125, 1e-5),
        "triode ids was {}",
        triode.element_currents()[2]
    );

    let sat = &mut n_mosfet_drain(100.0, true);
    let report = sat.run(20);
    assert!(report.converged, "did not converge: {:?}", report.error);
    assert!(
        close(sat.element_voltages()[2], 2.75, 1e-3),
        "saturation drain was {}",
        sat.element_voltages()[2]
    );
    assert!(
        close(sat.element_currents()[2], 0.0225, 1e-5),
        "saturation ids was {}",
        sat.element_currents()[2]
    );
}

#[test]
fn p_mosfet_mirrors_the_n_channel() {
    // The P-channel mirror of the triode case: source on the 5 V rail, gate at
    // 2 V (so Vsg = 3, the symmetric point of the N-channel's Vgs), drain
    // through 360 ohm to ground. Post 2 is the source post for a P-channel and
    // post 1 the drain post, so the source goes on the rail and the resistor
    // on the other side; the body diode (anode at post 1) then stays
    // reverse-biased while the channel conducts in the normal direction. At
    // the symmetric point Vsd = 0.5 V the channel current is the same 12.5 mA
    // as the N-channel, reported positive because the engine's source lands on
    // its nominal post here, so no fold-back flips the sign.
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 5.0)]),
            elm(2, "wire", &[[0, 0], [100, 0]], &[]),
            // Posts: gate, source, drain.
            elm(
                3,
                "mosfet",
                &[[200, 0], [100, 100], [100, 0]],
                &[("pnp", -1.0), ("threshold", 1.5), ("beta", 0.02)],
            ),
            elm(
                4,
                "resistor",
                &[[100, 100], [100, 200]],
                &[("resistance", 360.0)],
            ),
            elm(
                5,
                "voltage",
                &[[200, 100], [200, 0]],
                &[("maxVoltage", 2.0)],
            ),
            elm(6, "ground", &[[0, 100]], &[]),
            elm(7, "ground", &[[100, 200]], &[]),
            elm(8, "ground", &[[200, 100]], &[]),
        ],
        opts(1e-5, true),
    );
    let report = c.run(20);
    assert!(report.converged, "did not converge: {:?}", report.error);
    assert!(
        close(c.element_currents()[2], 0.0125, 1e-5),
        "P-channel ids was {}",
        c.element_currents()[2]
    );
    assert!(
        close(c.element_currents()[2].abs(), 0.0125, 1e-5),
        "P-channel magnitude was {}",
        c.element_currents()[2].abs()
    );
}

#[test]
fn mosfet_off_uses_min_conductance() {
    // Gate grounded (below Vt): the channel is a 1e-8 S resistor, so the drain
    // follows the divider 5 V through 1 k against 1e8 ohm to the grounded
    // source: Vd = 5/(1 + 1e-8*1000) = 4.99995 V and ids = Vd*1e-8. Without
    // that floor the drain would be a node the matrix cannot pin.
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 5.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(
                3,
                "mosfet",
                &[[200, 0], [100, 100], [100, 0]],
                &[("pnp", 1.0), ("threshold", 1.5), ("beta", 0.02)],
            ),
            elm(4, "ground", &[[0, 100]], &[]),
            elm(5, "ground", &[[100, 100]], &[]),
            elm(6, "ground", &[[200, 0]], &[]),
        ],
        opts(1e-5, true),
    );
    let report = c.run(20);
    assert!(report.converged, "did not converge: {:?}", report.error);
    assert!(
        close(c.element_voltages()[2], 4.99995, 1e-3),
        "off-channel drain was {}",
        c.element_voltages()[2]
    );
    assert!(
        close(c.element_currents()[2], 4.99995e-8, 1e-10),
        "off-channel ids was {}",
        c.element_currents()[2]
    );
}

#[test]
fn body_diode_conducts_when_reversed() {
    // N-channel with the source post on the 5 V rail and the drain post fed by
    // a 10 mA current source to ground. The gate is grounded (off), so the
    // channel carries nothing; the body diode (anode at the source) is forward
    // biased and must conduct the whole 10 mA, clamping the source-to-drain
    // drop at the default diode model's knee for that current. Without the
    // diode the current source would push through the 1e-8 off-channel and
    // drive the drain to ~1e6 V.
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 5.0)]),
            elm(2, "wire", &[[0, 0], [100, 0]], &[]),
            // Posts: gate, source, drain; the source post sits on the rail.
            elm(
                3,
                "mosfet",
                &[[200, 0], [100, 0], [100, 100]],
                &[("pnp", 1.0), ("threshold", 1.5), ("beta", 0.02)],
            ),
            elm(
                7,
                "current",
                &[[100, 100], [100, 200]],
                &[("current", 0.01)],
            ),
            elm(5, "ground", &[[0, 100]], &[]),
            elm(6, "ground", &[[200, 0]], &[]),
            elm(8, "ground", &[[100, 200]], &[]),
        ],
        opts(1e-5, true),
    );
    let report = c.run(20);
    assert!(report.converged, "did not converge: {:?}", report.error);
    assert!(report.error.is_none(), "error: {:?}", report.error);
    // The mosfet's voltage_diff is volts[2] - volts[1] = Vd - 5, so the drop
    // is -voltage_diff. The diode must sit on its own I-V curve at 10 mA.
    let drop = -c.element_voltages()[2];
    assert!(
        close(diode_current(drop), 0.01, 1e-6),
        "body diode drop {drop} does not conduct 10 mA"
    );
    assert!((0.4..0.8).contains(&drop), "body diode drop was {drop}");
}

#[test]
fn p_mosfet_body_diode_conducts_when_reversed() {
    // The P-channel mirror of the N body-diode case: source (post 2) on the
    // 5 V rail, drain (post 1) fed by a 10 mA current source from ground, and
    // the gate tied to the rail so Vsg = 0 and the channel is off. The body
    // diode (anode at post 1, the drain post for a P-channel) conducts the
    // whole 10 mA from the drain into the source rail, clamping the
    // drain-to-source drop on the default diode model's I-V curve at 10 mA.
    // With the diode wired the wrong way round (anode at the source) this
    // circuit would reverse-bias it and the drain would climb against the
    // 1e-8 off-channel instead.
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 5.0)]),
            elm(2, "wire", &[[0, 0], [100, 0]], &[]),
            elm(3, "wire", &[[0, 0], [200, 0]], &[]),
            // Posts: gate, source, drain; the source (post 2) sits on the rail.
            elm(
                4,
                "mosfet",
                &[[200, 0], [100, 100], [100, 0]],
                &[("pnp", -1.0), ("threshold", 1.5), ("beta", 0.02)],
            ),
            elm(
                5,
                "current",
                &[[100, 200], [100, 100]],
                &[("current", 0.01)],
            ),
            elm(6, "ground", &[[0, 100]], &[]),
            elm(7, "ground", &[[100, 200]], &[]),
        ],
        opts(1e-5, true),
    );
    let report = c.run(20);
    assert!(report.converged, "did not converge: {:?}", report.error);
    assert!(report.error.is_none(), "error: {:?}", report.error);
    // The mosfet's voltage_diff is volts[2] - volts[1] = V(source) - V(drain),
    // so the drain-to-source drop is -voltage_diff.
    let drop = -c.element_voltages()[3];
    assert!(
        close(diode_current(drop), 0.01, 1e-6),
        "P body diode drop {drop} does not conduct 10 mA"
    );
    assert!((0.4..0.8).contains(&drop), "P body diode drop was {drop}");
}

#[test]
fn gate_does_not_connect_to_channel() {
    // A gate tied only to the mosfet: with `connects` returning false for the
    // gate (no gate caps), the gate is its own component and the floating-node
    // analysis flags it, so a gate-only circuit warns instead of silently
    // pinning the gate onto the channel.
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 5.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            // Posts: gate, source, drain. The gate at (200,0) connects nowhere.
            elm(
                3,
                "mosfet",
                &[[200, 0], [100, 100], [100, 0]],
                &[("pnp", 1.0)],
            ),
            elm(4, "ground", &[[0, 100]], &[]),
            elm(5, "ground", &[[100, 100]], &[]),
        ],
        opts(1e-5, true),
    );
    assert!(
        c.warnings().iter().any(|w| w.contains("no path to ground")),
        "the floating gate was not flagged: {:?}",
        c.warnings()
    );
    // And the circuit still simulates with the gate pinned to ground.
    let report = c.run(5);
    assert!(report.converged, "did not converge: {:?}", report.error);
}

// ─── Relays (178 RelayElm, 425 RelayCoilElm, 426 RelayContactElm) ───

/// The relay throw-divider used by the pick-up and file-state tests. The coil
/// is fed by `coil_volts` through an 80 ohm series resistor (so the internal
/// 20 ohm coilR makes the current `coil_volts/100`), and each throw hangs a
/// 1000 ohm load to ground. The pole is fed 5 V through 1000 ohm, so a closed
/// throw reads ~2.5 V and an open one ~2.5 mV.
///
/// Relay post order: pole, throw1 (NC), throw2 (NO), coil0, coil1.
fn relay_throw_divider(coil_volts: f64, position: f64, coil_current: f64) -> Circuit {
    build(
        vec![
            elm(
                1,
                "voltage",
                &[[0, 100], [0, 0]],
                &[("maxVoltage", coil_volts)],
            ),
            elm(2, "resistor", &[[0, 0], [100, 0]], &[("resistance", 80.0)]),
            elm(
                3,
                "relay",
                &[[200, 0], [300, 16], [300, -16], [100, 0], [100, 100]],
                &[("position", position), ("coilCurrent", coil_current)],
            ),
            elm(4, "wire", &[[100, 100], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
            elm(
                6,
                "voltage",
                &[[500, -96], [500, 0]],
                &[("maxVoltage", 5.0)],
            ),
            elm(7, "ground", &[[500, -96]], &[]),
            elm(
                8,
                "resistor",
                &[[200, 0], [500, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(
                9,
                "resistor",
                &[[300, 16], [300, 96]],
                &[("resistance", 1000.0)],
            ),
            elm(10, "ground", &[[300, 96]], &[]),
            elm(
                11,
                "resistor",
                &[[300, -16], [300, -96]],
                &[("resistance", 1000.0)],
            ),
            elm(12, "ground", &[[300, -96]], &[]),
        ],
        opts(1e-4, true),
    )
}

#[test]
fn relay_picks_up_when_coil_current_exceeds_oncurrent() {
    // Coil driven at 0.01 A (1 V through 100 ohm) it stays below offCurrent
    // and the NC path stays closed; driven at 0.03 A (3 V) it picks up after
    // the 5 ms switching time and the NO path takes over. Element 9 is the
    // NC throw's load, element 11 the NO throw's load.
    let c = &mut relay_throw_divider(1.0, 0.0, 0.0);
    c.run(100);
    let v_nc = c.element_voltages()[8];
    let v_no = c.element_voltages()[10];
    assert!(
        v_nc > 2.0,
        "NC throw should be closed below onCurrent, got {v_nc}"
    );
    assert!(
        v_no < 0.1,
        "NO throw should be open below onCurrent, got {v_no}"
    );

    let c = &mut relay_throw_divider(3.0, 0.0, 0.0);
    c.run(100);
    let v_nc = c.element_voltages()[8];
    let v_no = c.element_voltages()[10];
    assert!(
        v_nc < 0.1,
        "NC throw should open above onCurrent, got {v_nc}"
    );
    assert!(
        v_no > 2.0,
        "NO throw should close above onCurrent, got {v_no}"
    );
}

#[test]
fn relay_off_is_a_high_impedance_switch() {
    // With the coil cold the pole-to-NO-throw path is r_off = 1e6: 10 V
    // through 1000 + 1e6 + 1000 gives I = 10/1.002e6. Element 4 is the load
    // resistor on the NO throw; the coil posts are left unconnected so the
    // relay has no drive at all.
    let c = &mut build(
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
                "relay",
                &[[100, 0], [200, 16], [200, -16], [200, -32], [200, -48]],
                &[],
            ),
            elm(
                4,
                "resistor",
                &[[200, -16], [200, -96]],
                &[("resistance", 1000.0)],
            ),
            elm(5, "wire", &[[200, -96], [0, -96]], &[]),
            elm(6, "wire", &[[0, -96], [0, 100]], &[]),
            elm(7, "ground", &[[0, 100]], &[]),
        ],
        opts(1e-4, true),
    );
    c.run(10);
    let expected = 10.0 / (1000.0 + 1e6 + 1000.0);
    let i = c.element_currents()[3];
    assert!(
        close(i, expected, 1e-10),
        "r_off path drew {i}, expected {expected}"
    );
}

/// A 425 coil labelled `coil_label` driving two relay contacts, each in its
/// own 1 k divider across 5 V. Both contacts are normally closed
/// (FLAG_NORMALLY_CLOSED, bit 2) and load closed, so the one the coil drives
/// flips closed to open when the coil picks up. Element indices: 1 = coil,
/// 8 = matched contact A, 11 = unmatched contact B.
fn coil_contact_pair(coil_label: &str, a_label: &str, b_label: &str) -> Circuit {
    let mut spec = CircuitSpec {
        elements: vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 1.0)]),
            elm(2, "relayCoil", &[[100, 0], [100, 100]], &[]),
            elm(3, "wire", &[[0, 0], [100, 0]], &[]),
            elm(4, "wire", &[[100, 100], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
            elm(
                6,
                "voltage",
                &[[400, -96], [400, 0]],
                &[("maxVoltage", 5.0)],
            ),
            elm(7, "ground", &[[400, -96]], &[]),
            elm(
                8,
                "resistor",
                &[[400, 0], [300, 0]],
                &[("resistance", 1000.0)],
            ),
            elm_flags(
                9,
                "relayContact",
                &[[300, 0], [300, 100]],
                &[],
                2, // FLAG_NORMALLY_CLOSED
            ),
            elm(10, "ground", &[[300, 100]], &[]),
            elm(
                11,
                "resistor",
                &[[400, 0], [500, 0]],
                &[("resistance", 1000.0)],
            ),
            elm_flags(
                12,
                "relayContact",
                &[[500, 0], [500, 100]],
                &[],
                2, // FLAG_NORMALLY_CLOSED
            ),
            elm(13, "ground", &[[500, 100]], &[]),
        ],
        options: Some(opts(1e-4, true)),
        scopes: Vec::new(),
    };
    spec.elements[1].label = Some(coil_label.to_string());
    spec.elements[8].label = Some(a_label.to_string());
    spec.elements[11].label = Some(b_label.to_string());
    let mut c = Circuit::new();
    c.set_circuit(&spec).expect("circuit should analyse");
    c
}

#[test]
fn relay_contact_pair_follows_its_coil_by_label() {
    // Both contacts are normally closed and loaded closed (i_position 0). The
    // coil, once it picks up, drives its matched contact to the open position,
    // flipping it from r_on to r_off; the differently-labelled contact has no
    // coil and stays closed. Element 7 is matched contact A's series resistor,
    // element 10 unmatched contact B's.
    let c = &mut coil_contact_pair("Q1", "Q1", "Q2");
    c.run(200);
    let i_a = c.element_currents()[7];
    let i_b = c.element_currents()[10];
    assert!(
        i_a.abs() < 1e-5,
        "matched contact should have opened when the coil picked up, got {i_a}"
    );
    assert!(
        close(i_b, 5.0 / 1000.05, 1e-6),
        "unmatched contact should stay closed, got {i_b}"
    );
}

#[test]
fn relay_polecount_expands_posts() {
    // poleCount = 2 needs 2 + 3*2 = 8 posts; the build itself would fail if
    // the engine counted differently, since the spec hands it exactly eight.
    // Both poles share a 5 V rail through a 1 k feed each and both NC throws
    // hang a 1 k load, so once the coil picks up both throw nodes must read
    // near zero together.
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 3.0)]),
            elm(2, "resistor", &[[0, 0], [100, 0]], &[("resistance", 80.0)]),
            elm(
                3,
                "relay",
                &[
                    [200, 0],
                    [300, 16],
                    [300, -16],
                    [400, 0],
                    [500, 16],
                    [500, -16],
                    [100, 0],
                    [100, 100],
                ],
                &[("poleCount", 2.0)],
            ),
            elm(4, "wire", &[[100, 100], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
            elm(
                6,
                "voltage",
                &[[700, -96], [700, 0]],
                &[("maxVoltage", 5.0)],
            ),
            elm(7, "ground", &[[700, -96]], &[]),
            elm(
                8,
                "resistor",
                &[[200, 0], [700, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(
                9,
                "resistor",
                &[[400, 0], [700, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(
                10,
                "resistor",
                &[[300, 16], [300, 96]],
                &[("resistance", 1000.0)],
            ),
            elm(11, "ground", &[[300, 96]], &[]),
            elm(
                12,
                "resistor",
                &[[300, -16], [300, -96]],
                &[("resistance", 1000.0)],
            ),
            elm(13, "ground", &[[300, -96]], &[]),
            elm(
                14,
                "resistor",
                &[[500, 16], [500, 96]],
                &[("resistance", 1000.0)],
            ),
            elm(15, "ground", &[[500, 96]], &[]),
            elm(
                16,
                "resistor",
                &[[500, -16], [500, -96]],
                &[("resistance", 1000.0)],
            ),
            elm(17, "ground", &[[500, -96]], &[]),
        ],
        opts(1e-4, true),
    );
    assert_eq!(
        c.element_nodes().len(),
        34,
        "two-pole relay should have 8 terminals, not 5"
    );
    c.run(100);
    let nodes = c.element_nodes();
    // Relay is element 2, its terminals start at node offset 4; post 1 is
    // pole 0's NC throw and post 4 is pole 1's NC throw.
    let v_nc0 = c.node_voltages()[nodes[4 + 1] as usize];
    let v_nc1 = c.node_voltages()[nodes[4 + 4] as usize];
    assert!(v_nc0 < 0.1, "pole 0 NC throw should be open, got {v_nc0}");
    assert!(v_nc1 < 0.1, "pole 1 NC throw should be open, got {v_nc1}");
}

#[test]
fn relay_file_state_is_restored() {
    // Coil driven at 0.016 A (1.6 V through 100 ohm), inside the hysteresis
    // band (0.015..0.02): high enough that a position-1 relay stays latched
    // on, low enough that a position-0 relay never picks up. So the loaded
    // position is what the throws read, not the pick-up machine.
    let c = &mut relay_throw_divider(1.6, 1.0, 0.016);
    c.run(200);
    let v_nc = c.element_voltages()[8];
    let v_no = c.element_voltages()[10];
    assert!(
        v_nc < 0.1,
        "NC throw should read open for position 1, got {v_nc}"
    );
    assert!(
        v_no > 2.0,
        "NO throw should read closed for position 1, got {v_no}"
    );

    let c = &mut relay_throw_divider(1.6, 0.0, 0.016);
    c.run(200);
    let v_nc = c.element_voltages()[8];
    let v_no = c.element_voltages()[10];
    assert!(
        v_nc > 2.0,
        "NC throw should read closed for position 0, got {v_nc}"
    );
    assert!(
        v_no < 0.1,
        "NO throw should read open for position 0, got {v_no}"
    );
}

#[test]
fn relay_contact_keeps_resting_position_across_reset() {
    // A de-energised coil rests at switchPosition 0 and drives its contact to
    // i_position 1 (open). The contact's own reset() zeroes i_position
    // (RelayContactElm.java:199-206), so the coil must re-announce its resting
    // position on reset (upstream's re-stamp toggle, RelayCoilElm.java:296-298)
    // or the normally-open contact snaps closed when the sim restarts. Element
    // 7 is the matched contact's series resistor; it stays current-free as
    // long as the contact rests open.
    let mut spec = CircuitSpec {
        elements: vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 0.0)]),
            elm(2, "relayCoil", &[[100, 0], [100, 100]], &[]),
            elm(3, "wire", &[[0, 0], [100, 0]], &[]),
            elm(4, "wire", &[[100, 100], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
            elm(
                6,
                "voltage",
                &[[400, -96], [400, 0]],
                &[("maxVoltage", 5.0)],
            ),
            elm(7, "ground", &[[400, -96]], &[]),
            elm(
                8,
                "resistor",
                &[[400, 0], [300, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(9, "relayContact", &[[300, 0], [300, 100]], &[]),
            elm(10, "ground", &[[300, 100]], &[]),
        ],
        options: Some(opts(1e-4, true)),
        scopes: Vec::new(),
    };
    spec.elements[1].label = Some("Q1".to_string());
    spec.elements[8].label = Some("Q1".to_string());
    let mut c = Circuit::new();
    c.set_circuit(&spec).expect("circuit should analyse");
    c.run(10);
    let i_rest = c.element_currents()[7];
    assert!(
        i_rest.abs() < 1e-5,
        "contact should rest open, got {i_rest}"
    );
    c.reset();
    c.run(10);
    let i_after = c.element_currents()[7];
    assert!(
        i_after.abs() < 1e-5,
        "contact should still rest open after reset, got {i_after}"
    );
}

#[test]
fn relay_latching_coil_keeps_its_contact_after_deenergising() {
    // A type-3 latching coil flips switchPosition on pick-up and keeps it once
    // the drive current drops away (RelayCoilElm.java:317-318, :341-342), so
    // its contact stays thrown instead of snapping back. Element 7 is the
    // matched contact's series resistor: current flows while the coil is
    // energised and must keep flowing after the coil voltage drops to zero.
    let mut spec = CircuitSpec {
        elements: vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 5.0)]),
            elm(2, "relayCoil", &[[100, 0], [100, 100]], &[("type", 3.0)]),
            elm(3, "wire", &[[0, 0], [100, 0]], &[]),
            elm(4, "wire", &[[100, 100], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
            elm(
                6,
                "voltage",
                &[[400, -96], [400, 0]],
                &[("maxVoltage", 5.0)],
            ),
            elm(7, "ground", &[[400, -96]], &[]),
            elm(
                8,
                "resistor",
                &[[400, 0], [300, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(9, "relayContact", &[[300, 0], [300, 100]], &[]),
            elm(10, "ground", &[[300, 100]], &[]),
        ],
        options: Some(opts(1e-4, true)),
        scopes: Vec::new(),
    };
    spec.elements[1].label = Some("Q1".to_string());
    spec.elements[8].label = Some("Q1".to_string());
    let mut c = Circuit::new();
    c.set_circuit(&spec).expect("circuit should analyse");
    c.run(300);
    let i_on = c.element_currents()[7];
    assert!(
        close(i_on, 5.0 / 1000.05, 1e-6),
        "contact should close when the latching coil picks up, got {i_on}"
    );
    assert!(c.set_param(1, "maxVoltage", 0.0));
    c.run(500);
    let i_off = c.element_currents()[7];
    assert!(
        close(i_off, 5.0 / 1000.05, 1e-6),
        "latching contact should stay closed after the coil drops out, got {i_off}"
    );
}

// ─── Transformers ────────────────────────────────────────────────────────────

/// One scope trace: the transformer family's tests read node voltages and
/// current peaks back through scopes rather than the per-element readout,
/// because a transformer's secondary voltage is `V(post1) - V(post3)`, not the
/// default `V(post0) - V(post1)`.
fn tr_scope(id: u32, value: ScopeValue, post: usize) -> ScopeSpec {
    ScopeSpec {
        element_id: id,
        value,
        post,
        steps_per_column: 1,
        columns: 4096,
    }
}

/// Average of the newest min/max column of scope `i`.
fn last_sample(c: &Circuit, i: usize) -> f64 {
    let snap = c.scopes()[i].snapshot();
    let (min, max) = (snap[snap.len() - 2], snap[snap.len() - 1]);
    (min as f64 + max as f64) / 2.0
}

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
fn transformer_dc_pass_pins_ratio() {
    // The DC operating point stamps the same companion with zero history
    // sources, so the ratio falls out of the conductance and VCCS stamps
    // alone: the open secondary forces its winding current to zero, and
    // `Vs = -(M⁻¹[1][0]/M⁻¹[1][1])·Vp = k·ratio·Vp`. The app builds every
    // circuit through this path (`dcOperatingPoint: true`), so a sign error
    // that only bit under DC would corrupt the first transient step's initial
    // conditions while every transient-only test stayed green.
    let v2 = open_secondary_v2_opts(
        "transformer",
        &[[0, 0], [100, 0], [0, 100], [100, 100]],
        &[("inductance", 4.0), ("ratio", 1.0), ("couplingCoef", 0.999)],
        None,
        (1, 3),
        0,
        true,
    );
    assert!(
        close(v2, 9.99, 1e-6),
        "DC operating point read {v2}, expected 9.99"
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

#[test]
fn tapped_transformer_center_tap() {
    // Tapped 1:1 at k = 0.99, secondary open with the centre tap grounded: the
    // tap splits the secondary into two halves of half the turns each, so each
    // half reads k·(ratio/2)·V1 = 4.95 V, one up from ground and one down.
    let spec = CircuitSpec {
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
    // pinning fixes the absolute potential, not the winding difference.
    let spec = CircuitSpec {
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
        close(last_sample(&c, 0) - last_sample(&c, 1), 9.99, 1e-6),
        "floating secondary read {} V, expected 9.99",
        last_sample(&c, 0) - last_sample(&c, 1)
    );
}
