//! MOSFETs and relays.

use circuit_core::{Circuit, CircuitSpec};

mod common;
use common::*;

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

/// A beta=10 common-source stage: source grounded, gate biased to 3 V, drain
/// fed from 10 V through 700 ohm. With beta = 10 A/V^2 the saturation current
/// .5*beta*(vgs-vt)^2 = 11.25 A would drop far more than the supply across any
/// sane drain resistor, so the stage sits deep in triode at the parabola's
/// foot: 7000*(1.5*vd - vd^2/2)... solved, 3500*vd^2 - 10501*vd + 10 = 0,
/// whose only root inside the device frame is vd = 9.526e-4 V. The other
/// quadratic root lies past vgs-vt, outside the triode branch's validity.
///
/// A drain capacitor charged to `perturbation` starts the Newton trajectory
/// at different points for otherwise identical circuits; once it discharges
/// (tau <= RC, sub-microsecond here, and 300 steps give 300 us) both must sit
/// on the same operating point. Converging "to tolerance" means the endpoint
/// cannot depend on where the iteration started or how it walked in.
fn high_beta_stage(perturbation: f64) -> Circuit {
    build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 10.0)]),
            elm(2, "resistor", &[[0, 0], [100, 0]], &[("resistance", 700.0)]),
            elm(
                3,
                "mosfet",
                &[[200, 0], [100, 100], [100, 0]],
                &[("pnp", 1.0), ("threshold", 1.5), ("beta", 10.0)],
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
            elm(
                8,
                "capacitor",
                &[[100, 0], [300, 0]],
                &[("capacitance", 1e-9), ("voltDiff", perturbation)],
            ),
            elm(9, "ground", &[[300, 0]], &[]),
        ],
        // A generous Newton budget so the loosened late-iteration tolerances
        // are reachable instead of a step being rejected for budget first.
        opts_budget(1e-6, false, 500),
    )
}

#[test]
fn high_beta_common_source_drain_is_invariant_to_initial_condition_perturbation() {
    let a = &mut high_beta_stage(0.1);
    let b = &mut high_beta_stage(0.2);
    let ra = a.run(300);
    let rb = b.run(300);
    assert!(
        ra.converged,
        "perturbed run did not converge: {:?}",
        ra.error
    );
    assert!(
        rb.converged,
        "2x-perturbed run did not converge: {:?}",
        rb.error
    );

    let va = a.element_voltages()[2];
    let vb = b.element_voltages()[2];

    // Both runs land on the analytic triode root...
    assert!(close(va, 9.526e-4, 2e-4), "drain was {} not 9.526e-4", va);
    assert!(close(vb, 9.526e-4, 2e-4), "drain was {} not 9.526e-4", vb);
    // ...and on the SAME point, to well under the pre-fix 10 mV stopping bar.
    assert!(
        (va - vb).abs() < 1e-4,
        "drain moved with the initial condition: {} vs {}",
        va,
        vb
    );
}

