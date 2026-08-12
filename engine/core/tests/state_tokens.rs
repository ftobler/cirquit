//! Live state tokens and their round trip through save/load for capacitors, inductors, transistors, SCRs and transformers.

use circuit_core::{Circuit, ElementSpec};

mod common;
use common::*;

/// Builds `specs`, runs `steps`, captures `Circuit::state_tokens`, rebuilds a
/// second circuit from the same specs with those tokens written back into the
/// params, runs one step and returns both circuits' node voltages. A
/// base-relative conversion sign error (the transistor's swap, the SCR's
/// anchor signs) shows up as the second circuit diverging from the first.
fn round_trip_specs(specs: &[ElementSpec], dt: f64, steps: u32) -> (Vec<f64>, Vec<f64>) {
    let options = opts(dt, false);
    let mut a = build(specs.to_vec(), options.clone());
    a.run(steps);
    let before = a.node_voltages().to_vec();
    let tokens = a.state_tokens();
    let rebuilt: Vec<ElementSpec> = specs
        .iter()
        .cloned()
        .zip(tokens.iter())
        .map(|(mut spec, toks)| {
            for (k, v) in toks {
                spec.params.insert(k.clone(), *v);
            }
            spec
        })
        .collect();
    let mut b = build(rebuilt, options);
    b.run(1);
    (before, b.node_voltages().to_vec())
}

fn assert_round_trip_tracks(before: &[f64], after: &[f64]) {
    assert_eq!(before.len(), after.len(), "rebuild renumbered the nodes");
    for (i, (a, b)) in before.iter().zip(after.iter()).enumerate() {
        assert!(
            close(*a, *b, 0.05),
            "node {i} diverged after the rebuild: live {a}, rebuilt {b}"
        );
    }
}

#[test]
fn resistor_and_wire_report_no_state_tokens() {
    // Everything without an operating-point token in the format stays silent:
    // the default empty vector is what makes the read-back cheap and keeps the
    // save path identical for the bulk of element kinds.
    let c = &mut build(
        vec![
            elm(
                1,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(2, "wire", &[[100, 0], [100, 100]], &[]),
        ],
        opts(1e-5, false),
    );
    c.run(10);
    let tokens = c.state_tokens();
    assert!(tokens[0].is_empty(), "resistor reported tokens");
    assert!(tokens[1].is_empty(), "wire reported tokens");
}

#[test]
fn capacitor_volt_diff_token_follows_the_live_charge() {
    // A cap seeded at voltDiff 5 in the 10 V RC charges up its time constant;
    // the token must report where the charge actually is, not the load-time 5,
    // or a mid-transient save would write the stale value. One tau from the
    // 5 V seed lands at 10 - 5/e = 8.16 V.
    let c = &mut restored_charge_circuit(1e-6, false);
    c.run(1000); // one tau
    let cap = c.state_tokens()[2]
        .iter()
        .find(|(k, _)| k == "voltDiff")
        .map(|(_, v)| *v)
        .expect("capacitor reported no voltDiff token");
    assert!(
        close(cap, 10.0 - 5.0 * (-1.0f64).exp(), 0.1),
        "voltDiff token stuck at the load value, read {cap}"
    );
}

#[test]
fn capacitor_round_trip_preserves_the_live_charge() {
    let specs = vec![
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
    ];
    let (before, after) = round_trip_specs(&specs, 1e-6, 1000);
    assert_round_trip_tracks(&before, &after);
}

#[test]
fn inductor_current_token_equals_the_loop_current() {
    // The RL loop climbs toward 5/100 = 0.05 A; the `current` token must be
    // exactly the loop current the element reports, since that is what a save
    // would write and a load would restore.
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
    c.run(100);
    let reported = c.element_currents()[2];
    let token = c.state_tokens()[2]
        .iter()
        .find(|(k, _)| k == "current")
        .map(|(_, v)| *v)
        .expect("inductor reported no current token");
    assert!(
        close(reported, token, 1e-9),
        "current token {token} diverged from the loop current {reported}"
    );
    assert!(
        reported > 0.02,
        "loop current {reported} too small to be meaningful"
    );
}

#[test]
fn inductor_round_trip_preserves_the_live_current() {
    let specs = vec![
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
    ];
    let (before, after) = round_trip_specs(&specs, 1e-7, 100);
    assert_round_trip_tracks(&before, &after);
}

#[test]
fn transistor_round_trip_preserves_the_node_differences() {
    // The transistor's file tokens are node differences, not its internal
    // fields (the constructor swaps and polarity-scales them). A sign error in
    // the base-relative conversion seeds the collector and emitter the wrong
    // way and the rebuild lands somewhere else entirely.
    let specs = vec![
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
            &[("pnp", 1.0), ("beta", 100.0)],
        ),
        elm(5, "ground", &[[200, 100]], &[]),
    ];
    let (before, after) = round_trip_specs(&specs, 1e-5, 50);
    assert_round_trip_tracks(&before, &after);
}

