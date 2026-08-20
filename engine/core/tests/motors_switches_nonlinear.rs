//! Three-phase and DC motors, the time-delay relay, make-before-break and DPDT switches, and mixed nonlinear circuits.

use std::f64::consts::PI;

use circuit_core::{Circuit, CircuitSpec, ScopeSpec, ScopeValue};

mod common;
use common::*;

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
fn time_delay_relay_switches_after_the_on_delay_and_back_after_off_delay() {
    // The relay's coil sense (posts 0-1) is a fixed 10 kOhm resistor; the
    // switched path (posts 2-3) holds offResistance until onDelay after the
    // coil powers, then onResistance, and returns after offDelay once the
    // coil drops (TimeDelayRelayElm.java:92-100). The switched path is driven
    // by its own 5 V source, so the relay's reported current reads 5/R and
    // exposes which state it is in.
    let dt = 1e-3;
    let c = &mut build(
        vec![
            // Coil drive: post 0 at +5 V, post 1 grounded.
            elm(1, "voltage", &[[0, -64], [0, 0]], &[("maxVoltage", 5.0)]),
            elm(2, "ground", &[[0, -64]], &[]),
            elm(
                3,
                "timeDelayRelay",
                &[[0, 0], [64, 0], [128, 0], [192, 0]],
                &[
                    ("onDelay", 0.5),
                    ("offDelay", 0.3),
                    ("onResistance", 10.0),
                    ("offResistance", 1e6),
                ],
            ),
            elm(4, "ground", &[[64, 0]], &[]),
            // Switched path drive: post 2 at +5 V, post 3 grounded.
            elm(
                5,
                "voltage",
                &[[128, -64], [128, 0]],
                &[("maxVoltage", 5.0)],
            ),
            elm(6, "ground", &[[128, -64]], &[]),
            elm(7, "ground", &[[192, 0]], &[]),
        ],
        opts(dt, false),
    );
    // Before the on delay (0.1 s < 0.5 s) the path sits at offResistance:
    // 5 V / 1 MOhm = 5 uA.
    c.run(100);
    assert!(
        close(c.element_currents()[2], 5e-6, 5e-9),
        "before onDelay the path carried {}, expected 5 uA",
        c.element_currents()[2]
    );

    // Past the on delay the path closes to 10 ohm -> 0.5 A.
    c.run(600); // total 0.7 s
    assert!(
        close(c.element_currents()[2], 0.5, 1e-6),
        "after onDelay the path carried {}, expected 0.5 A",
        c.element_currents()[2]
    );

    // Drop the coil drive; the path stays closed through offDelay (0.3 s),
    // then reopens to offResistance.
    assert!(c.set_param(1, "maxVoltage", 0.0), "coil drive edit refused");
    c.run(100); // 0.1 s after the drop, still within offDelay
    assert!(
        close(c.element_currents()[2], 0.5, 1e-6),
        "during offDelay the path carried {}, expected it to stay closed",
        c.element_currents()[2]
    );
    c.run(300); // 0.4 s after the drop, past offDelay
    assert!(
        close(c.element_currents()[2], 5e-6, 5e-9),
        "after offDelay the path carried {}, expected 5 uA again",
        c.element_currents()[2]
    );
}