#[test]
fn resolved_mosfet_default_cuts_off_while_resolved_jfet_default_conducts() {
    // The frontend's built-in tables resolve a `default` mosfet to
    // (threshold 1.5, beta 0.02) and a `default-jfet` to (threshold -4,
    // beta 0.00125). With the gate tied to the source (vgs = 0) those are the
    // params the engine honors: the mosfet's enhancement channel is below
    // threshold and sits on its min conductance, while the jfet's depletion
    // channel already conducts its full saturation current ids =
    // .5*beta*(vgs-vt)^2 = 10 mA. This pins that the resolved params are the
    // params the engine reads, even though the two families have no
    // discriminating analytic difference beyond their table values.
    let drain_current = |kind: &str, threshold: f64, beta: f64| {
        let c = &mut build(
            vec![
                elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 5.0)]),
                elm(2, "resistor", &[[0, 0], [100, 0]], &[("resistance", 50.0)]),
                elm(
                    3,
                    kind,
                    &[[200, 100], [100, 100], [100, 0]],
                    &[("pnp", 1.0), ("threshold", threshold), ("beta", beta)],
                ),
                elm(4, "wire", &[[200, 100], [100, 100]], &[]),
                elm(5, "ground", &[[0, 100]], &[]),
                elm(6, "ground", &[[100, 100]], &[]),
            ],
            opts(1e-5, true),
        );
        let report = c.run(20);
        assert!(report.converged, "did not converge: {:?}", report.error);
        c.element_currents()[2]
    };

    // The jfet draws 10 mA into the 50 ohm load, the mosfet's channel leaks
    // only through its 1e-8 S floor (Vd ~ 5 V through the 1e8 ohm channel).
    let jfet = drain_current("jfet", -4.0, 0.00125);
    assert!(close(jfet, 0.01, 1e-5), "jfet ids was {jfet}");
    let mosfet = drain_current("mosfet", 1.5, 0.02);
    assert!(mosfet < 1e-6, "mosfet ids was {mosfet}");
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
        preserve_run: false,
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
fn empty_relay_labels_do_not_pair() {
    // An empty label is "no label": a coil and a contact that round-tripped
    // an empty `\0` token must not pair, or every unlabelled relay in a file
    // would drive every other. Both contacts stay closed here even though the
    // coil picks up.
    let c = &mut coil_contact_pair("", "", "");
    c.run(200);
    let i_a = c.element_currents()[7];
    let i_b = c.element_currents()[10];
    assert!(
        close(i_a, 5.0 / 1000.05, 1e-6),
        "unlabelled contact A should stay closed, got {i_a}"
    );
    assert!(
        close(i_b, 5.0 / 1000.05, 1e-6),
        "unlabelled contact B should stay closed, got {i_b}"
    );
}

#[test]
fn relay_label_string_still_pairs() {
    // The upstream constructor default "label" is a real label and must keep
    // driving its contact; only the empty string means unlabelled.
    let c = &mut coil_contact_pair("label", "label", "");
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

// ─── FLAG_PULLDOWN (RelayElm.java:43) ───

/// A pulldown probe: the pole hangs off a 5 V rail through 1 k and each throw
/// carries a 1 k load to ground. `wiring` picks which throws are actually
/// wired: `Some(true)` wires only the NO throw (post 2), `Some(false)` only
/// the NC throw (post 1), `None` both. The coil is driven at 16 mA, inside
/// the 15..20 mA pick-up/drop-out band, so a `set_state`-forced throw holds
/// still instead of drifting back to rest. Relay post order: pole, throw1
/// (NC), throw2 (NO), coil0, coil1; the relay is element index 2 after two
/// two-terminal parts, so its terminals sit at node offset 4.
fn pulldown_relay(flags: i64, wiring: Option<bool>, relay_params: &[(&str, f64)]) -> Circuit {
    let mut el = vec![
        elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 5.0)]),
        elm(
            2,
            "resistor",
            &[[0, 0], [200, 0]],
            &[("resistance", 1000.0)],
        ),
        elm_flags(
            3,
            "relay",
            &[[200, 0], [300, 16], [300, -16], [400, 32], [400, 48]],
            relay_params,
            flags,
        ),
        elm(4, "ground", &[[0, 100]], &[]),
    ];
    let mut id = 5;
    if wiring != Some(true) {
        el.push(elm(
            id,
            "resistor",
            &[[300, 16], [300, 96]],
            &[("resistance", 1000.0)],
        ));
        id += 1;
        el.push(elm(id, "ground", &[[300, 96]], &[]));
        id += 1;
    }
    if wiring != Some(false) {
        el.push(elm(
            id,
            "resistor",
            &[[300, -16], [300, -96]],
            &[("resistance", 1000.0)],
        ));
        id += 1;
        el.push(elm(id, "ground", &[[300, -96]], &[]));
        id += 1;
    }
    // Coil drive: 1.6 V through the 80 ohm series resistor into the 20 ohm
    // coil puts 16 mA through it at the operating point, inside the band.
    el.push(elm(
        id,
        "voltage",
        &[[500, 100], [500, 0]],
        &[("maxVoltage", 1.6)],
    ));
    id += 1;
    el.push(elm(id, "ground", &[[500, 100]], &[]));
    id += 1;
    el.push(elm(
        id,
        "resistor",
        &[[500, 0], [400, 32]],
        &[("resistance", 80.0)],
    ));
    id += 1;
    el.push(elm(id, "ground", &[[400, 48]], &[]));
    build(el, opts(1e-4, true))
}

