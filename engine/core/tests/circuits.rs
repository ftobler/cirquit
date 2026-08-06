//! End-to-end checks against circuits with known analytic answers.
//!
//! These are the real regression net for the solver: if stamping signs,
//! companion models or Newton limiting break, one of these stops matching
//! theory.

use std::collections::HashMap;
use std::f64::consts::PI;

use circuit_core::{Circuit, CircuitSpec, ElementSpec, SimOptions};

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

fn build(elements: Vec<ElementSpec>, options: SimOptions) -> Circuit {
    let spec = CircuitSpec {
        elements,
        options: Some(options),
        scopes: Vec::new(),
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