#[test]
fn dc_motor_reaches_the_analytic_steady_state_and_spins() {
    // A DC motor under a fixed armature supply settles to the standard
    // electromechanical operating point. With the constructor defaults
    // L = 0.5, R = 1, K = Kb = 0.15, J = 0.02, b = 0.05 and a 10 V drive,
    // the steady-state armature current is I = V*b/(K*Kb + b*R) and the shaft
    // speed is omega = K*V/(K*Kb + b*R). Under a forward drive (the + terminal
    // on post 0) the armature current is positive and the rotor advances in the
    // positive angle direction, the same sense upstream integrates
    // (angle += speed*dt, DCMotorElm.java:136), so the sign of the angle delta
    // is asserted, not just its magnitude.
    let v = 10.0;
    let r = 1.0;
    let k = 0.15;
    let kb = 0.15;
    let b = 0.05;
    let denom = k * kb + b * r;
    let i_ss = v * b / denom;
    let omega_ss = k * v / denom;
    let dt = 1e-3;
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, -64], [0, 0]], &[("maxVoltage", v)]),
            elm(2, "ground", &[[0, -64]], &[]),
            elm(
                3,
                "dcMotor",
                &[[0, 0], [96, 0]],
                &[
                    ("inductance", 0.5),
                    ("resistance", r),
                    ("K", k),
                    ("Kb", kb),
                    ("J", 0.02),
                    ("b", b),
                    ("gearRatio", 1.0),
                    ("tau", 0.0),
                ],
            ),
            elm(4, "ground", &[[96, 0]], &[]),
        ],
        opts(dt, false),
    );
    // The electrical time constant is L/(R + K*Kb/b) ~ 0.34 s once the
    // back-EMF feedback is in, the mechanical one J/b = 0.4 s, so 20 s is
    // deep into steady state.
    let report = c.run(20000);
    assert!(report.converged, "did not converge: {:?}", report.error);
    let i = c.element_currents()[2];
    assert!(
        close(i, i_ss, i_ss * 0.03),
        "armature current settled to {i}, expected {i_ss} within 3%"
    );
    assert!(i > 0.0, "armature current should be positive, was {i}");

    // The rotor angle advances at the settled speed: measure the signed delta
    // over a fresh batch of steps, long after the transient has settled.
    let before = c.element_states()[2];
    let n = 1000u32;
    let report = c.run(n);
    assert!(report.converged, "did not converge: {:?}", report.error);
    let after = c.element_states()[2];
    let expected_delta = omega_ss * n as f64 * dt;
    let delta = after - before;
    assert!(
        close(delta, expected_delta, expected_delta * 0.03),
        "angle advanced {delta} over {n} steps, expected {expected_delta} within 3%"
    );
    assert!(
        delta > 0.0,
        "forward drive should spin the rotor forward, saw {delta}"
    );
}

#[test]
fn dc_motor_reverses_when_the_drive_is_reversed() {
    // Reversing the armature supply flips both the armature current and the
    // rotor's spin direction: the angle must now advance in the negative
    // direction, mirroring upstream's sign-coupled speed and current.
    let v = 10.0;
    let r = 1.0;
    let k = 0.15;
    let kb = 0.15;
    let b = 0.05;
    let denom = k * kb + b * r;
    let i_ss = v * b / denom;
    let omega_ss = k * v / denom;
    let dt = 1e-3;
    let c = &mut build(
        vec![
            // + terminal on post 1, so post 0 is grounded.
            elm(1, "voltage", &[[96, -64], [96, 0]], &[("maxVoltage", v)]),
            elm(2, "ground", &[[96, -64]], &[]),
            elm(
                3,
                "dcMotor",
                &[[0, 0], [96, 0]],
                &[
                    ("inductance", 0.5),
                    ("resistance", r),
                    ("K", k),
                    ("Kb", kb),
                    ("J", 0.02),
                    ("b", b),
                    ("gearRatio", 1.0),
                    ("tau", 0.0),
                ],
            ),
            elm(4, "ground", &[[0, 0]], &[]),
        ],
        opts(dt, false),
    );
    let report = c.run(20000);
    assert!(report.converged, "did not converge: {:?}", report.error);
    let i = c.element_currents()[2];
    // Current now leaves post 0, so the element current reads negative under
    // the port's post-0-in convention.
    assert!(
        close(i, -i_ss, i_ss * 0.03),
        "reversed armature current settled to {i}, expected {} within 3%",
        -i_ss
    );
    let before = c.element_states()[2];
    let n = 1000u32;
    c.run(n);
    let after = c.element_states()[2];
    let delta = after - before;
    let expected_delta = -omega_ss * n as f64 * dt;
    assert!(
        close(delta, expected_delta, expected_delta.abs() * 0.03),
        "reversed drive advanced angle {delta}, expected {expected_delta} within 3%"
    );
    assert!(
        delta < 0.0,
        "reversed drive should spin the rotor backward, saw {delta}"
    );
}

#[test]
fn dc_motor_starts_with_the_upstream_rotor_angle() {
    // A fresh motor seeds `angle = pi/2` (DCMotorElm.java:29,37), so the
    // drawn spokes start rotated instead of lying on the axis.
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, -64], [0, 0]], &[("maxVoltage", 10.0)]),
            elm(2, "ground", &[[0, -64]], &[]),
            elm(3, "dcMotor", &[[0, 0], [96, 0]], &[("resistance", 1.0)]),
            elm(4, "ground", &[[96, 0]], &[]),
        ],
        opts(1e-3, false),
    );
    assert!(
        close(c.element_states()[2], PI / 2.0, 1e-9),
        "fresh motor angle should be pi/2, saw {}",
        c.element_states()[2]
    );
}

