//! Diodes, zeners, varactors and the tunnel diode.

mod common;
use circuit_core::elements::build_element;
use common::*;

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
fn diode_1n4148_forward_drop_is_above_the_default() {
    // The spec the built-in table resolution writes for `d ... 2 1N4148`
    // (DiodeModel.java:108): Is = 4.352e-9, n = 1.906, Rs = 0.6458. A current
    // source forces 1 mA, so the terminal drop is analytic:
    //   Vd = n*vt*ln(I/Is + 1) + I*Rs = 0.6092 V.
    // The same circuit with the default model (Is = 1.7143528192808883e-7,
    // n = 2, Rs = 0) reads 0.4486 V, so the named model visibly changes the
    // result. The default's 0.4486 is also what the bare-diode knee test
    // asserts at 1 mA, keeping the two models' points honest.
    let drop = |params: &[(&str, f64)]| {
        let c = &mut build(
            vec![
                elm(1, "current", &[[0, 0], [100, 0]], &[("current", 1e-3)]),
                elm(2, "diode", &[[100, 0], [100, 100]], params),
                elm(3, "wire", &[[100, 100], [0, 0]], &[]),
                elm(4, "ground", &[[0, 0]], &[]),
            ],
            opts(1e-5, true),
        );
        c.run(20);
        c.element_voltages()[1]
    };

    let one_n4148 = drop(&[
        ("saturationCurrent", 4.352e-9),
        ("emissionCoefficient", 1.906),
        ("seriesResistance", 0.6458),
        ("breakdownVoltage", 75.0),
    ]);
    assert!(
        close(one_n4148, 0.6092, 5e-3),
        "1N4148 drop was {one_n4148}"
    );

    let default = drop(&[]);
    assert!(close(default, 0.4486, 5e-3), "default drop was {default}");
    assert!(
        one_n4148 > default + 0.1,
        "1N4148 ({one_n4148}) must sit well above the default ({default})"
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

/// Regression for EM2: a varactor built from a hostile netlist with a
/// non-positive or non-finite `baseCapacitance` must be rejected at build
/// time, never stamped. A negative companion conductance (geq = 2*C/dt)
/// behaves as an active negative resistance, and a zero or NaN slips past the
/// stamper's per-stamp positivity checks to poison the solve, diverging from
/// the b17 negative-reactives policy that already rejects non-positive
/// capacitors and inductors. The guard lives in `VaractorCap::new`, mirrored
/// on `Diode::new_varactor`, so `build_element` returns the error.
#[test]
fn varactor_rejects_nonpositive_or_nonfinite_base_capacitance() {
    let bad = |c: f64| {
        build_element(&elm(
            1,
            "varactor",
            &[[0, 0], [100, 0]],
            &[("baseCapacitance", c)],
        ))
        .err()
        .map(|e| e.contains("baseCapacitance"))
        .unwrap_or(false)
    };

    assert!(bad(0.0), "zero baseCapacitance must be rejected");
    assert!(bad(-4e-12), "negative baseCapacitance must be rejected");
    assert!(
        bad(f64::NEG_INFINITY),
        "negative-infinite baseCapacitance must be rejected"
    );
    assert!(bad(f64::NAN), "NaN baseCapacitance must be rejected");
    assert!(
        build_element(&elm(1, "varactor", &[[0, 0], [100, 0]], &[])).is_ok(),
        "default baseCapacitance must still build"
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