#[test]
fn scr_anchors_track_the_node_differences_and_round_trip() {
    // The SCR's file tokens are the last anode-minus-terminal voltages, which
    // the constructor reads directly and the seed applies as the cathode and
    // gate negatives. The latch itself is not a file quantity (upstream dumps
    // only the anchors), so the round-trip is done in the blocked state, where
    // the first step after the rebuild does not depend on the un-persisted
    // on-state resistor.
    let dt = 1e-5;
    let specs = vec![
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
    ];
    let options = opts_budget(dt, false, 100);
    let mut a = build(specs.clone(), options.clone());
    a.run(20); // blocked: anode near the full 2 V supply

    // The anchors must be exactly the node differences, the sign the seed
    // converts into the cathode and gate negatives.
    let anchors = a.state_tokens()[2].clone();
    let get = |name: &str| {
        anchors
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| *v)
            .unwrap_or_else(|| panic!("SCR reported no {name} token"))
    };
    let (vac, vag) = (get("lastvac"), get("lastvag"));
    // The SCR is element index 2; its three terminal nodes start at offset
    // 2 + 2 = 4 in the flattened element_nodes array (voltage, resistor).
    let nodes = a.element_nodes();
    let v = a.node_voltages();
    let (na, nc, ng) = (nodes[4] as usize, nodes[5] as usize, nodes[6] as usize);
    assert!(
        close(vac, v[na] - v[nc], 1e-9),
        "lastvac {vac} != V(a)-V(c) = {}",
        v[na] - v[nc]
    );
    assert!(
        close(vag, v[na] - v[ng], 1e-9),
        "lastvag {vag} != V(a)-V(g) = {}",
        v[na] - v[ng]
    );
    assert!(
        close(vac, 2.0, 0.05),
        "blocked SCR lastvac {vac}, expected near the full 2 V supply"
    );

    // Round-trip: the seeded anchors (against the pinned cathode and gate)
    // must reproduce the blocked state after one step.
    let before = a.node_voltages().to_vec();
    let rebuilt: Vec<ElementSpec> = specs
        .iter()
        .cloned()
        .zip(a.state_tokens().iter())
        .map(|(mut spec, toks)| {
            for (k, v) in toks {
                spec.params.insert(k.clone(), *v);
            }
            spec
        })
        .collect();
    let mut b = build(rebuilt, options);
    b.run(1);
    assert_round_trip_tracks(&before, b.node_voltages());
}

#[test]
fn transformer_reports_all_winding_currents() {
    // A 1:1 transformer with a loaded secondary: both windings carry real
    // current, so both tokens must be reported, named by winding order.
    let dt = 1e-5;
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 10.0)]),
            elm(2, "resistor", &[[0, 0], [100, 0]], &[("resistance", 1.0)]),
            elm(
                3,
                "transformer",
                &[[100, 0], [200, 0], [100, 100], [200, 100]],
                &[("inductance", 4.0), ("ratio", 1.0), ("couplingCoef", 0.999)],
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
    );
    c.run(200);
    let tokens = &c.state_tokens()[2];
    let get = |name: &str| {
        tokens
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| *v)
            .unwrap_or_else(|| panic!("transformer reported no {name} token"))
    };
    let i0 = get("current0");
    let i1 = get("current1");
    assert!(i0.abs() > 1e-3, "primary current {i0} too small");
    assert!(i1.abs() > 1e-3, "secondary current {i1} too small");
}

#[test]
fn damped_ideal_capacitor_reports_the_validate_series_resistance() {
    // The parallel ideal pair: validate gives one member a 0.1 ohm series
    // resistance, which only ever lived in engine state before. The read-back
    // must surface it, or a save would write the params' 0 and the next build
    // would re-damp the walk all over again.
    let c = &mut parallel_ideal_pair(1e-6);
    c.run(200);
    let tokens = c.state_tokens();
    let sr = |i: usize| {
        tokens[i]
            .iter()
            .find(|(k, _)| k == "seriesResistance")
            .map(|(_, v)| *v)
            .expect("capacitor reported no seriesResistance token")
    };
    assert!(
        close(sr(0), 0.1, 1e-12),
        "damped member's seriesResistance token was {}",
        sr(0)
    );
    assert!(
        close(sr(1), 0.0, 1e-12),
        "ideal member's seriesResistance token was {}",
        sr(1)
    );
}

