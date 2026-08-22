//! The battery's SOC table, coulomb counting and state round trip.

use circuit_core::{Circuit, ElementSpec};

mod common;
use common::*;

/// Upstream's alkaline table, exactly as `batteryTypeTables[BT_ALKALINE]`
/// ships it (BatteryElm.java:47). Used by the analytic tests so the
/// hand-computed interpolation is against the real shipped values.
const ALKALINE_TABLE: &str =
    "0=0.8\n10=0.95\n20=1.05\n40=1.18\n60=1.28\n80=1.38\n90=1.43\n100=1.55\n";

/// A battery spec carrying the table in `spec.model`, the raw `\n`-joined
/// string carrier the frontend uses (like the custom-logic blob).
fn battery(
    id: u32,
    posts: &[[i32; 2]],
    params: &[(&str, f64)],
    table: Option<&str>,
) -> ElementSpec {
    let mut e = elm(id, "battery", posts, params);
    e.model = table.map(|s| s.to_string());
    e
}

/// The alkaline battery with a 10M probe from plus to ground, minus grounded.
/// `soc_param` lets the over-discharge test inject a negative `soc` directly,
/// which the constructor restores from the param the way a live-state save
/// would.
fn alkaline_probe(soc_param: f64, dc: bool) -> Circuit {
    build(
        vec![
            battery(
                1,
                &[[0, 100], [0, 0]],
                &[
                    ("r0", 0.15),
                    ("r1", 0.25),
                    ("c1", 1e-3),
                    ("capacityAh", 2.5),
                    ("initialSoc", 0.5),
                    ("soc", soc_param),
                ],
                Some(ALKALINE_TABLE),
            ),
            elm(2, "ground", &[[0, 100]], &[]),
            elm(3, "resistor", &[[0, 0], [0, -100]], &[("resistance", 10e6)]),
            elm(4, "ground", &[[0, -100]], &[]),
        ],
        opts(1e-5, dc),
    )
}

/// Interpolation of the alkaline table at 50%: between the 40% 1.18 and the
/// 60% 1.28 points, halfway, so 1.23 V.
const ALKALINE_AT_50: f64 = 1.23;

#[test]
fn open_circuit_terminal_voltage_matches_table() {
    // The transient companion settles with the polarization cap charged, so
    // the terminal voltage is the table value minus the divider sag through
    // r0 + r1 into the 10M probe. The sag is ~5e-8 V, far inside tolerance.
    let mut c = alkaline_probe(0.5, false);
    c.run(1000);
    let expected = ALKALINE_AT_50 * 10e6 / (10e6 + 0.15 + 0.25);
    let terminal = c.element_voltages()[0];
    assert!(
        close(terminal, expected, 1e-6),
        "terminal voltage was {terminal}, expected {expected}"
    );
}

#[test]
fn discharge_integrates_coulombs() {
    // An empty table falls back to the flat 3.7 V (BatteryElm.java:230-232).
    // With r0 + r1 + load = 3.7 ohm the current is exactly 1 A, so coulomb
    // counting subtracts exactly N*dt/(3600*Ah): the sign convention must
    // discharge. The DC operating point pre-charges the polarization cap, so
    // the transient starts settled and the current never ripples.
    let dt = 1e-4;
    let capacity_ah = 0.1;
    let c = &mut build(
        vec![
            battery(
                1,
                &[[0, 100], [0, 0]],
                &[
                    ("r0", 0.01),
                    ("r1", 0.02),
                    ("c1", 2000.0),
                    ("capacityAh", capacity_ah),
                    ("initialSoc", 1.0),
                ],
                Some(""),
            ),
            elm(2, "ground", &[[0, 100]], &[]),
            elm(3, "resistor", &[[0, 0], [0, -100]], &[("resistance", 3.67)]),
            elm(4, "ground", &[[0, -100]], &[]),
        ],
        opts(dt, true),
    );
    c.run(1000);
    let current = c.element_currents()[0];
    assert!(
        close(current, 1.0, 1e-6),
        "discharge current was {current}, expected 1 A"
    );
    let soc = c.state_tokens()[0]
        .iter()
        .find(|(k, _)| k == "soc")
        .map(|(_, v)| *v)
        .expect("battery reported no soc token");
    let expected = 1.0 - 1000.0 * dt / (3600.0 * capacity_ah);
    assert!(
        close(soc, expected, 1e-9),
        "soc was {soc}, expected {expected}: the sign convention must discharge"
    );
    assert!(soc < 1.0, "soc did not decrease under discharge");
}

