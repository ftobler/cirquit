//! Capacitors and inductors: RC/RL time constants, LC tanks, ESR, DC operating point, and saved-charge/current round trips.

use std::f64::consts::PI;

use circuit_core::{Circuit, SimOptions};

mod common;
use common::*;

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
/// the DC operating point on or off. Both matter: the shared `opts` helper
/// defaults to off, but the app sends `dcOperatingPoint` from `settings.autoDC`, which a
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