#[test]
fn mbb_switch_closes_the_expected_throws_per_position() {
    // Four positions: 0 closes pole A (posts 0-1) only, 1 closes both, 2
    // closes pole B (posts 0-2) only, 3 closes both again. Each throw drives
    // a load, so the position is read off the two load currents. The ideal
    // path stamps one 0 V source per conducting throw, so the per-pole
    // currents stay reportable and the element's own current is their sum.
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, -64], [0, 0]], &[("maxVoltage", 10.0)]),
            elm(2, "ground", &[[0, -64]], &[]),
            elm(
                3,
                "mbbSwitch",
                &[[0, 0], [64, -16], [64, 16]],
                &[("position", 0.0)],
            ),
            elm(
                4,
                "resistor",
                &[[64, -16], [64, -80]],
                &[("resistance", 100.0)],
            ),
            elm(5, "ground", &[[64, -80]], &[]),
            elm(
                6,
                "resistor",
                &[[64, 16], [64, 80]],
                &[("resistance", 200.0)],
            ),
            elm(7, "ground", &[[64, 80]], &[]),
        ],
        opts(1e-5, false),
    );
    let load_a = 3; // element index 3 = the load on throw A (100 ohm -> 0.1 A)
    let load_b = 5; // element index 5 = the load on throw B (200 ohm -> 0.05 A)

    let assert_loads = |c: &mut Circuit, a_amps: f64, b_amps: f64| {
        let i = c.element_currents();
        assert!(
            close(i[load_a], a_amps, 1e-9),
            "throw A load carried {}, expected {a_amps}",
            i[load_a]
        );
        assert!(
            close(i[load_b], b_amps, 1e-9),
            "throw B load carried {}, expected {b_amps}",
            i[load_b]
        );
    };

    c.run(5);
    assert_loads(c, 0.1, 0.0); // position 0: pole A only

    assert!(c.set_state(3, 1), "mbb switch refused position 1");
    c.run(5);
    assert_loads(c, 0.1, 0.05); // position 1: both throws
    assert!(
        close(c.element_currents()[2], 0.15, 1e-9),
        "both throws should draw {} A total, saw {}",
        0.15,
        c.element_currents()[2]
    );

    assert!(c.set_state(3, 2), "mbb switch refused position 2");
    c.run(5);
    assert_loads(c, 0.0, 0.05); // position 2: pole B only

    assert!(c.set_state(3, 3), "mbb switch refused position 3");
    c.run(5);
    assert_loads(c, 0.1, 0.05); // position 3: both again

    assert!(c.set_state(3, 4), "mbb switch refused a wrapped position");
    c.run(5);
    assert_loads(c, 0.1, 0.0); // position 4 wraps to 0
}

#[test]
fn mbb_switch_resistance_edit_crossing_zero_rebuilds() {
    // A resistance edit that crosses the ideal/resistor boundary changes the
    // switch's `voltage_source_count` (0 with a resistance, 1 or 2 ideal),
    // which a live restamp cannot reallocate: the closure builder would index
    // the new vs slots past the end of the stale array. `set_param` refuses
    // the crossing (returns false), so the caller rebuilds via `set_circuit`
    // with the re-serialised params (which is how the edited resistance
    // survives the rebuild), and the ideal path works again without
    // panicking. The reverse 0 -> nonzero direction needs the same rebuild; a
    // same-side edit stays on the live path.
    let spec = |resistance: f64| CircuitSpec {
        preserve_run: false,
        elements: vec![
            elm(1, "voltage", &[[0, -64], [0, 0]], &[("maxVoltage", 10.0)]),
            elm(2, "ground", &[[0, -64]], &[]),
            elm(
                3,
                "mbbSwitch",
                &[[0, 0], [64, -16], [64, 16]],
                &[("position", 0.0), ("resistance", resistance)],
            ),
            elm(
                4,
                "resistor",
                &[[64, -16], [64, -80]],
                &[("resistance", 100.0)],
            ),
            elm(5, "ground", &[[64, -80]], &[]),
        ],
        options: Some(opts(1e-5, false)),
        scopes: Vec::new(),
    };
    let mut c = Circuit::new();
    c.set_circuit(&spec(25.0)).unwrap();
    c.run(5);
    assert!(
        close(c.element_currents()[3], 10.0 / 125.0, 1e-9),
        "resistor path should give {} A, saw {}",
        10.0 / 125.0,
        c.element_currents()[3]
    );

    // >0 -> 0 crosses the boundary: the live edit is refused, the caller
    // rebuilds with the edited params, and the ideal 0 V source path conducts.
    assert!(
        !c.set_param(3, "resistance", 0.0),
        "boundary crossing must refuse the live path"
    );
    c.set_circuit(&spec(0.0)).unwrap();
    c.run(5);
    assert!(
        close(c.element_currents()[3], 0.1, 1e-9),
        "ideal path should short the load to 0.1 A, saw {}",
        c.element_currents()[3]
    );

    // Reverse 0 -> >0: refused too, and the rebuilt switch reads Ohm's law
    // through the new resistance.
    assert!(
        !c.set_param(3, "resistance", 25.0),
        "boundary crossing must refuse the live path"
    );
    c.set_circuit(&spec(25.0)).unwrap();
    c.run(5);
    assert!(
        close(c.element_currents()[3], 10.0 / 125.0, 1e-9),
        "resistor path should give {} A, saw {}",
        10.0 / 125.0,
        c.element_currents()[3]
    );

    // A same-side edit (both > 0) stays live: accepted, restamped, no rebuild.
    assert!(c.set_param(3, "resistance", 30.0), "same-side edit refused");
    c.run(5);
    assert!(
        close(c.element_currents()[3], 10.0 / 130.0, 1e-9),
        "same-side edit should give {} A, saw {}",
        10.0 / 130.0,
        c.element_currents()[3]
    );
}