#[test]
fn relay_pulldown_grounds_the_unwired_throw() {
    // FLAG_PULLDOWN stamps a constant r_off from every throw post to ground
    // (RelayElm.java:394-401) and doStep then drops the pole-to-unselected-
    // throw r_off (RelayElm.java:468-473). An unwired throw must therefore
    // read exactly 0 V in either settled position while the wired one keeps
    // its divider potential near half the rail.
    let c = &mut pulldown_relay(16, Some(false), &[]);
    assert!(c.set_state(3, 0));
    c.run(20);
    let nodes = c.element_nodes();
    let v_nc = c.node_voltages()[nodes[4 + 1] as usize];
    let v_no = c.node_voltages()[nodes[4 + 2] as usize];
    // The wired divider reads 5 V through 1000 + r_on against its 1 k load,
    // which the pulldown turns into 1k || 1e6.
    assert!(close(v_nc, 2.49869, 1e-3), "wired NC throw was {v_nc}");
    assert!(
        v_no.abs() < 1e-9,
        "unwired NO throw should be grounded, got {v_no}"
    );

    // Position 1 mirrors: pole closed onto the wired NO throw.
    let c = &mut pulldown_relay(16, Some(true), &[]);
    assert!(c.set_state(3, 1));
    c.run(20);
    let nodes = c.element_nodes();
    let v_nc = c.node_voltages()[nodes[4 + 1] as usize];
    let v_no = c.node_voltages()[nodes[4 + 2] as usize];
    assert!(close(v_no, 2.49869, 1e-3), "wired NO throw was {v_no}");
    assert!(
        v_nc.abs() < 1e-9,
        "unwired NC throw should be grounded, got {v_nc}"
    );
}

#[test]
fn relay_without_pulldown_keeps_the_throw_coupled() {
    // With the flag clear doStep keeps stamping the pole-to-unselected-throw
    // r_off (RelayElm.java:468-483), so the same unwired throw rides at the
    // pole's potential instead of being pulled down: no current can leave a
    // dead-ended r_off, so it sits at the pole voltage exactly. Guarded in
    // both directions because either position must keep the old coupling.
    let c = &mut pulldown_relay(0, Some(false), &[]);
    assert!(c.set_state(3, 0));
    c.run(20);
    let nodes = c.element_nodes();
    let v_pole = c.node_voltages()[nodes[4] as usize];
    let v_no = c.node_voltages()[nodes[4 + 2] as usize];
    assert!(
        close(v_no, v_pole, 1e-9),
        "NO throw was {v_no}, pole {v_pole}"
    );
    assert!(v_no > 2.0, "NO throw should track the pole, got {v_no}");

    let c = &mut pulldown_relay(0, Some(true), &[]);
    assert!(c.set_state(3, 1));
    c.run(20);
    let nodes = c.element_nodes();
    let v_pole = c.node_voltages()[nodes[4] as usize];
    let v_nc = c.node_voltages()[nodes[4 + 1] as usize];
    assert!(
        close(v_nc, v_pole, 1e-9),
        "NC throw was {v_nc}, pole {v_pole}"
    );
    assert!(v_nc > 2.0, "NC throw should track the pole, got {v_nc}");
}

