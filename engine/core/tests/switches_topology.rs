//! Switches, the AC source, potentiometer, labeled nodes, and the solver's handling of floating nodes, wires and grounds.

use circuit_core::{Circuit, CircuitSpec, ScopeValue};

mod common;
use common::*;

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
fn closing_a_switch_that_grounds_the_last_node_does_not_panic_on_the_next_step() {
    // The switch's far terminal sits on the same coordinate as the ground
    // symbol and the source's own grounded post. Open, the source's other
    // terminal is a distinct, healthy non-ground node; closing the switch is
    // a removable wire that collapses that terminal onto ground too, leaving
    // a live voltage source with nowhere to route its row (the same
    // degenerate topology `all_ground_voltage_source_is_rejected_at_set_circuit`
    // covers at set_circuit, transformer_matrix.rs). This reaches it through
    // set_state's reanalyze path instead, which has no Result to report
    // failure through and used to leave a stale, larger closure list in
    // place for the very next run() to index the shrunk node voltages with
    // and panic.
    let mut c = build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 10.0)]),
            elm(2, "ground", &[[0, 0]], &[]),
            elm(3, "switch", &[[0, 100], [0, 0]], &[("position", 1.0)]),
        ],
        opts(1e-5, false),
    );
    c.run(1);

    assert!(c.set_state(3, 0));
    assert!(
        c.error().is_some(),
        "the degenerate closure should surface as an error"
    );
    assert!(
        c.closure_rows().is_empty(),
        "closures survived a rejected reanalyze"
    );

    // The critical assertion: stepping after the rejected reanalyze must not
    // panic against the stale, larger closure list.
    let report = c.run(3);
    assert!(
        report.converged,
        "the empty-closures no-op path should not report a failed step"
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
fn wire_into_a_pure_ground_reports_its_current() {
    // A wire whose post 0 sits at a node holding only a ground symbol used to
    // recover zero: the ground is excluded from the KCL injection, and the
    // chain resolver tried the post 0 end first and read an empty leaf. The
    // reference plane spans several coordinates, so such a wire really carries
    // the branch current; it must resolve from its driven end. Reversing the
    // wire is the same circuit, so the magnitude must not change.
    let make = |flipped: bool| {
        let posts = if flipped {
            [[128, 64], [64, 64]]
        } else {
            [[64, 64], [128, 64]]
        };
        build(
            vec![
                elm(1, "voltage", &[[0, 64], [0, 0]], &[("maxVoltage", 5.0)]),
                elm(2, "ground", &[[0, 0]], &[]),
                elm(
                    3,
                    "resistor",
                    &[[0, 64], [64, 64]],
                    &[("resistance", 1000.0)],
                ),
                elm(4, "wire", &posts, &[]),
                elm(5, "ground", &[[128, 64]], &[]),
            ],
            opts(1e-5, true),
        )
    };

    let mut c = make(false);
    c.run(5);
    assert!(
        close(c.element_currents()[3], -5e-3, 1e-9),
        "wire into a pure ground reported {}",
        c.element_currents()[3]
    );

    let mut c = make(true);
    c.run(5);
    assert!(
        close(c.element_currents()[3], 5e-3, 1e-9),
        "flipped wire into a pure ground reported {}",
        c.element_currents()[3]
    );
}

#[test]
fn wires_off_a_rail_carry_the_rail_current() {
    // The bundled 'Voltage Reference w/ Follower' (zenerreffollow.txt): a rail
    // feeds a divider through two wires, and the emitter drives R500 through
    // two more. The rail is a one-post source to ground whose post used to
    // inject nothing into the wire-current recovery (the default
    // `current_into_node` reads zero for a one-post element), so the first
    // wire reported zero and the second resolved against a missing rail
    // current and came out sign-flipped: no dots, or dots running the wrong
    // way, fixed by reversing the wire. Each wire must instead report the
    // branch current of the element it feeds.
    let mut c = build(
        vec![
            elm(
                1,
                "rail",
                &[[240, 128]],
                &[
                    ("waveform", 1.0),
                    ("frequency", 40.0),
                    ("maxVoltage", 2.0),
                    ("bias", 8.8),
                ],
            ),
            elm(2, "wire", &[[240, 128], [320, 128]], &[]),
            elm(
                3,
                "resistor",
                &[[320, 128], [320, 208]],
                &[("resistance", 10000.0)],
            ),
            elm(
                4,
                "transistor",
                &[[320, 208], [400, 192], [400, 224]],
                &[("pnp", 1.0), ("beta", 100.0)],
            ),
            elm(
                5,
                "resistor",
                &[[400, 128], [400, 192]],
                &[("resistance", 100.0)],
            ),
            elm(6, "wire", &[[320, 128], [400, 128]], &[]),
            elm(
                7,
                "zener",
                &[[320, 320], [320, 208]],
                &[("breakdownVoltage", 5.6)],
            ),
            elm(8, "wire", &[[400, 224], [400, 256]], &[]),
            elm(9, "wire", &[[400, 256], [448, 256]], &[]),
            elm(
                10,
                "resistor",
                &[[448, 256], [448, 320]],
                &[("resistance", 500.0)],
            ),
            elm(11, "ground", &[[448, 320]], &[]),
            elm(12, "ground", &[[320, 320]], &[]),
        ],
        opts(1e-5, true),
    );
    c.run(5);

    let i = c.element_currents();
    // rail = wire1 = the whole feed; wire2 = the collector branch.
    assert!(close(i[1], i[0], 1e-9), "wire off the rail took {}", i[1]);
    assert!(i[1] > 1e-3, "wire off the rail carried {:.2e}", i[1]);
    assert!(close(i[5], i[4], 1e-9), "second wire took {}", i[5]);
    assert!(i[5] > 1e-3, "second wire carried {:.2e}", i[5]);
    // emitter wire and the wire into R500 both carry the emitter current.
    assert!(close(i[7], i[9], 1e-9), "emitter wire took {}", i[7]);
    assert!(i[7] > 1e-3, "emitter wire carried {:.2e}", i[7]);
    assert!(close(i[8], i[9], 1e-9), "wire into R500 took {}", i[8]);

    // Reversing the first wire is the same circuit: the sign flips, the
    // magnitude does not.
    let mut c = build(
        vec![
            elm(
                1,
                "rail",
                &[[240, 128]],
                &[
                    ("waveform", 1.0),
                    ("frequency", 40.0),
                    ("maxVoltage", 2.0),
                    ("bias", 8.8),
                ],
            ),
            elm(2, "wire", &[[320, 128], [240, 128]], &[]),
            elm(
                3,
                "resistor",
                &[[320, 128], [320, 208]],
                &[("resistance", 10000.0)],
            ),
            elm(
                4,
                "transistor",
                &[[320, 208], [400, 192], [400, 224]],
                &[("pnp", 1.0), ("beta", 100.0)],
            ),
            elm(
                5,
                "resistor",
                &[[400, 128], [400, 192]],
                &[("resistance", 100.0)],
            ),
            elm(6, "wire", &[[320, 128], [400, 128]], &[]),
            elm(
                7,
                "zener",
                &[[320, 320], [320, 208]],
                &[("breakdownVoltage", 5.6)],
            ),
            elm(8, "wire", &[[400, 224], [400, 256]], &[]),
            elm(9, "wire", &[[400, 256], [448, 256]], &[]),
            elm(
                10,
                "resistor",
                &[[448, 256], [448, 320]],
                &[("resistance", 500.0)],
            ),
            elm(11, "ground", &[[448, 320]], &[]),
            elm(12, "ground", &[[320, 320]], &[]),
        ],
        opts(1e-5, true),
    );
    c.run(5);
    let i = c.element_currents();
    assert!(
        close(i[1], -i[0], 1e-9),
        "flipped wire off the rail took {}",
        i[1]
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

// The ground-current tests below use rails where the ground must carry the
// current. A two-terminal voltage source closes its loop through the circuit
// elements, so a single ground attached to it is only a reference node and
// reads 0; the ground genuinely sinks a current only when the return path is
// through the reference, which a rail (whose negative terminal is the
// reference already) provides. The plan reads "5 V source" loosely; its own
// case 2 says "6 V rail" for exactly this reason.

#[test]
fn ground_reports_the_current_it_sinks() {
    // A 5 V rail drives 1 kΩ into a ground symbol, so the ground is the
    // current's only sink and must report 5 mA, positive flowing from the
    // node down the stem into earth.
    let c = &mut build(
        vec![
            elm(1, "rail", &[[0, 0]], &[("maxVoltage", 5.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(3, "ground", &[[100, 0]], &[]),
        ],
        opts(1e-5, true),
    );
    c.run(5);
    assert!(
        close(c.element_currents()[2], 5e-3, 1e-9),
        "ground current was {}",
        c.element_currents()[2]
    );
}

#[test]
fn scope_on_a_ground_samples_the_recovered_current() {
    // The scope sampling path reads the ground's recovered `base.current`
    // (circuit.rs:1362), so a current trace on a ground symbol must see the
    // same 5 mA the element readout reports, exactly like any other element.
    let c = &mut build_with(
        vec![
            elm(1, "rail", &[[0, 0]], &[("maxVoltage", 5.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(3, "ground", &[[100, 0]], &[]),
        ],
        opts(1e-5, true),
        vec![tr_scope(3, ScopeValue::Current, 0)],
    );
    c.run(5);
    assert!(
        close(c.element_currents()[2], 5e-3, 1e-9),
        "ground current was {}",
        c.element_currents()[2]
    );
    assert!(
        close(last_sample(c, 0), 5e-3, 1e-9),
        "scope sampled {}",
        last_sample(c, 0)
    );
}

#[test]
fn ground_sums_every_branch_at_its_coordinate() {
    // A 6 V rail into 1 kΩ and 2 kΩ, both returning to one ground: the ground
    // must report the sum of the two branch currents, 6 mA + 3 mA = 9 mA.
    let c = &mut build(
        vec![
            elm(1, "rail", &[[0, 0]], &[("maxVoltage", 6.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(
                3,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 2000.0)],
            ),
            elm(4, "ground", &[[100, 0]], &[]),
        ],
        opts(1e-5, true),
    );
    c.run(5);
    assert!(
        close(c.element_currents()[1], 6e-3, 1e-9),
        "first branch was {}",
        c.element_currents()[1]
    );
    assert!(
        close(c.element_currents()[2], 3e-3, 1e-9),
        "second branch was {}",
        c.element_currents()[2]
    );
    assert!(
        close(c.element_currents()[3], 9e-3, 1e-9),
        "ground current was {}",
        c.element_currents()[3]
    );
}

#[test]
fn wire_between_resistor_and_ground_keeps_both_currents() {
    // The single-ground case with a wire between the resistor and the ground:
    // the wire recovers 5 mA from the wire graph first, then the ground sums
    // that recovered current at its coordinate. This pins the ordering
    // (ground after wires) and that the ground is excluded from the wire graph.
    let c = &mut build(
        vec![
            elm(1, "rail", &[[0, 0]], &[("maxVoltage", 5.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(3, "wire", &[[100, 0], [100, 100]], &[]),
            elm(4, "ground", &[[100, 100]], &[]),
        ],
        opts(1e-5, true),
    );
    c.run(5);
    assert!(
        close(c.element_currents()[2], 5e-3, 1e-9),
        "wire current was {}",
        c.element_currents()[2]
    );
    assert!(
        close(c.element_currents()[3], 5e-3, 1e-9),
        "ground current was {}",
        c.element_currents()[3]
    );
}

#[test]
fn grounds_on_separate_branches_each_keep_their_own_current() {
    // Two grounds at different coordinates on different branches: each must
    // report its own branch current (6 mA and 3 mA), not the total.
    let c = &mut build(
        vec![
            elm(1, "rail", &[[0, 0]], &[("maxVoltage", 6.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(
                3,
                "resistor",
                &[[0, 0], [200, 0]],
                &[("resistance", 2000.0)],
            ),
            elm(4, "ground", &[[100, 0]], &[]),
            elm(5, "ground", &[[200, 0]], &[]),
        ],
        opts(1e-5, true),
    );
    c.run(5);
    assert!(
        close(c.element_currents()[3], 6e-3, 1e-9),
        "first ground was {}",
        c.element_currents()[3]
    );
    assert!(
        close(c.element_currents()[4], 3e-3, 1e-9),
        "second ground was {}",
        c.element_currents()[4]
    );
}

#[test]
fn grounds_sharing_a_coordinate_split_the_net_evenly() {
    // Two grounds stacked on one coordinate split the coordinate's net evenly,
    // and the halves sum back to the single-ground answer from the rail case.
    let c = &mut build(
        vec![
            elm(1, "rail", &[[0, 0]], &[("maxVoltage", 5.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(3, "ground", &[[100, 0]], &[]),
            elm(4, "ground", &[[100, 0]], &[]),
        ],
        opts(1e-5, true),
    );
    c.run(5);
    let first = c.element_currents()[2];
    let second = c.element_currents()[3];
    assert!(
        close(first, 2.5e-3, 1e-9) && close(second, 2.5e-3, 1e-9),
        "stacked grounds took {first} and {second}"
    );
    assert!(close(first + second, 5e-3, 1e-9));
}

#[test]
fn no_ground_symbol_leaves_wire_recovery_untouched() {
    // The ground pass must not disturb the no-ground-symbol fallback: a
    // divider with no ground symbol still solves (the first node becomes the
    // reference) and its wire still recovers the loop current.
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
        ],
        opts(1e-5, true),
    );
    let report = c.run(5);
    assert!(
        report.converged,
        "no-ground divider failed to solve: {}",
        report.error.unwrap_or_default()
    );
    assert!(!c.warnings().is_empty(), "expected a no-ground warning");
    assert!(
        close(c.element_currents()[1], 5e-3, 1e-9),
        "divider current was {}",
        c.element_currents()[1]
    );
    assert!(
        close(c.element_currents()[3], 5e-3, 1e-9),
        "wire current was {}",
        c.element_currents()[3]
    );
}

#[test]
fn element_post_currents_matches_the_post_major_layout() {
    // The per-post array must be laid out identically to element_nodes, so the
    // renderer indexes both with the same post-offset map. The three entries
    // of the transistor (whose base current is forced to 1e-6 by the current
    // source) must be `current_into_node` at each post: `-ib`, `-ic`, `-ie`.
    let c = &mut build(
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
                    ("saturationCurrent", 1e-13),
                    ("betaReverse", 1.0),
                    ("beta", 100.0),
                ],
            ),
            elm(5, "ground", &[[100, 200]], &[]),
            elm(6, "ground", &[[0, 0]], &[]),
        ],
        opts(1e-5, true),
    );
    c.run(20);

    let posts = c.element_post_currents();
    assert_eq!(
        posts.len(),
        c.element_nodes().len(),
        "per-post array must match the flattened post count"
    );

    // Element order: current source (2 posts), rail (1), resistor (2),
    // transistor (3), two grounds (1 each). The transistor's slice starts at
    // offset 5.
    let ic = c.element_currents()[3];
    let (pb, pc, pe) = (posts[5], posts[6], posts[7]);
    assert!(
        close(pc, -ic, 1e-9),
        "collector post current was {pc}, expected -Ic = {}",
        -ic
    );
    assert!(
        close(pb, -1e-6, 1e-9),
        "base post current was {pb}, expected -Ib = -1e-6"
    );
    // KCL: the three terminal currents sum to zero, so the negated entries do
    // too (-ib - ic - ie = 0). This pins the emitter entry to -ie.
    assert!(
        close(pb + pc + pe, 0.0, 1e-9),
        "terminal currents did not sum to zero: {pb} {pc} {pe}"
    );
}