#[test]
fn dpdt_switch_throws_both_poles_together_and_clamps_pole_count() {
    // poleCount 2 (the default) gives six posts: poles 0 and 3, each with two
    // throws. Position 0 ties each pole to its first throw, position 1 to its
    // second. The poles are driven at different voltages so the load currents
    // identify which throw conducted.
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, -64], [0, 0]], &[("maxVoltage", 10.0)]),
            elm(2, "ground", &[[0, -64]], &[]),
            elm(3, "voltage", &[[0, -96], [0, -48]], &[("maxVoltage", 5.0)]),
            elm(4, "ground", &[[0, -96]], &[]),
            elm(
                5,
                "dpdtSwitch",
                &[[0, 0], [64, -48], [64, 48], [0, -48], [64, -96], [64, 0]],
                &[("position", 0.0), ("poleCount", 2.0)],
            ),
            // Pole 0's throws: post 1 -> load1, post 2 -> load2.
            elm(
                6,
                "resistor",
                &[[64, -48], [64, -128]],
                &[("resistance", 1000.0)],
            ),
            elm(7, "ground", &[[64, -128]], &[]),
            elm(
                8,
                "resistor",
                &[[64, 48], [64, 128]],
                &[("resistance", 1000.0)],
            ),
            elm(9, "ground", &[[64, 128]], &[]),
            // Pole 1's throws: post 4 -> load3, post 5 -> load4.
            elm(
                10,
                "resistor",
                &[[64, -96], [64, -176]],
                &[("resistance", 1000.0)],
            ),
            elm(11, "ground", &[[64, -176]], &[]),
            elm(
                12,
                "resistor",
                &[[64, 0], [64, 80]],
                &[("resistance", 1000.0)],
            ),
            elm(13, "ground", &[[64, 80]], &[]),
        ],
        opts(1e-5, false),
    );
    // Element indices: load1 = 5, load2 = 7, load3 = 9, load4 = 11.
    let assert_loads = |c: &mut Circuit, l1: f64, l2: f64, l3: f64, l4: f64| {
        let i = c.element_currents();
        assert!(
            close(i[5], l1, 1e-9),
            "load1 carried {}, expected {l1}",
            i[5]
        );
        assert!(
            close(i[7], l2, 1e-9),
            "load2 carried {}, expected {l2}",
            i[7]
        );
        assert!(
            close(i[9], l3, 1e-9),
            "load3 carried {}, expected {l3}",
            i[9]
        );
        assert!(
            close(i[11], l4, 1e-9),
            "load4 carried {}, expected {l4}",
            i[11]
        );
    };

    c.run(5);
    assert_loads(c, 0.01, 0.0, 0.005, 0.0); // position 0: first throws

    assert!(c.set_state(5, 1), "dpdt switch refused position 1");
    c.run(5);
    assert_loads(c, 0.0, 0.01, 0.0, 0.005); // position 1: second throws

    assert!(c.set_state(5, 0), "dpdt switch refused position 0 again");
    c.run(5);
    assert_loads(c, 0.01, 0.0, 0.005, 0.0);
}