#[test]
fn relay_midtravel_stamps_both_throws_whatever_the_flag() {
    // The intermediate position pins the pole to BOTH throws through r_off
    // regardless of FLAG_PULLDOWN: the else arm carries no needsPulldown
    // guard (RelayElm.java:474-482). With both throws loaded the added
    // pulldowns are 1e6 parallel 1k and move nothing measurable, so the flag
    // and no-flag builds must agree: the pole sits at 4.990 V and each throw
    // tracks it down its branch, near 5 mV, instead of reading 0 V.
    //
    // set_state cannot hold this position (it zeroes d_position, which
    // start_iteration collapses straight to rest), so the state comes from
    // the file token like relay_file_state_is_restored does, and the large
    // switching time keeps d_position mid-travel for the whole run.
    let params = &[("position", 2.0), ("switchingTime", 50.0)];
    let mut circuits = [
        pulldown_relay(0, None, params),
        pulldown_relay(16, None, params),
    ];
    for c in &mut circuits {
        c.run(20);
        let nodes = c.element_nodes();
        let volts = |off: usize| c.node_voltages()[nodes[off] as usize];
        let (v_pole, v_nc, v_no) = (volts(4), volts(5), volts(6));
        assert!(close(v_pole, 4.9900, 1e-3), "pole was {v_pole}");
        assert!(close(v_nc, 4.985e-3, 5e-4), "NC throw was {v_nc}");
        assert!(close(v_no, 4.985e-3, 5e-4), "NO throw was {v_no}");
    }
    // The two builds differ only by 1e6 pulldowns in parallel with 1k loads.
    let (a, b) = (&circuits[0], &circuits[1]);
    let worst = a
        .node_voltages()
        .iter()
        .zip(b.node_voltages())
        .map(|(x, y)| (x - y).abs())
        .fold(0.0, f64::max);
    assert!(worst < 1e-5, "mid-travel builds diverged by {worst}");
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
        preserve_run: false,
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
        preserve_run: false,
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

/// A type-N 425 coil labelled Q1 driving one normally-closed contact in a
/// 1 k divider across 5 V. The coil hangs on its own drive source through
/// wires; a lowered inductance puts the L/R time constant at 1 ms so the
/// pick-up ramp and release decay settle within a couple of milliseconds,
/// keeping the delay edges under test well clear of the electrical ones.
/// Element indices: 0 = coil drive, 1 = coil, 7 = contact series resistor.
fn typed_coil(coil_type: f64, switching_time: f64) -> Circuit {
    let mut spec = CircuitSpec {
        preserve_run: false,
        elements: vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 0.0)]),
            elm(
                2,
                "relayCoil",
                &[[100, 0], [100, 100]],
                &[
                    ("type", coil_type),
                    ("switchingTime", switching_time),
                    ("inductance", 0.02),
                ],
            ),
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
            elm_flags(9, "relayContact", &[[300, 0], [300, 100]], &[], 2),
            elm(10, "ground", &[[300, 100]], &[]),
        ],
        options: Some(opts(1e-4, true)),
        scopes: Vec::new(),
    };
    spec.elements[1].label = Some("Q1".to_string());
    spec.elements[8].label = Some("Q1".to_string());
    let mut c = Circuit::new();
    c.set_circuit(&spec).expect("circuit should analyse");
    c
}

#[test]
fn relay_on_delay_coil_switches_only_after_its_delay() {
    // Type 1 delays the pick-up by switchingTime and drops out with none
    // (RelayCoilElm.java:284-287). Driven at 2 V the coil current crosses
    // the filtered on-current inside a millisecond, so the contact must
    // still be closed at 12 ms, open past the 20 ms edge, and closed again
    // immediately on drop-out.
    let c = &mut typed_coil(1.0, 0.02);
    c.set_param(1, "maxVoltage", 2.0);
    c.run(120);
    assert!(
        close(c.element_currents()[7], 5.0 / 1000.05, 1e-6),
        "on-delay contact fired early: {}",
        c.element_currents()[7]
    );
    c.run(200);
    assert!(
        c.element_currents()[7].abs() < 1e-5,
        "on-delay contact did not fire after its delay: {}",
        c.element_currents()[7]
    );
    // The off edge carries no delay: one short run closes it again.
    c.set_param(1, "maxVoltage", 0.0);
    c.run(60);
    assert!(
        close(c.element_currents()[7], 5.0 / 1000.05, 1e-6),
        "on-delay contact did not drop out instantly: {}",
        c.element_currents()[7]
    );
}

#[test]
fn relay_off_delay_coil_picks_up_at_once_and_holds_past_drop_out() {
    // Type 2 is the mirror: no pick-up delay, switchingTime of hold after
    // the coil current falls away (RelayCoilElm.java:287-290). The contact
    // opens within milliseconds of energising, stays open through the hold
    // window after de-energising, and only recloses once the window ends.
    let c = &mut typed_coil(2.0, 0.02);
    c.set_param(1, "maxVoltage", 2.0);
    c.run(60);
    assert!(
        c.element_currents()[7].abs() < 1e-5,
        "off-delay contact should open without an on delay: {}",
        c.element_currents()[7]
    );
    c.set_param(1, "maxVoltage", 0.0);
    c.run(80);
    assert!(
        c.element_currents()[7].abs() < 1e-5,
        "off-delay contact released before its hold elapsed: {}",
        c.element_currents()[7]
    );
    c.run(300);
    assert!(
        close(c.element_currents()[7], 5.0 / 1000.05, 1e-6),
        "off-delay contact did not reclose after its hold: {}",
        c.element_currents()[7]
    );
}

