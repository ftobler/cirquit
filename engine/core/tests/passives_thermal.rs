//! Resistors, fuses, the motor-protection switch, and the lamp, thermistor and LDR temperature/light-dependent resistances.

use circuit_core::{Circuit, CircuitSpec};

mod common;
use common::*;

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

#[test]
fn fuse_display_state_passes_one_on_the_step_it_blows() {
    // The renderer thresholds the fuse's melt fraction at 1, so the state
    // report must cross 1 on the very step the electrical behaviour opens:
    // the drawing cannot lag the pop by a frame. Reset must drop it back to 0.
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

    // Heat accumulates from the previous step's current, so the first step
    // cannot blow anything; step one at a time until the fraction crosses 1.
    let mut steps = 0;
    loop {
        c.run(1);
        steps += 1;
        if c.element_states()[1] > 1.0 {
            break;
        }
        assert!(steps < 100_000, "fuse never blew");
    }

    let states = c.element_states();
    assert!(
        states[1] > 1.0,
        "display_state must exceed 1 the step it blows, got {}",
        states[1]
    );
    assert!(
        c.element_currents()[1].abs() < 1e-6,
        "the blow must have opened the fuse already"
    );

    c.reset();
    assert_eq!(
        c.element_states()[1],
        0.0,
        "reset must un-pop the fuse and clear its heat"
    );
}

#[test]
fn fuse_set_state_confirms_an_unpop_once_the_heat_has_decayed() {
    // The frontend pushes a reset fuse's live `e.state` back through
    // set_state so the store copy and the model never diverge. Releasing
    // `blown` alone cannot show an intact fuse while the heat is still past
    // i2t, so let the open fuse cool below its rating first — the blown clamp
    // holds the report at exactly 1 — then confirm the un-pop and check the
    // fraction falls through.
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

    let mut steps = 0;
    loop {
        c.run(1);
        steps += 1;
        if c.element_states()[1] > 1.0 {
            break;
        }
        assert!(steps < 100_000, "fuse never blew");
    }

    // Heat bleeds off the open fuse at i2t/3 per second (FuseElm.java:156-160);
    // 2 s drops it well below the rating, and the blown clamp pins the report.
    c.run(2000);
    assert_eq!(
        c.element_states()[1],
        1.0,
        "the blown clamp must hold the fraction at exactly 1"
    );

    assert!(c.set_state(2, 0), "the un-pop confirm must be accepted");
    assert!(
        c.element_states()[1] < 1.0,
        "releasing blown must let the melt fraction fall below 1, got {}",
        c.element_states()[1]
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

/// Ports the lamp's temperature update (`startIteration`, LampElm.java:176-182)
/// exactly like `lamp_resistance_after` ports its resistance, so the expected
/// filament temperature comes from literally the same discrete loop the engine
/// runs. The two share the previous step's power and the 0.4 s baseline time
/// constants, so the only difference is that this returns `temp` rather than
/// the resistance stamped from it.
fn lamp_temp_after(dt: f64, steps: u32, applied_v: f64, nom_pow: f64, nom_v: f64) -> f64 {
    const ROOM_TEMP: f64 = 300.0;
    let mut temp = ROOM_TEMP;
    let mut prev_power = 0.0;
    let cap = 1.57e-4 * nom_pow;
    let capw = cap;
    let capc = cap;
    let cr = 2600.0 / nom_pow;
    for _ in 0..steps {
        let nom_r = nom_v * nom_v / nom_pow;
        let tp = temp.min(5390.0);
        let resistance = nom_r
            * (1.26104 - 4.90662 * (17.1839 / tp - 0.00318794).sqrt() - 7.8569 / (tp - 187.56));
        temp += prev_power * dt / capw;
        temp -= dt * (temp - ROOM_TEMP) / (capc * cr);
        prev_power = applied_v * (applied_v / resistance);
    }
    temp
}

#[test]
fn lamp_display_state_reports_the_rising_filament_temperature() {
    // Drive a default lamp (100 W @ 120 V) at its rated voltage for 5 s, and
    // the reported state must follow the same rising temp the resistance curve
    // is stamped from, settling near its ~2900 K steady state. Reset returns
    // it to room temperature.
    let dt = 1e-3;
    let steps = 5000;
    let expected = lamp_temp_after(dt, steps, 120.0, 100.0, 120.0);
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 120.0)]),
            elm(2, "lamp", &[[0, 0], [0, 100]], &[]),
            elm(3, "ground", &[[0, 100]], &[]),
        ],
        opts(dt, false),
    );

    c.run(steps);
    let temp = c.element_states()[1];
    assert!(
        temp > 2000.0,
        "a lamp at rated voltage should be hot after 5 s, got {} K",
        temp
    );
    assert!(
        close(temp, expected, 1.0),
        "display_state temp {} K should match the discrete update's {} K",
        temp,
        expected
    );

    c.reset();
    assert_eq!(
        c.element_states()[1],
        300.0,
        "reset must return the filament to room temperature"
    );
}

#[test]
fn element_states_lines_up_one_entry_per_element_with_the_voltages() {
    // The renderer indexes every per-element array by the same engine order,
    // so a mixed circuit must report exactly one state per element, in the
    // same order as the voltages, with every non-animated element at the
    // default 0.
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 10.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(3, "fuse", &[[100, 0], [100, 100]], &[]),
            elm(
                4,
                "lamp",
                &[[100, 100], [200, 100]],
                &[("nomPower", 100.0), ("nomVoltage", 120.0)],
            ),
            elm(5, "wire", &[[200, 100], [300, 100]], &[]),
            elm(6, "ground", &[[0, 100]], &[]),
        ],
        opts(1e-4, true),
    );

    let states = c.element_states();
    let volts = c.element_voltages();
    assert_eq!(
        states.len(),
        volts.len(),
        "states must have one entry per element, like the voltages"
    );
    // Element order is the spec order: fuse at index 2, lamp at index 3.
    assert_eq!(states[2], 0.0, "an intact fuse reports a 0 melt fraction");
    assert_eq!(states[3], 300.0, "a cold lamp reports room temperature");
    for (i, s) in states.iter().enumerate() {
        if i != 2 && i != 3 {
            assert_eq!(*s, 0.0, "element {i} must default to display state 0");
        }
    }
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