#[test]
fn dpdt_switch_resistance_edit_crossing_zero_rebuilds() {
    // Same live source-count flip as the MBB: a resistance edit that crosses
    // the ideal/resistor boundary changes `voltage_source_count` from 0 to
    // `pole_count`, which the live restamp cannot reallocate. `set_param`
    // refuses the crossing, the caller rebuilds via `set_circuit` with the
    // re-serialised params, and the ideal and resistor paths each work again
    // without panicking. A same-side edit stays live.
    let spec = |resistance: f64| CircuitSpec {
        preserve_run: false,
        elements: vec![
            elm(1, "voltage", &[[0, -64], [0, 0]], &[("maxVoltage", 10.0)]),
            elm(2, "ground", &[[0, -64]], &[]),
            elm(
                5,
                "dpdtSwitch",
                &[[0, 0], [64, -48], [64, 48], [0, -48], [64, -96], [64, 0]],
                &[
                    ("position", 0.0),
                    ("poleCount", 2.0),
                    ("resistance", resistance),
                ],
            ),
            elm(
                6,
                "resistor",
                &[[64, -48], [64, -128]],
                &[("resistance", 1000.0)],
            ),
            elm(7, "ground", &[[64, -128]], &[]),
        ],
        options: Some(opts(1e-5, false)),
        scopes: Vec::new(),
    };
    let mut c = Circuit::new();
    c.set_circuit(&spec(15.0)).unwrap();
    c.run(5);
    assert!(
        close(c.element_currents()[3], 10.0 / 1015.0, 1e-9),
        "resistor path should give {} A, saw {}",
        10.0 / 1015.0,
        c.element_currents()[3]
    );

    // >0 -> 0 crosses the boundary: refused, then rebuilt to the ideal path.
    assert!(
        !c.set_param(5, "resistance", 0.0),
        "boundary crossing must refuse the live path"
    );
    c.set_circuit(&spec(0.0)).unwrap();
    c.run(5);
    assert!(
        close(c.element_currents()[3], 0.01, 1e-9),
        "ideal path should short pole 0's load to 0.01 A, saw {}",
        c.element_currents()[3]
    );

    // Reverse 0 -> >0: refused, and the rebuilt resistor path conducts.
    assert!(
        !c.set_param(5, "resistance", 15.0),
        "boundary crossing must refuse the live path"
    );
    c.set_circuit(&spec(15.0)).unwrap();
    c.run(5);
    assert!(
        close(c.element_currents()[3], 10.0 / 1015.0, 1e-9),
        "resistor path should give {} A, saw {}",
        10.0 / 1015.0,
        c.element_currents()[3]
    );

    // A same-side edit (both > 0) stays live.
    assert!(c.set_param(5, "resistance", 20.0), "same-side edit refused");
    c.run(5);
    assert!(
        close(c.element_currents()[3], 10.0 / 1020.0, 1e-9),
        "same-side edit should give {} A, saw {}",
        10.0 / 1020.0,
        c.element_currents()[3]
    );
}