#[test]
fn live_operating_tokens_follow_the_running_state() {
    // One circuit holding the scalar-token kinds, asserting each reports where
    // its live state actually is: the memristor's dopeWidth grows, the lamp
    // warms off room temperature, the fuse's heat rises, the gate outputs its
    // high level, the flip-flop's saved pin flips, and the triac latches.

    // Memristor under constant current: dopeWidth grows (memristor test
    // pattern). After 10 steps the width is 8 nm, well off the default 0.
    let c = &mut build(
        vec![
            elm(1, "current", &[[0, 0], [100, 0]], &[("current", 1e-3)]),
            elm(
                2,
                "memristor",
                &[[100, 0], [200, 0]],
                &[
                    ("r_on", 100.0),
                    ("r_off", 16000.0),
                    ("totalWidth", 1e-8),
                    ("mobility", 1e-10),
                ],
            ),
            elm(3, "ground", &[[0, 0]], &[]),
            elm(4, "ground", &[[200, 0]], &[]),
        ],
        opts(1e-6, false),
    );
    c.run(10);
    let dope = c.state_tokens()[1]
        .iter()
        .find(|(k, _)| k == "dopeWidth")
        .map(|(_, v)| *v)
        .expect("memristor reported no dopeWidth token");
    assert!(dope > 0.5e-8, "memristor dopeWidth {dope} did not grow");

    // Fuse under sustained overcurrent: heat accumulates toward i2t. The 3 A
    // case pops a 1 A^2*s fuse in ~116 steps; 10 steps in it must have warmed.
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
        opts(1e-3, false),
    );
    c.run(10);
    let heat = c.state_tokens()[1]
        .iter()
        .find(|(k, _)| k == "heat")
        .map(|(_, v)| *v)
        .expect("fuse reported no heat token");
    assert!(heat > 0.0, "fuse heat {heat} did not rise");

    // Gate: a high AND output after settling reports lastOutputVoltage at the
    // high level, so a save writes the live output, not the load-time 0.
    let c = &mut build(
        vec![
            elm(1, "rail", &[[0, -16]], &[("maxVoltage", 5.0)]),
            elm(2, "rail", &[[0, 16]], &[("maxVoltage", 5.0)]),
            elm(3, "andGate", &[[0, -16], [0, 16], [96, 0]], &[]),
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
    let lo = c.state_tokens()[2]
        .iter()
        .find(|(k, _)| k == "lastOutputVoltage")
        .map(|(_, v)| *v)
        .expect("gate reported no lastOutputVoltage token");
    assert!(
        close(lo, 5.0, 1e-9),
        "gate lastOutputVoltage {lo}, expected 5"
    );

    // D flip-flop: the saved Q pin (index 1) flips after a clock with D high.
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
    let q_token = |c: &Circuit| {
        c.state_tokens()[2]
            .iter()
            .find(|(k, _)| k == "voltage1")
            .map(|(_, v)| *v)
            .expect("dFlipFlop reported no voltage1 token")
    };
    assert!(
        close(q_token(c), 0.0, 1e-9),
        "fresh Q token was {}, expected low",
        q_token(c)
    );
    clock_cycle(c, 2);
    assert!(
        close(q_token(c), 5.0, 1e-9),
        "Q token was {} after the clock, expected high",
        q_token(c)
    );

    // Triac: after a gate pulse the latch reports state on, and a blocked
    // triac reports it off.
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
    let triac_state = |c: &Circuit| {
        c.state_tokens()[2]
            .iter()
            .find(|(k, _)| k == "state")
            .map(|(_, v)| *v)
            .expect("triac reported no state token")
    };
    assert_eq!(triac_state(c), 0.0, "blocked triac reported latched");
    assert!(c.set_param(6, "maxVoltage", 3.0), "gate pulse refused");
    c.run(5);
    assert_eq!(triac_state(c), 1.0, "fired triac reported unlatched");

    // Lamp: sustained voltage warms the filament off ROOM_TEMP. The lamp test
    // at line 616 uses the same shape; a few hundred steps is plenty to move.
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 120.0)]),
            elm(
                2,
                "lamp",
                &[[0, 0], [0, 100]],
                &[
                    ("nomPower", 100.0),
                    ("nomVoltage", 120.0),
                    ("warmTime", 0.4),
                    ("coolTime", 0.4),
                ],
            ),
            elm(3, "ground", &[[0, 100]], &[]),
        ],
        opts(1e-4, false),
    );
    c.run(500);
    let temp = c.state_tokens()[1]
        .iter()
        .find(|(k, _)| k == "temp")
        .map(|(_, v)| *v)
        .expect("lamp reported no temp token");
    assert!(
        temp > 300.0 + 10.0,
        "lamp temp {temp} did not leave ROOM_TEMP"
    );
}