#[test]
fn over_discharge_extrapolates() {
    // Below 0% the source extrapolates linearly at three times the 0..10%
    // slope (BatteryElm.java:219-226): v0 + slope*3*socPct. Alkaline: v0 =
    // 0.8, v10 = 0.95, so at soc = -0.05 the source is 0.8 + 0.015*3*(-5) =
    // 0.575 V and at -0.10 it is 0.35 V. The 10M probe reads the source value
    // with negligible sag.
    let terminal = |soc_param: f64| alkaline_probe(soc_param, true).element_voltages()[0];
    assert!(
        close(terminal(-0.05), 0.575, 1e-6),
        "over-discharge at -5% was {}, expected 0.575",
        terminal(-0.05)
    );
    assert!(
        close(terminal(-0.10), 0.35, 1e-6),
        "over-discharge at -10% was {}, expected 0.35",
        terminal(-0.10)
    );
}

#[test]
fn dc_analysis_uses_100m_and_skips_counting() {
    // Under the autoDC operating point the polarization cap becomes a 1e8
    // open, so the solve converges to the divider answer, and step_finished
    // must not count coulombs: the soc token stays at the initial 0.5.
    let c = alkaline_probe(0.5, true);
    let expected = ALKALINE_AT_50 * 10e6 / (10e6 + 0.15 + 0.25);
    let terminal = c.element_voltages()[0];
    assert!(
        close(terminal, expected, 1e-6),
        "DC terminal voltage was {terminal}, expected {expected}"
    );
    let soc = c.state_tokens()[0]
        .iter()
        .find(|(k, _)| k == "soc")
        .map(|(_, v)| *v)
        .expect("battery reported no soc token");
    assert!(
        close(soc, 0.5, 1e-12),
        "soc was {soc} after the operating point, expected the initial 0.5"
    );
}

#[test]
fn state_tokens_round_trip() {
    // A discharging battery mid-run: save its soc and capVoltDiff, rebuild
    // with those params, and the terminal voltage and soc must continue
    // without a jump. A battery that ignored the restored soc would snap back
    // to initialSoc and the terminal voltage would step by the whole curve.
    let dt = 1e-5;
    let capacity_ah = 0.001;
    let specs = vec![
        battery(
            1,
            &[[0, 100], [0, 0]],
            &[
                ("r0", 0.15),
                ("r1", 0.25),
                ("c1", 1e-3),
                ("capacityAh", capacity_ah),
                ("initialSoc", 0.5),
            ],
            Some(ALKALINE_TABLE),
        ),
        elm(2, "ground", &[[0, 100]], &[]),
        elm(3, "resistor", &[[0, 0], [0, -100]], &[("resistance", 1.0)]),
        elm(4, "ground", &[[0, -100]], &[]),
    ];
    let options = opts(dt, false);
    let mut a = build(specs.clone(), options.clone());
    a.run(500);
    let before = a.node_voltages().to_vec();
    let soc_before = a.state_tokens()[0]
        .iter()
        .find(|(k, _)| k == "soc")
        .map(|(_, v)| *v)
        .expect("battery reported no soc token");
    assert!(
        soc_before < 0.5,
        "soc {soc_before} did not discharge below the initial 0.5"
    );
    // The one-step expectation uses the battery's own settled discharge
    // current (about 0.879 A through the 1 ohm load, not 1 A): coulomb
    // counting subtracts exactly `current * dt / (3600 * Ah)`, and the same
    // current holds after the rebuild because capVoltDiff was restored.
    let current = a.element_currents()[0];
    assert!(
        current > 0.5,
        "discharge current {current} too small to matter"
    );

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
    for (i, (x, y)) in before.iter().zip(b.node_voltages().iter()).enumerate() {
        assert!(
            close(*x, *y, 0.05),
            "node {i} jumped after the rebuild: live {x}, rebuilt {y}"
        );
    }
    let soc_after = b.state_tokens()[0]
        .iter()
        .find(|(k, _)| k == "soc")
        .map(|(_, v)| *v)
        .expect("battery reported no soc token");
    assert!(
        close(
            soc_after,
            soc_before - current * dt / (3600.0 * capacity_ah),
            1e-6
        ),
        "soc did not continue after the rebuild: before {soc_before}, after {soc_after}"
    );
}

#[test]
fn empty_table_falls_back_to_flat_3_7() {
    // No table at all (a Custom battery with an empty editor): interpSocTable
    // returns the flat 3.7 V (BatteryElm.java:205-206), whatever the soc.
    let c = &mut build(
        vec![
            battery(
                1,
                &[[0, 100], [0, 0]],
                &[
                    ("r0", 0.01),
                    ("r1", 0.02),
                    ("c1", 1e-3),
                    ("capacityAh", 2.0),
                    ("initialSoc", 0.7),
                ],
                None,
            ),
            elm(2, "ground", &[[0, 100]], &[]),
            elm(3, "resistor", &[[0, 0], [0, -100]], &[("resistance", 10e6)]),
            elm(4, "ground", &[[0, -100]], &[]),
        ],
        opts(1e-5, true),
    );
    let expected = 3.7 * 10e6 / (10e6 + 0.03);
    assert!(
        close(c.element_voltages()[0], expected, 1e-6),
        "flat-table terminal was {}, expected {expected}",
        c.element_voltages()[0]
    );
}