#[test]
fn dpdt_switch_clamps_pole_count_to_two_through_ten() {
    // The file can carry any poleCount; the frontend normalizes it to 2..=10
    // and derives 3*poleCount posts from the clamped value, and the engine
    // clamps independently so the two halves can never disagree. The post
    // count shows up in the flat per-terminal node array.
    let c = &mut build(
        vec![elm(
            1,
            "dpdtSwitch",
            &[[0, 0], [0, 64], [0, 128], [0, 192], [0, 256], [0, 320]],
            &[("position", 0.0), ("poleCount", 1.0)],
        )],
        opts(1e-5, false),
    );
    assert_eq!(c.element_nodes().len(), 6, "poleCount 1 clamps to 2 poles");

    let c = &mut build(
        vec![elm(
            1,
            "dpdtSwitch",
            &(0..30).map(|i| [i * 8, 0]).collect::<Vec<_>>(),
            &[("position", 0.0), ("poleCount", 12.0)],
        )],
        opts(1e-5, false),
    );
    assert_eq!(
        c.element_nodes().len(),
        30,
        "poleCount 12 clamps to 10 poles"
    );
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

/// Builds the bundled 3motor.txt machine driven by three 220 V, 50 Hz sine
/// rails 120 degrees apart on the phase-1 posts (0, 2, 4), the phase-2 posts
/// (1, 3, 5) grounded. `swap` reverses the V/W phase feeds, flipping the
/// sequence from ABC to ACB. The small `J` spins the shaft up inside the test
/// run; the physics is upstream's reduced-order model, untouched by this port.
fn abc_motor_circuit(swap: bool) -> Circuit {
    let (vb, wb) = if swap {
        (2.0 * PI / 3.0, -2.0 * PI / 3.0)
    } else {
        (-2.0 * PI / 3.0, 2.0 * PI / 3.0)
    };
    build(
        vec![
            elm(
                1,
                "rail",
                &[[608, 192]],
                &[
                    ("waveform", 1.0),
                    ("frequency", 50.0),
                    ("maxVoltage", 220.0),
                    ("phaseShift", 0.0),
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
                    ("phaseShift", vb),
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
                    ("phaseShift", wb),
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
                    ("J", 0.005),
                ],
            ),
            elm(5, "ground", &[[752, 192]], &[]),
            elm(6, "ground", &[[752, 224]], &[]),
            elm(7, "ground", &[[752, 256]], &[]),
        ],
        opts(5e-6, false),
    )
}

/// The motor is element id 4, which lands at index 3 in element order; it is
/// the only element whose `display_state` is non-zero (the rotor angle). The
/// build warm-up may already have spun it, so this only identifies the motor,
/// it does not assume a starting angle.
fn motor_angle(c: &mut Circuit) -> f64 {
    let s = c.element_states();
    let rest: f64 = s
        .iter()
        .enumerate()
        .filter(|(i, _)| *i != 3)
        .map(|(_, v)| v.abs())
        .sum();
    assert!(
        rest < 1e-9,
        "only the motor (index 3) should have a live state, rest={rest} (states {:?})",
        s
    );
    s[3]
}

#[test]
fn three_phase_motor_spins_forward_under_abc_drive() {
    // A balanced 3-phase ABC supply must turn the rotor the forward way
    // (angle increasing) and keep accelerating to a steady speed instead of
    // stalling. The angle is the engine's integrated `speed*dt`, so a positive
    // per-window delta is exactly a positive shaft speed.
    let mut c = abc_motor_circuit(false);
    let a0 = motor_angle(&mut c);
    let dt = 5e-6;
    let n = 15000u32; // 75 ms per window
    c.run(n);
    let a1 = motor_angle(&mut c);
    c.run(n);
    let a2 = motor_angle(&mut c);
    c.run(n);
    let a3 = motor_angle(&mut c);
    c.run(n);
    let a4 = motor_angle(&mut c);
    let w1 = (a1 - a0) / (n as f64 * dt);
    let w2 = (a2 - a1) / (n as f64 * dt);
    let w3 = (a3 - a2) / (n as f64 * dt);
    let w4 = (a4 - a3) / (n as f64 * dt);
    assert!(
        w4 > 0.0,
        "ABC drive should spin the rotor forward, saw {w4}"
    );
    assert!(
        w1 > 0.0 && w2 > 0.0 && w3 > 0.0,
        "every window should advance forward, saw {w1},{w2},{w3}"
    );
    // The shaft spins up then settles: the last two windows agree to 25%,
    // confirming a steady rotation rather than a stall or runaway.
    assert!(
        close(w4, w3, 0.25 * w4.abs().max(1.0)),
        "speed not settling: window3 {w3}, window4 {w4}"
    );
    // It also keeps accelerating off the line (does not stall immediately).
    assert!(
        w4 > 0.5 * w1,
        "rotor should keep spinning up, not stall: {w1} vs {w4}"
    );
}

#[test]
fn three_phase_motor_reverses_when_phase_order_swapped() {
    // Swapping the V and W feeds reverses the rotating-field sequence, so the
    // rotor must advance the other way: negative angle delta, the mirror of the
    // ABC case.
    let mut c = abc_motor_circuit(true);
    let a0 = motor_angle(&mut c);
    let dt = 5e-6;
    let n = 15000u32;
    c.run(n);
    let a1 = motor_angle(&mut c);
    c.run(n);
    let a2 = motor_angle(&mut c);
    c.run(n);
    let a3 = motor_angle(&mut c);
    let w1 = (a1 - a0) / (n as f64 * dt);
    let w2 = (a2 - a1) / (n as f64 * dt);
    let w3 = (a3 - a2) / (n as f64 * dt);
    assert!(
        w3 < 0.0,
        "reversed phase order should spin the rotor backward, saw {w3}"
    );
    assert!(
        w1 < 0.0 && w2 < 0.0,
        "every window should advance backward, saw {w1},{w2}"
    );
    assert!(
        close(w3, w2, 0.25 * w3.abs().max(1.0)),
        "speed not settling: window2 {w2}, window3 {w3}"
    );
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
        preserve_run: false,
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