/// A type-4 set coil and a type-5 reset coil sharing the label Q1, both
/// driving one normally-closed contact. Set/reset coils skip the resting
/// announcement, so the contact starts where its file put it (closed) and
/// moves only when a coil actually fires. Element indices: 0 = set drive,
/// 1 = set coil, 5 = reset drive, 6 = reset coil, 12 = contact resistor.
fn set_reset_pair() -> Circuit {
    let mut spec = CircuitSpec {
        preserve_run: false,
        elements: vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 0.0)]),
            elm(
                2,
                "relayCoil",
                &[[100, 0], [100, 100]],
                &[
                    ("type", 4.0),
                    ("switchingTime", 0.005),
                    ("inductance", 0.02),
                ],
            ),
            elm(3, "wire", &[[0, 0], [100, 0]], &[]),
            elm(4, "wire", &[[100, 100], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
            elm(6, "voltage", &[[0, 300], [0, 200]], &[("maxVoltage", 0.0)]),
            elm(
                7,
                "relayCoil",
                &[[100, 200], [100, 300]],
                &[
                    ("type", 5.0),
                    ("switchingTime", 0.005),
                    ("inductance", 0.02),
                ],
            ),
            elm(8, "wire", &[[0, 200], [100, 200]], &[]),
            elm(9, "wire", &[[100, 300], [0, 300]], &[]),
            elm(10, "ground", &[[0, 300]], &[]),
            elm(
                11,
                "voltage",
                &[[400, -96], [400, 0]],
                &[("maxVoltage", 5.0)],
            ),
            elm(12, "ground", &[[400, -96]], &[]),
            elm(
                13,
                "resistor",
                &[[400, 0], [300, 0]],
                &[("resistance", 1000.0)],
            ),
            elm_flags(14, "relayContact", &[[300, 0], [300, 100]], &[], 2),
            elm(15, "ground", &[[300, 100]], &[]),
        ],
        options: Some(opts(1e-4, true)),
        scopes: Vec::new(),
    };
    for id in [1usize, 6, 13] {
        spec.elements[id].label = Some("Q1".to_string());
    }
    let mut c = Circuit::new();
    c.set_circuit(&spec).expect("circuit should analyse");
    c
}

#[test]
fn relay_set_and_reset_coils_drive_their_contact_both_ways() {
    // The set coil (type 4) drives matching contacts to the energised-on
    // position when it fires and never touches them again; the reset coil
    // (type 5) drives them to the energised-off position (RelayCoilElm.java:
    // 319-326). Together they form the upstream relay flip-flop: set opens
    // the normally-closed contact and it latches open after the set coil
    // drops out, then the reset coil closes it again.
    let c = &mut set_reset_pair();
    c.set_param(1, "maxVoltage", 2.0);
    c.run(30);
    assert!(
        close(c.element_currents()[12], 5.0 / 1000.05, 1e-6),
        "set coil fired before its delay: {}",
        c.element_currents()[12]
    );
    c.run(150);
    assert!(
        c.element_currents()[12].abs() < 1e-5,
        "set coil did not open the contact: {}",
        c.element_currents()[12]
    );
    // Drop the set coil out: a latching type keeps its switchPosition, so
    // the contact holds open with no coil energised.
    c.set_param(1, "maxVoltage", 0.0);
    c.run(250);
    assert!(
        c.element_currents()[12].abs() < 1e-5,
        "the set state did not latch: {}",
        c.element_currents()[12]
    );
    // Now the reset coil fires and drives the contact back.
    c.set_param(6, "maxVoltage", 2.0);
    c.run(150);
    assert!(
        close(c.element_currents()[12], 5.0 / 1000.05, 1e-6),
        "reset coil did not restore the contact: {}",
        c.element_currents()[12]
    );
}

// ─── Transformers ────────────────────────────────────────────────────────────
