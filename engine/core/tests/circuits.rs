//! End-to-end checks against circuits with known analytic answers.
//!
//! These are the real regression net for the solver: if stamping signs,
//! companion models or Newton limiting break, one of these stops matching
//! theory.

use std::collections::HashMap;
use std::f64::consts::PI;

use circuit_core::{Circuit, CircuitSpec, Element, ElementSpec, ScopeSpec, ScopeValue, SimOptions};

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
        model: None,
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

/// A controlled source whose expression arrives as the element's label, the
/// string carrier the frontend uses for the `exprString` token.
fn elm_expr(id: u32, kind: &str, posts: &[[i32; 2]], input_count: f64, expr: &str) -> ElementSpec {
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
fn elm_model(
    id: u32,
    posts: &[[i32; 2]],
    inputs: usize,
    outputs: usize,
    tri_state: bool,
    rules: &[(&str, &str)],
) -> ElementSpec {
    let model = serde_json::json!({
        "inputs": (0..inputs).map(|i| String::from_utf8(vec![b'A' + i as u8]).unwrap()).collect::<Vec<_>>(),
        "outputs": (0..outputs).map(|i| String::from_utf8(vec![b'A' + inputs as u8 + i as u8]).unwrap()).collect::<Vec<_>>(),
        "triState": tri_state,
        "rulesLeft": rules.iter().map(|(l, _)| *l).collect::<Vec<_>>(),
        "rulesRight": rules.iter().map(|(_, r)| *r).collect::<Vec<_>>(),
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
        min_time_step: 50e-12,
        adaptive: false,
        steps_per_frame: 1,
        max_subiterations: 100,
        dc_operating_point: dc,
    }
}

/// The fixed `opts` helper keeps `adaptive: false` so the 120-odd existing
/// tests stay on the fixed-step path. The adaptive-timestep tests use this
/// instead, selecting the min step and the Newton budget the plan's scenarios
/// need.
fn adaptive_opts(max_step: f64, min_step: f64, subiters: u32) -> SimOptions {
    SimOptions {
        time_step: max_step,
        min_time_step: min_step,
        adaptive: true,
        steps_per_frame: 1,
        max_subiterations: subiters,
        dc_operating_point: false,
    }
}

/// Non-adaptive options at a chosen Newton budget, for the tests that pin the
/// fixed-step path at a small budget. The plan's tuning lever: a circuit that
/// genuinely stalls at the full step must be able to do so within the budget
/// the fixed run hands it.
fn opts_budget(time_step: f64, dc: bool, max_sub: u32) -> SimOptions {
    SimOptions {
        time_step,
        min_time_step: 50e-12,
        adaptive: false,
        steps_per_frame: 1,
        max_subiterations: max_sub,
        dc_operating_point: dc,
    }
}

fn close(a: f64, b: f64, tol: f64) -> bool {
    (a - b).abs() <= tol
}

#[test]
fn spec_requires_integer_posts() {
    // The wire contract is `posts: Vec<[i32; 2]>`. A fractional post, which a
    // snap-off drag used to hand over, must be rejected at deserialisation,
    // before any node merging. This pins why the store rounds coordinates at
    // the handoff: the alternative, widening the type to f64, would silently
    // change node-merging semantics (nodes merge on exact coordinate equality).
    let ok = serde_json::from_str::<CircuitSpec>(
        r#"{"elements":[{"id":1,"kind":"resistor","posts":[[10,20],[170,20]],"params":{},"label":null,"flags":0}]}"#,
    )
    .expect("integer posts should deserialise");
    assert_eq!(ok.elements[0].posts, vec![[10, 20], [170, 20]]);

    let bad = serde_json::from_str::<CircuitSpec>(
        r#"{"elements":[{"id":1,"kind":"resistor","posts":[[10.4,20],[170,20]],"params":{},"label":null,"flags":0}]}"#,
    );
    assert!(bad.is_err(), "fractional posts must be rejected");
}

#[test]
fn spec_rejects_null_params() {
    // The same failure mode as a fractional post: `JSON.stringify(NaN)` emits
    // null, and serde rejects null for an `f64`. This is why the store and the
    // spec builder both drop non-finite params before serialisation.
    let bad = serde_json::from_str::<CircuitSpec>(
        r#"{"elements":[{"id":1,"kind":"resistor","posts":[[10,20],[170,20]],"params":{"resistance":null},"label":null,"flags":0}]}"#,
    );
    assert!(bad.is_err(), "null params must be rejected");
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

/// The motorprotect.txt pattern: a protection switch across a source that can
/// overcurrent it, plus a normally-closed relay contact sharing the switch's
/// label carrying a separate 5 V load. The intact switch drives its NC
/// contact closed (i_position 0); a trip drives it open
/// (MotorProtectionSwitchElm.java:245-256).
fn motor_protection_switch_contact_circuit() -> Circuit {
    let mut spec = CircuitSpec {
        elements: vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 3.0)]),
            elm(
                2,
                "motorProtectionSwitch",
                &[[0, 0], [0, 100], [48, 0], [48, 100], [96, 0], [96, 100]],
                &[("resistance", 1.0), ("i2t", 1.0)],
            ),
            elm(3, "ground", &[[0, 100]], &[]),
            elm(
                4,
                "voltage",
                &[[400, -96], [400, 0]],
                &[("maxVoltage", 5.0)],
            ),
            elm(5, "ground", &[[400, -96]], &[]),
            elm(
                6,
                "resistor",
                &[[400, 0], [300, 0]],
                &[("resistance", 1000.0)],
            ),
            elm_flags(
                7,
                "relayContact",
                &[[300, 0], [300, 100]],
                &[("r_on", 0.05), ("r_off", 1e6)],
                2, // FLAG_NORMALLY_CLOSED
            ),
            elm(8, "ground", &[[300, 100]], &[]),
        ],
        options: Some(opts(1e-3, false)),
        scopes: Vec::new(),
    };
    spec.elements[1].label = Some("mps".to_string());
    spec.elements[6].label = Some("mps".to_string());
    let mut c = Circuit::new();
    c.set_circuit(&spec).expect("circuit should analyse");
    c
}

#[test]
fn motor_protection_switch_trips_on_overcurrent_and_resets() {
    // Four phases on the same model (MotorProtectionSwitchElm.java:221-243):
    // a current below the I²t rating passes like a plain resistor, an
    // overcurrent accumulates heat at i² - i2t/3 per second until one channel
    // crosses its rating and the whole switch opens at ~1 GOhm, a reset
    // clears the heat and re-closes it, and the label-linked relay contact
    // follows the trip.
    //
    // Low-current phase: 10 V across a 1000 ohm channel draws 10 mA. The
    // bleed rate i2t/3 dwarfs the i² accumulation (1e6/3 per second against
    // 1e-4), so heat never climbs and the switch stays on, reading exactly
    // Ohm's law.
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 10.0)]),
            elm(
                2,
                "motorProtectionSwitch",
                &[[0, 0], [0, 100], [48, 0], [48, 100], [96, 0], [96, 100]],
                &[("resistance", 1000.0), ("i2t", 1e6)],
            ),
            elm(3, "ground", &[[0, 100]], &[]),
        ],
        opts(1e-3, false),
    );
    c.run(5);
    let amps = c.element_currents();
    assert!(
        close(amps[1], 0.01, 1e-9),
        "low current through the intact switch was {}, expected 10 mA",
        amps[1]
    );

    // Trip phase: a 1 ohm channel straight across a 3 V source draws 3 A,
    // well past a 1 A²s rating. Heat nets +8.667 per second and crosses the
    // rating in ~116 steps; once blown, the channel becomes a ~1 GOhm
    // resistor and the current collapses toward zero.
    let dt = 1e-3;
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 3.0)]),
            elm(
                2,
                "motorProtectionSwitch",
                &[[0, 0], [0, 100], [48, 0], [48, 100], [96, 0], [96, 100]],
                &[("resistance", 1.0), ("i2t", 1.0)],
            ),
            elm(3, "ground", &[[0, 100]], &[]),
        ],
        opts(dt, false),
    );
    // One warm-up step: start_iteration's first call sees the switch's
    // initial current (0), so heat cannot have moved yet and the switch
    // should still read as a plain 1 ohm resistor here.
    c.run(1);
    let amps = c.element_currents();
    assert!(
        close(amps[1], 3.0, 1e-6),
        "expected the intact switch to draw 3 A, got {}",
        amps[1]
    );

    // Comfortably past the ~116 further steps the heat integral needs to
    // cross its 1.0 A²s rating at a steady 3 A.
    c.run(300);
    let amps = c.element_currents();
    assert!(
        amps[1].abs() < 1e-6,
        "expected the tripped switch's current to collapse toward zero, got {}",
        amps[1]
    );

    // A reset clears the accumulated heat and re-closes the switch, so the
    // overcurrent returns and the cycle can begin again.
    c.reset();
    c.run(5);
    let amps = c.element_currents();
    assert!(
        close(amps[1], 3.0, 1e-6),
        "expected the reset switch to draw 3 A again, got {}",
        amps[1]
    );

    // Label phase: the intact switch holds its labelled normally-closed
    // relay contact shut, so the separate 5 V load reads 5 V / (1 k + r_on);
    // once the switch trips it drives the contact open and the load current
    // collapses.
    let c = &mut motor_protection_switch_contact_circuit();
    c.run(1);
    let amps = c.element_currents();
    assert!(
        close(amps[5], 5.0 / 1000.05, 1e-6),
        "expected the intact switch to hold its contact closed, load current was {}",
        amps[5]
    );
    c.run(300);
    let amps = c.element_currents();
    assert!(
        amps[5].abs() < 1e-4,
        "expected the tripped switch to open its labelled contact, load current was {}",
        amps[5]
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

#[test]
fn dc_solve_charges_the_cap_before_the_first_transient_step() {
    // The DC operating point charges the capacitor to the steady 10 V, and
    // `step_finished` commits that plate voltage to the capacitor's history,
    // so the very first transient step starts pre-charged instead of
    // re-solving from zero (the t=0 glitch). Without the commit the cap would
    // act as a 2 S resistor for one step and the node would collapse to about
    // 5e-3 V with a 0.01 A charging current.
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
        opts(1e-6, true),
    );
    let v = c.element_voltages()[2];
    assert!(close(v, 10.0, 1e-3), "DC solve charged the cap to {v}");

    c.run(1);
    let volts = c.element_voltages();
    let amps = c.element_currents();
    assert!(
        close(volts[2], 10.0, 1e-3),
        "first transient step dropped the charge to {}",
        volts[2]
    );
    assert!(amps[2].abs() < 1e-6, "charged cap drew {} A", amps[2]);
}

#[test]
fn dc_off_starts_from_initial_conditions() {
    // With the DC operating point off, the same RC network starts uncharged:
    // one step in, the capacitor acts as a 2 S resistor and the node has
    // collapsed toward 5e-3 V. With the solve on, the identical step holds
    // 10 V, so this assertion pins the whole switch.
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
        opts(1e-6, false),
    );
    c.run(1);
    let v = c.element_voltages()[2];
    assert!(v.abs() < 0.01, "uncharged start read {v} V, expected ~5e-3");
}

#[test]
fn failed_dc_solve_restarts_from_initial_conditions() {
    // A current source pushing into a node whose only load is a reverse diode
    // has no DC operating point: the diode cannot pass the source's current
    // backwards, so Newton diverges and the operating-point solve fails. The
    // reset path in `solve_operating_point` must then leave the circuit at
    // its documented initial conditions: element voltages read zero, and
    // `node_voltages` is cleared rather than holding the last, diverged
    // iterate (which reads ~1e12 V on this circuit). The uncharged-start
    // comparison is what pins "a failed solve leaves no trace": the same
    // circuit built with the DC solve off starts identical and runs the same.
    let current_into_reverse_diode = |dc: bool| {
        build(
            vec![
                elm(1, "current", &[[0, 0], [100, 0]], &[("current", 1e-2)]),
                elm(2, "diode", &[[200, 0], [100, 0]], &[]),
                elm(3, "ground", &[[0, 0]], &[]),
                elm(4, "ground", &[[200, 0]], &[]),
            ],
            opts(1e-5, dc),
        )
    };
    let mut dc_on = current_into_reverse_diode(true);
    let mut dc_off = current_into_reverse_diode(false);

    // The failed solve left no trace: both circuits read the uncharged start.
    assert_eq!(
        dc_on.node_voltages(),
        dc_off.node_voltages(),
        "node voltages must not hold the last DC iterate"
    );
    assert!(
        dc_on.node_voltages().iter().all(|&v| v == 0.0),
        "node voltages were {:?}, expected all zero",
        dc_on.node_voltages()
    );
    assert_eq!(dc_on.element_voltages(), dc_off.element_voltages());
    assert!(
        dc_on.element_voltages().iter().all(|&v| v == 0.0),
        "element voltages were {:?}, expected all zero",
        dc_on.element_voltages()
    );

    // The transient degrades to the uncharged start, not to the DC failure's
    // last iterate: it behaves exactly like the never-solved circuit.
    let on_report = dc_on.run(1);
    let off_report = dc_off.run(1);
    assert_eq!(on_report.converged, off_report.converged);
    assert_eq!(on_report.error, off_report.error);
}

/// 10 V behind 900 ohm into a capacitor with a 100 ohm ESR, built either with
/// the DC operating point on or off. Both matter: `circuits.rs` defaults to
/// off, but the app sends `dcOperatingPoint` from `settings.autoDC`, which a
/// loaded file's header flag bit 128 turns on, and the internal node exists
/// for the whole run either way, so the DC pass is the only place this port
/// has to stamp something upstream does not (upstream's
/// `getInternalNodeCount()` returns 0 under DC and the node simply is not
/// there).
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

/// A freshly drawn parallel pair of ideal capacitors with unequal stored
/// charges (1 V and 0 V). This is the loop `CapacitorElm.validate()`
/// (CapacitorElm.java:274-291) dampens: the trapezoidal companion on an
/// ideal-cap loop rings at the Nyquist rate, the per-cap currents alternating
/// sign every step at full amplitude and never decaying (CapacitorElm.java:
/// 163-165). The validate pass gives one member a 0.1 ohm series resistance
/// and the ring dies within a few dozen steps, leaving the charge-weighted
/// average on the common node.
fn parallel_ideal_pair(dt: f64) -> Circuit {
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

#[test]
fn ideal_capacitor_loop_settles_instead_of_ringing() {
    let dt = 1e-6;
    let c = &mut parallel_ideal_pair(dt);
    c.run(200);

    // The common node holds the charge-weighted average whether or not the
    // ring is damped, so the ring shows up in the currents, not the voltage.
    let v = c.element_voltages()[0];
    assert!(
        close(v, 0.5, 1e-3),
        "common node at {v}, expected the charge-weighted 0.5 V"
    );

    // Second half of the run: an undamped ring keeps swapping ±1 A through
    // each cap forever. Damped, the currents decay to nothing.
    let mut peak: f64 = 0.0;
    for _ in 0..100 {
        c.run(1);
        for i in c.element_currents() {
            peak = peak.max(i.abs());
        }
    }
    assert!(peak < 1e-3, "cap loop still ringing, peak current {peak} A");
}

#[test]
fn cappar_recorded_pair_is_left_alone() {
    // The cappar.txt shape: one member already carries the 0.1 ohm upstream's
    // validate() wrote there. The walk must find no CAP_V path through it (it
    // is no longer ideal), so the pair keeps exactly the recorded ESR: the
    // ideal member gains no internal node and the pair settles as before.
    let dt = 1e-6;
    let c = &mut build(
        vec![
            elm(
                1,
                "capacitor",
                &[[0, 0], [0, 100]],
                &[
                    ("capacitance", 1e-6),
                    ("voltDiff", 1.0),
                    ("seriesResistance", 0.1),
                ],
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
    );
    // Two caps share two posts: one node pair plus the recorded ESR's single
    // internal node. The node count is the real guard against over-damping: a
    // wrongly-damped ideal member would add a second internal node and grow
    // the count. The settle check below is redundant by construction once the
    // count holds, because an undamped pair rings and this one cannot.
    assert_eq!(
        c.node_count(),
        3,
        "walk double-damped the ideal member, node count changed"
    );
    c.run(200);
    let mut peak: f64 = 0.0;
    for _ in 0..100 {
        c.run(1);
        for i in c.element_currents() {
            peak = peak.max(i.abs());
        }
    }
    assert!(
        peak < 1e-3,
        "recorded pair not settling, peak current {peak} A"
    );
}

#[test]
fn shorted_capacitor_is_inert() {
    // A capacitor with a wire directly across its posts: both posts merge to
    // one node, `validate()`'s SHORT condition fires and `shorted()` zeroes
    // the stored charge. The self-node stamp cancels in the Stamper, so the
    // matrix is not singular and the cap reports no current.
    let dt = 1e-6;
    let c = &mut build(
        vec![
            elm(
                1,
                "capacitor",
                &[[0, 0], [0, 100]],
                &[("capacitance", 1e-6), ("voltDiff", 5.0)],
            ),
            elm(2, "wire", &[[0, 0], [0, 100]], &[]),
            elm(
                3,
                "resistor",
                &[[0, 100], [100, 100]],
                &[("resistance", 1000.0)],
            ),
            elm(4, "ground", &[[100, 100]], &[]),
        ],
        opts(dt, false),
    );
    assert_eq!(
        c.error(),
        None,
        "shorted cap must not make the matrix singular"
    );
    let report = c.run(10);
    assert!(
        report.converged,
        "shorted cap run failed: {}",
        report.error.as_deref().unwrap_or("no error text")
    );
    assert!(
        c.element_currents()[0].abs() < 1e-9,
        "shorted cap carries current"
    );
    assert!(
        c.element_voltages()[0].abs() < 1e-9,
        "shorted cap shows a voltage drop"
    );
}

#[test]
fn cap_across_a_rail_is_damped_by_the_cap_v_walk() {
    // A rail is a one-post voltage source: the walk must cross it as an edge
    // from its terminal to ground, so an ideal cap in parallel with a rail is
    // caught and damped. The undamped case rings at the source voltage; the
    // damped one settles to the rail and stops moving current.
    let dt = 1e-6;
    let c = &mut build(
        vec![
            elm(1, "rail", &[[0, 0]], &[("maxVoltage", 5.0)]),
            elm(
                2,
                "capacitor",
                &[[100, 0], [100, 100]],
                &[("capacitance", 1e-6), ("voltDiff", 0.0)],
            ),
            elm(3, "wire", &[[0, 0], [100, 0]], &[]),
            elm(4, "ground", &[[100, 100]], &[]),
        ],
        opts(dt, false),
    );
    c.run(200);
    // The cap sits at the rail voltage and carries no current once settled.
    assert!(
        close(c.element_voltages()[1], 5.0, 1e-3),
        "cap at {} V, expected the rail's 5 V",
        c.element_voltages()[1]
    );
    let mut peak: f64 = 0.0;
    for _ in 0..100 {
        c.run(1);
        peak = peak.max(c.element_currents()[1].abs());
    }
    assert!(
        peak < 1e-3,
        "cap across a rail still ringing, peak {peak} A"
    );
}

#[test]
fn two_rails_without_a_ground_symbol_drive_their_difference() {
    // Two rails bridge the reference node, so a circuit that never touches a
    // ground symbol is still grounded through them. The no-ground fallback
    // must skip such a circuit: grounding the first rail's post would short
    // that source to itself (a ground-to-ground row) and the build would go
    // singular. Upstream's setGroundNode only falls back when no rail exists
    // (SimulationManager.java:517-528).
    let mut c = build(
        vec![
            elm(1, "rail", &[[0, 0]], &[("maxVoltage", 10.0)]),
            elm(2, "rail", &[[100, 0]], &[("maxVoltage", 5.0)]),
            elm(3, "resistor", &[[0, 0], [100, 0]], &[("resistance", 100.0)]),
        ],
        opts(1e-6, false),
    );
    // Both posts are normal nodes now, so the resistor carries the rails'
    // difference; the two rails sink and source the same 50 mA.
    c.run(1);
    let i = c.element_currents();
    assert!(
        close(i[2], 0.05, 1e-9),
        "resistor current was {}, expected 50 mA",
        i[2]
    );
    assert!(
        close(i[0], 0.05, 1e-6) && close(i[1], -0.05, 1e-6),
        "rail currents {} and {} should be the resistor's 50 mA, opposite signs",
        i[0],
        i[1]
    );
}

#[test]
fn closing_a_switch_reruns_the_capacitor_walk() {
    // A switch in parallel with a capacitor. Closing it (position 0) shorts
    // the cap, and the reanalyze path must run the walk so `shorted()` zeroes
    // whatever charge the cap built up while open. Toggling stays clean: no
    // singular matrix, no spurious current through the shorted cap.
    let dt = 1e-5;
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
                "capacitor",
                &[[100, 0], [100, 100]],
                &[("capacitance", 1e-6)],
            ),
            elm(4, "switch", &[[100, 0], [100, 100]], &[("position", 0.0)]),
            elm(5, "wire", &[[100, 100], [0, 100]], &[]),
            elm(6, "ground", &[[0, 100]], &[]),
        ],
        opts(dt, false),
    );

    // Open the switch and let the cap charge toward the 5 V rail.
    assert!(c.set_state(4, 1));
    c.run(200);
    let charged = c.element_voltages()[2];
    assert!(charged > 4.0, "cap only reached {charged} V after charging");

    // Close it again: the cap shorts and its charge must be zeroed, not left
    // to circulate. The resistor still carries the steady 5 mA.
    assert!(c.set_state(4, 0));
    let report = c.run(50);
    assert!(
        report.converged,
        "reanalyze after closing failed: {}",
        report.error.unwrap_or_default()
    );
    assert!(
        c.element_currents()[2].abs() < 1e-9,
        "shorted cap still carrying charge"
    );
    assert!(
        close(c.element_currents()[1], 0.005, 1e-6),
        "resistor current {} A, expected the steady 5 mA",
        c.element_currents()[1]
    );
}

#[test]
fn closing_a_switch_completes_a_cap_v_loop_and_damps_it() {
    // A voltage source from A to B, an ideal cap from B to C, and a switch
    // from C to A. Open, the cap is not in a CAP_V loop: its far post C is
    // unreachable from A. Closing the switch merges C into A, so the cap now
    // sits directly across the source, and the reanalyze `set_state` triggers
    // must run the walk and damp it, or the cap rings at the source voltage.
    let dt = 1e-6;
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 0], [100, 0]], &[("maxVoltage", 5.0)]),
            elm(
                2,
                "capacitor",
                &[[100, 0], [200, 0]],
                &[("capacitance", 1e-6), ("voltDiff", 0.0)],
            ),
            elm(3, "switch", &[[200, 0], [0, 0]], &[("position", 1.0)]),
            elm(4, "ground", &[[0, 0]], &[]),
        ],
        opts(dt, false),
    );

    // Open, three nodes: ground(A), B, C, and the cap stays ideal. Closing
    // the switch merges C into A; without the walk the cap would keep no
    // internal node and node_count would drop to 2, so the walk's damping is
    // the only way the count stays at 3.
    assert_eq!(c.node_count(), 3, "open cap loop was damped early");
    assert!(c.set_state(3, 0), "switch close refused");
    assert_eq!(
        c.node_count(),
        3,
        "closing the switch did not damp the cap via reanalyze"
    );

    // The damped cap charges through its 0.1 ohm ESR to the rail and stops
    // moving current; undamped it would ring at the 10 A the source demands.
    c.run(200);
    let mut peak: f64 = 0.0;
    for _ in 0..100 {
        c.run(1);
        peak = peak.max(c.element_currents()[1].abs());
    }
    assert!(
        peak < 1e-3,
        "cap loop completed by a switch still ringing, peak {peak} A"
    );
}

#[test]
fn capacitor_series_resistance_controls_charging() {
    assert_esr_step_response(&mut esr_rc_circuit(1e-6, 100.0, false), 100.0);
}

#[test]
fn capacitor_series_resistance_survives_the_dc_operating_point() {
    // The same circuit on the path a loaded file with header bit 128 takes:
    // the frontend sends `dcOperatingPoint` from `settings.autoDC`. Node
    // assignment runs once, before the DC solve, so the internal plate node is
    // allocated for the DC matrix too and its row would be all zeros without
    // the `resistor(n1, cap_node, R_s)` this port adds, which the dense LU
    // rejects as singular. Upstream never meets this: its
    // `getInternalNodeCount()` returns 0 under DC, so the node is simply not
    // there.
    //
    // The failure is quiet, which is why it needs its own test:
    // `solve_operating_point` does not surface a singular DC solve and
    // `simulator.ts` never reads `error()` after a build, so a failed pass
    // would leave the transient to run from an operating point that was never
    // solved. Unlike the from-zero test above, the DC solve pre-charges the
    // capacitor to the steady 10 V and holds it there with zero current, which
    // is what the app's start state looks like.
    let c = &mut esr_rc_circuit(1e-6, 100.0, true);
    assert_eq!(c.error(), None, "the DC operating point did not solve");
    assert!(c.warnings().is_empty(), "warnings: {:?}", c.warnings());
    let v = c.element_voltages()[2];
    assert!(close(v, 10.0, 1e-3), "DC solve pre-charged the cap to {v}");
    c.run(1);
    let volts = c.element_voltages();
    let amps = c.element_currents();
    assert!(
        close(volts[2], 10.0, 1e-3),
        "first transient step dropped the charge to {}",
        volts[2]
    );
    assert!(amps[2].abs() < 1e-6, "charged cap drew {} A", amps[2]);
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
fn capacitor_restored_charge_yields_to_the_dc_operating_point() {
    // The path the app actually takes with the DC solve on: `step_finished`
    // commits the operating point, so the DC pass solves the capacitor as a
    // 100 M open, puts the node at nearly the full 10 V, and writes that
    // steady voltage into `v_prev`, replacing the file-restored 5 V exactly as
    // upstream's unguarded `stepFinished` does when a DC analysis runs
    // (CapacitorElm.java:183-186). A file-restored charge survives only on
    // the no-DC path, covered by `capacitor_restores_saved_volt_diff_on_load`.
    let c = &mut restored_charge_circuit(1e-6, true);
    c.run(1);
    let v = c.element_voltages()[2];
    assert!(
        close(v, 10.0, 0.05),
        "the DC solve overwrote the restored charge with {v}, expected the steady 10 V"
    );
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
fn fresh_lc_tank_self_starts_under_default_options() {
    // The engine default must stay in step with the app default
    // (`DEFAULT_SETTINGS.autoDC = false`, matching upstream's
    // `autoDCOnReset`, CircuitLoader.java:56): a fresh circuit runs no DC
    // solve, so its 1e-3 capacitor seed is not zeroed by an inductor-short
    // operating point and the tank rings. If the default ever flips back to a
    // DC solve, that solve pins both plates at 0 V through the 1e-6 short and
    // commits v_prev = 0, and the current never leaves zero, so this
    // assertion fails loudly.
    assert!(
        !SimOptions::default().dc_operating_point,
        "SimOptions::default() must not run a DC solve, or a fresh tank dies"
    );

    let l: f64 = 1e-6;
    let cap: f64 = 1e-6;
    let period = 2.0 * PI * (l * cap).sqrt();
    let options = SimOptions {
        time_step: period / 2000.0,
        ..SimOptions::default()
    };
    let c = &mut build(
        vec![
            elm(1, "capacitor", &[[0, 0], [0, 100]], &[("capacitance", cap)]),
            elm(2, "inductor", &[[0, 0], [100, 0]], &[("inductance", l)]),
            elm(3, "wire", &[[100, 0], [100, 100]], &[]),
            elm(4, "wire", &[[100, 100], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
        ],
        options,
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
fn dc_solve_carries_the_inductor_current() {
    // With DC on, the inductor is solved as a 1e-6 ohm short and that
    // steady-state current (V/R = 0.05) is committed to the inductor's
    // history, so the very first transient step already runs at 0.05 instead
    // of starting from zero. Without the commit the companion would model the
    // inductor as a 2e4 ohm resistor for one step and the current would drop
    // to about 5/(100 + 2e4) = 2.5e-4.
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
        opts(1e-7, true),
    );
    c.run(1);
    let i = c.element_currents()[2];
    assert!(
        close(i, 0.05, 1e-6),
        "inductor current was {i}, expected the DC steady-state V/R"
    );
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
fn zener_model_params_hold_the_rated_voltage() {
    // The engine spec the `34`-line resolution produces for an upstream-saved
    // 6.2 V legacy zener: an explicit saturationCurrent plus the emission
    // coefficient and breakdown voltage of the model. The offset shifts by the
    // +0.6 V of the rated voltage, so the 100 uA knee is 6.099 and the 5 mA
    // point is 6.2, not the 5.6 default. This already passes today; it exists
    // to fail loudly if the engine's zener parameters drift off the `34`-line
    // contract the load-time resolution feeds them.
    let reverse = |i: f64| {
        let c = &mut build(
            vec![
                elm(1, "current", &[[100, 100], [100, 0]], &[("current", i)]),
                elm(
                    2,
                    "zener",
                    &[[100, 100], [100, 0]],
                    &[
                        ("saturationCurrent", 1.714_352_819_280_888_3e-7),
                        ("emissionCoefficient", 2.0),
                        ("breakdownVoltage", 6.2),
                        ("seriesResistance", 0.0),
                    ],
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
    assert!(close(knee, 6.099, 0.02), "at 100 uA reverse got {knee}");
    let rated = reverse(5e-3);
    assert!(close(rated, 6.2, 0.01), "at 5 mA reverse got {rated}");
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
fn tunnel_diode_operating_points_land_on_its_curve() {
    // The diode sits directly across the supply, so its terminal voltage is
    // the bias exactly, and the current it draws is the curve value with no
    // load line to bisect. The expected values below are hand-rounded from
    // upstream's law (TunnelDiodeElm.java:93-98, :107-110): a tunnelling
    // peak `pip` = 4.7 mA at `pvp` = 0.1 V, a valley exponential `piv` at
    // `pvv` = 0.37 V, and a steep forward exponential at `pvt` = 0.026 V.
    let current_at = |v: f64| {
        let c = &mut build(
            vec![
                elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", v)]),
                elm(2, "tunnelDiode", &[[0, 0], [0, 100]], &[]),
                elm(3, "ground", &[[0, 100]], &[]),
            ],
            opts_budget(1e-5, true, 200),
        );
        let report = c.run(20);
        assert!(
            report.converged,
            "tunnel diode stalled: {:?}",
            report.failing
        );
        c.element_currents()[1]
    };

    // Hand-rounded points: the tunnelling peak, the negative-resistance
    // region, the valley, the steep second exponential, and a small reverse
    // bias. The reverse point pins upstream's unclamped tunnelling tail,
    // which conducts tens of milliamps where a real junction would not.
    for (v, want) in [
        (0.1, 4.726_879_08e-3),
        (0.25, 2.694_488_07e-3),
        (0.45, 1.046_537_66e-3),
        (0.6, 8.451_453_02e-2),
        (-0.05, -1.054_443_37e-2),
    ] {
        assert!(
            close(current_at(v), want, 1e-5),
            "at {v} V the tunnel diode drew {}, expected {want}",
            current_at(v)
        );
    }

    // End-to-end stamp check: 5 V through 52 ohm onto a tunnel diode to
    // ground. The load line crosses the curve exactly once, in the steep
    // forward region, at 0.600031 V and 84.6 mA. A sign error in the stamped
    // conductance or Norton source throws the solve onto a different branch
    // (or a non-positive matrix diagonal) and misses this window entirely.
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 5.0)]),
            elm(2, "resistor", &[[0, 0], [100, 0]], &[("resistance", 52.0)]),
            elm(3, "tunnelDiode", &[[100, 0], [100, 100]], &[]),
            elm(4, "wire", &[[100, 100], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
        ],
        opts_budget(1e-5, true, 200),
    );
    let report = c.run(20);
    assert!(
        report.converged,
        "series tunnel diode stalled: {:?}",
        report.failing
    );
    let v = c.element_voltages()[2];
    assert!(
        close(v, 0.600, 0.02),
        "series operating point was {v} V, expected ~0.600"
    );
    let i = c.element_currents()[2];
    assert!(
        close(i, 0.0846, 3e-3),
        "diode current was {i} A, expected ~84.6 mA"
    );
    // KCL: both devices carry the load-line current for the settled voltage.
    assert!(
        close(c.element_currents()[1], (5.0 - v) / 52.0, 2e-3),
        "resistor current {} did not match the load line",
        c.element_currents()[1]
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
            ac_coupled: false,
            trigger: Default::default(),
            display_width: 0,
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
fn current_scope_samples_the_dc_branch_current() {
    // A Current scope on a resistor must sample the branch current, not the
    // voltage: 5 V across 100 ohm is 0.05 A. The scope o-line value token 3
    // maps to a Current spec in the frontend, and this pins the engine side
    // of that contract: the sample has to be a real current, or a saved file
    // would reload a current trace as a flat voltage one.
    let c = &mut build_with(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 5.0)]),
            elm(2, "resistor", &[[0, 0], [100, 0]], &[("resistance", 100.0)]),
            elm(3, "wire", &[[100, 0], [100, 100]], &[]),
            elm(4, "wire", &[[100, 100], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
        ],
        opts(1e-5, true),
        vec![ScopeSpec {
            element_id: 2,
            value: ScopeValue::Current,
            post: 0,
            steps_per_column: 1,
            columns: 1024,
            ac_coupled: false,
            trigger: Default::default(),
            display_width: 0,
        }],
    );
    c.run(30);
    let snap = c.scopes()[0].snapshot();
    let (min, max) = (snap[snap.len() - 2] as f64, snap[snap.len() - 1] as f64);
    assert!(
        close(min, 0.05, 1e-6) && close(max, 0.05, 1e-6),
        "current scope sampled {min}/{max}, expected 0.05 A"
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
                ac_coupled: false,
                trigger: Default::default(),
                display_width: 0,
            },
            ScopeSpec {
                element_id: 3,
                value: ScopeValue::Voltage,
                post: 0,
                steps_per_column: 1,
                columns: 1024,
                ac_coupled: false,
                trigger: Default::default(),
                display_width: 0,
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
fn transistor_model_line_resolves_saturation_current_into_the_engine() {
    // The `32` line is the transistor twin of the `34` diode-model line: a
    // TransistorModel table the element's model name looks up. The port's
    // Ebers-Moll consumes only satCur and betaR (as `saturationCurrent` and
    // `betaReverse`), so this builds exactly the spec that resolution writes
    // and checks the engine uses it: a current source forces a known base
    // current, which pins the operating point without a load-line coupling.
    //
    // In the active region (vbc << 0, so rev ~ -sat) the port's model gives
    //   ib = fwd/bf - sat/br,   fwd = sat*(exp(Vbe/VT) - 1)
    //   => Vbe = VT*ln(1 + bf*(ib + sat/br)/sat)
    //   => Ic = fwd + sat*(1 + 1/br) = bf*ib + sat*(bf/br + 1 + 1/br)
    // The early.txt model `early` (satCur 1e-13, betaR 1) resolves to the
    // port's own defaults, so the corpus file must not change behaviour; a
    // model whose satCur is 1e-9 shifts Vbe down by exactly
    // VT*ln((1 + bf*(ib + sat2/br)/sat2)/(1 + bf*(ib + sat1/br)/sat1))
    // ~ 0.238 V, proving the resolved saturation current is not ignored.
    let stage = |sat: f64, br: f64, beta: f64| {
        build(
            vec![
                // Forced base current: 1e-6 into the base node at (100,100).
                elm(1, "current", &[[0, 0], [100, 100]], &[("current", 1e-6)]),
                elm(2, "rail", &[[300, 0]], &[("maxVoltage", 5.0)]),
                elm(
                    3,
                    "resistor",
                    &[[300, 0], [300, 100]],
                    &[("resistance", 10_000.0)],
                ),
                // Posts: base, collector, emitter.
                elm(
                    4,
                    "transistor",
                    &[[100, 100], [300, 100], [100, 200]],
                    &[
                        ("saturationCurrent", sat),
                        ("betaReverse", br),
                        ("beta", beta),
                    ],
                ),
                elm(5, "ground", &[[100, 200]], &[]),
                elm(6, "ground", &[[0, 0]], &[]),
            ],
            opts(1e-5, true),
        )
    };

    // The resolved spec for early.txt's `early` model: beta 100 from the
    // element line, satCur and betaR from the `32` line. At ib = 1e-6 the
    // equations give Vbe = 0.53601 V, Ic ~ 1e-4 A and a collector at
    // 5 - Ic*10k ~ 4 V, all active-region values.
    let c = &mut stage(1e-13, 1.0, 100.0);
    c.run(20);
    let v = c.node_voltages();
    let nodes = c.element_nodes();
    let (nb, nc, ne) = (nodes[5] as usize, nodes[6] as usize, nodes[7] as usize);
    let vbe = v[nb] - v[ne];
    assert!(close(vbe, 0.5360, 5e-3), "early-model Vbe was {vbe}");
    assert!(
        close(v[nc], 4.0, 1e-2),
        "early-model collector was {}",
        v[nc]
    );
    let currents = c.element_currents();
    let ic = currents[2]; // the 10k collector load
    assert!(close(ic, 1e-4, 1e-6), "early-model Ic was {ic}");
    assert!(
        (95.0..105.0).contains(&(ic / 1e-6)),
        "early-model gain was {}",
        ic / 1e-6
    );

    // A model whose satCur differs (1e-9, documented as not in the corpus)
    // drops Vbe to 0.2978 V, the exact Ebers-Moll prediction for the same
    // forced base current, while Ic stays at bf*ib (the extra 2*sat ~ 2e-9 A
    // of junction leakage is far below the assertion tolerance).
    let c2 = &mut stage(1e-9, 1.0, 100.0);
    c2.run(20);
    let v = c2.node_voltages();
    let nodes = c2.element_nodes();
    let (nb, _nc, ne) = (nodes[5] as usize, nodes[6] as usize, nodes[7] as usize);
    let vbe_high = v[nb] - v[ne];
    assert!(close(vbe_high, 0.2978, 5e-3), "high-Is Vbe was {vbe_high}");
    assert!(
        close(vbe - vbe_high, 0.2382, 1e-2),
        "Vbe shift was {}",
        vbe - vbe_high
    );
    assert!(
        close(c2.element_currents()[2], 1e-4, 1e-6),
        "high-Is Ic was {}",
        c2.element_currents()[2]
    );
}

#[test]
fn darlington_current_gain_is_the_product_of_the_two_betas() {
    // A darlington is two Ebers-Moll transistors in cascade: Q1's emitter
    // feeds Q2's base and the collectors share one post, so the current gain
    // compounds. In the linear region Ic = ic1 + ic2 = beta*ib +
    // beta*(beta+1)*ib = beta*(beta+2)*ib, which is 10200 with beta = 100.
    // That ratio, not an absolute current, is the hand-derivable assertion:
    // it follows from the Ebers-Moll equations alone, so the pair of series
    // Vbe drops cancels out of it. The 47 M base resistor keeps the ~0.85 mA
    // collector current well below the 5 mA saturation of the 1 k load, so
    // the pair stays in the linear region where the ratio holds.
    let c = &mut build(
        vec![
            elm(1, "rail", &[[0, 0]], &[("maxVoltage", 5.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 47_000_000.0)],
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
                "darlington",
                &[[100, 0], [200, 0], [200, 100]],
                &[("pnp", 1.0)],
            ),
            elm(5, "ground", &[[200, 100]], &[]),
        ],
        opts_budget(1e-5, true, 1000),
    );
    c.run(50);

    let currents = c.element_currents();
    let ib = currents[1]; // through the 47 M base resistor
    let ic = currents[2]; // through the 1 k collector load
    assert!(ib > 1e-8 && ib < 2e-7, "base current was {ib}");
    assert!(ic > 5e-4 && ic < 1.5e-3, "collector current was {ic}");
    let measured_gain = ic / ib;
    assert!(
        (10_000.0..10_400.0).contains(&measured_gain),
        "darlington gain was {measured_gain}, expected beta*(beta+2) = 10200"
    );

    // The operating point follows from the gain and the load line: Vb =
    // Vbe1 + Vbe2 ~ 1.06 V and Vc = 5 - Ic*1k ~ 4.15 V. The reported element
    // current is the collector current into the device.
    let nodes = c.element_nodes();
    let v = c.node_voltages();
    let (nb, nc, _ne) = (nodes[5] as usize, nodes[6] as usize, nodes[7] as usize);
    assert!((0.98..1.14).contains(&v[nb]), "base was {}", v[nb]);
    assert!((4.0..4.3).contains(&v[nc]), "collector was {}", v[nc]);
    assert!(
        currents[3] > 0.0,
        "reported darlington current was {}",
        currents[3]
    );

    // The PNP in the same orientation is reverse biased and off: the base is
    // pulled to the rail, no base current flows and the collector load draws
    // nothing, the darlington's mirror of the transistor's own polarity test.
    let mut pnp = build(
        vec![
            elm(1, "rail", &[[0, 0]], &[("maxVoltage", 5.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 47_000_000.0)],
            ),
            elm(
                3,
                "resistor",
                &[[0, 0], [200, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(
                4,
                "darlington",
                &[[100, 0], [200, 0], [200, 100]],
                &[("pnp", -1.0)],
            ),
            elm(5, "ground", &[[200, 100]], &[]),
        ],
        opts_budget(1e-5, true, 1000),
    );
    pnp.run(50);
    let nodes = pnp.element_nodes();
    let v = pnp.node_voltages();
    let (nb, nc, _ne) = (nodes[5] as usize, nodes[6] as usize, nodes[7] as usize);
    assert!(
        (4.9..5.1).contains(&v[nb]) && (4.9..5.1).contains(&v[nc]),
        "PNP base and collector were {} and {}",
        v[nb],
        v[nc]
    );
    assert!(
        pnp.element_currents()[2].abs() < 1e-9,
        "PNP leaked {} A through the collector load",
        pnp.element_currents()[2]
    );
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
fn dc_solve_freezes_ac_sources_at_bias() {
    // During the DC solve a square wave collapses to its bias, not its t=0
    // value (VoltageElm.java:168-169). At t=0 the square sits on its high
    // plateau, so without the freeze the operating point would sit at
    // bias + maxVoltage = 7 V and draw 7e-3 A through the 1k; the freeze
    // puts it at bias = 2 V and 2e-3 A. The transient is not frozen: one
    // step in, the source is back on its high plateau.
    let c = &mut build(
        vec![
            elm(
                1,
                "voltage",
                &[[0, 100], [0, 0]],
                &[
                    ("waveform", 2.0),
                    ("frequency", 40.0),
                    ("maxVoltage", 5.0),
                    ("bias", 2.0),
                ],
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
        opts(1e-5, true),
    );
    let i = c.element_currents()[1];
    assert!(
        close(i, 2e-3, 1e-9),
        "DC operating point sat at {i} A, expected bias over 1k"
    );

    c.run(1);
    let i = c.element_currents()[1];
    assert!(
        close(i, 7e-3, 1e-9),
        "first transient step read {i} A, expected the high plateau"
    );
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
fn floating_node_warning_states_the_pin_in_ohms() {
    // One node with no path to ground: the warning must name the pin as a
    // resistance derived from GMIN (1e-8 S == 100 MΩ), with the ohm glyph and
    // no siemens anywhere.
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 10.0)]),
            elm(2, "resistor", &[[0, 0], [0, 100]], &[("resistance", 500.0)]),
            elm(3, "ground", &[[0, 100]], &[]),
            elm(
                4,
                "resistor",
                &[[100, 0], [100, 0]],
                &[("resistance", 500.0)],
            ),
        ],
        opts(1e-5, true),
    );
    c.run(5);
    let warn = c
        .warnings()
        .iter()
        .find(|w| w.contains("no path to ground"))
        .expect("expected a floating-node warning");
    assert!(
        warn.contains("M\u{2126}") && !warn.contains(" S") && !warn.contains("1e-8"),
        "warning was {warn}"
    );
    assert_eq!(
        warn,
        "1 floating node(s) have no path to ground; they were pinned with a 100 M\u{2126} resistance."
    );
}

#[test]
fn two_floating_subcircuits_report_their_count() {
    // Two one-node floating components, each pinned separately, so the leading
    // count in the warning reflects the real pin count instead of the plural
    // path silently dropping it.
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 10.0)]),
            elm(2, "resistor", &[[0, 0], [0, 100]], &[("resistance", 500.0)]),
            elm(3, "ground", &[[0, 100]], &[]),
            elm(
                4,
                "resistor",
                &[[100, 0], [100, 0]],
                &[("resistance", 500.0)],
            ),
            elm(
                5,
                "resistor",
                &[[200, 0], [200, 0]],
                &[("resistance", 500.0)],
            ),
        ],
        opts(1e-5, true),
    );
    c.run(5);
    let warn = c
        .warnings()
        .iter()
        .find(|w| w.contains("no path to ground"))
        .expect("expected a floating-node warning");
    assert_eq!(
        warn,
        "2 floating node(s) have no path to ground; they were pinned with a 100 M\u{2126} resistance."
    );
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
            ac_coupled: false,
            trigger: Default::default(),
            display_width: 0,
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
                ac_coupled: false,
                trigger: Default::default(),
                display_width: 0,
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
                ac_coupled: false,
                trigger: Default::default(),
                display_width: 0,
            },
            ScopeSpec {
                element_id: 3,
                value: ScopeValue::Voltage,
                post: 0,
                steps_per_column: 1,
                columns: 1024,
                ac_coupled: false,
                trigger: Default::default(),
                display_width: 0,
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
            ac_coupled: false,
            trigger: Default::default(),
            display_width: 0,
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
            ac_coupled: false,
            trigger: Default::default(),
            display_width: 0,
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
        ac_coupled: false,
        trigger: Default::default(),
        display_width: 0,
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
    // circuit with a `$ 128` header through this path
    // (`settings.autoDC`), so a sign error that only bit under DC would
    // corrupt the first transient step's initial conditions while every
    // transient-only test stayed green.
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
    // pinning fixes the absolute potential, not the winding difference. Both
    // secondary nodes are pinned at 1e-8 S each, and the pin current loads
    // the winding a little (measured 9.98992 V, an 8e-5 V drop from the ideal
    // 9.99), so the 1e-4 window covers the pin loading while still pinning the
    // full-ratio reading.
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
        close(last_sample(&c, 0) - last_sample(&c, 1), 9.99, 1e-4),
        "floating secondary read {} V, expected 9.99",
        last_sample(&c, 0) - last_sample(&c, 1)
    );
}

// ─── Adaptive timestep with step rejection ──────────────────────────────────

/// A 20 kHz, 10 V sine drives a node through 200 ohm that also carries a
/// voltage-limited current source (0.01 A, 5 V compliance), post 0 on ground.
/// When the source pushes the node through the compliance transition, the
/// tanh companion's step-size limiter refuses to settle in a handful of
/// iterations (CurrentElm.java:139-158): at dt = 5e-6 the transition needs
/// 8, more than the budget of 5, so a fixed-step run stalls there. The exact
/// iteration counts were tuned by probing: 8 at 5e-6, 5 at 2.5e-6, 4 at
/// 1.25e-6, which is what makes the halve-and-retry tests below robust.
fn compliance_circuit(phase_shift: f64) -> Vec<ElementSpec> {
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
    // floor budget cannot settle the first step at dt = 2.5e-6 (probing
    // measured >5000 iterations needed), so the run must stop with the error
    // set and the clock still at zero. min_time_step = 1.25e-6 lands the
    // first halving exactly on the floor: 5e-6/2 = 2.5e-6 can no longer be
    // halved, which is what forces the 5000 budget.
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
fn diode_bridge_startup_converges_only_with_gmin_ramping() {
    // Nothing conducts initially, and once the capacitor has charged the
    // bridge's diode switching locks into a Newton limit cycle: the junctions
    // creep a fraction of a thermal voltage per iteration (junction limiting)
    // and the step cannot settle within the budget. The first ~365 steps are
    // easy (the junctions are nearly linear), so the test single-steps a
    // window that reaches the step-366 switching stall. The same window
    // converges once the geometric junction-gmin ramp engages (subiter > 100),
    // and the failing-element diagnostics name the diodes that were still
    // moving when the ramp-off run gave up.
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
    // dt = 1e-6 (period 1 ms / 1000); the switching stall lands at step 366,
    // so a 500-step window reaches it with margin on both sides.
    let steps = 500;

    // Ramp off: a constant 1e-12 S junction conductance cannot settle the
    // stall, and the failure report names the diodes that were still moving.
    let mut off = build(bridge.clone(), opts_budget(1e-6, false, 80));
    let mut r_off = None;
    for _ in 0..steps {
        let r = off.run(1);
        if !r.converged {
            r_off = Some(r);
            break;
        }
    }
    let r_off = r_off.expect("bridge converged without the ramp");
    assert!(
        !r_off.failing.is_empty(),
        "no element was reported as failing"
    );
    assert!(
        r_off.failing.contains(&3),
        "failing ids were {:?}, expected the D2 diode (id 3)",
        r_off.failing
    );

    // Ramp on: the geometric gmin ramp engages at subiter > 100, and the
    // worst step settles just past it (measured 103 iterations), so the ramp
    // is what gets the bridge through the stall.
    let mut on = build(bridge, opts_budget(1e-6, false, 500));
    let mut worst = 0u32;
    for _ in 0..steps {
        let r = on.run(1);
        assert!(
            r.converged,
            "ramp-on bridge step failed: {}",
            r.error.unwrap_or_default()
        );
        worst = worst.max(r.iterations);
    }
    assert!(
        worst > 100,
        "ramp never engaged, worst step used only {worst} iterations"
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

// ─── Matrix simplification (per-closure dense systems) ───

/// 20 chains of 20 equal resistors fanning out from one driven node to
/// ground: a literal 20x20 grid of 400 nodes, all in a single closure (the
/// chains share the driven node) plus the feeding source. The fan's first
/// resistor in each chain shares post 0 with the driven node, so no wires are
/// needed.
fn twenty_by_twenty_grid() -> Vec<ElementSpec> {
    let mut v = vec![
        elm(1, "voltage", &[[0, 400], [0, 0]], &[("maxVoltage", 20.0)]),
        elm(2, "ground", &[[0, 400]], &[]),
    ];
    let mut id = 3;
    for c in 0..20 {
        // The first resistor fans out from the shared driven node (0,0).
        v.push(elm(
            id,
            "resistor",
            &[[0, 0], [c * 16, 16]],
            &[("resistance", 1.0)],
        ));
        id += 1;
        for k in 1..20 {
            v.push(elm(
                id,
                "resistor",
                &[[c * 16, 16 * k], [c * 16, 16 * (k + 1)]],
                &[("resistance", 1.0)],
            ));
            id += 1;
        }
        v.push(elm(id, "ground", &[[c * 16, 320]], &[]));
        id += 1;
    }
    v
}

/// A chain of `n` equal resistors in series from a driven node to ground,
/// placed at x offset `off`. `base_id` gives unique element ids so several
/// chains can share one circuit.
fn resistor_chain(n: usize, off: i32, base_id: u32) -> Vec<ElementSpec> {
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

#[test]
fn large_resistor_grid_keeps_the_analytic_far_corner() {
    // 400 nodes in one closure, driven at 20 V. Each chain of 20 equal 1 ohm
    // resistors drops 1 V per resistor, so every far corner sits at exactly
    // 1 V. This is the "big linear circuit stays exact" guard: the closure
    // split must not change any solved value.
    let c = &mut build(twenty_by_twenty_grid(), opts(1e-5, false));
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
    let divider = |base: i32| {
        vec![
            elm(
                1,
                "voltage",
                &[[base, 200], [base, 0]],
                &[("maxVoltage", 10.0)],
            ),
            elm(
                2,
                "resistor",
                &[[base, 0], [base + 100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(
                3,
                "resistor",
                &[[base + 100, 0], [base + 100, 100]],
                &[("resistance", 2000.0)],
            ),
            elm(4, "ground", &[[base, 200]], &[]),
            elm(5, "ground", &[[base + 100, 100]], &[]),
        ]
    };
    let mut full = build([divider(0), divider(400)].concat(), opts(1e-5, false));
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
    let mut single = build(divider(0), opts(1e-5, false));
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
    // The DC operating point is where the transformer's `matrix_connects`
    // override earns its keep. The companion's current injection is silent
    // under dc_analysis, so a loaded secondary reads
    // `V2 = k * ratio * V1 * a11/(a11 + 1/Rload)` purely from the
    // mutual-inductance VCCS in the matrix; drop the override and the VCCS
    // cross-terms are lost, leaving the secondary uncoupled at V2 = 0. An
    // open-secondary sine is no guard here because the RHS current injection
    // couples that through one step late, reproducing the same peak.
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
    // The transformer reads V(post0) - V(post1) = V1 - V2, so V2 = 10 - that.
    let v2 = 10.0 - c.element_voltages()[1];
    assert!(
        close(v2, 0.0588, 2e-4),
        "loaded secondary operating point was {v2}, expected 0.0588"
    );
}

// ─── Three-phase motor ───────────────────────────────────────────────────────

/// Exact backward-Euler response of a series `RL` stepped at `dt` from rest:
/// `I_n = (V/R)·(1 - (1 + R·dt/L)^-n)`. Under a balanced three-phase drive the
/// motor's stator phases reduce to exactly this: equal stator currents couple
/// into each rotor coil as `(Lm - Lm/2 - Lm/2)·i = 0`, so the rotor stays at
/// zero current and every phase sees only its own `Ls` in series with `Rs`.
fn rl_backward_euler_step(v: f64, r: f64, l: f64, dt: f64, n: u32) -> f64 {
    let decay = (1.0 + r * dt / l).powi(-(n as i32));
    (v / r) * (1.0 - decay)
}

#[test]
fn three_phase_motor_balanced_drive_reaches_v_over_rs() {
    // Three 10 V DC sources feed the phase-1 posts (0, 2, 4) and the phase-2
    // posts (1, 3, 5) are grounded, a balanced drive. The stator currents are
    // then equal, so the rotor flux couplings cancel exactly
    // (M[3][0] = Lm, M[3][1] = M[3][2] = -Lm/2) and the rotor windings carry
    // no current: each stator phase is an independent `Ls` in series with
    // `Rs`, which is the model's phase impedance at DC. The phase current must
    // therefore follow the discrete RL response and settle to `10/Rs`, and
    // every rotor node must read 0.
    let rs = 0.435;
    let ls = 0.0294;
    let dt = 1e-3;
    let c = &mut build_with(
        vec![
            // A source's post 0 is the negative terminal, so the ground side
            // comes first and the phase post hangs off post 1 at +10 V. The
            // motor's six posts sit at the registry's `motorPosts` positions
            // for a left-to-right body: phase pairs hang off the axis at a
            // 32-unit perpendicular offset (posts 0, 2, 4 at y = -32, 0, 32).
            elm(1, "voltage", &[[0, -64], [0, -32]], &[("maxVoltage", 10.0)]),
            elm(2, "voltage", &[[0, -64], [0, 0]], &[("maxVoltage", 10.0)]),
            elm(3, "voltage", &[[0, -64], [0, 32]], &[("maxVoltage", 10.0)]),
            elm(
                4,
                "threePhaseMotor",
                &[[0, -32], [100, 32], [0, 0], [100, 0], [0, 32], [100, -32]],
                &[
                    ("Rs", rs),
                    ("Rr", 0.816),
                    ("Ls", ls),
                    ("Lr", 0.0297),
                    ("lm", 0.0287),
                    ("b", 0.05),
                    ("J", 1.0),
                ],
            ),
            elm(5, "ground", &[[0, -64]], &[]),
            elm(6, "ground", &[[100, 32]], &[]),
            elm(7, "ground", &[[100, 0]], &[]),
            elm(8, "ground", &[[100, -32]], &[]),
        ],
        opts(dt, false),
        vec![
            tr_scope(4, ScopeValue::NodeVoltage, 7), // n002, back-EMF source node
            tr_scope(4, ScopeValue::NodeVoltage, 9), // n004, rotor coil 3 far end
            tr_scope(4, ScopeValue::NodeVoltage, 11), // n006, back-EMF source node
            tr_scope(4, ScopeValue::NodeVoltage, 12), // n007, rotor coil 4 far end
        ],
    );

    // tau = Ls/Rs = 67.6 ms, so ten 1 ms steps sit well inside the RL rise.
    let report = c.run(10);
    assert!(report.converged, "did not converge: {:?}", report.error);
    assert!(c.error().is_none(), "error: {:?}", c.error());
    let i = c.element_currents();
    let expected = rl_backward_euler_step(10.0, rs, ls, dt, 10);
    for (k, phase) in ["U", "V", "W"].iter().enumerate() {
        assert!(
            close(i[k], expected, 1e-6),
            "phase {phase} current at step 10 was {}, expected {expected}",
            i[k]
        );
        assert!(
            close(i[k], i[0], 1e-12),
            "phase {phase} current {} diverged from phase U's {}",
            i[k],
            i[0]
        );
    }
    assert!(
        close(i[3], i[0], 1e-9),
        "motor's own phase current {} should equal the U source's {}",
        i[3],
        i[0]
    );
    for (k, node) in [(0usize, "n002"), (1, "n004"), (2, "n006"), (3, "n007")] {
        let v = last_sample(c, k);
        assert!(close(v, 0.0, 1e-9), "{node} read {v} V, expected 0");
    }

    // Let the RL transient settle: 3000 more steps is ~44 time constants, so
    // the phase currents reach the hand-derived steady state `10/Rs`.
    let report = c.run(3000);
    assert!(report.converged, "did not converge: {:?}", report.error);
    assert!(c.error().is_none(), "error: {:?}", c.error());
    let i = c.element_currents();
    let settled = 10.0 / rs;
    for (k, phase) in ["U", "V", "W"].iter().enumerate() {
        assert!(
            close(i[k], settled, 1e-6),
            "phase {phase} current settled to {}, expected {settled}",
            i[k]
        );
    }
    assert!(
        close(i[3], settled, 1e-6),
        "motor's own settled current {} should equal {settled}",
        i[3]
    );
    for (k, node) in [(0usize, "n002"), (1, "n004"), (2, "n006"), (3, "n007")] {
        let v = last_sample(c, k);
        assert!(close(v, 0.0, 1e-9), "{node} read {v} V, expected 0");
    }
}

#[test]
fn wye_motor_on_rails_without_a_ground_symbol_runs() {
    // The bundled 3motor.txt: three 220 V sine rails, 120 degrees apart, feed
    // the phase-1 posts and the phase-2 posts are wired into a floating wye
    // neutral. There is no ground symbol, so the only reference to ground is
    // through the rails themselves; the no-ground fallback must leave the
    // rails' posts alone or the first rail's source reads ground-to-ground and
    // the build goes singular. Balanced drive also has to stay balanced: the
    // floating neutral carries no current, so the three rail currents sum to
    // zero.
    let mut c = build(
        vec![
            elm(
                1,
                "rail",
                &[[608, 192]],
                &[
                    ("waveform", 1.0),
                    ("frequency", 50.0),
                    ("maxVoltage", 220.0),
                ],
            ),
            elm(
                2,
                "rail",
                &[[608, 224]],
                &[
                    ("waveform", 1.0),
                    ("frequency", 50.0),
                    ("maxVoltage", 220.0),
                    ("phaseShift", -2.0 * PI / 3.0),
                ],
            ),
            elm(
                3,
                "rail",
                &[[608, 256]],
                &[
                    ("waveform", 1.0),
                    ("frequency", 50.0),
                    ("maxVoltage", 220.0),
                    ("phaseShift", 2.0 * PI / 3.0),
                ],
            ),
            elm(
                4,
                "threePhaseMotor",
                &[
                    [608, 192],
                    [752, 256],
                    [608, 224],
                    [752, 224],
                    [608, 256],
                    [752, 192],
                ],
                &[
                    ("Rs", 0.067),
                    ("Rr", 0.032),
                    ("Ls", 0.0294),
                    ("Lr", 0.0297),
                    ("lm", 0.0287),
                    ("b", 0.05),
                    ("J", 0.067),
                ],
            ),
            elm(5, "wire", &[[752, 192], [768, 192]], &[]),
            elm(6, "wire", &[[752, 224], [768, 224]], &[]),
            elm(7, "wire", &[[768, 192], [768, 224]], &[]),
            elm(8, "wire", &[[752, 256], [768, 256]], &[]),
            elm(9, "wire", &[[768, 224], [768, 256]], &[]),
        ],
        opts(5e-6, false),
    );
    // 2000 steps is 10 ms, well inside the phase's ~440 ms RL rise: the motor
    // is drawing real current but the transient has not settled, so only the
    // balance property is asserted, not a settled magnitude.
    let report = c.run(2000);
    assert!(report.converged, "did not converge: {:?}", report.error);
    assert!(c.error().is_none(), "error: {:?}", c.error());
    let i = c.element_currents();
    let sum = i[0] + i[1] + i[2];
    assert!(
        close(sum, 0.0, 1e-6),
        "rail currents {:?} sum to {sum}, expected 0",
        &i[..3]
    );
    for (k, phase) in ["U", "V", "W"].iter().enumerate() {
        assert!(
            i[k].abs() > 1.0,
            "phase {phase} draws {} A, expected a real drive current",
            i[k]
        );
    }
}

#[test]
fn current_source_matrix_connects_keeps_the_companion_in_one_closure() {
    // The Norton companion of a voltage-limited source stamps a resistance
    // between its terminals, so two terminals living in separate networks must
    // still land in one closure. A 0.01 A source with 5 V compliance driving a
    // node through a capacitor (no DC path, so never forced broken) clips its
    // terminal voltage near maxVoltage.
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
        "terminal voltage was {v}, expected it clipped near 5 V"
    );
}

#[test]
fn singular_closure_is_rejected_at_set_circuit_inside_a_healthy_circuit() {
    // The eager per-closure factor must still reject a singular closure (two
    // sources fighting over one node) at set_circuit even when a healthy
    // divider shares the circuit as a second closure.
    let spec = CircuitSpec {
        elements: vec![
            elm(1, "voltage", &[[0, 300], [0, 200]], &[("maxVoltage", 10.0)]),
            elm(
                2,
                "resistor",
                &[[0, 200], [100, 200]],
                &[("resistance", 1000.0)],
            ),
            elm(
                3,
                "resistor",
                &[[100, 200], [100, 300]],
                &[("resistance", 1000.0)],
            ),
            elm(4, "ground", &[[0, 300]], &[]),
            elm(5, "ground", &[[100, 300]], &[]),
            elm(
                6,
                "voltage",
                &[[200, 100], [200, 0]],
                &[("maxVoltage", 5.0)],
            ),
            elm(
                7,
                "voltage",
                &[[200, 100], [200, 0]],
                &[("maxVoltage", 3.0)],
            ),
            elm(8, "ground", &[[200, 0]], &[]),
        ],
        options: Some(opts(1e-5, false)),
        scopes: Vec::new(),
    };
    let mut c = Circuit::new();
    assert!(
        c.set_circuit(&spec).is_err(),
        "singular closure accepted at set_circuit"
    );
}

#[test]
fn mixed_nonlinear_circuit_stays_finite_and_converges() {
    // One op-amp amp, one diode, one mosfet follower, one transformer and one
    // voltage-limited current source, each its own closure. A missed
    // matrix_connects override tears one of these across closures; the run
    // would diverge or produce garbage. Assert the whole solve stays finite
    // and converged, plus one analytic anchor (the op-amp gain).
    let c = &mut build(
        vec![
            // Op-amp inverting amp.
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
            // Diode forward drop.
            elm(
                7,
                "voltage",
                &[[400, 300], [400, 200]],
                &[("maxVoltage", 2.0)],
            ),
            elm(
                8,
                "resistor",
                &[[400, 200], [500, 200]],
                &[("resistance", 1000.0)],
            ),
            elm(9, "diode", &[[500, 200], [500, 300]], &[]),
            elm(10, "ground", &[[400, 300]], &[]),
            elm(11, "ground", &[[500, 300]], &[]),
            // Mosfet source follower.
            elm(
                12,
                "voltage",
                &[[700, 500], [700, 400]],
                &[("maxVoltage", 5.0)],
            ),
            elm(
                13,
                "mosfet",
                &[[900, 400], [800, 500], [700, 400]],
                &[("pnp", 1.0), ("threshold", 1.5), ("beta", 0.02)],
            ),
            elm(
                14,
                "voltage",
                &[[900, 500], [900, 400]],
                &[("maxVoltage", 3.0)],
            ),
            elm(
                15,
                "resistor",
                &[[800, 500], [800, 600]],
                &[("resistance", 1000.0)],
            ),
            elm(16, "ground", &[[700, 500]], &[]),
            elm(17, "ground", &[[900, 500]], &[]),
            elm(18, "ground", &[[800, 600]], &[]),
            // Transformer with a loaded secondary.
            elm(
                19,
                "voltage",
                &[[1000, 800], [1000, 700]],
                &[
                    ("maxVoltage", 10.0),
                    ("waveform", 1.0),
                    ("frequency", 1000.0),
                ],
            ),
            elm(
                20,
                "transformer",
                &[[1000, 700], [1100, 700], [1000, 800], [1100, 800]],
                &[("inductance", 4.0), ("ratio", 2.0), ("couplingCoef", 0.999)],
            ),
            elm(
                21,
                "resistor",
                &[[1100, 700], [1100, 800]],
                &[("resistance", 4000.0)],
            ),
            elm(22, "ground", &[[1000, 800]], &[]),
            elm(23, "ground", &[[1100, 800]], &[]),
            // Voltage-limited current source into a resistor.
            elm(
                24,
                "current",
                &[[1300, 1000], [1300, 900]],
                &[("current", 0.01), ("maxVoltage", 5.0)],
            ),
            elm(
                25,
                "resistor",
                &[[1300, 900], [1400, 900]],
                &[("resistance", 1000.0)],
            ),
            elm(26, "ground", &[[1300, 1000]], &[]),
            elm(27, "ground", &[[1400, 900]], &[]),
        ],
        opts(1e-5, true),
    );
    let report = c.run(10);
    assert!(report.converged, "did not converge: {:?}", report.error);
    assert!(
        report.iterations < 100,
        "mixed circuit used {} subiterations",
        report.iterations
    );
    for (i, v) in c.node_voltages().iter().enumerate() {
        assert!(v.is_finite(), "node {i} reached a non-finite voltage {v}");
    }
    for (i, v) in c.element_voltages().iter().enumerate() {
        assert!(
            v.is_finite(),
            "element {i} reached a non-finite voltage {v}"
        );
    }
    for (i, v) in c.element_currents().iter().enumerate() {
        assert!(
            v.is_finite(),
            "element {i} reached a non-finite current {v}"
        );
    }
    assert!(
        close(c.element_voltages()[3], -5.0, 0.01),
        "op-amp output was {}",
        c.element_voltages()[3]
    );
    assert!(
        c.element_currents()[8] > 0.0,
        "diode current was {}",
        c.element_currents()[8]
    );
}

#[test]
fn double_halve_restores_the_committed_state() {
    // Budget 4 is one below the 5 subiterations the 2.5e-6 step needs, so each
    // compliance crossing rejects twice (5e-6 then 2.5e-6) and settles at
    // 1.25e-6, while the current-source terminal voltage stays capped at the
    // rating. Every rejection restamps the closures and restores the
    // committed state; the run must stay converged and sane across the whole
    // halving sequence, with the delivered current capped at the rating.
    let mut c = build_with(
        compliance_circuit(0.0),
        adaptive_opts(5e-6, 50e-12, 4),
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
    assert!(report.converged, "did not converge: {:?}", report.error);
    assert!(
        report.rejected_steps >= 2,
        "the double halve never engaged, rejected {} times",
        report.rejected_steps
    );
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

// ─── Logic gates, inverter, Schmitt triggers and tri-state buffer ───

/// Output of a two-input gate driven by rails, read across a load resistor.
/// The gate hangs off `[0,0] -> [96,0]`, so its inputs sit at (0,-16) and
/// (0,16) and the output at (96,0), the upstream setPoints layout.
fn gate2_output(kind: &str, v0: f64, v1: f64, params: &[(&str, f64)]) -> f64 {
    let mut c = build(
        vec![
            elm(1, "rail", &[[0, -16]], &[("maxVoltage", v0)]),
            elm(2, "rail", &[[0, 16]], &[("maxVoltage", v1)]),
            elm(3, kind, &[[0, -16], [0, 16], [96, 0]], params),
            elm(
                4,
                "resistor",
                &[[96, 0], [96, 100]],
                &[("resistance", 1000.0)],
            ),
            elm(5, "ground", &[[96, 100]], &[]),
        ],
        opts(1e-5, false),
    );
    c.run(5);
    c.element_voltages()[3]
}

#[test]
fn and_gate_truth_table() {
    // All four input pairs; the output is high exactly when both inputs are.
    assert!(close(gate2_output("andGate", 5.0, 5.0, &[]), 5.0, 1e-9));
    assert!(close(gate2_output("andGate", 5.0, 0.0, &[]), 0.0, 1e-9));
    assert!(close(gate2_output("andGate", 0.0, 5.0, &[]), 0.0, 1e-9));
    assert!(close(gate2_output("andGate", 0.0, 0.0, &[]), 0.0, 1e-9));
}

#[test]
fn nand_gate_truth_table() {
    // The AND output bubble inverts every row.
    assert!(close(gate2_output("nandGate", 5.0, 5.0, &[]), 0.0, 1e-9));
    assert!(close(gate2_output("nandGate", 5.0, 0.0, &[]), 5.0, 1e-9));
    assert!(close(gate2_output("nandGate", 0.0, 5.0, &[]), 5.0, 1e-9));
    assert!(close(gate2_output("nandGate", 0.0, 0.0, &[]), 5.0, 1e-9));
}

#[test]
fn or_gate_truth_table() {
    // High when either input is high.
    assert!(close(gate2_output("orGate", 5.0, 5.0, &[]), 5.0, 1e-9));
    assert!(close(gate2_output("orGate", 5.0, 0.0, &[]), 5.0, 1e-9));
    assert!(close(gate2_output("orGate", 0.0, 5.0, &[]), 5.0, 1e-9));
    assert!(close(gate2_output("orGate", 0.0, 0.0, &[]), 0.0, 1e-9));
}

#[test]
fn nor_gate_truth_table() {
    assert!(close(gate2_output("norGate", 5.0, 5.0, &[]), 0.0, 1e-9));
    assert!(close(gate2_output("norGate", 5.0, 0.0, &[]), 0.0, 1e-9));
    assert!(close(gate2_output("norGate", 0.0, 5.0, &[]), 0.0, 1e-9));
    assert!(close(gate2_output("norGate", 0.0, 0.0, &[]), 5.0, 1e-9));
}

#[test]
fn xor_gate_truth_table() {
    // High on odd parity.
    assert!(close(gate2_output("xorGate", 5.0, 5.0, &[]), 0.0, 1e-9));
    assert!(close(gate2_output("xorGate", 5.0, 0.0, &[]), 5.0, 1e-9));
    assert!(close(gate2_output("xorGate", 0.0, 5.0, &[]), 5.0, 1e-9));
    assert!(close(gate2_output("xorGate", 0.0, 0.0, &[]), 0.0, 1e-9));
}

#[test]
fn xnor_gate_truth_table() {
    assert!(close(gate2_output("xnorGate", 5.0, 5.0, &[]), 5.0, 1e-9));
    assert!(close(gate2_output("xnorGate", 5.0, 0.0, &[]), 0.0, 1e-9));
    assert!(close(gate2_output("xnorGate", 0.0, 5.0, &[]), 0.0, 1e-9));
    assert!(close(gate2_output("xnorGate", 0.0, 0.0, &[]), 5.0, 1e-9));
}

#[test]
fn and_gate_honours_its_high_logic_voltage() {
    // The threshold is highVoltage/2, so a 5 V input is LOW to a 10 V gate
    // (GateElm.getInput, GateElm.java:248-249).
    assert!(close(
        gate2_output("andGate", 5.0, 5.0, &[("highVoltage", 10.0)]),
        0.0,
        1e-9
    ));
    assert!(close(
        gate2_output("andGate", 10.0, 10.0, &[("highVoltage", 10.0)]),
        10.0,
        1e-9
    ));
}

#[test]
fn and_gate_takes_an_editable_input_count() {
    // A three-input gate: i0 = -1, 0, 1, so the posts hang at (0,-16), (0,0)
    // and (0,16) with the output at (96,0).
    let out = |a: f64, b: f64, c: f64| {
        let mut c = build(
            vec![
                elm(1, "rail", &[[0, -16]], &[("maxVoltage", a)]),
                elm(2, "rail", &[[0, 0]], &[("maxVoltage", b)]),
                elm(3, "rail", &[[0, 16]], &[("maxVoltage", c)]),
                elm(
                    4,
                    "andGate",
                    &[[0, -16], [0, 0], [0, 16], [96, 0]],
                    &[("inputCount", 3.0)],
                ),
                elm(
                    5,
                    "resistor",
                    &[[96, 0], [96, 100]],
                    &[("resistance", 1000.0)],
                ),
                elm(6, "ground", &[[96, 100]], &[]),
            ],
            opts(1e-5, false),
        );
        c.run(5);
        c.element_voltages()[4]
    };
    assert!(close(out(5.0, 5.0, 5.0), 5.0, 1e-9));
    assert!(close(out(5.0, 5.0, 0.0), 0.0, 1e-9));
    assert!(close(out(0.0, 5.0, 0.0), 0.0, 1e-9));
}

#[test]
fn two_inverter_chain_reproduces_the_input() {
    // NOT(NOT(x)) = x, proving a signal propagates across two elements whose
    // posts only meet through a wire. Run long enough that a wrongly wired
    // oscillation counter would freeze the output.
    for v in [0.0, 5.0] {
        let c = &mut build(
            vec![
                elm(1, "rail", &[[0, 0]], &[("maxVoltage", v)]),
                elm(2, "inverter", &[[0, 0], [80, 0]], &[]),
                elm(3, "wire", &[[80, 0], [80, -16]], &[]),
                elm(4, "inverter", &[[80, -16], [160, -16]], &[]),
                elm(
                    5,
                    "resistor",
                    &[[160, -16], [160, 84]],
                    &[("resistance", 1000.0)],
                ),
                elm(6, "ground", &[[160, 84]], &[]),
            ],
            opts(1e-5, false),
        );
        c.run(100);
        assert!(
            close(c.element_voltages()[4], v, 1e-9),
            "inverter chain with input {v} settled at {}",
            c.element_voltages()[4]
        );
    }
}

/// Output of a one-input slew-limited element (inverter or Schmitt trigger)
/// driven by a rail, read across a load resistor.
fn slew_output(kind: &str, input_v: f64, params: &[(&str, f64)], dt: f64, steps: u32) -> f64 {
    let mut c = build(
        vec![
            elm(1, "rail", &[[0, 0]], &[("maxVoltage", input_v)]),
            elm(2, kind, &[[0, 0], [96, 0]], params),
            elm(
                3,
                "resistor",
                &[[96, 0], [96, 100]],
                &[("resistance", 1000.0)],
            ),
            elm(4, "ground", &[[96, 100]], &[]),
        ],
        opts(dt, false),
    );
    c.run(steps);
    c.element_voltages()[2]
}

#[test]
fn inverter_outputs_the_inverse_logic_level() {
    assert!(close(slew_output("inverter", 5.0, &[], 1e-5, 5), 0.0, 1e-9));
    assert!(close(slew_output("inverter", 0.0, &[], 1e-5, 5), 5.0, 1e-9));
}

#[test]
fn inverter_is_slew_rate_limited() {
    // slewRate 0.25 V/ns at dt = 1e-8 s allows 2.5 V per step, so a low input
    // (target high) reaches 5 V in exactly two steps (InverterElm.java:124-125).
    let params = &[("slewRate", 0.25)];
    assert!(close(
        slew_output("inverter", 0.0, params, 1e-8, 1),
        2.5,
        1e-6
    ));
    assert!(close(
        slew_output("inverter", 0.0, params, 1e-8, 2),
        5.0,
        1e-6
    ));
}

#[test]
fn schmitt_trigger_buffers_and_is_slew_limited() {
    // The non-inverting Schmitt follows the input at the extremes. The first
    // step still sees the pre-solve input (0), which parks the output low; the
    // rail's 5 V then arrives, so the ramp to the on level at 2.5 V/step takes
    // two more: 0 -> 2.5 -> 5.
    let params = &[("slewRate", 0.25)];
    assert!(close(
        slew_output("schmitt", 5.0, params, 1e-8, 2),
        2.5,
        1e-6
    ));
    assert!(close(
        slew_output("schmitt", 5.0, params, 1e-8, 3),
        5.0,
        1e-6
    ));
}

#[test]
fn inverting_schmitt_trigger_inverts_and_is_slew_limited() {
    // Low input, inverting output high, same 2.5 V/step ramp as the others.
    let params = &[("slewRate", 0.25)];
    assert!(close(
        slew_output("invertingSchmitt", 0.0, params, 1e-8, 1),
        2.5,
        1e-6
    ));
    assert!(close(
        slew_output("invertingSchmitt", 0.0, params, 1e-8, 2),
        5.0,
        1e-6
    ));
}

/// Runs a Schmitt trigger through one triangle input cycle and returns the
/// (input, output) pairs, sampling once per step.
fn schmitt_walk(kind: &str) -> Vec<(f64, f64)> {
    // Triangle source, 0 V bias, 6 V amplitude at 100 Hz: the input sweeps
    // -6..+6..0 over the 750 sampled steps, crossing the default 3.33 upper
    // trigger on the way up and the 1.66 lower one on the way down.
    let mut c = build(
        vec![
            elm(
                1,
                "voltage",
                &[[0, 0], [0, -16]],
                &[
                    ("waveform", 3.0),
                    ("maxVoltage", 6.0),
                    ("bias", 0.0),
                    ("frequency", 100.0),
                ],
            ),
            elm(2, "ground", &[[0, 0]], &[]),
            elm(3, kind, &[[0, -16], [96, -16]], &[]),
            elm(
                4,
                "resistor",
                &[[96, -16], [96, 84]],
                &[("resistance", 1000.0)],
            ),
            elm(5, "ground", &[[96, 84]], &[]),
        ],
        opts(1e-5, false),
    );
    let mut walk = Vec::with_capacity(750);
    for _ in 0..750 {
        c.run(1);
        walk.push((c.element_voltages()[0], c.element_voltages()[3]));
    }
    walk
}

#[test]
fn non_inverting_schmitt_has_hysteresis() {
    // Below the lower trigger the output is off; above the upper trigger it is
    // on; in between it keeps the last value, so the band on the way up reads
    // off and the band on the way down reads on (SchmittElm.java:40-65). A
    // do_step reads the previous step's solved input, so each output is
    // paired with the input one sample earlier.
    let walk = schmitt_walk("schmitt");
    let mut crossed_upper = false;
    let mut crossed_lower = false;
    for i in 1..walk.len() {
        let (prev_in, _) = walk[i - 1];
        let vout = walk[i].1;
        if prev_in > 3.33 && !crossed_upper {
            crossed_upper = true;
        }
        if crossed_upper && prev_in < 1.66 && !crossed_lower {
            crossed_lower = true;
        }
        if prev_in < 1.66 {
            assert!(vout < 0.1, "below lower, out {vout}, in {prev_in}");
        } else if prev_in > 3.33 {
            assert!(vout > 4.9, "above upper, out {vout}, in {prev_in}");
        } else if crossed_upper && !crossed_lower {
            assert!(
                vout > 4.9,
                "hysteresis band on the way down, out {vout}, in {prev_in}"
            );
        } else {
            assert!(
                vout < 0.1,
                "hysteresis band on the way up, out {vout}, in {prev_in}"
            );
        }
    }
    assert!(crossed_upper, "input never crossed the upper trigger");
    assert!(crossed_lower, "input never fell below the lower trigger");
}

#[test]
fn inverting_schmitt_has_hysteresis() {
    // The inverting mirror image: off above the upper trigger, on below the
    // lower one, memory in between (InvertingSchmittElm.java:123-146).
    let walk = schmitt_walk("invertingSchmitt");
    let mut crossed_upper = false;
    let mut crossed_lower = false;
    for i in 1..walk.len() {
        let (prev_in, _) = walk[i - 1];
        let vout = walk[i].1;
        if prev_in > 3.33 && !crossed_upper {
            crossed_upper = true;
        }
        if crossed_upper && prev_in < 1.66 && !crossed_lower {
            crossed_lower = true;
        }
        if prev_in < 1.66 {
            assert!(vout > 4.9, "below lower, out {vout}, in {prev_in}");
        } else if prev_in > 3.33 {
            assert!(vout < 0.1, "above upper, out {vout}, in {prev_in}");
        } else if crossed_upper && !crossed_lower {
            assert!(
                vout < 0.1,
                "hysteresis band on the way down, out {vout}, in {prev_in}"
            );
        } else {
            assert!(
                vout > 4.9,
                "hysteresis band on the way up, out {vout}, in {prev_in}"
            );
        }
    }
    assert!(crossed_upper, "input never crossed the upper trigger");
    assert!(crossed_lower, "input never fell below the lower trigger");
}

/// Output of a tri-state buffer driven by rails, read across a load resistor.
fn tristate_output(input_v: f64, control_v: f64, params: &[(&str, f64)]) -> f64 {
    let mut c = build(
        vec![
            elm(1, "rail", &[[0, 0]], &[("maxVoltage", input_v)]),
            elm(2, "rail", &[[48, -16]], &[("maxVoltage", control_v)]),
            elm(3, "triState", &[[0, 0], [96, 0], [48, -16]], params),
            elm(
                4,
                "resistor",
                &[[96, 0], [96, 100]],
                &[("resistance", 1000.0)],
            ),
            elm(5, "ground", &[[96, 100]], &[]),
        ],
        opts(1e-5, false),
    );
    c.run(5);
    c.element_voltages()[3]
}

#[test]
fn tri_state_buffers_when_enabled() {
    // Control high closes the 0.1 ohm path, so the output follows the input's
    // logic level through a negligible divider drop.
    assert!(
        close(tristate_output(5.0, 5.0, &[]), 5.0, 0.01),
        "enabled high input should read near 5 V"
    );
    assert!(
        close(tristate_output(0.0, 5.0, &[]), 0.0, 1e-6),
        "enabled low input should read 0 V"
    );
}

#[test]
fn tri_state_disables_into_high_impedance() {
    // Control low opens the 1e10 path, so the output floats to the load and
    // reads 0; the optional pulldown (the file's r_off_ground token) makes it
    // sit at 0 even without the load pulling it.
    assert!(
        tristate_output(5.0, 0.0, &[]) < 1e-3,
        "disabled output with no pulldown should float to the load, got {}",
        tristate_output(5.0, 0.0, &[])
    );
    assert!(
        tristate_output(5.0, 0.0, &[("r_off_ground", 1e8)]) < 1e-3,
        "disabled output with a pulldown should sit at 0"
    );
}

/// Output voltage of a 2-in/2-out custom-logic chip's `out`-th output, driven
/// by rails on the inputs. Posts: the inputs at (0,0) and (0,32), the outputs
/// at (96,0) and (96,32), each output pulled to ground through a 1k load whose
/// drop is what `element_voltages` reads back.
fn custom_output(a: f64, b: f64, rules: &[(&str, &str)], out: usize) -> f64 {
    let mut c = build(
        vec![
            elm(1, "rail", &[[0, 0]], &[("maxVoltage", a)]),
            elm(2, "rail", &[[0, 32]], &[("maxVoltage", b)]),
            elm_model(3, &[[0, 0], [0, 32], [96, 0], [96, 32]], 2, 2, false, rules),
            elm(
                4,
                "resistor",
                &[[96, 0], [96, 100]],
                &[("resistance", 1000.0)],
            ),
            elm(5, "ground", &[[96, 100]], &[]),
            elm(
                6,
                "resistor",
                &[[96, 32], [96, 132]],
                &[("resistance", 1000.0)],
            ),
            elm(7, "ground", &[[96, 132]], &[]),
        ],
        opts(1e-5, false),
    );
    c.run(5);
    // The output's own voltage_diff is `V(input0) - V(input1)`, useless here,
    // so read the load resistor's drop, which is the output node to ground.
    c.element_voltages()[if out == 0 { 3 } else { 5 }]
}

#[test]
fn custom_logic_evaluates_its_truth_table() {
    // A 2-in/2-out model where output 0 is the AND and output 1 the OR of the
    // inputs, one rule per input pair (the ledarray smiley's shape). Every
    // left string is exactly the input count, every right string the output
    // count.
    let rules = [("00", "00"), ("01", "01"), ("10", "01"), ("11", "11")];
    for (a, b, and, or) in [
        (0.0, 0.0, 0.0, 0.0),
        (0.0, 5.0, 0.0, 5.0),
        (5.0, 0.0, 0.0, 5.0),
        (5.0, 5.0, 5.0, 5.0),
    ] {
        assert!(
            close(custom_output(a, b, &rules, 0), and, 1e-6),
            "AND of {a} and {b} should read {and}"
        );
        assert!(
            close(custom_output(a, b, &rules, 1), or, 1e-6),
            "OR of {a} and {b} should read {or}"
        );
    }
}

#[test]
fn custom_logic_pattern_and_dont_care_rules_match_like_upstream() {
    // The first rule `aA=10` matches exactly when the two inputs are equal:
    // `a` saves input 0 into the pattern table, `A` compares input 1 against
    // it (the parseRules dedup turns the second occurrence of the letter into
    // the compare form). The `??` fallback matches every other input pair with
    // both positions don't-care, so unequal inputs take the second rule.
    let rules = [("aA", "10"), ("??", "01")];
    for (a, b) in [(0.0, 0.0), (5.0, 5.0)] {
        assert!(
            close(custom_output(a, b, &rules, 0), 5.0, 1e-6),
            "equal inputs {a},{b}: output 0 should be high"
        );
        assert!(
            close(custom_output(a, b, &rules, 1), 0.0, 1e-6),
            "equal inputs {a},{b}: output 1 should be low"
        );
    }
    for (a, b) in [(0.0, 5.0), (5.0, 0.0)] {
        assert!(
            close(custom_output(a, b, &rules, 0), 0.0, 1e-6),
            "unequal inputs {a},{b}: output 0 should be low"
        );
        assert!(
            close(custom_output(a, b, &rules, 1), 5.0, 1e-6),
            "unequal inputs {a},{b}: output 1 should be high"
        );
    }
}

#[test]
fn custom_logic_tri_state_output_goes_high_impedance() {
    // A 1-in/1-out tri-state model: input high drives the output through the
    // 1e-3 ohm path, input low sets `_` and opens the 1e8 path, leaving the
    // output to whatever the circuit pins it to. The output node sits in the
    // middle of a 5 V / ground 1k divider: driven, it pins the midpoint; at
    // high impedance it floats to the 2.5 V divider point, which a driven-low
    // output could never reach. The midpoint is resistor R2's drop.
    let midpoint = |input: f64| {
        let mut c = build(
            vec![
                elm(1, "rail", &[[0, 0]], &[("maxVoltage", input)]),
                elm_model(
                    2,
                    &[[0, 0], [200, 100]],
                    1,
                    1,
                    true,
                    &[("1", "1"), ("0", "_")],
                ),
                elm(
                    3,
                    "resistor",
                    &[[200, 0], [200, 100]],
                    &[("resistance", 1000.0)],
                ),
                elm(4, "rail", &[[200, 0]], &[("maxVoltage", 5.0)]),
                elm(
                    5,
                    "resistor",
                    &[[200, 100], [200, 200]],
                    &[("resistance", 1000.0)],
                ),
                elm(6, "ground", &[[200, 200]], &[]),
            ],
            opts(1e-5, false),
        );
        c.run(5);
        c.element_voltages()[4]
    };
    assert!(
        close(midpoint(5.0), 5.0, 1e-3),
        "driven output pins the divider midpoint high, got {}",
        midpoint(5.0)
    );
    assert!(
        close(midpoint(0.0), 2.5, 1e-3),
        "high-impedance output floats to the 2.5 V divider point, got {}",
        midpoint(0.0)
    );
}

#[test]
fn and_gate_with_schmitt_inputs_has_input_hysteresis() {
    // FLAG_SCHMITT gives each input a hysteresis band: it trips high above
    // 0.55*highVoltage and holds until the input falls below 0.35*highVoltage,
    // with the band holding whichever state the input last settled in
    // (GateElm.getInput, GateElm.java:250-256). Drive a one-input AND through
    // the band by changing a rail's voltage live and check the output only
    // flips at the two trips. Each rail change needs two steps: one for the
    // solve to apply it, one for the gate to evaluate the new input.
    let mut c = build(
        vec![
            elm(1, "rail", &[[0, 0]], &[("maxVoltage", 5.0)]),
            elm_flags(2, "andGate", &[[0, 0], [96, 0]], &[("inputCount", 1.0)], 2),
            elm(
                3,
                "resistor",
                &[[96, 0], [96, 100]],
                &[("resistance", 1000.0)],
            ),
            elm(4, "ground", &[[96, 100]], &[]),
        ],
        opts(1e-5, false),
    );
    // Settle high at 5 V (well above 2.75), then drop into the band at 2 V:
    // the 1.75 V lower trip has not been crossed, so the output holds high.
    c.run(5);
    assert!(
        close(c.element_voltages()[2], 5.0, 1e-9),
        "sanity: high input, out {}",
        c.element_voltages()[2]
    );
    assert!(c.set_param(1, "maxVoltage", 2.0));
    c.run(2);
    assert!(
        close(c.element_voltages()[2], 5.0, 1e-9),
        "band on the way down held {}",
        c.element_voltages()[2]
    );

    // Below 1.75 V the input flips low and the output follows.
    assert!(c.set_param(1, "maxVoltage", 1.0));
    c.run(2);
    assert!(
        close(c.element_voltages()[2], 0.0, 1e-9),
        "below the lower trip, out {}",
        c.element_voltages()[2]
    );

    // Back in the band at 2 V, still below the 2.75 V upper trip: holds low.
    assert!(c.set_param(1, "maxVoltage", 2.0));
    c.run(2);
    assert!(
        close(c.element_voltages()[2], 0.0, 1e-9),
        "band on the way up held {}",
        c.element_voltages()[2]
    );

    // Above 2.75 V the input flips high again.
    assert!(c.set_param(1, "maxVoltage", 3.0));
    c.run(2);
    assert!(
        close(c.element_voltages()[2], 5.0, 1e-9),
        "above the upper trip, out {}",
        c.element_voltages()[2]
    );
}

#[test]
fn and_gate_with_inverted_inputs_behaves_as_nor() {
    // FLAG_INVERT_INPUTS bubbles every input (GateElm.java:28, :246-249), so
    // a two-input AND evaluates NOT(a) AND NOT(b), which is NOR. Drive the
    // four input pairs and check the truth table.
    let out = |a: f64, b: f64| {
        let mut c = build(
            vec![
                elm(1, "rail", &[[0, -16]], &[("maxVoltage", a)]),
                elm(2, "rail", &[[0, 16]], &[("maxVoltage", b)]),
                elm_flags(3, "andGate", &[[0, -16], [0, 16], [96, 0]], &[], 4),
                elm(
                    4,
                    "resistor",
                    &[[96, 0], [96, 100]],
                    &[("resistance", 1000.0)],
                ),
                elm(5, "ground", &[[96, 100]], &[]),
            ],
            opts(1e-5, false),
        );
        c.run(5);
        c.element_voltages()[3]
    };
    assert!(close(out(5.0, 5.0), 0.0, 1e-9));
    assert!(close(out(5.0, 0.0), 0.0, 1e-9));
    assert!(close(out(0.0, 5.0), 0.0, 1e-9));
    assert!(close(out(0.0, 0.0), 5.0, 1e-9));
}

#[test]
fn gate_restores_last_output_from_the_file_token() {
    // The `lastOutputVoltage` token restores the gate's committed output, and
    // setupVolts seeds the inputs to reproduce it, so the first step does not
    // glitch (GateElm.java:56-62, :168-174). A non-inverting AND whose token
    // says high starts high even with its input left floating at the seed; a
    // NAND remembers high too, because its seed fills the inputs with the low
    // level the inverted function turns back into a high output.
    let out = |kind: &str, last_output_v: f64| {
        let mut c = build(
            vec![
                elm_flags(
                    1,
                    kind,
                    &[[0, 0], [96, 0]],
                    &[("inputCount", 1.0), ("lastOutputVoltage", last_output_v)],
                    0,
                ),
                elm(
                    2,
                    "resistor",
                    &[[96, 0], [96, 100]],
                    &[("resistance", 1000.0)],
                ),
                elm(3, "ground", &[[96, 100]], &[]),
            ],
            opts(1e-5, false),
        );
        c.run(1);
        c.element_voltages()[1]
    };
    assert!(close(out("andGate", 5.0), 5.0, 1e-9), "AND remembers high");
    assert!(
        close(out("nandGate", 5.0), 5.0, 1e-9),
        "NAND remembers high"
    );
    assert!(close(out("andGate", 0.0), 0.0, 1e-9), "AND remembers low");
}

#[test]
fn logic_input_high_drives_a_divider() {
    // A logic input at position 1 is a 5 V source to ground; across two equal
    // 1 k resistors the midpoint sits at half its output and the source
    // delivers the divider current.
    let c = &mut build(
        vec![
            elm(
                1,
                "logicInput",
                &[[0, 0]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 1.0)],
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
    assert!(close(volts[2], 2.5, 1e-9), "midpoint was {}", volts[2]);
    assert!(
        close(amps[1], 2.5e-3, 1e-12),
        "source current was {}",
        amps[1]
    );
    assert!(
        close(amps[2], 2.5e-3, 1e-12),
        "first resistor current was {}",
        amps[2]
    );
}

#[test]
fn logic_output_reads_its_node_voltage() {
    // A 5 V rail drives a logic output with the pull-down flag set: the 1 M
    // pull-down to ground must not drag the node down. The element's readout
    // is the node voltage itself, and a voltage scope on the element samples
    // that same value (getVoltageDiff, LogicOutputElm.java:97).
    let c = &mut build_with(
        vec![
            elm(1, "rail", &[[0, 0]], &[("maxVoltage", 5.0)]),
            elm(2, "ground", &[[100, 0]], &[]),
            elm_flags(3, "logicOutput", &[[0, 0]], &[("threshold", 2.5)], 4),
        ],
        opts(1e-5, true),
        vec![ScopeSpec {
            element_id: 3,
            value: ScopeValue::Voltage,
            post: 0,
            steps_per_column: 1,
            columns: 1024,
            ac_coupled: false,
            trigger: Default::default(),
            display_width: 0,
        }],
    );
    c.run(1);
    assert!(
        close(c.element_voltages()[2], 5.0, 1e-9),
        "logic output readout was {}",
        c.element_voltages()[2]
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
fn led_drops_about_two_volts_forward() {
    // A 5 V source through 1 k drives a few mA into the LED. The LED's
    // forward drop is 2.1024259 V at 1 A (LEDElm.java:41), so at a few mA it
    // sits just under 2 V and the loop current is roughly (5 - 2.1)/R.
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 5.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(3, "led", &[[100, 0], [100, 100]], &[]),
            elm(4, "wire", &[[100, 100], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
        ],
        opts(1e-5, true),
    );
    c.run(20);

    let vd = c.element_voltages()[2];
    let i = c.element_currents()[1];
    assert!((1.5..2.4).contains(&vd), "forward drop was {vd}");
    assert!(close(i, (5.0 - vd) / 1000.0, 1e-5), "current was {i}");
    assert!(close(i, (5.0 - 2.1) / 1000.0, 0.5e-3), "current was {i}");
}

#[test]
fn analog_switch_passes_signal_above_threshold_only() {
    // A 5 V source drives a 1 k feed through the analog switch to ground; the
    // control post is driven by its own 5 V source. With the control above
    // the 2.5 V threshold the switch stamps r_on, so the loop current is
    // 5/(R + r_on).
    let closed = &mut build(
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
                "analogSwitch",
                &[[100, 0], [100, 100], [84, 50]],
                &[("r_on", 20.0), ("r_off", 1e10), ("threshold", 2.5)],
            ),
            elm(4, "wire", &[[100, 100], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
            elm(6, "voltage", &[[84, 34], [84, 50]], &[("maxVoltage", 5.0)]),
            elm(7, "ground", &[[84, 34]], &[]),
        ],
        opts(1e-5, true),
    );
    closed.run(5);
    let expected = 5.0 / (1000.0 + 20.0);
    assert!(
        close(closed.element_currents()[1], expected, 1e-12),
        "closed switch drew {}, expected {expected}",
        closed.element_currents()[1]
    );

    let open = &mut build(
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
                "analogSwitch",
                &[[100, 0], [100, 100], [84, 50]],
                &[("r_on", 20.0), ("r_off", 1e10), ("threshold", 2.5)],
            ),
            elm(4, "wire", &[[100, 100], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
            elm(6, "voltage", &[[84, 34], [84, 50]], &[("maxVoltage", 0.0)]),
            elm(7, "ground", &[[84, 34]], &[]),
        ],
        opts(1e-5, true),
    );
    open.run(5);
    assert!(
        close(open.element_currents()[1], 0.0, 1e-8),
        "open switch should pass no current, got {}",
        open.element_currents()[1]
    );
}

#[test]
fn analog_switch2_routes_current_to_the_selected_throw_only() {
    // A 5 V source through a 1k resistor into the SPDT analog switch's common
    // post. The control rail sits at 5 V, above the 2.5 V threshold, so throw
    // 1 carries r_on and is grounded, carrying I = 5/(R+r_on). Throw 2
    // carries r_off and reads zero.
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
                "analogSwitch2",
                &[[100, 0], [300, -16], [300, 16], [200, -16]],
                &[("r_on", 20.0), ("r_off", 1e10), ("threshold", 2.5)],
            ),
            elm(4, "ground", &[[300, -16]], &[]),
            elm(
                5,
                "resistor",
                &[[300, 16], [300, 116]],
                &[("resistance", 1000.0)],
            ),
            elm(6, "ground", &[[300, 116]], &[]),
            elm(7, "rail", &[[200, -16]], &[("maxVoltage", 5.0)]),
            elm(8, "ground", &[[0, 100]], &[]),
        ],
        opts(1e-5, true),
    );
    let report = c.run(5);
    assert!(report.converged, "did not converge: {:?}", report.error);
    let expected = 5.0 / (1000.0 + 20.0);
    let amps = c.element_currents();
    assert!(
        close(amps[1], expected, 1e-9),
        "divider current was {}, expected {}",
        amps[1],
        expected
    );
    assert!(
        close(amps[2], expected, 1e-9),
        "switch current was {}, expected {}",
        amps[2],
        expected
    );
    assert!(
        close(c.element_voltages()[2], 5.0 * 20.0 / (1000.0 + 20.0), 1e-9),
        "common voltage was {}, expected the r_on divider drop",
        c.element_voltages()[2]
    );
    assert!(
        close(amps[4], 0.0, 1e-9),
        "unselected throw's resistor carried {}, expected none",
        amps[4]
    );
}

#[test]
fn analog_switch2_pulldown_grounds_the_unselected_throw() {
    // The same divider as the routing test above, with FLAG_PULLDOWN (2) set:
    // the unselected throw is no longer stamped with `r_off` to the common, it
    // is tied to ground through `r_off` for the whole run instead, so its node
    // reads zero while the common carries the divider drop
    // (AnalogSwitch2Elm.java:100-117).
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 5.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm_flags(
                3,
                "analogSwitch2",
                &[[100, 0], [300, -16], [300, 16], [200, -16]],
                &[("r_on", 20.0), ("r_off", 1e10), ("threshold", 2.5)],
                2,
            ),
            elm(4, "ground", &[[300, -16]], &[]),
            elm(
                5,
                "resistor",
                &[[300, 16], [300, 116]],
                &[("resistance", 1000.0)],
            ),
            elm(6, "ground", &[[300, 116]], &[]),
            elm(7, "rail", &[[200, -16]], &[("maxVoltage", 5.0)]),
            elm(8, "ground", &[[0, 100]], &[]),
        ],
        opts(1e-5, true),
    );
    let report = c.run(5);
    assert!(report.converged, "did not converge: {:?}", report.error);
    let expected = 5.0 / (1000.0 + 20.0);
    let amps = c.element_currents();
    assert!(
        close(amps[1], expected, 1e-9),
        "divider current was {}, expected {}",
        amps[1],
        expected
    );
    assert!(
        close(amps[2], expected, 1e-9),
        "switch current was {}, expected {}",
        amps[2],
        expected
    );
    assert!(
        close(c.element_voltages()[2], 5.0 * 20.0 / (1000.0 + 20.0), 1e-9),
        "common voltage was {}, expected the r_on divider drop",
        c.element_voltages()[2]
    );
    // The switch's posts start at flattened index 4 (2 for the source, 2 for
    // the divider); throw 2 is its third post. The pulldown leaves it at
    // ground exactly, unlike the `r_off`-to-common stamp the routing test
    // relies on, which would leave it at the divider's drop.
    let nodes = c.element_nodes();
    let throw2 = nodes[6] as usize;
    assert!(
        close(c.node_voltages()[throw2], 0.0, 1e-9),
        "unselected throw sat at {}, expected the pulldown's ground",
        c.node_voltages()[throw2]
    );
    assert!(
        close(amps[4], 0.0, 1e-9),
        "unselected throw's load carried {}, expected none",
        amps[4]
    );
}

#[test]
fn memristor_biased_with_constant_current_integrates_linearly() {
    // A current source in series with a memristor to ground forces a constant
    // 1 mA through it, so dopeWidth integrates linearly and the resistance
    // sweeps from r_off toward r_on. The discrete update (MemristorElm.java:
    // 119-127) advances dopeWidth from the *previous* step's converged current,
    // and a fresh element starts with current 0, so step 1 stamps the initial
    // r_off and advances nothing; from step 2 on each step moves dopeWidth by
    // delta = dt*mobility*r_on*I/totalWidth. The resistance a step stamps uses
    // the wd captured *before* that step's advance (the same capture-before-
    // advance order as the lamp), so step N stamps the blend at
    // wd = (N-2)*delta/totalWidth. With these numbers delta = totalWidth/10,
    // so after 10 steps the last stamped resistance is at wd = 0.8,
    // R = 3280 ohm, V = 3.28 V.
    let dt = 1e-6;
    let i = 1e-3;
    let r_on = 100.0;
    let r_off = 16000.0;
    let total_width = 1e-8;
    let mobility = 1e-10;
    let steps = 10u32;

    let delta = dt * mobility * r_on * i / total_width; // 1e-9 m per step
    let wd = (steps - 2) as f64 * delta / total_width; // 0.8
    let resistance = r_on * wd + r_off * (1.0 - wd); // 3280 ohm

    let c = &mut build(
        vec![
            elm(1, "current", &[[0, 0], [100, 0]], &[("current", i)]),
            elm(
                2,
                "memristor",
                &[[100, 0], [200, 0]],
                &[
                    ("r_on", r_on),
                    ("r_off", r_off),
                    ("totalWidth", total_width),
                    ("mobility", mobility),
                ],
            ),
            elm(3, "ground", &[[0, 0]], &[]),
            elm(4, "ground", &[[200, 0]], &[]),
        ],
        opts(dt, false),
    );
    c.run(steps);

    let volts = c.element_voltages();
    let amps = c.element_currents();
    assert!(
        close(volts[1], i * resistance, 1e-9),
        "memristor voltage {}, expected {} (R = {})",
        volts[1],
        i * resistance,
        resistance
    );
    assert!(
        close(amps[1], i, 1e-12),
        "memristor current {}, expected the source's {} A",
        amps[1],
        i
    );
}

// ─── Digital chip family ───

/// One full clock cycle: raise the clock, let the level settle, drop it, let
/// that settle. A `set_state` reanalyzes the circuit and zeroes every element
/// voltage, so the first step after each change still sees the old level and
/// the edge fires a step later; three steps cover the settling either way.
fn clock_cycle(c: &mut Circuit, clock_id: u32) {
    c.set_state(clock_id, 1);
    c.run(3);
    c.set_state(clock_id, 0);
    c.run(3);
}

#[test]
fn d_flip_flop_captures_d_on_the_rising_edge() {
    // D held high, clocked by a logic input. A fresh flip-flop starts Q low
    // and Qbar high; the first rising edge copies D into Q and Qbar follows.
    let c = &mut build(
        vec![
            elm(1, "rail", &[[0, 0]], &[("maxVoltage", 5.0)]),
            elm(
                2,
                "logicInput",
                &[[0, 32]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm(
                3,
                "dFlipFlop",
                &[[0, 0], [96, 0], [96, 64], [0, 32]],
                &[("highVoltage", 5.0)],
            ),
            elm(
                4,
                "resistor",
                &[[96, 0], [96, 100]],
                &[("resistance", 1000.0)],
            ),
            elm(5, "ground", &[[96, 100]], &[]),
            elm(
                6,
                "resistor",
                &[[96, 64], [96, 164]],
                &[("resistance", 1000.0)],
            ),
            elm(7, "ground", &[[96, 164]], &[]),
        ],
        opts(1e-5, false),
    );
    c.run(3);
    assert!(
        close(c.element_voltages()[3], 0.0, 1e-9),
        "fresh Q was not low"
    );
    assert!(
        close(c.element_voltages()[5], 5.0, 1e-9),
        "fresh Qbar was not high"
    );
    clock_cycle(c, 2);
    assert!(
        close(c.element_voltages()[3], 5.0, 1e-9),
        "Q did not capture D"
    );
    assert!(
        close(c.element_voltages()[5], 0.0, 1e-9),
        "Qbar did not complement Q"
    );
    clock_cycle(c, 2);
    assert!(
        close(c.element_voltages()[3], 5.0, 1e-9),
        "Q dropped on a later edge"
    );
}

#[test]
fn t_flip_flop_toggles_on_each_rising_edge() {
    // T held high: every rising clock edge flips Q, and Qbar follows.
    let c = &mut build(
        vec![
            elm(1, "rail", &[[0, 0]], &[("maxVoltage", 5.0)]),
            elm(
                2,
                "logicInput",
                &[[0, 32]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm(
                3,
                "tFlipFlop",
                &[[0, 0], [96, 0], [96, 64], [0, 32]],
                &[("highVoltage", 5.0)],
            ),
            elm(
                4,
                "resistor",
                &[[96, 0], [96, 100]],
                &[("resistance", 1000.0)],
            ),
            elm(5, "ground", &[[96, 100]], &[]),
            elm(
                6,
                "resistor",
                &[[96, 64], [96, 164]],
                &[("resistance", 1000.0)],
            ),
            elm(7, "ground", &[[96, 164]], &[]),
        ],
        opts(1e-5, false),
    );
    c.run(3);
    assert!(
        close(c.element_voltages()[3], 0.0, 1e-9),
        "fresh Q was not low"
    );
    clock_cycle(c, 2);
    assert!(
        close(c.element_voltages()[3], 5.0, 1e-9),
        "first edge did not set Q"
    );
    clock_cycle(c, 2);
    assert!(
        close(c.element_voltages()[3], 0.0, 1e-9),
        "second edge did not clear Q"
    );
    clock_cycle(c, 2);
    assert!(
        close(c.element_voltages()[3], 5.0, 1e-9),
        "third edge did not set Q"
    );
}

#[test]
fn jk_flip_flop_toggles_on_every_negative_edge() {
    // J = K = 1 turn the JK into a toggle flip-flop. The default triggers on
    // the falling clock edge. A 1 kHz square clock at dt = 1e-5 s has a 100
    // step period, high for 0..48 and low from step 49; the level the chip
    // sees lags one step behind the source, so the first falling edge fires
    // at step 50 and every 100 steps after that.
    let c = &mut build(
        vec![
            elm(1, "rail", &[[0, 0]], &[("maxVoltage", 5.0)]),
            elm(
                2,
                "voltage",
                &[[0, 100], [0, 32]],
                &[
                    ("waveform", 2.0),
                    ("frequency", 1000.0),
                    ("maxVoltage", 2.5),
                    ("bias", 2.5),
                    ("phaseShift", 0.0),
                    ("dutyCycle", 0.5),
                ],
            ),
            elm(3, "ground", &[[0, 100]], &[]),
            elm(4, "rail", &[[0, 64]], &[("maxVoltage", 5.0)]),
            elm(
                5,
                "jkFlipFlop",
                &[[0, 0], [0, 32], [0, 64], [96, 0], [96, 64]],
                &[("highVoltage", 5.0)],
            ),
            elm(
                6,
                "resistor",
                &[[96, 0], [96, 100]],
                &[("resistance", 1000.0)],
            ),
            elm(7, "ground", &[[96, 100]], &[]),
            elm(
                8,
                "resistor",
                &[[96, 64], [96, 164]],
                &[("resistance", 1000.0)],
            ),
            elm(9, "ground", &[[96, 164]], &[]),
        ],
        opts(1e-5, false),
    );
    c.run(3);
    assert!(
        close(c.element_voltages()[5], 0.0, 1e-9),
        "fresh Q was not low"
    );
    assert!(
        close(c.element_voltages()[7], 5.0, 1e-9),
        "fresh Qbar was not high"
    );
    c.run(50); // steps 4..53: the first falling edge at step 50
    assert!(
        close(c.element_voltages()[5], 5.0, 1e-9),
        "first edge did not set Q"
    );
    c.run(100); // the second falling edge at step 150
    assert!(
        close(c.element_voltages()[5], 0.0, 1e-9),
        "second edge did not clear Q"
    );
    c.run(100); // the third falling edge at step 250
    assert!(
        close(c.element_voltages()[5], 5.0, 1e-9),
        "third edge did not set Q"
    );
}

#[test]
fn counter_advances_on_each_clock_edge() {
    // 3-bit counter with no up/down pin, reset active high and held low.
    // Every rising edge adds one, wrapping at 2^3.
    let c = &mut build(
        vec![
            elm(
                1,
                "logicInput",
                &[[0, 0]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm(
                2,
                "logicInput",
                &[[0, 64]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm_flags(
                3,
                "counter",
                &[[0, 0], [0, 64], [96, 0], [96, 32], [96, 64]],
                &[("bits", 3.0), ("invertreset", 0.0), ("modulus", 0.0)],
                0,
            ),
            elm(
                4,
                "resistor",
                &[[96, 0], [96, 100]],
                &[("resistance", 1000.0)],
            ),
            elm(5, "ground", &[[96, 100]], &[]),
            elm(
                6,
                "resistor",
                &[[96, 32], [96, 132]],
                &[("resistance", 1000.0)],
            ),
            elm(7, "ground", &[[96, 132]], &[]),
            elm(
                8,
                "resistor",
                &[[96, 64], [96, 164]],
                &[("resistance", 1000.0)],
            ),
            elm(9, "ground", &[[96, 164]], &[]),
        ],
        opts(1e-5, false),
    );
    // The output pins run MSB first, so element 3 (Q2) is the 4s column, 5
    // (Q1) the 2s and 7 (Q0) the 1s.
    let count = |c: &Circuit| -> i64 {
        let v = c.element_voltages();
        let bit = |i: usize| if v[i] > 2.5 { 1i64 } else { 0 };
        bit(3) * 4 + bit(5) * 2 + bit(7)
    };
    c.run(3);
    assert_eq!(count(c), 0, "fresh counter did not start at zero");
    for expected in [1, 2, 3, 4, 5, 6, 7, 0] {
        clock_cycle(c, 1);
        assert_eq!(count(c), expected, "count after the next edge");
    }
}

#[test]
fn ring_counter_advances_the_high_bit_each_edge() {
    // 3-bit ring counter, reset active high (FLAG_RESET_HIGH = 4) and held
    // low. A fresh ring starts with Q0 high (the reset that runs when no
    // output is high), and each rising edge moves the single high bit around.
    let c = &mut build(
        vec![
            elm(
                1,
                "logicInput",
                &[[0, 32]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm(
                2,
                "logicInput",
                &[[96, 64]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm_flags(
                3,
                "ringCounter",
                &[[0, 32], [96, 64], [32, -32], [64, -32], [96, -32]],
                &[("bits", 3.0), ("highVoltage", 5.0)],
                4,
            ),
            elm(
                4,
                "resistor",
                &[[32, -32], [32, 68]],
                &[("resistance", 1000.0)],
            ),
            elm(5, "ground", &[[32, 68]], &[]),
            elm(
                6,
                "resistor",
                &[[64, -32], [64, 68]],
                &[("resistance", 1000.0)],
            ),
            elm(7, "ground", &[[64, 68]], &[]),
            elm(
                8,
                "resistor",
                &[[96, -32], [96, 68]],
                &[("resistance", 1000.0)],
            ),
            elm(9, "ground", &[[96, 68]], &[]),
        ],
        opts(1e-5, false),
    );
    let high = |c: &Circuit| -> usize {
        let v = c.element_voltages();
        [3, 5, 7]
            .iter()
            .position(|&i| v[i] > 2.5)
            .expect("no ring output is high")
    };
    c.run(3);
    assert_eq!(high(c), 0, "fresh ring did not start on Q0");
    for expected in [1, 2, 0] {
        clock_cycle(c, 1);
        assert_eq!(high(c), expected, "high bit after the next edge");
    }
}

#[test]
fn latch_outputs_follow_while_load_is_high_and_hold_after() {
    // 2-bit level latch (FLAG_NO_EDGE = 4): transparent while the load clock
    // is high, holding the last sampled bits once it drops.
    let c = &mut build(
        vec![
            elm(
                1,
                "logicInput",
                &[[0, 32]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm(
                2,
                "logicInput",
                &[[0, 0]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm_flags(
                3,
                "latch",
                &[[0, 32], [0, 0], [96, 32], [96, 0], [0, 64]],
                &[("bits", 2.0), ("highVoltage", 5.0)],
                4,
            ),
            elm(
                4,
                "logicInput",
                &[[0, 64]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm(
                5,
                "resistor",
                &[[96, 32], [96, 132]],
                &[("resistance", 1000.0)],
            ),
            elm(6, "ground", &[[96, 132]], &[]),
            elm(
                7,
                "resistor",
                &[[96, 0], [96, 100]],
                &[("resistance", 1000.0)],
            ),
            elm(8, "ground", &[[96, 100]], &[]),
        ],
        opts(1e-5, false),
    );
    // O0 is element 4, O1 element 6; bit 0 from the I0 pin, bit 1 from I1.
    let o = |c: &Circuit| -> i64 {
        let v = c.element_voltages();
        let bit = |i: usize| if v[i] > 2.5 { 1i64 } else { 0 };
        bit(4) | (bit(6) << 1)
    };
    // I0 = I1 = 1 but load is low: nothing is sampled yet.
    c.set_state(1, 1);
    c.set_state(2, 1);
    c.run(3);
    assert_eq!(o(c), 0, "latched with load low");
    // Load high: the outputs mirror the inputs.
    c.set_state(4, 1);
    c.run(3);
    assert_eq!(o(c), 3, "did not follow while transparent");
    // Inputs drop while load stays high: the outputs follow.
    c.set_state(1, 0);
    c.set_state(2, 0);
    c.run(3);
    assert_eq!(o(c), 0, "did not follow the new inputs");
    // Load drops, then the inputs rise: the outputs hold the last sample.
    c.set_state(4, 0);
    c.set_state(1, 1);
    c.set_state(2, 1);
    c.run(3);
    assert_eq!(o(c), 0, "did not hold after load went low");
}

#[test]
fn transmission_line_step_reaches_open_far_end_after_delay() {
    // A 10 V step drives the left port through a matched 75 ohm source
    // resistor; the right port is open. After exactly one delay the far-end
    // post rises from 0 to 10 V and holds there.
    let dt = 5e-6;
    let len = 10;
    let delay = len as f64 * dt;
    let c = &mut build_with(
        vec![
            elm(
                1,
                "transmissionLine",
                &[[0, 100], [400, 100], [0, 0], [400, 0]],
                &[("delay", delay), ("imped", 75.0)],
            ),
            elm(2, "ground", &[[0, 100]], &[]),
            elm(3, "ground", &[[400, 100]], &[]),
            elm(
                4,
                "voltage",
                &[[-100, 100], [-100, 0]],
                &[("maxVoltage", 10.0)],
            ),
            elm(5, "resistor", &[[-100, 0], [0, 0]], &[("resistance", 75.0)]),
            elm(6, "ground", &[[-100, 100]], &[]),
        ],
        opts(dt, false),
        vec![tr_scope(1, ScopeValue::NodeVoltage, 3)],
    );
    c.run(len);
    assert!(
        close(last_sample(c, 0), 0.0, 1e-9),
        "far end should be 0 before the delay"
    );
    c.run(1);
    assert!(
        close(last_sample(c, 0), 10.0, 1e-3),
        "far end should reach the source value"
    );
    c.run(len);
    assert!(
        close(last_sample(c, 0), 10.0, 1e-3),
        "far end must hold after the round trip"
    );
}

#[test]
fn var_rail_feeds_its_voltage_into_a_divider() {
    let c = &mut build(
        vec![
            elm(1, "varRail", &[[0, 0]], &[("voltage", 3.0)]),
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
    assert!(close(volts[0], 3.0, 1e-9), "rail readout was {}", volts[0]);
    assert!(close(volts[2], 1.5, 1e-9), "midpoint was {}", volts[2]);
    assert!(close(amps[1], 1.5e-3, 1e-12), "current was {}", amps[1]);
    assert!(c.set_param(1, "voltage", 6.0));
    c.run(5);
    let volts = c.element_voltages();
    let amps = c.element_currents();
    assert!(close(volts[0], 6.0, 1e-9), "rail readout was {}", volts[0]);
    assert!(close(volts[2], 3.0, 1e-9), "midpoint was {}", volts[2]);
    assert!(close(amps[1], 3e-3, 1e-12), "current was {}", amps[1]);
}

#[test]
fn ext_voltage_feeds_the_divider() {
    let c = &mut build(
        vec![
            elm(1, "extVoltage", &[[0, 0]], &[("voltage", 5.0)]),
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
    assert!(
        close(volts[0], 5.0, 1e-9),
        "source readout was {}",
        volts[0]
    );
    assert!(close(volts[2], 2.5, 1e-9), "midpoint was {}", volts[2]);
    assert!(close(amps[1], 2.5e-3, 1e-12), "current was {}", amps[1]);
}

#[test]
fn sweep_with_constant_frequency_degenerates_to_ac_source() {
    let freq = 100.0;
    let dt = 1e-5;
    let c = &mut build(
        vec![
            elm(
                1,
                "sweep",
                &[[0, 100]],
                &[
                    ("minF", freq),
                    ("maxF", freq),
                    ("maxV", 5.0),
                    ("sweepTime", 0.1),
                ],
            ),
            elm(
                2,
                "resistor",
                &[[0, 100], [0, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(3, "ground", &[[0, 0]], &[]),
        ],
        opts(dt, false),
    );
    c.run(250);
    let v = c.element_voltages()[1];
    assert!(close(v, 5.0, 1e-9), "quarter-period voltage was {v}");
    c.run(500);
    let v = c.element_voltages()[1];
    assert!(close(v, -5.0, 1e-9), "three-quarter voltage was {v}");
}

#[test]
fn sweep_integrates_the_frequency_ramp_in_phase() {
    let c = &mut build(
        vec![
            elm_flags(
                1,
                "sweep",
                &[[0, 100]],
                &[
                    ("minF", 100.0),
                    ("maxF", 200.0),
                    ("maxV", 5.0),
                    ("sweepTime", 0.1),
                ],
                2, // FLAG_BIDIR
            ),
            elm(
                2,
                "resistor",
                &[[0, 100], [0, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(3, "ground", &[[0, 0]], &[]),
        ],
        opts(1e-5, false),
    );
    c.run(5000);
    let v = c.element_voltages()[1];
    assert!(close(v, 5.0, 1e-9), "mid-ramp voltage was {v}");
    c.run(5000);
    let v = c.element_voltages()[1];
    assert!(close(v, 0.0, 1e-9), "ramp-top voltage was {v}");
    c.run(5000);
    let v = c.element_voltages()[1];
    assert!(close(v, -5.0, 1e-9), "return-ramp voltage was {v}");
}

#[test]
fn audio_output_reads_its_node_voltage_and_draws_no_current() {
    let c = &mut build(
        vec![
            elm(1, "rail", &[[0, 0]], &[("maxVoltage", 5.0)]),
            elm(2, "wire", &[[0, 0], [100, 0]], &[]),
            elm(
                3,
                "audioOutput",
                &[[100, 0]],
                &[
                    ("duration", 1.0),
                    ("samplingRate", 8000.0),
                    ("labelNum", 1.0),
                ],
            ),
            elm(4, "ground", &[[200, 200]], &[]),
        ],
        opts(1e-5, true),
    );
    c.run(5);
    let volts = c.element_voltages();
    let amps = c.element_currents();
    assert!(
        close(volts[2], 5.0, 1e-9),
        "audio output read {} V, expected the rail's 5 V",
        volts[2]
    );
    assert!(
        close(amps[2], 0.0, 1e-12),
        "audio output carried {} A, expected none",
        amps[2]
    );
}

#[test]
fn timer_divider_biases_ctl_and_trigger_sets_out() {
    // The 555's internal divider stamps VCC->CTL 5000 ohm and CTL->ground
    // 10000 ohm, so CTL sits at two thirds of VCC, and pulling TRIG below
    // CTL/2 drives OUT to the rail. RST is held high, THRES tied below CTL,
    // DIS parked on ground.
    let c = &mut build(
        vec![
            elm(1, "rail", &[[64, 0]], &[("maxVoltage", 5.0)]),
            elm(2, "ground", &[[64, 288]], &[]),
            elm_flags(
                3,
                "timer",
                &[
                    [0, 96],    // 0 DIS
                    [0, 192],   // 1 TRIG
                    [0, 240],   // 2 THRES
                    [64, 0],    // 3 VCC
                    [64, 336],  // 4 CTL
                    [128, 192], // 5 OUT
                    [128, 96],  // 6 RST
                    [64, 288],  // 7 GND
                ],
                &[("highVoltage", 5.0)],
                6, // FLAG_RESET | FLAG_GROUND
            ),
            elm(4, "wire", &[[128, 96], [64, 0]], &[]), // RST to VCC
            elm(5, "wire", &[[0, 240], [64, 288]], &[]), // THRES to ground
            elm(6, "ground", &[[0, 192]], &[]),         // TRIG below CTL/2
            elm(7, "wire", &[[0, 96], [64, 288]], &[]), // DIS to ground
        ],
        opts(1e-5, false),
    );
    c.run(5);
    let nodes = c.element_nodes();
    let volts = c.node_voltages();
    // The timer is element index 2; its posts start at flattened index 2 (the
    // rail and ground before it each carry one post).
    let n_ctl = nodes[2 + 4] as usize;
    let n_out = nodes[2 + 5] as usize;
    assert!(
        close(volts[n_ctl], 5.0 * 2.0 / 3.0, 1e-6),
        "CTL was {} V, expected two thirds of VCC",
        volts[n_ctl]
    );
    assert!(
        volts[n_out] > 4.9,
        "OUT was {} V, expected the rail",
        volts[n_out]
    );
}

fn n_jfet_drain(r: f64) -> Circuit {
    build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 5.0)]),
            elm(2, "resistor", &[[0, 0], [100, 0]], &[("resistance", r)]),
            elm(
                3,
                "jfet",
                &[[200, 100], [100, 100], [100, 0]],
                &[("pnp", 1.0), ("threshold", -4.0), ("beta", 0.00125)],
            ),
            elm(4, "wire", &[[200, 100], [100, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
            elm(6, "ground", &[[100, 100]], &[]),
        ],
        opts(1e-5, true),
    )
}

#[test]
fn n_jfet_saturation_current_with_gate_tied_to_source() {
    // Gate at source voltage, vt = -4, beta = 0.00125: the depletion channel
    // conducts its full saturation current ids = .5*beta*(vgs-vt)^2 = 10 mA,
    // and the gate junction, sitting at 0 V, leaks nothing. The drain voltage
    // follows Ohm's law on the 50 ohm load: Vd = 5 - ids*R = 4.5 V.
    let c = &mut n_jfet_drain(50.0);
    let report = c.run(20);
    assert!(report.converged, "did not converge: {:?}", report.error);
    assert!(
        close(c.element_voltages()[2], 4.5, 1e-3),
        "drain was {}",
        c.element_voltages()[2]
    );
    assert!(
        close(c.element_currents()[2], 0.01, 1e-5),
        "ids was {}",
        c.element_currents()[2]
    );
}

#[test]
fn triode_plate_current_matches_its_power_law() {
    // The triode sits between two ideal sources, so its terminal voltages are
    // pinned: plate at +250 V and the grid at vg, cathode grounded. The
    // reported element current is the cathode current `ids + ig` from
    // upstream's law (TriodeElm.java:169-202): `ival = vgk + vpk/mu`,
    // `ids = pow(ival, 1.5)/kg1` above cutoff and `vpk*1e-8` below, with
    // `ig = vgk/6000` once the grid conducts. The values below are
    // hand-rounded from that law at mu = 93, kg1 = 680.
    let plate_current = |vg: f64| {
        let c = &mut build(
            vec![
                elm(1, "voltage", &[[0, 0], [0, 200]], &[("maxVoltage", 250.0)]),
                elm(2, "voltage", &[[100, 0], [100, 200]], &[("maxVoltage", vg)]),
                elm(
                    3,
                    "triode",
                    &[[0, 200], [100, 200], [100, 0]],
                    &[("mu", 93.0), ("kg1", 680.0)],
                ),
                elm(4, "ground", &[[0, 0]], &[]),
                elm(5, "ground", &[[100, 0]], &[]),
            ],
            opts_budget(1e-5, true, 100),
        );
        let report = c.run(20);
        assert!(
            report.converged,
            "triode stalled at Vg = {vg}: {:?}",
            report.failing
        );
        c.element_currents()[2]
    };

    // At Vg = 0 the tube conducts `(250/93)^1.5/680` with no grid current; at
    // Vg = 1 the grid adds its `vgk/6000` share; at Vg = -3 ival is negative,
    // so the plate collapses to the `vpk*1e-8` leak. The bias values pin the
    // same plate voltage in each build, isolating the grid's effect.
    for (vg, want) in [
        (0.0, 6.481_517_19e-3),
        (1.0, 1.058_283_15e-2),
        (-3.0, 2.5e-6),
    ] {
        assert!(
            close(plate_current(vg), want, 1e-6),
            "at Vg = {vg} the triode drew {}, expected {want}",
            plate_current(vg)
        );
    }

    // End-to-end stamp check: a 400 V supply feeds the plate through a 2380
    // ohm resistor with the grid grounded. The load line crosses the triode
    // curve exactly at Vp = 372 V, where `ids = (400-372)/2380 = 1/85` and the
    // law gives `(372/93)^1.5/680 = 4^1.5/680 = 8/680 = 1/85`. A sign error in
    // the stamped companion moves the plate voltage off this window.
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 0], [0, 400]], &[("maxVoltage", 400.0)]),
            elm(
                2,
                "resistor",
                &[[0, 400], [100, 400]],
                &[("resistance", 2380.0)],
            ),
            elm(
                3,
                "triode",
                &[[100, 400], [200, 400], [200, 0]],
                &[("mu", 93.0), ("kg1", 680.0)],
            ),
            elm(4, "ground", &[[0, 0]], &[]),
            elm(5, "ground", &[[200, 0]], &[]),
            elm(6, "ground", &[[200, 400]], &[]),
        ],
        opts_budget(1e-5, true, 200),
    );
    let report = c.run(20);
    assert!(
        report.converged,
        "load-line triode stalled: {:?}",
        report.failing
    );
    let vp = c.element_voltages()[2];
    assert!(
        close(vp, 372.0, 0.5),
        "plate voltage was {vp} V, expected ~372"
    );
    let ids = c.element_currents()[2];
    assert!(
        close(ids, 1.0 / 85.0, 1e-4),
        "plate current was {ids} A, expected ~1/85"
    );
}

#[test]
fn phase_comparator_drives_high_on_i1_edge_and_clears_on_i2_edge() {
    // A rising edge on I1 with I2 low sets the first internal flip-flop and
    // drives the output high; a later rising edge on I2 sets the second and,
    // with both set, the comparator clears and the output drops.
    let c = &mut build(
        vec![
            elm(
                1,
                "logicInput",
                &[[0, 0]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm(
                2,
                "logicInput",
                &[[0, 32]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm(
                3,
                "phaseComp",
                &[[0, 0], [0, 32], [96, 0]],
                &[("highVoltage", 5.0)],
            ),
            elm(
                4,
                "resistor",
                &[[96, 0], [96, 100]],
                &[("resistance", 1000.0)],
            ),
            elm(5, "ground", &[[96, 100]], &[]),
        ],
        opts(1e-5, false),
    );
    let out = |c: &Circuit| c.element_voltages()[3];
    c.run(3);
    assert!(close(out(c), 0.0, 1e-9), "fresh output was not low");
    c.set_state(1, 1);
    c.run(3);
    assert!(
        close(out(c), 5.0, 1e-9),
        "first edge did not drive the output high"
    );
    c.set_state(1, 0);
    c.run(3);
    assert!(
        close(out(c), 5.0, 1e-9),
        "output dropped while only ff1 was set"
    );
    c.set_state(2, 1);
    c.run(3);
    assert!(
        close(out(c), 0.0, 1e-9),
        "second edge did not clear the output"
    );
}

#[test]
fn spark_gap_fires_above_breakdown_and_latches_on() {
    // A 1500 V source through 1000 ohm and the gap: once the gap fires the
    // loop draws V/(R + r_on) = 0.75 A, and the gap holds 750 V, below the
    // 1000 V breakdown. It stays on because 0.75 A > holdcurrent.
    let dt = 1e-5;
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 1500.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(3, "sparkGap", &[[100, 0], [100, 100]], &[]),
            elm(4, "wire", &[[100, 100], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
        ],
        opts(dt, false),
    );
    c.run(3);
    let volts = c.element_voltages();
    let amps = c.element_currents();
    assert!(
        close(amps[1], 0.75, 1e-6),
        "resistor current was {}, expected 0.75 A once the gap fired",
        amps[1]
    );
    assert!(
        close(amps[2], 0.75, 1e-6),
        "gap current was {}, expected 0.75 A",
        amps[2]
    );
    assert!(
        close(volts[2], 750.0, 1e-3),
        "gap held {} V, expected 750 V below breakdown",
        volts[2]
    );
    c.run(97);
    let amps = c.element_currents();
    assert!(
        close(amps[2], 0.75, 1e-6),
        "latched gap current drifted to {} A",
        amps[2]
    );
}

#[test]
fn spark_gap_stays_off_below_breakdown() {
    // A 500 V source across the off gap is below the 1000 V breakdown, so the
    // gap keeps stamping r_off and the loop current stays at V/(R + r_off).
    let dt = 1e-5;
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 500.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(3, "sparkGap", &[[100, 0], [100, 100]], &[]),
            elm(4, "wire", &[[100, 100], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
        ],
        opts(dt, false),
    );
    c.run(5);
    let volts = c.element_voltages();
    let amps = c.element_currents();
    let expected = 500.0 / (1000.0 + 1e9);
    assert!(
        close(amps[2], expected, 1e-12),
        "off gap drew {}, expected the r_off divider current {}",
        amps[2],
        expected
    );
    assert!(
        close(volts[2], 500.0 * 1e9 / (1000.0 + 1e9), 1e-6),
        "off gap held {}, expected almost the full supply",
        volts[2]
    );
}

#[test]
fn spark_gap_clears_when_current_drops_below_holdcurrent() {
    // Fire the gap at 2000 V (loop current 1 A), then cut the source to 1 V:
    // the on-state current drops below the 1 mA holdcurrent and the gap opens.
    let dt = 1e-5;
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 2000.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(3, "sparkGap", &[[100, 0], [100, 100]], &[]),
            elm(4, "wire", &[[100, 100], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
        ],
        opts(dt, false),
    );
    c.run(3);
    let amps = c.element_currents();
    assert!(
        close(amps[2], 1.0, 1e-6),
        "expected the fired gap to draw 1 A, got {}",
        amps[2]
    );
    assert!(
        c.set_param(1, "maxVoltage", 1.0),
        "source voltage edit refused"
    );
    c.run(2);
    let amps = c.element_currents();
    let expected = 1.0 / (1000.0 + 1e9);
    assert!(
        close(amps[2], expected, 1e-12),
        "gap should have opened to the r_off current {}, got {}",
        expected,
        amps[2]
    );
}

#[test]
fn scr_blocks_until_gate_pulse_then_latches() {
    // The SCR's off state is not an open circuit: the anode path is a 10e5
    // (upstream's literal `10e5`) ohm resistor in series with the internal
    // forward-biased diode, so a 2 V supply leaks about 17.6 uA through it,
    // far below the 8.2 mA holding current, and the anode-cathode voltage
    // holds near the full supply. Driving the gate to 3 V pushes 60 mA
    // through the 50 ohm internal gate resistor, past the 10 mA trigger, and
    // the next step latches the resistor to 0.0105 ohm: the loop then draws
    // (2 - v_on)/50 with v_on ~ 0.62 V, about 27.6 mA. That anode current is
    // well above holdingI, so the latch survives the gate returning to 0 V.
    let dt = 1e-5;
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 2.0)]),
            elm(2, "resistor", &[[0, 0], [100, 0]], &[("resistance", 50.0)]),
            elm(3, "scr", &[[100, 0], [100, 200], [128, 128]], &[]),
            elm(4, "wire", &[[100, 200], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
            elm(
                6,
                "voltage",
                &[[128, 48], [128, 128]],
                &[("maxVoltage", 0.0)],
            ),
            elm(7, "ground", &[[128, 48]], &[]),
        ],
        opts_budget(dt, false, 100),
    );
    c.run(20);
    let volts = c.element_voltages();
    let amps = c.element_currents();
    assert!(
        amps[2] < 1e-4,
        "blocked SCR drew {} A, expected only the ~17.6 uA off-state leakage",
        amps[2]
    );
    assert!(
        close(volts[2], 2.0, 0.05),
        "blocked SCR held {} V, expected nearly the full 2 V supply",
        volts[2]
    );

    // Gate pulse: 3 V on the gate drives 60 mA through the internal 50 ohm
    // gate resistor, over the 10 mA trigger, so the latch fires and the
    // anode-cathode voltage drops to the diode's on-state drop.
    assert!(c.set_param(6, "maxVoltage", 3.0), "gate pulse refused");
    c.run(5);
    let volts = c.element_voltages();
    let amps = c.element_currents();
    assert!(
        close(amps[1], 0.0276, 5e-4),
        "fired SCR drew {} A through the load, expected ~27.6 mA",
        amps[1]
    );
    assert!(
        close(amps[2], 0.0276, 5e-4),
        "fired SCR anode current was {} A, expected ~27.6 mA",
        amps[2]
    );
    assert!(
        close(volts[2], 0.62, 0.05),
        "fired SCR held {} V anode-cathode, expected the ~0.62 V on drop",
        volts[2]
    );

    // Gate back to 0 V: the 27.6 mA anode current stays far above the 8.2 mA
    // holding current, so the latch must hold even with the gate current gone.
    assert!(c.set_param(6, "maxVoltage", 0.0), "gate return refused");
    c.run(5);
    let amps = c.element_currents();
    assert!(
        close(amps[1], 0.0276, 5e-4),
        "SCR unlatched after the gate went low, drew {} A",
        amps[1]
    );
    let volts = c.element_voltages();
    assert!(
        close(volts[2], 0.62, 0.05),
        "latched SCR drifted to {} V anode-cathode",
        volts[2]
    );
}

#[test]
fn diac_blocks_below_breakover_and_conducts_above() {
    // The diac's off state stamps a 1e8 ohm resistor per branch, so 20 V
    // through 1k leaves nearly the whole supply across the device and only a
    // microamp-scale leakage. 40 V exceeds the 30 V breakdown and latches the
    // 500 ohm on state; the loop then settles at the load-line fixed point
    // i = (V - vd)/1500 where vd = 2*vt*ln(i/Is + 1) is the forward drop of
    // the internal default-model diode (Is = 1.71435e-7): i = 26.25 mA and
    // the device holds 13.745 V. Dropping the supply to 10 V puts the on-state
    // current at ~6.3 mA, below the 10 mA holdcurrent, and the diac opens
    // again. A -40 V build fires the mirrored back-to-back branch and conducts
    // the same 26.25 mA in reverse, pinning the second junction's stamp signs.
    let dt = 1e-5;
    let blocking = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 20.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(3, "diac", &[[100, 0], [100, 100]], &[]),
            elm(4, "wire", &[[100, 100], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
        ],
        opts_budget(dt, false, 200),
    );
    blocking.run(5);
    let volts = blocking.element_voltages();
    let amps = blocking.element_currents();
    assert!(
        amps[2] < 1e-5,
        "blocked diac drew {} A, expected only the r_off leakage",
        amps[2]
    );
    assert!(
        close(volts[2], 20.0, 0.05),
        "blocked diac held {} V, expected nearly the full 20 V supply",
        volts[2]
    );

    let conducting = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 40.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(3, "diac", &[[100, 0], [100, 100]], &[]),
            elm(4, "wire", &[[100, 100], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
        ],
        opts_budget(dt, false, 200),
    );
    let report = conducting.run(20);
    assert!(
        report.converged,
        "diac firing stalled: {:?}",
        report.failing
    );
    let volts = conducting.element_voltages();
    let amps = conducting.element_currents();
    assert!(
        close(amps[2], 0.02625, 5e-4),
        "fired diac drew {} A, expected ~26.25 mA",
        amps[2]
    );
    assert!(
        close(volts[2], 13.745, 0.05),
        "fired diac held {} V, expected ~13.745 V",
        volts[2]
    );

    // The 26.25 mA on-state is well above the 10 mA holdcurrent, so it latches
    // until the supply drops and the current falls under the threshold.
    assert!(
        conducting.set_param(1, "maxVoltage", 10.0),
        "supply edit refused"
    );
    conducting.run(2);
    let volts = conducting.element_voltages();
    let amps = conducting.element_currents();
    assert!(
        amps[2] < 1e-5,
        "diac stayed on after the current dropped below holdcurrent, drew {} A",
        amps[2]
    );
    assert!(
        close(volts[2], 10.0, 0.05),
        "cleared diac held {} V, expected the full 10 V supply",
        volts[2]
    );

    let reversed = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", -40.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(3, "diac", &[[100, 0], [100, 100]], &[]),
            elm(4, "wire", &[[100, 100], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
        ],
        opts_budget(dt, false, 200),
    );
    let report = reversed.run(20);
    assert!(
        report.converged,
        "reverse diac firing stalled: {:?}",
        report.failing
    );
    let volts = reversed.element_voltages();
    let amps = reversed.element_currents();
    assert!(
        close(amps[2], -0.02625, 5e-4),
        "reverse-fired diac drew {} A, expected ~-26.25 mA",
        amps[2]
    );
    assert!(
        close(volts[2], -13.745, 0.05),
        "reverse-fired diac held {} V, expected ~-13.745 V",
        volts[2]
    );
}

#[test]
fn triac_blocks_both_ways_until_gate_pulse_then_latches() {
    // The triac's off state is not an open circuit: the main path is a 10e5
    // (upstream's literal `10e5`) ohm resistor in series with a back-to-back
    // diode pair, so a 2 V supply leaks about 18 uA through it (2 V across
    // the 10e5 less the small diode drop), far below the 8.2 mA holding
    // current, and the MT2-MT1 voltage holds near the full supply. The
    // antiparallel diodes block the reverse polarity the same way, which is
    // the point of a triac over an SCR. Driving the gate to 3 V pushes 30 mA
    // through the internal 100 ohm gate resistor, past the 10 mA trigger, and
    // the next step latches the resistor to 0.01 ohm: the loop then draws
    // (2 - v_on)/50 with v_on ~ 0.62 V, about 27.6 mA. That main current is
    // well above holdingI, so the latch survives the gate returning to 0 V.
    let dt = 1e-5;
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 2.0)]),
            elm(2, "resistor", &[[0, 0], [100, 0]], &[("resistance", 50.0)]),
            elm(3, "triac", &[[100, 0], [100, 200], [128, 128]], &[]),
            elm(4, "wire", &[[100, 200], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
            elm(
                6,
                "voltage",
                &[[128, 48], [128, 128]],
                &[("maxVoltage", 0.0)],
            ),
            elm(7, "ground", &[[128, 48]], &[]),
        ],
        opts_budget(dt, false, 200),
    );
    c.run(20);
    let volts = c.element_voltages();
    let amps = c.element_currents();
    assert!(
        amps[2] < 1e-4,
        "blocked triac drew {} A, expected only the ~2 uA off-state leakage",
        amps[2]
    );
    assert!(
        close(volts[2], 2.0, 0.05),
        "blocked triac held {} V, expected nearly the full 2 V supply",
        volts[2]
    );

    // Reverse the supply: the back-to-back diodes block the other polarity
    // just the same while the latch is off.
    assert!(
        c.set_param(1, "maxVoltage", -2.0),
        "reverse polarity refused"
    );
    c.run(20);
    let volts = c.element_voltages();
    let amps = c.element_currents();
    assert!(
        amps[2] < 1e-4,
        "reverse-blocked triac drew {} A, expected only leakage",
        amps[2]
    );
    assert!(
        close(volts[2], -2.0, 0.05),
        "reverse-blocked triac held {} V, expected nearly the full -2 V supply",
        volts[2]
    );

    // Back to forward polarity, then a gate pulse: 3 V on the gate drives
    // 30 mA through the internal 100 ohm gate resistor, over the 10 mA
    // trigger, so the latch fires and the MT2-MT1 voltage drops to the
    // diode's on-state drop.
    assert!(c.set_param(1, "maxVoltage", 2.0), "forward return refused");
    assert!(c.set_param(6, "maxVoltage", 3.0), "gate pulse refused");
    c.run(5);
    let volts = c.element_voltages();
    let amps = c.element_currents();
    assert!(
        close(amps[1], 0.0276, 5e-4),
        "fired triac drew {} A through the load, expected ~27.6 mA",
        amps[1]
    );
    assert!(
        close(amps[2], 0.0276, 5e-4),
        "fired triac main current was {} A, expected ~27.6 mA",
        amps[2]
    );
    assert!(
        close(volts[2], 0.62, 0.05),
        "fired triac held {} V MT2-MT1, expected the ~0.62 V on drop",
        volts[2]
    );

    // Gate back to 0 V: the 27.6 mA main current stays far above the 8.2 mA
    // holding current, so the latch must hold even with the gate current gone.
    assert!(c.set_param(6, "maxVoltage", 0.0), "gate return refused");
    c.run(5);
    let amps = c.element_currents();
    assert!(
        close(amps[1], 0.0276, 5e-4),
        "triac unlatched after the gate went low, drew {} A",
        amps[1]
    );
    let volts = c.element_voltages();
    assert!(
        close(volts[2], 0.62, 0.05),
        "latched triac drifted to {} V MT2-MT1",
        volts[2]
    );
}

#[test]
fn decimal_display_reads_its_input_bits_as_a_binary_number() {
    let c = &mut build(
        vec![
            elm(
                1,
                "logicInput",
                &[[0, 0]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 1.0)],
            ),
            elm(
                2,
                "logicInput",
                &[[0, 32]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm(
                3,
                "logicInput",
                &[[0, 64]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 1.0)],
            ),
            elm(
                4,
                "logicInput",
                &[[0, 96]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm(
                5,
                "decimalDisplay",
                &[[0, 0], [0, 32], [0, 64], [0, 96]],
                &[("bits", 4.0), ("highVoltage", 5.0)],
            ),
            elm(
                6,
                "resistor",
                &[[0, 32], [0, 132]],
                &[("resistance", 1000.0)],
            ),
            elm(7, "ground", &[[0, 132]], &[]),
        ],
        opts(1e-5, false),
    );
    c.run(3);
    // The display's value() reads the thresholded bit pattern: 0101 = 5.
    assert!(
        close(c.element_values()[4], 5.0, 1e-9),
        "display read was {}",
        c.element_values()[4]
    );
}

// The DAC output source drives `ival * Vplus / (2^bits - 1)`, where `ival` is
// the binary value of the thresholded bit inputs (DACElm.java:42-51). Element
// 7 is the load resistor from the O post to ground, so its voltage diff is the
// output. The source's do_step reads the previous solve's node voltages, so the
// output lags the inputs by one step; running a few steps settles it.
#[test]
fn dac_scales_the_bit_pattern_against_the_vplus_pin() {
    let c = &mut build(
        vec![
            elm(
                1,
                "dac",
                &[[0, 0], [0, 32], [0, 64], [0, 96], [96, 0], [96, 96]],
                &[("bits", 4.0), ("highVoltage", 5.0)],
            ),
            elm(
                2,
                "logicInput",
                &[[0, 0]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 1.0)],
            ),
            elm(
                3,
                "logicInput",
                &[[0, 32]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm(
                4,
                "logicInput",
                &[[0, 64]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 1.0)],
            ),
            elm(
                5,
                "logicInput",
                &[[0, 96]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm(6, "rail", &[[96, 96]], &[("maxVoltage", 5.0)]),
            elm(
                7,
                "resistor",
                &[[96, 0], [96, 100]],
                &[("resistance", 1000.0)],
            ),
            elm(8, "ground", &[[96, 100]], &[]),
        ],
        opts(1e-5, false),
    );
    let output = |c: &Circuit| c.element_voltages()[6];
    // D3..D0 = 0101 gives ival 5, so 5 * 5 / 15 = 1.6667 V.
    c.run(3);
    let got = output(c);
    assert!(
        close(got, 5.0 * 5.0 / 15.0, 1e-9),
        "0101 drove {got}, expected {}",
        5.0 * 5.0 / 15.0
    );
    // All bits high drives the full scale, exactly the V+ pin voltage.
    for id in 2..=5 {
        c.set_state(id, 1);
    }
    c.run(3);
    let got = output(c);
    assert!(close(got, 5.0, 1e-9), "1111 drove {got}, expected 5.0");
    // All bits low drives zero.
    for id in 2..=5 {
        c.set_state(id, 0);
    }
    c.run(3);
    let got = output(c);
    assert!(close(got, 0.0, 1e-9), "0000 drove {got}, expected 0.0");
}

#[test]
fn noise_source_across_a_resistor_is_bounded_and_finite() {
    let c = &mut build_with(
        vec![
            elm(1, "noise", &[[0, 0]], &[("maxVoltage", 5.0), ("bias", 0.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(3, "wire", &[[100, 0], [100, 100]], &[]),
            elm(4, "ground", &[[100, 100]], &[]),
        ],
        opts(1e-5, false),
        vec![ScopeSpec {
            element_id: 1,
            value: ScopeValue::Voltage,
            post: 0,
            steps_per_column: 1,
            columns: 1024,
            ac_coupled: false,
            trigger: Default::default(),
            display_width: 0,
        }],
    );
    let report = c.run(200);
    assert!(report.converged, "noise source broke Newton convergence");
    assert!(c.error().is_none(), "error: {:?}", c.error());
    let snap = c.scopes()[0].snapshot();
    assert!(
        snap.len() >= 200,
        "expected one column per step, got {}",
        snap.len()
    );
    for v in snap {
        assert!(v.is_finite(), "non-finite noise sample {v}");
        assert!(
            (-5.0..=5.0).contains(&(v as f64)),
            "noise sample {v} left [-5, 5]"
        );
    }
}

#[test]
fn seven_seg_reads_its_segment_input_bits() {
    let c = &mut build(
        vec![
            elm(
                1,
                "logicInput",
                &[[0, 0]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm(
                2,
                "logicInput",
                &[[0, 32]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm(
                3,
                "logicInput",
                &[[0, 64]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm(
                4,
                "logicInput",
                &[[0, 96]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm(
                5,
                "logicInput",
                &[[0, 128]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm(
                6,
                "logicInput",
                &[[0, 160]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm(
                7,
                "logicInput",
                &[[0, 192]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm(
                8,
                "sevenSeg",
                &[
                    [0, 0],
                    [0, 32],
                    [0, 64],
                    [0, 96],
                    [0, 128],
                    [0, 160],
                    [0, 192],
                ],
                &[
                    ("baseSegments", 7.0),
                    ("extraSegment", 0.0),
                    ("diodeDirection", 0.0),
                    ("highVoltage", 5.0),
                ],
            ),
            elm(9, "ground", &[[64, 224]], &[]),
        ],
        opts(1e-5, false),
    );
    let value = |c: &Circuit| c.element_values()[7] as i64;
    c.set_state(1, 1);
    c.run(3);
    assert_eq!(value(c), 1, "segment a alone did not read as bit 0");
    for id in 2..=6 {
        c.set_state(id, 1);
    }
    c.run(3);
    assert_eq!(value(c), 0b011_1111, "digit 0 did not read as 63");
    for id in 1..=7 {
        c.set_state(id, 0);
    }
    c.set_state(2, 1);
    c.set_state(3, 1);
    c.run(3);
    assert_eq!(value(c), 0b000_0110, "digit 1 did not read as 6");
}

#[test]
fn led_array_lights_the_cells_whose_columns_are_driven_low() {
    // A 2x2 LED array: the south columns driven by logic inputs, the west
    // rows pulled to 5 V through 1 k. Each cell is a Shockley diode from its
    // row post (anode) to its column post (cathode), so it conducts when its
    // row sits above its column (LEDArrayElm.java:93-97). A lit cell pulls
    // its row down to the diode drop, roughly 1.6 V at the 3.73-emission
    // default-led model, while the reverse cells stay dark. The value()
    // readout is the lit-cell bit pattern, bit i = the cell (ix, iy) with
    // i = iy*sizeX + ix, so column 0 low lights bits 0 and 2.
    let c = &mut build(
        vec![
            elm(
                1,
                "logicInput",
                &[[0, 0]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm(
                2,
                "logicInput",
                &[[0, 32]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 1.0)],
            ),
            elm(
                3,
                "resistor",
                &[[64, 0], [64, 100]],
                &[("resistance", 1000.0)],
            ),
            elm(
                4,
                "resistor",
                &[[64, 32], [64, 132]],
                &[("resistance", 1000.0)],
            ),
            elm(5, "rail", &[[64, 100]], &[("maxVoltage", 5.0)]),
            elm(6, "rail", &[[64, 132]], &[("maxVoltage", 5.0)]),
            elm(
                7,
                "ledArray",
                &[[0, 0], [0, 32], [64, 0], [64, 32]],
                &[("sizeX", 2.0), ("sizeY", 2.0)],
            ),
            elm(8, "ground", &[[164, 100]], &[]),
        ],
        opts(1e-5, true),
    );
    let lit = |c: &Circuit| c.element_values()[6] as i64;
    c.run(3);
    assert_eq!(lit(c), 0b0101, "column 0 low lit the wrong cells");
    // The lit cells pull the rows down to the diode drop, so the row0 feed
    // resistor reads about 5 - 1.6 = 3.4 V across it.
    let vd = c.element_voltages()[2];
    assert!((-3.5..-3.0).contains(&vd), "row0 drop was {vd}");
    // Flip the drives: column 1 low lights the cells beside column 0.
    c.set_state(1, 1);
    c.set_state(2, 0);
    c.run(3);
    assert_eq!(lit(c), 0b1010, "column 1 low lit the wrong cells");
    // Both columns high leaves every cell dark: no cell sees its row above
    // its column, the rows sit at the rail unloaded, and the feed resistors
    // carry only the Newton convergence residual (a few tens of microvolts).
    c.set_state(2, 1);
    c.run(3);
    assert_eq!(lit(c), 0, "both columns high lit a cell");
    assert!(
        close(c.element_voltages()[2], 0.0, 1e-3),
        "an unlit row should sit at the rail, got {}",
        c.element_voltages()[2]
    );
    // Both columns low lights the whole grid.
    c.set_state(1, 0);
    c.set_state(2, 0);
    c.run(3);
    assert_eq!(lit(c), 0b1111, "both columns low did not light the grid");
}

#[test]
fn adc_converts_its_analog_input_into_digital_bits() {
    // A 4-bit ADC with a 5 V reference converts `trunc(15 * V(in) / V(+))`
    // clamped to [0, 15] (ADCElm.java:42-46). Truncation is deliberate:
    // rounding would break the half-flash architecture, so 2.5 V reads 7, not
    // 8. Post order is D0..D3, In, V+ (ADCElm.java:36-39); value() reports
    // the output bits as the code, bit 0 = D0.
    let code = |c: &Circuit| c.element_values()[0] as i64;
    let adc = |vin: f64| {
        build(
            vec![
                elm(
                    1,
                    "adc",
                    &[[0, 0], [0, 32], [0, 64], [0, 96], [0, 128], [0, 160]],
                    &[("bits", 4.0), ("highVoltage", 5.0)],
                ),
                elm(2, "voltage", &[[0, 200], [0, 128]], &[("maxVoltage", vin)]),
                elm(3, "ground", &[[0, 200]], &[]),
                elm(4, "voltage", &[[0, 200], [0, 160]], &[("maxVoltage", 5.0)]),
                elm(5, "ground", &[[0, 200]], &[]),
            ],
            opts(1e-5, false),
        )
    };
    for (vin, expected) in [
        (0.0, 0),  // 15 * 0.0 / 5 = 0
        (0.5, 1),  // 15 * 0.1 = 1.5, truncated to 1
        (2.5, 7),  // 15 * 0.5 = 7.5, truncated to 7, not rounded to 8
        (3.3, 9),  // 15 * 0.66 = 9.9, truncated to 9
        (5.0, 15), // 15 * 1.0 = 15
        (8.0, 15), // over-range input clamps at 15
    ] {
        let mut c = adc(vin);
        c.run(5);
        assert_eq!(
            code(&c),
            expected,
            "V(in) = {vin} V against a 5 V reference"
        );
    }
}

#[test]
fn multiplexer_routes_the_selected_data_input_to_the_output() {
    // A 4-to-1 multiplexer (bits 2): I0 driven high, I1..I3 low. With both
    // select bits low the output mirrors I0; raising S0 picks I1, S1 alone
    // picks I2 and both pick I3, so the output tracks the level of whichever
    // input the little-endian select address names. The mux is combinational,
    // so three steps after each change settle it onto the new input.
    let c = &mut build(
        vec![
            elm(
                1,
                "logicInput",
                &[[0, 0]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 1.0)],
            ),
            elm(
                2,
                "logicInput",
                &[[0, 32]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm(
                3,
                "logicInput",
                &[[0, 64]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm(
                4,
                "logicInput",
                &[[0, 96]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm(
                5,
                "logicInput",
                &[[64, 160]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm(
                6,
                "logicInput",
                &[[96, 160]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm(
                7,
                "multiplexer",
                &[
                    [0, 0],
                    [0, 32],
                    [0, 64],
                    [0, 96],
                    [64, 160],
                    [96, 160],
                    [128, 0],
                ],
                &[("bits", 2.0), ("highVoltage", 5.0)],
            ),
            elm(
                8,
                "resistor",
                &[[128, 0], [128, 100]],
                &[("resistance", 1000.0)],
            ),
            elm(9, "ground", &[[128, 100]], &[]),
        ],
        opts(1e-5, false),
    );
    // The mux readout reports the Q level as 0 V or 5 V.
    let out = |c: &Circuit| -> f64 { c.element_values()[6] };
    c.run(3);
    assert!(
        close(out(c), 5.0, 1e-9),
        "select 00 did not route I0, read {}",
        out(c)
    );
    c.set_state(5, 1); // select 01: I1, still low
    c.run(3);
    assert!(
        close(out(c), 0.0, 1e-9),
        "select 01 did not route I1, read {}",
        out(c)
    );
    c.set_state(2, 1); // I1 goes high
    c.run(3);
    assert!(
        close(out(c), 5.0, 1e-9),
        "I1 rising did not reach the output, read {}",
        out(c)
    );
    c.set_state(5, 0);
    c.set_state(6, 1); // select 10: I2, still low
    c.run(3);
    assert!(
        close(out(c), 0.0, 1e-9),
        "select 10 did not route I2, read {}",
        out(c)
    );
    c.set_state(3, 1); // I2 goes high
    c.run(3);
    assert!(
        close(out(c), 5.0, 1e-9),
        "I2 rising did not reach the output, read {}",
        out(c)
    );
    c.set_state(5, 1); // S0 rises on top of the high S1: select 11 picks I3, still low
    c.run(3);
    assert!(
        close(out(c), 0.0, 1e-9),
        "select 11 did not route I3, read {}",
        out(c)
    );
    c.set_state(4, 1); // I3 goes high
    c.run(3);
    assert!(
        close(out(c), 5.0, 1e-9),
        "I3 rising did not reach the output, read {}",
        out(c)
    );
}

#[test]
fn demultiplexer_routes_the_data_bit_to_the_selected_output() {
    // 2 select bits and a 5 V data input: exactly the selected output reads
    // high, the idle outputs stay low, and re-selecting moves the high output.
    // Post order of the demux: Q0..Q3 on the east, S0 and S1 on the south,
    // the data input on the west, so the resistor voltages at element indices
    // 4, 6, 8, 10 are the Q0..Q3 node levels.
    let o = |c: &Circuit| -> i64 {
        let v = c.element_voltages();
        let bit = |i: usize| if v[i] > 2.5 { 1i64 } else { 0 };
        bit(4) | (bit(6) << 1) | (bit(8) << 2) | (bit(10) << 3)
    };
    let c = &mut build(
        vec![
            elm(
                1,
                "logicInput",
                &[[0, 0]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 1.0)],
            ),
            elm(
                2,
                "logicInput",
                &[[32, 160]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm(
                3,
                "logicInput",
                &[[64, 160]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm(
                4,
                "deMultiplexer",
                &[
                    [128, 0],
                    [128, 32],
                    [128, 64],
                    [128, 96],
                    [32, 160],
                    [64, 160],
                    [0, 0],
                ],
                &[("selectBits", 2.0), ("highVoltage", 5.0)],
            ),
            elm(
                5,
                "resistor",
                &[[128, 0], [128, 80]],
                &[("resistance", 1000.0)],
            ),
            elm(6, "ground", &[[128, 80]], &[]),
            elm(
                7,
                "resistor",
                &[[128, 32], [128, 112]],
                &[("resistance", 1000.0)],
            ),
            elm(8, "ground", &[[128, 112]], &[]),
            elm(
                9,
                "resistor",
                &[[128, 64], [128, 144]],
                &[("resistance", 1000.0)],
            ),
            elm(10, "ground", &[[128, 144]], &[]),
            elm(
                11,
                "resistor",
                &[[128, 96], [128, 176]],
                &[("resistance", 1000.0)],
            ),
            elm(12, "ground", &[[128, 176]], &[]),
        ],
        opts(1e-5, false),
    );
    c.run(3);
    assert_eq!(o(c), 1, "select 0 did not route the data to Q0");
    c.set_state(2, 1); // S0 high -> select 1
    c.run(3);
    assert_eq!(o(c), 2, "select 1 did not route the data to Q1");
    c.set_state(3, 1); // S1 high -> select 3
    c.run(3);
    assert_eq!(o(c), 8, "select 3 did not route the data to Q3");
    c.set_state(2, 0); // S0 low -> select 2
    c.run(3);
    assert_eq!(o(c), 4, "select 2 did not route the data to Q2");

    // FLAG_INVERT_OUTPUTS (16) idles the inactive outputs high, the 74139
    // rule. With the data input low and select 0 only Q0 reads low; moving
    // the select drops exactly the new output and the old one idles high.
    let c = &mut build(
        vec![
            elm(
                1,
                "logicInput",
                &[[0, 0]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm(
                2,
                "logicInput",
                &[[32, 160]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm(
                3,
                "logicInput",
                &[[64, 160]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm_flags(
                4,
                "deMultiplexer",
                &[
                    [128, 0],
                    [128, 32],
                    [128, 64],
                    [128, 96],
                    [32, 160],
                    [64, 160],
                    [0, 0],
                ],
                &[("selectBits", 2.0), ("highVoltage", 5.0)],
                16,
            ),
            elm(
                5,
                "resistor",
                &[[128, 0], [128, 80]],
                &[("resistance", 1000.0)],
            ),
            elm(6, "ground", &[[128, 80]], &[]),
            elm(
                7,
                "resistor",
                &[[128, 32], [128, 112]],
                &[("resistance", 1000.0)],
            ),
            elm(8, "ground", &[[128, 112]], &[]),
            elm(
                9,
                "resistor",
                &[[128, 64], [128, 144]],
                &[("resistance", 1000.0)],
            ),
            elm(10, "ground", &[[128, 144]], &[]),
            elm(
                11,
                "resistor",
                &[[128, 96], [128, 176]],
                &[("resistance", 1000.0)],
            ),
            elm(12, "ground", &[[128, 176]], &[]),
        ],
        opts(1e-5, false),
    );
    c.run(3);
    assert_eq!(o(c), 0b1110, "inverted select 0 did not idle Q1..Q3 high");
    c.set_state(2, 1); // S0 high -> select 1
    c.run(3);
    assert_eq!(
        o(c),
        0b1101,
        "inverted select 1 did not move the low output"
    );
}

// The VCO mirrors the currents through its external R1 and R2 resistors into
// the capacitor across the C pins. With Vi = 5 V and R1 = R2 = 10k both to
// ground, the mirror current is Vi/R1 + 5/R2 = 1 mA, and the cap voltage
// integrates it, so a half-cycle swings the 4 V between the 0.5 V and 4.5 V
// comparator levels at 1 mA / 1e-7 F = 1e4 V/s: 0.4 ms, which is 40 steps at
// dt = 1e-5. Each crossing adds one or two steps of comparator dead time (the
// threshold check reads the previous step's cap voltage) and the internal 1 M
// bleeder slows the charge a couple of percent, so consecutive 2.5 V
// crossings of the output land about 41 to 43 steps apart. The output itself
// is a 0 V / 5 V source, so the sampled node swings between the two rails.
//
// The load resistor at the Vo pin is only there so the scope has a two-pin
// element to plot: its voltage diff is the Vo node voltage itself.
#[test]
fn vco_output_oscillates_at_the_control_frequency() {
    let dt = 1e-5;
    let c = &mut build_with(
        vec![
            elm(
                1,
                "vco",
                &[[0, 0], [0, 96], [48, 0], [48, 32], [48, 64], [48, 96]],
                &[],
            ),
            elm(2, "voltage", &[[0, 64], [0, 0]], &[("maxVoltage", 5.0)]),
            elm(3, "ground", &[[0, 64]], &[]),
            elm(
                4,
                "resistor",
                &[[48, 64], [48, 128]],
                &[("resistance", 10000.0)],
            ),
            elm(5, "ground", &[[48, 128]], &[]),
            elm(
                6,
                "resistor",
                &[[48, 96], [48, 160]],
                &[("resistance", 10000.0)],
            ),
            elm(7, "ground", &[[48, 160]], &[]),
            elm(
                8,
                "capacitor",
                &[[48, 0], [48, 32]],
                &[("capacitance", 1e-7), ("voltDiff", 0.0)],
            ),
            elm(
                9,
                "resistor",
                &[[0, 96], [0, 160]],
                &[("resistance", 1000.0)],
            ),
            elm(10, "ground", &[[0, 160]], &[]),
        ],
        opts(dt, false),
        vec![ScopeSpec {
            element_id: 9,
            value: ScopeValue::Voltage,
            post: 0,
            steps_per_column: 1,
            columns: 1024,
            ac_coupled: false,
            trigger: Default::default(),
            display_width: 0,
        }],
    );
    let report = c.run(800);
    assert!(
        report.converged,
        "VCO broke Newton convergence: {:?}",
        report.failing
    );
    let snap = c.scopes()[0].snapshot();
    assert!(
        snap.len() >= 1600,
        "expected a min/max column per step, got {}",
        snap.len()
    );
    // The output source drives 0 V and 5 V exactly, so the swing must reach
    // both rails and cross 2.5 V about once per half-cycle.
    let max = snap.iter().copied().fold(f32::MIN, f32::max);
    let min = snap.iter().copied().fold(f32::MAX, f32::min);
    assert!(max > 4.9, "output never reached the high rail, max {max}");
    assert!(min < 0.1, "output never reached the low rail, min {min}");
    let crossings = vco_crossing_steps(&snap);
    assert!(
        crossings.len() >= 10,
        "output did not oscillate, {} crossings in 800 steps",
        crossings.len()
    );
    // The mean gap between crossings is the half-period. The first gap spans
    // the startup ramp (the cap starts at 0 V, not at the 0.5 V comparator
    // level), so it is dropped.
    let gaps: Vec<usize> = crossings.windows(2).map(|w| w[1] - w[0]).skip(1).collect();
    let mean_gap = gaps.iter().sum::<usize>() as f64 / gaps.len() as f64;
    assert!(
        (40.0..=44.0).contains(&mean_gap),
        "mean output half-period was {mean_gap} steps, expected ~40 at 1250 Hz"
    );
}

/// The step indices where the output crosses the 2.5 V mid level, a rising or
/// falling edge. The snapshot interleaves a min/max column per step, so a
/// crossing is detected at the boundary between two steps' samples and its
/// index halves to the step number.
fn vco_crossing_steps(snap: &[f32]) -> Vec<usize> {
    let mut out = Vec::new();
    for i in 1..snap.len() {
        if (snap[i - 1] < 2.5) != (snap[i] < 2.5) {
            out.push(i / 2);
        }
    }
    out
}

// A scope element has zero posts and no electrical presence, so adding one to
// a circuit must leave every node voltage exactly as it was. The divider below
// is built twice, once with a scope and once without, and both must land on
// the hand-computed midpoint of half the supply. The scope is appended last so
// the divider's element indices stay the same in both circuits.
#[test]
fn scope_changes_no_node_voltage() {
    let build_divider = |with_scope: bool| {
        let mut elements = vec![
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
        ];
        if with_scope {
            elements.push(elm(6, "scope", &[], &[]));
        }
        elements
    };

    let plain = &mut build(build_divider(false), opts(1e-5, true));
    plain.run(5);
    let with_scope = &mut build(build_divider(true), opts(1e-5, true));
    with_scope.run(5);

    let plain_mid = plain.element_voltages()[2];
    let scope_mid = with_scope.element_voltages()[2];
    assert!(
        (plain_mid - 5.0).abs() <= 1e-9,
        "plain divider midpoint was {}",
        plain_mid
    );
    assert!(
        (scope_mid - 5.0).abs() <= 1e-9,
        "divider midpoint with scope was {}",
        scope_mid
    );
    // The scope itself reads and draws no current, and it sits at element
    // index 5 in the with-scope circuit.
    let with_scope_volts = with_scope.element_voltages();
    let with_scope_amps = with_scope.element_currents();
    assert!(
        with_scope_volts[5] == 0.0 && with_scope_amps[5] == 0.0,
        "scope element reported volts {} amps {}",
        with_scope_volts[5],
        with_scope_amps[5]
    );
}

#[test]
fn ammeter_reads_the_series_current_without_loading() {
    // The ammeter is a zero-volt source in series (AmmeterElm.java:211-213),
    // so it must not disturb the loop it measures: a 10 V source through a
    // 2 k resistor reads exactly 5 mA through the meter, positive entering
    // its post 0, and the resistor agrees.
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 10.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 2000.0)],
            ),
            elm(3, "ammeter", &[[100, 0], [100, 100]], &[]),
            elm(4, "wire", &[[100, 100], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
        ],
        opts(1e-5, false),
    );
    c.run(5);
    assert!(
        close(c.element_currents()[1], 5e-3, 1e-12),
        "resistor current was {}",
        c.element_currents()[1]
    );
    assert!(
        close(c.element_currents()[2], 5e-3, 1e-12),
        "ammeter current was {}",
        c.element_currents()[2]
    );
    assert!(
        close(c.element_values()[2], 5e-3, 1e-12),
        "ammeter reading was {}",
        c.element_values()[2]
    );
}

#[test]
fn line_decoration_leaves_the_circuit_unchanged() {
    // A line is pure decoration (LineElm.java): upstream declares no posts
    // (GraphicElm.java:35), so adding one must not shift the divider by so
    // much as a volt.
    let divider = |with_line: bool| {
        let mut elements = vec![
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
        ];
        if with_line {
            // A line carries no posts, so its endpoints merge nothing and it
            // stamps nothing: the divider's matrix is unchanged.
            elements.push(elm(6, "line", &[], &[]));
        }
        elements
    };

    let plain = &mut build(divider(false), opts(1e-5, true));
    let decorated = &mut build(divider(true), opts(1e-5, true));
    plain.run(5);
    decorated.run(5);

    let plain_v = plain.element_voltages();
    let decorated_v = decorated.element_voltages();
    assert!(
        close(plain_v[2], 5.0, 1e-9),
        "plain midpoint was {}",
        plain_v[2]
    );
    assert!(
        close(decorated_v[2], 5.0, 1e-9),
        "decorated midpoint was {}",
        decorated_v[2]
    );
    assert!(
        close(decorated_v[2], plain_v[2], 1e-12),
        "the line moved the midpoint by {}",
        decorated_v[2] - plain_v[2]
    );
}

#[test]
fn box_does_not_perturb_the_divider() {
    // The box is a pure decoration: zero posts, no current path, nothing
    // stamped into the matrix. A circuit must solve identically with one
    // drawn on top, which pins the model to a true shell rather than a
    // device that quietly couples or loads its corners.
    let divider = || {
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
        ]
    };
    let plain = &mut build(divider(), opts(1e-5, true));
    plain.run(5);
    let v_plain = plain.element_voltages()[2];

    let mut with_box = divider();
    with_box.push(elm(6, "box", &[], &[]));
    let decorated = &mut build(with_box, opts(1e-5, true));
    decorated.run(5);
    let v_decorated = decorated.element_voltages()[2];

    assert!(close(v_plain, 5.0, 1e-9), "midpoint was {}", v_plain);
    assert!(
        close(v_decorated, v_plain, 1e-9),
        "the box moved the midpoint from {} to {}",
        v_plain,
        v_decorated,
    );
}

#[test]
fn antenna_across_a_resistor_is_bounded_and_finite() {
    let c = &mut build_with(
        vec![
            elm(1, "antenna", &[[0, 0]], &[]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(3, "wire", &[[100, 0], [100, 100]], &[]),
            elm(4, "ground", &[[100, 100]], &[]),
        ],
        opts(1e-5, false),
        vec![ScopeSpec {
            element_id: 1,
            value: ScopeValue::Voltage,
            post: 0,
            steps_per_column: 1,
            columns: 1024,
            ac_coupled: false,
            trigger: Default::default(),
            display_width: 0,
        }],
    );
    let report = c.run(2000);
    assert!(report.converged, "antenna broke Newton convergence");
    assert!(c.error().is_none(), "error: {:?}", c.error());
    let snap = c.scopes()[0].snapshot();
    assert!(
        snap.len() >= 1024,
        "expected a full scope ring, got {}",
        snap.len()
    );
    // The antenna is an ideal source to ground across a plain resistor, so the
    // node reads the injected value exactly. Each AM carrier is bounded by
    // 3*(1.3+1)*3 = 6.9 V and the FM term by 3 V, so the value never leaves
    // [-23.7, 23.7]; 30 keeps a comfortable headroom while still catching a
    // 2x amplitude or a stamping sign error.
    for v in snap {
        assert!(v.is_finite(), "non-finite antenna sample {v}");
        assert!(
            (-30.0..=30.0).contains(&(v as f64)),
            "antenna sample {v} left [-30, 30]"
        );
    }
}

#[test]
fn cc2_positive_gain_conveys_voltage_and_current() {
    // CCII+ (gain +1): X follows Y and the Z current equals the X current.
    // Y is driven to 1 V, X loaded with 1 k to ground and Z with 1 k to
    // ground, so V(X) = V(Y) = 1 V and V(Z) = 1 V, with 1 mA in both loads.
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 1.0)]),
            elm(2, "wire", &[[0, 0], [50, 200]], &[]),
            // Posts: X (output), Y (input), Z (current output).
            elm(
                3,
                "cc2",
                &[[50, 0], [50, 200], [150, 100]],
                &[("gain", 1.0)],
            ),
            elm(
                4,
                "resistor",
                &[[50, 0], [50, 300]],
                &[("resistance", 1000.0)],
            ),
            elm(
                5,
                "resistor",
                &[[150, 100], [150, 300]],
                &[("resistance", 1000.0)],
            ),
            elm(6, "ground", &[[50, 300]], &[]),
            elm(7, "ground", &[[150, 300]], &[]),
            elm(8, "ground", &[[0, 100]], &[]),
        ],
        opts(1e-5, true),
    );
    let report = c.run(20);
    assert!(report.converged, "did not converge: {:?}", report.error);
    let nodes = c.element_nodes();
    let v = c.node_voltages();
    // The cc2 is element index 2; its three posts start at flattened index
    // 2*2 = 4.
    let (nx, ny, nz) = (nodes[4] as usize, nodes[5] as usize, nodes[6] as usize);
    assert!(
        close(v[nx], 1.0, 1e-6) && close(v[ny], 1.0, 1e-6),
        "X/Y were {}/{}, expected 1 V",
        v[nx],
        v[ny]
    );
    assert!(close(v[nz], 1.0, 1e-6), "Z was {}, expected 1 V", v[nz]);
    let cur = c.element_currents();
    // The X-load and Z-load resistors (elements 4 and 5) both carry 1 mA.
    assert!(
        close(cur[3], 1e-3, 1e-6) && close(cur[4], 1e-3, 1e-6),
        "load currents were {}/{} A, expected 1 mA",
        cur[3],
        cur[4]
    );
}

#[test]
fn cc2_negative_gain_inverts_current() {
    // CCII- (gain -1): X still follows Y but the Z current is negated, so the
    // Z load reads -1 mA while the X load reads +1 mA.
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 1.0)]),
            elm(2, "wire", &[[0, 0], [50, 200]], &[]),
            elm(
                3,
                "cc2",
                &[[50, 0], [50, 200], [150, 100]],
                &[("gain", -1.0)],
            ),
            elm(
                4,
                "resistor",
                &[[50, 0], [50, 300]],
                &[("resistance", 1000.0)],
            ),
            elm(
                5,
                "resistor",
                &[[150, 100], [150, 300]],
                &[("resistance", 1000.0)],
            ),
            elm(6, "ground", &[[50, 300]], &[]),
            elm(7, "ground", &[[150, 300]], &[]),
            elm(8, "ground", &[[0, 100]], &[]),
        ],
        opts(1e-5, true),
    );
    let report = c.run(20);
    assert!(report.converged, "did not converge: {:?}", report.error);
    let nodes = c.element_nodes();
    let v = c.node_voltages();
    let (nx, _ny, nz) = (nodes[4] as usize, nodes[5] as usize, nodes[6] as usize);
    assert!(close(v[nx], 1.0, 1e-6), "X was {}, expected 1 V", v[nx]);
    // V(Z) = gain * V(X) = -1 V.
    assert!(close(v[nz], -1.0, 1e-6), "Z was {}, expected -1 V", v[nz]);
    let cur = c.element_currents();
    assert!(
        close(cur[3], 1e-3, 1e-6),
        "X load current was {}, expected +1 mA",
        cur[3]
    );
    assert!(
        close(cur[4], -1e-3, 1e-6),
        "Z load current was {}, expected -1 mA",
        cur[4]
    );
}

#[test]
fn vcvs_expression_drives_the_output() {
    // 212 with one input: V(V+) - V(V-) = expr(a). A 1 V input and expr
    // "2*a" put 2 V across the output pair, which a 1 k load sees as 2 mA.
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 1.0)]),
            elm(2, "wire", &[[0, 0], [50, 0]], &[]),
            // Posts: input A, V+, V-.
            elm_expr(3, "vcvs", &[[50, 0], [150, 100], [150, 200]], 1.0, "2*a"),
            elm(4, "wire", &[[150, 200], [150, 300]], &[]),
            elm(
                5,
                "resistor",
                &[[150, 100], [150, 300]],
                &[("resistance", 1000.0)],
            ),
            elm(6, "ground", &[[150, 300]], &[]),
            elm(7, "ground", &[[0, 100]], &[]),
        ],
        opts(1e-5, true),
    );
    let report = c.run(20);
    assert!(report.converged, "did not converge: {:?}", report.error);
    let nodes = c.element_nodes();
    let v = c.node_voltages();
    // The vcvs is element index 2; posts start at flattened index 2*2 = 4.
    let (vp, vn) = (nodes[4 + 1] as usize, nodes[4 + 2] as usize);
    assert!(
        close(v[vp] - v[vn], 2.0, 1e-6),
        "output was {}/{}, expected 2 V",
        v[vp],
        v[vn]
    );
    assert!(
        close(c.element_currents()[4], 2e-3, 1e-6),
        "load current was {}, expected 2 mA",
        c.element_currents()[4]
    );
}

#[test]
fn vcvs_two_input_linear_map() {
    // 212 with two inputs: expr "a+b" with A = 1 V and B = 0.5 V drives the
    // output to 1.5 V.
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 1.0)]),
            elm(2, "ground", &[[0, 100]], &[]),
            elm(3, "wire", &[[0, 0], [50, 0]], &[]),
            elm(4, "voltage", &[[0, 300], [0, 200]], &[("maxVoltage", 0.5)]),
            elm(5, "ground", &[[0, 300]], &[]),
            elm(6, "wire", &[[0, 200], [50, 200]], &[]),
            // Posts: input A, input B, V+, V-.
            elm_expr(
                7,
                "vcvs",
                &[[50, 0], [50, 200], [150, 100], [150, 300]],
                2.0,
                "a+b",
            ),
            elm(
                8,
                "resistor",
                &[[150, 100], [150, 400]],
                &[("resistance", 1000.0)],
            ),
            elm(9, "wire", &[[150, 300], [150, 400]], &[]),
            elm(10, "ground", &[[150, 400]], &[]),
        ],
        opts(1e-5, true),
    );
    let report = c.run(20);
    assert!(report.converged, "did not converge: {:?}", report.error);
    let nodes = c.element_nodes();
    let v = c.node_voltages();
    // The vcvs is element index 6; posts start at flattened index
    // 2 + 1 + 2 + 2 + 1 + 2 = 10.
    let (vp, vn) = (nodes[10 + 2] as usize, nodes[10 + 3] as usize);
    assert!(
        close(v[vp] - v[vn], 1.5, 1e-6),
        "output was {}/{}, expected 1.5 V",
        v[vp],
        v[vn]
    );
}

#[test]
fn vccs_expression_current_into_load() {
    // 213 with one input: the output current is expr(a). A 5 V input and expr
    // "0.001*a" push 5 mA through a 1 k load, so V(C+) = 5 V.
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 5.0)]),
            elm(2, "wire", &[[0, 0], [50, 0]], &[]),
            // Posts: input A, C+, C-.
            elm_expr(
                3,
                "vccs",
                &[[50, 0], [150, 100], [150, 200]],
                1.0,
                "0.001*a",
            ),
            elm(
                4,
                "resistor",
                &[[150, 100], [150, 300]],
                &[("resistance", 1000.0)],
            ),
            elm(5, "wire", &[[150, 200], [150, 300]], &[]),
            elm(6, "ground", &[[150, 300]], &[]),
            elm(7, "ground", &[[0, 100]], &[]),
        ],
        opts(1e-5, true),
    );
    let report = c.run(20);
    assert!(report.converged, "did not converge: {:?}", report.error);
    let nodes = c.element_nodes();
    let v = c.node_voltages();
    // The vccs is element index 2; posts start at flattened index 2*2 = 4.
    let (vc, _vm) = (nodes[4 + 1] as usize, nodes[4 + 2] as usize);
    assert!(
        close(v[vc], 5.0, 1e-4),
        "C+ was {}, expected 5 V across the 1 k load",
        v[vc]
    );
    assert!(
        close(c.element_currents()[3], 5e-3, 1e-5),
        "load current was {}, expected 5 mA",
        c.element_currents()[3]
    );
}

#[test]
fn vccs_with_no_dc_path_reports_zero_current() {
    // A vccs whose output pair has no DC path (C- hangs off a capacitor) is
    // marked broken like an independent current source: it stamps a 1e8 ohm
    // resistor and reports zero current, so every node stays near ground.
    let c = &mut build(
        vec![
            elm_expr(1, "vccs", &[[0, 0], [100, 0], [100, 100]], 1.0, "0.001*a"),
            elm(2, "capacitor", &[[100, 100], [200, 100]], &[]),
            elm(3, "ground", &[[200, 100]], &[]),
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
        "broken vccs reported {} A",
        c.element_currents()[0]
    );
}

#[test]
fn unijunction_fires_when_the_emitter_is_driven_high() {
    // The UJT's internal CCVS makes V(node6) = 1000 * I(emitter) and the VCCS
    // feedback is what fires the emitter-to-B1 path. B2 sits on a 10 V rail
    // and B1 on a 100 ohm load: with E held at 0 V the device is off (B1 near
    // ground, no emitter current), and once E is driven above the peak point
    // (about 6.6 V here) the emitter conducts and B1 is pulled up by the
    // E-B1 current. This asserts the static operating point rather than a full
    // relaxation oscillation, which needs the adaptive timestep upstream turns
    // on for this element (UnijunctionElm.java:46) and is hard to pin
    // analytically. The fired operating point needs the gmin ramps room to
    // climb, so its Newton budget is the app's default 1000, not the test
    // helper's 100.
    let off = &mut build(
        vec![
            elm(1, "voltage", &[[0, 200], [0, 0]], &[("maxVoltage", 0.0)]),
            elm(2, "wire", &[[0, 0], [100, 0]], &[]),
            // Posts: emitter E, base-one B1, base-two B2.
            elm(3, "unijunction", &[[100, 0], [100, 300], [100, 500]], &[]),
            elm(
                4,
                "resistor",
                &[[100, 300], [100, 400]],
                &[("resistance", 100.0)],
            ),
            elm(5, "ground", &[[100, 400]], &[]),
            elm(6, "rail", &[[300, 500]], &[("maxVoltage", 10.0)]),
            elm(7, "wire", &[[300, 500], [100, 500]], &[]),
            elm(8, "ground", &[[0, 200]], &[]),
        ],
        opts(1e-5, true),
    );
    let report = off.run(10);
    assert!(report.converged, "did not converge: {:?}", report.error);
    let v = off.node_voltages();
    // The unijunction is element index 2; its three posts start at flattened
    // index 2 + 2 = 4.
    let nb1 = off.element_nodes()[4 + 1] as usize;
    let ie = off.element_currents()[0];
    assert!(
        v[nb1] < 0.5,
        "not-fired B1 was {} V, expected near ground",
        v[nb1]
    );
    assert!(
        ie.abs() < 1e-4,
        "not-fired emitter current was {} A, expected near zero",
        ie
    );

    // The same circuit with E driven above the peak point fires: B1 is pulled
    // up to a few volts and the emitter conducts tens of milliamps.
    let fired = &mut build(
        vec![
            elm(1, "voltage", &[[0, 200], [0, 0]], &[("maxVoltage", 8.0)]),
            elm(2, "wire", &[[0, 0], [100, 0]], &[]),
            elm(3, "unijunction", &[[100, 0], [100, 300], [100, 500]], &[]),
            elm(
                4,
                "resistor",
                &[[100, 300], [100, 400]],
                &[("resistance", 100.0)],
            ),
            elm(5, "ground", &[[100, 400]], &[]),
            elm(6, "rail", &[[300, 500]], &[("maxVoltage", 10.0)]),
            elm(7, "wire", &[[300, 500], [100, 500]], &[]),
            elm(8, "ground", &[[0, 200]], &[]),
        ],
        opts_budget(1e-5, true, 1000),
    );
    let report = fired.run(10);
    assert!(
        report.converged,
        "fired circuit did not converge: {:?}",
        report.error
    );
    let v = fired.node_voltages();
    let nb1 = fired.element_nodes()[4 + 1] as usize;
    let ie = fired.element_currents()[0];
    assert!(
        v[nb1] > 2.0,
        "fired B1 was {} V, expected the E-B1 path pulled up",
        v[nb1]
    );
    assert!(
        ie > 1e-2,
        "fired emitter current was {} A, expected tens of milliamps",
        ie
    );
}

// ─── Composite elements and the OTA (Milestone B subcircuits) ───

/// A generic composite built from a model string, for exercising the
/// delegation and node-remapping machinery without the OTA's transistor
/// network. `external` picks which model nodes are the composite's posts, and
/// `dumps` are the `_`-joined child dump tokens (flags first, then the child
/// kind's field values).
fn elm_composite(
    id: u32,
    posts: &[[i32; 2]],
    model: &str,
    external: &[usize],
    dumps: &[&str],
) -> ElementSpec {
    let m = serde_json::json!({
        "model": model,
        "external": external,
        "dumps": dumps,
    });
    ElementSpec {
        id,
        kind: "composite".into(),
        posts: posts.to_vec(),
        params: HashMap::new(),
        label: None,
        model: Some(m.to_string()),
        flags: 0,
    }
}

/// An OTA whose child dump tokens come from a saved 402 line (the corpus
/// `_`-joined form), carried to the engine in the `spec.model` string slot.
fn elm_ota(id: u32, posts: &[[i32; 2]], tokens: &[&str], params: &[(&str, f64)]) -> ElementSpec {
    ElementSpec {
        id,
        kind: "ota".into(),
        posts: posts.to_vec(),
        params: params
            .iter()
            .map(|(k, v)| (k.to_string(), *v))
            .collect::<HashMap<_, _>>(),
        label: None,
        model: Some(serde_json::to_string(tokens).unwrap()),
        flags: 0,
    }
}

#[test]
fn composite_resistor_divider_splits_the_supply() {
    // Two 1k resistors in series between the composite's two posts, the
    // midpoint its single internal node. The delegation and node remapping
    // must make it behave exactly like the plain divider: post 0 at 10 V,
    // post 1 grounded, the internal midpoint at 5 V, 10 mA total.
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 200], [0, 0]], &[("maxVoltage", 10.0)]),
            elm_composite(
                2,
                &[[0, 0], [300, 0]],
                "ResistorElm 1 2\rResistorElm 2 3",
                &[1, 3],
                &["0_1000", "0_1000"],
            ),
            elm(3, "ground", &[[300, 0]], &[]),
            elm(4, "ground", &[[0, 200]], &[]),
        ],
        opts(1e-5, true),
    );
    let report = c.run(20);
    assert!(report.converged, "did not converge: {:?}", report.error);
    let v = c.node_voltages();
    // The midpoint is the composite's one internal node, which `assign_nodes`
    // hands out after the four terminals. The composite reports no internal
    // connectivity (upstream's `getConnection` returns false), so the
    // floating-node walk pins the midpoint with GMIN; a 100 M load across the
    // 1k divider shifts it by 25 uV, well inside the 1 mV asserted here.
    assert!(close(v[2], 5.0, 1e-3), "midpoint was {}", v[2]);
    assert!(
        close(c.element_voltages()[1], 10.0, 1e-6),
        "post drop was {}",
        c.element_voltages()[1]
    );
    assert!(
        close(c.element_currents()[1], 1e-2, 1e-6),
        "divider current was {}",
        c.element_currents()[1]
    );
}

#[test]
fn composite_rail_drives_its_post_through_its_vs_row() {
    // A composite whose only child is a rail exercises the voltage-source
    // path: the child's source must stamp into the composite's own vs_base
    // row, and the composite's single post must read the rail voltage. The
    // 1k load draws 5 mA, which the aggregate current must report.
    let c = &mut build(
        vec![
            elm_composite(1, &[[100, 0]], "RailElm 1", &[1], &["0_0_40_5_0_0_0.5"]),
            elm(
                2,
                "resistor",
                &[[100, 0], [100, 100]],
                &[("resistance", 1000.0)],
            ),
            elm(3, "ground", &[[100, 100]], &[]),
        ],
        opts(1e-5, true),
    );
    let report = c.run(20);
    assert!(report.converged, "did not converge: {:?}", report.error);
    assert!(
        close(c.element_voltages()[0], 5.0, 1e-3),
        "post voltage was {}",
        c.element_voltages()[0]
    );
    assert!(
        close(c.element_currents()[0], 5e-3, 1e-6),
        "rail current was {}",
        c.element_currents()[0]
    );
}

#[test]
fn composite_with_a_transistor_child_reports_nonlinear() {
    // A composite whose model contains a transistor is nonlinear, which the
    // circuit learns through the composite so the Newton loop refactors each
    // iteration. The flag must not leak out of a pure-resistor composite.
    let with_transistor = circuit_core::elements::composite::Composite::from_model(
        "NTransistorElm 1 2 3",
        &[1, 3],
        None,
        "composite",
    );
    assert!(
        with_transistor.nonlinear(),
        "transistor composite was linear"
    );
    assert_eq!(with_transistor.voltage_source_count(), 0);
    let divider = circuit_core::elements::composite::Composite::from_model(
        "ResistorElm 1 2\rResistorElm 2 3",
        &[1, 3],
        None,
        "composite",
    );
    assert!(!divider.nonlinear(), "resistor composite was nonlinear");
}

/// The `_`-joined child dump tokens from the bundled ota-gain circuit's 402
/// line: two rails then sixteen transistors, each carrying its saved flags,
/// polarity, junction state and beta.
const OTA_GAIN_TOKENS: &[&str] = &[
    "0_0_40_-9_0_0_0.5",
    "0_0_40_9_0_0_0.5",
    "0_1_-7.706770717572512_0.5136506772730565_100",
    "0_1_-0.5136506772730565_0.5134043698921236_100",
    "0_1_0_0.5134043698921236_100",
    "0_1_-7.77671430671658_0.49657201297165443_100",
    "0_1_-7.779737407777473_0.49556431261798917_100",
    "0_-1_0.49656711146272414_-0.49632080411134893_100",
    "0_-1_0_-0.49632080411134893_100",
    "0_-1_16.014233971869707_-0.49656711146272414_100",
    "0_-1_0.4955594111078838_-0.49531310375896176_100",
    "0_-1_0_-0.49531310375896176_100",
    "0_-1_8.063446815812046_-0.4955594111078838_100",
    "0_1_0_0.49631590260242753_100",
    "0_1_-0.49656220995379385_0.49631590260242753_100",
    "0_1_-7.952802556764888_0.49656220995379385_100",
    "0_1_0_0.5578444879154357_100",
    "0_1_0_0.558852188269101_100",
];

/// The OTA follower: non-inverting input driven, output wired straight back
/// to the inverting input. Returns the output node voltage.
fn ota_follower(tokens: &[&str], vin: f64) -> f64 {
    let c = &mut build(
        vec![
            elm(
                1,
                "voltage",
                &[[0, 300], [100, 300]],
                &[("maxVoltage", vin)],
            ),
            elm(2, "wire", &[[100, 300], [100, 0]], &[]),
            elm_ota(
                3,
                &[[100, 0], [100, 200], [300, 100], [300, 200], [300, 300]],
                tokens,
                &[("posVolt", 9.0), ("negVolt", -9.0)],
            ),
            elm(4, "wire", &[[300, 300], [100, 200]], &[]),
            elm(
                5,
                "resistor",
                &[[300, 300], [300, 400]],
                &[("resistance", 33000.0)],
            ),
            elm(6, "ground", &[[300, 400]], &[]),
            // The post-2 collector load.
            elm(
                7,
                "resistor",
                &[[300, 100], [400, 100]],
                &[("resistance", 8200.0)],
            ),
            elm(8, "rail", &[[400, 100]], &[("maxVoltage", 9.0)]),
            // Iabc through 470 ohm from a -7 V rail: about 1.7 mA, enough for
            // a usable transconductance (upstream biases Iabc through a
            // resistor too, so the tail is whatever that path allows).
            elm(9, "rail", &[[100, 500]], &[("maxVoltage", -7.0)]),
            elm(
                10,
                "resistor",
                &[[100, 500], [300, 200]],
                &[("resistance", 470.0)],
            ),
            elm(11, "ground", &[[0, 300]], &[]),
        ],
        opts(1e-5, true),
    );
    let report = c.run(30);
    assert!(report.converged, "did not converge: {:?}", report.error);
    let nodes = c.element_nodes();
    // The OTA is element index 2; its posts start at flattened index 2 + 2.
    let out_node = nodes[4 + 4] as usize;
    c.node_voltages()[out_node]
}

#[test]
fn ota_buffers_its_non_inverting_input() {
    // The OTA in unity-gain feedback follows its non-inverting input across
    // the supply range. This is the plan's stated fallback when a full gain
    // stage is too fiddly to pin: the composite's delegation, node remapping
    // and the two internal rail voltage sources are all exercised, and the
    // output has to reach several volts each way, which the +/-9 V rails make
    // possible. The input offset voltage of this topology lands the error
    // around 10-20 mV, well inside the 30 mV asserted here.
    for vin in [-3.0, -1.0, 0.0, 0.5, 1.0, 2.0, 5.0] {
        let out = ota_follower(&[], vin);
        assert!(
            (out - vin).abs() < 0.03,
            "follower output was {out} for input {vin}, expected it to track"
        );
    }
}

#[test]
fn ota_inverting_gain_stage_inverts_and_amplifies() {
    // Inverting gain stage: Vin through 1k into the inverting input (post 1),
    // 10k feedback from the output, non-inverting input grounded. The OTA's
    // finite transconductance (~3 mS at the ~1.7 mA tail) puts the closed-loop
    // gain at about -6.8 rather than the ideal -Rf/Rin = -10, so the output is
    // asserted as a range and the *increment* is pinned against the feedback
    // ratio. A negative input is not asserted: the input protection clamps
    // (T15/T16) hold the inverting node above ground when V+ sits at 0, so the
    // negative half of the transfer saturates at the clamp, as it does on the
    // real part.
    let gain_stage = |vin: f64| {
        let c = &mut build(
            vec![
                elm(1, "voltage", &[[0, 200], [0, 0]], &[("maxVoltage", vin)]),
                elm(
                    2,
                    "resistor",
                    &[[0, 0], [100, 200]],
                    &[("resistance", 1000.0)],
                ),
                elm(
                    3,
                    "resistor",
                    &[[300, 300], [100, 200]],
                    &[("resistance", 10000.0)],
                ),
                elm_ota(
                    4,
                    &[[100, 0], [100, 200], [300, 100], [300, 200], [300, 300]],
                    &[],
                    &[("posVolt", 9.0), ("negVolt", -9.0)],
                ),
                elm(5, "ground", &[[100, 0]], &[]),
                elm(
                    6,
                    "resistor",
                    &[[300, 300], [300, 400]],
                    &[("resistance", 33000.0)],
                ),
                elm(7, "ground", &[[300, 400]], &[]),
                elm(
                    8,
                    "resistor",
                    &[[300, 100], [400, 100]],
                    &[("resistance", 8200.0)],
                ),
                elm(9, "rail", &[[400, 100]], &[("maxVoltage", 9.0)]),
                elm(10, "rail", &[[100, 500]], &[("maxVoltage", -7.0)]),
                elm(
                    11,
                    "resistor",
                    &[[100, 500], [300, 200]],
                    &[("resistance", 470.0)],
                ),
                elm(12, "ground", &[[0, 200]], &[]),
            ],
            opts(1e-5, true),
        );
        let report = c.run(30);
        assert!(report.converged, "did not converge: {:?}", report.error);
        let nodes = c.element_nodes();
        // The OTA is element index 3; its posts start at flattened index 6.
        let out_node = nodes[6 + 4] as usize;
        c.node_voltages()[out_node]
    };

    let v_pos = gain_stage(0.5);
    assert!(
        (-9.0..-1.0).contains(&v_pos),
        "positive input gave {v_pos} V, expected a clear negative swing between the rails"
    );
    // Incremental gain: a 0.4 V step in the input moves the output by 4 to
    // 10 times that, inverting.
    let v_small = gain_stage(0.1);
    let increment = (v_pos - v_small) / 0.4;
    assert!(
        (-10.0..-4.0).contains(&increment),
        "incremental gain was {increment}, expected between -10 and -4"
    );
}

#[test]
fn ota_parses_the_corpus_child_dump_tokens() {
    // The saved 402 line's child dump tokens (rail flags + waveform fields,
    // then transistor pnp/lastVbe/lastVbc/beta) must map onto the child specs
    // without corrupting the model: the sixteen transistor polarities and the
    // two rail voltages are what the OTA runs on, so a fresh build and a
    // token-carrying build must land on the same operating point.
    let fresh = ota_follower(&[], 1.0);
    let from_tokens = ota_follower(OTA_GAIN_TOKENS, 1.0);
    assert!(
        close(fresh, from_tokens, 1e-6),
        "token-carrying OTA output {from_tokens} differs from fresh {fresh}"
    );
    assert!(
        close(from_tokens, 1.0, 0.03),
        "token-carrying follower output was {from_tokens}, expected to track 1 V"
    );
}
