//! Composite (subcircuit) elements and the OTA.

use std::collections::HashMap;

use circuit_core::{Element, ElementSpec};

mod common;
use common::*;

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

#[test]
fn composite_ground_model_and_tapped_divider_hit_analytic_voltages() {
    // Two-pin case: the model references ground (node 0) directly and the
    // external list names ground as the second post. `from_model` must route
    // the child's node 0 to circuit ground (the GROUND_NODE sentinel), not to
    // the composite's own post, and the phantom ground post still reads 0 V
    // when its terminal is grounded. Two equal 1k resistors from the driven
    // post to ground put the internal midpoint at exactly half the supply.
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 200], [0, 0]], &[("maxVoltage", 10.0)]),
            elm_composite(
                2,
                &[[0, 0], [300, 0]],
                "ResistorElm 1 2\rResistorElm 2 0",
                &[1, 0],
                &["0_1000", "0_1000"],
            ),
            elm(3, "ground", &[[300, 0]], &[]),
            elm(4, "ground", &[[0, 200]], &[]),
        ],
        opts(1e-5, true),
    );
    let report = c.run(20);
    assert!(report.converged, "did not converge: {:?}", report.error);
    // The midpoint is the composite's single internal node, handed out after
    // the posts: node 1 is the driven post, node 2 the midpoint. The composite
    // reports no internal connectivity, so the floating-node walk pins the
    // midpoint with a 100 M load, shifting 5 V by 25 uV.
    assert!(
        close(c.node_voltages()[2], 5.0, 1e-3),
        "midpoint was {}",
        c.node_voltages()[2]
    );
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

    // Three-post case: a tapped divider whose tap post is left unloaded, so
    // all three 1k legs share one current. The tap must read V/3 and the
    // internal midpoint 2V/3, pinning that both the extra post and the
    // internal node are remapped onto the right matrix rows.
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 200], [0, 0]], &[("maxVoltage", 10.0)]),
            elm_composite(
                2,
                &[[0, 0], [150, 0], [300, 0]],
                "ResistorElm 1 2\rResistorElm 2 3\rResistorElm 3 4",
                &[1, 3, 4],
                &["0_1000", "0_1000", "0_1000"],
            ),
            elm(3, "ground", &[[300, 0]], &[]),
            elm(4, "ground", &[[0, 200]], &[]),
        ],
        opts(1e-5, true),
    );
    let report = c.run(20);
    assert!(report.converged, "did not converge: {:?}", report.error);
    let v = c.node_voltages();
    // First-seen node order: 0 ground, 1 the driven post, 2 the unloaded tap
    // post, 3 the composite's internal midpoint. Both float under the walk, so
    // the GMIN pins shift them by tens of uV.
    assert!(
        close(v[2], 10.0 / 3.0, 1e-3),
        "tap was {}, expected {}",
        v[2],
        10.0 / 3.0
    );
    assert!(
        close(v[3], 20.0 / 3.0, 1e-3),
        "midpoint was {}, expected {}",
        v[3],
        20.0 / 3.0
    );
}

#[test]
fn composite_with_a_capacitor_child_charges_the_divider_midpoint() {
    // A capacitor across the low resistor of a divider is an open circuit at
    // DC, so the steady-state ratio is the plain 5 V, but the transient shows
    // the child is really there: without it the midpoint would sit at 5 V from
    // the first step, while the child makes it charge from its 1e-3 initial
    // voltage toward 5 V with time constant (R1||R2)*C = 5 ms. After 200 us
    // (20 steps, 0.04 tau) the midpoint has only just begun to charge, and
    // after 50 ms (10 tau) it has reached the same ratio as the
    // capacitor-free divider.
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 200], [0, 0]], &[("maxVoltage", 10.0)]),
            elm_composite(
                2,
                &[[0, 0], [300, 0]],
                "ResistorElm 1 2\rResistorElm 2 3\rCapacitorElm 2 3",
                &[1, 3],
                &["0_1000", "0_1000", "0_1e-5"],
            ),
            elm(3, "ground", &[[300, 0]], &[]),
            elm(4, "ground", &[[0, 200]], &[]),
        ],
        opts(1e-5, false),
    );
    let report = c.run(20);
    assert!(report.converged, "did not converge: {:?}", report.error);
    let v = c.node_voltages()[2];
    assert!(
        (0.1..0.4).contains(&v),
        "midpoint was {v} after 200 us, expected it charging toward 5 V"
    );
    c.run(4980);
    assert!(
        close(c.node_voltages()[2], 5.0, 1e-3),
        "midpoint was {} after 50 ms, expected the 5 V steady state",
        c.node_voltages()[2]
    );
}

#[test]
fn composite_with_a_diode_child_clamps_its_output_post() {
    // A diode child from the output post to ground, driven through a resistor
    // from a rail, clamps the post at the diode's forward drop the same way a
    // bare diode would, and the composite reports nonlinear through the child
    // so the Newton loop has to converge around the junction stamp. Solving
    // (10 - v)/1000 = Is*(exp(v/vscale) - 1) with Is derived from the 0.7 V
    // rated drop (the `forwardVoltage` dump field) puts the clamp at about
    // 0.456 V; the asserted window brackets that and is below the 0.565 V the
    // default 0.806 V drop would give, so a dropped dump field fails the test.
    let c = &mut build(
        vec![
            elm(1, "rail", &[[0, 200]], &[("maxVoltage", 10.0)]),
            elm(
                2,
                "resistor",
                &[[0, 200], [0, 100]],
                &[("resistance", 1000.0)],
            ),
            elm_composite(3, &[[0, 100]], "DiodeElm 1 0", &[1], &["0_0.7"]),
        ],
        opts(1e-5, true),
    );
    let report = c.run(20);
    assert!(report.converged, "did not converge: {:?}", report.error);
    let vd = c.element_voltages()[2];
    assert!((0.4..0.52).contains(&vd), "clamp was {vd}");
    assert!(
        close(c.element_currents()[1], (10.0 - vd) / 1000.0, 1e-5),
        "drive current was {}",
        c.element_currents()[1]
    );
}

#[test]
fn composite_with_an_inductor_child_shorts_at_dc() {
    // An inductor behaves as a short at DC (its steady-state stamp is a
    // 1e-6 ohm conductance), so a composite holding a resistor in series with
    // an inductor reaches the analytic loop current and the junction between
    // them sits at the grounded rail. Without the inductor child the junction
    // would float and read nearly the full supply instead.
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 200], [0, 0]], &[("maxVoltage", 10.0)]),
            elm_composite(
                2,
                &[[0, 0], [300, 0]],
                "ResistorElm 1 2\rInductorElm 2 3",
                &[1, 3],
                &["0_1000", "0_1e-3"],
            ),
            elm(3, "ground", &[[300, 0]], &[]),
            elm(4, "ground", &[[0, 200]], &[]),
        ],
        opts(1e-5, true),
    );
    let report = c.run(20);
    assert!(report.converged, "did not converge: {:?}", report.error);
    assert!(
        close(c.element_currents()[0], 1e-2, 1e-6),
        "loop current was {}",
        c.element_currents()[0]
    );
    assert!(
        close(c.node_voltages()[2], 0.0, 1e-3),
        "junction was {}",
        c.node_voltages()[2]
    );
}

#[test]
fn composite_with_a_closed_switch_child_conducts() {
    // A closed switch inside a composite cannot rely on wire merging, which
    // only runs for top-level elements, so it must stamp its 1e-3 ohm closed
    // resistance like upstream (SwitchElm.java:222-229). A 1k resistor in
    // series with the switch between the posts carries I = 10/1001, and the
    // junction between them sits at I*0.001, a near-short. Before the fix the
    // switch stamped nothing and the floating walk read ~100 MOhm.
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 200], [0, 0]], &[("maxVoltage", 10.0)]),
            elm_composite(
                2,
                &[[0, 0], [300, 0]],
                "ResistorElm 1 2\rSwitchElm 2 3",
                &[1, 3],
                &["0_1000", "0_0"],
            ),
            elm(3, "ground", &[[300, 0]], &[]),
            elm(4, "ground", &[[0, 200]], &[]),
        ],
        opts(1e-5, true),
    );
    let report = c.run(20);
    assert!(report.converged, "did not converge: {:?}", report.error);
    assert!(
        close(c.element_currents()[0], 10.0 / 1001.0, 1e-5),
        "loop current was {}",
        c.element_currents()[0]
    );
    assert!(
        close(c.node_voltages()[2], 0.0, 1e-3),
        "junction was {}",
        c.node_voltages()[2]
    );
}

#[test]
fn composite_with_an_open_switch_child_blocks() {
    // An open switch inside a composite stamps nothing, so the resistor's far
    // end floats and the GMIN pin keeps the loop current near zero, unlike the
    // closed-switch test above.
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 200], [0, 0]], &[("maxVoltage", 10.0)]),
            elm_composite(
                2,
                &[[0, 0], [300, 0]],
                "ResistorElm 1 2\rSwitchElm 2 3",
                &[1, 3],
                &["0_1000", "0_1"],
            ),
            elm(3, "ground", &[[300, 0]], &[]),
            elm(4, "ground", &[[0, 200]], &[]),
        ],
        opts(1e-5, true),
    );
    let report = c.run(20);
    assert!(report.converged, "did not converge: {:?}", report.error);
    assert!(
        c.element_currents()[0] < 1e-4,
        "open-switch current was {}",
        c.element_currents()[0]
    );
}

#[test]
fn composite_with_a_zener_child_clamps_in_breakdown() {
    // A zener child from the output post to ground, driven through a 1k
    // internal resistor from a +12 V source with another 1k outside, clamps
    // the output at the breakdown voltage. Solving the loop puts about 3.2 mA
    // through the zener, just below its 5 mA rated point, so the clamp sits a
    // little under the rated 5.6 V.
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 200], [0, 0]], &[("maxVoltage", 12.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm_composite(
                3,
                &[[100, 0], [200, 0]],
                "ResistorElm 1 2\rZenerElm 0 2",
                &[1, 2],
                &["0_1000", "0_0.805904783_5.6"],
            ),
            elm(4, "ground", &[[0, 200]], &[]),
        ],
        opts(1e-5, true),
    );
    let report = c.run(20);
    assert!(report.converged, "did not converge: {:?}", report.error);
    let out = c.node_voltages()[3];
    assert!(
        (5.5..5.65).contains(&out),
        "zener clamped at {out}, expected the 5.6 V breakdown"
    );
}

#[test]
fn composite_with_a_current_child_delivers_its_rated_current() {
    // A current child pushes its rated 10 mA from the rail post into the
    // output post, so the 1k load resistor to ground must read 10 V while the
    // rail holds the source side at 5 V.
    let c = &mut build(
        vec![
            elm(1, "rail", &[[0, 0]], &[("maxVoltage", 5.0)]),
            elm_composite(
                2,
                &[[0, 0], [100, 0]],
                "CurrentElm 1 2",
                &[1, 2],
                &["0_0.01"],
            ),
            elm(
                3,
                "resistor",
                &[[100, 0], [100, 100]],
                &[("resistance", 1000.0)],
            ),
            elm(4, "ground", &[[100, 100]], &[]),
        ],
        opts(1e-5, true),
    );
    let report = c.run(20);
    assert!(report.converged, "did not converge: {:?}", report.error);
    assert!(
        close(c.node_voltages()[2], 10.0, 1e-3),
        "load node was {}",
        c.node_voltages()[2]
    );
    assert!(
        close(c.element_currents()[2], 1e-2, 1e-6),
        "composite current was {}",
        c.element_currents()[2]
    );
}

#[test]
fn composite_with_an_led_child_drops_about_two_volts() {
    // An LED child is the port's Shockley diode with the LED's 2.1 V rated
    // drop, so a 5 V source through 1k into the composite reads just under
    // 2 V across the LED, like the bare-element test.
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 200], [0, 0]], &[("maxVoltage", 5.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm_composite(
                3,
                &[[100, 0], [200, 0]],
                "LEDElm 1 2",
                &[1, 2],
                &["0_2.1024259_1_0_0_0.01"],
            ),
            elm(4, "ground", &[[0, 200]], &[]),
            elm(5, "wire", &[[200, 0], [200, 100]], &[]),
            elm(6, "ground", &[[200, 100]], &[]),
        ],
        opts(1e-5, true),
    );
    let report = c.run(20);
    assert!(report.converged, "did not converge: {:?}", report.error);
    let vd = c.element_voltages()[2];
    assert!((1.5..2.4).contains(&vd), "LED drop was {vd}");
}

/// A jfet gate driven 5 V above its post-1 terminal: the polarity decides
/// whether the gate junction conducts and pulls that terminal up. The channel
/// type is the `pnp` param the composite folds from the child's flags bit 1,
/// so this pins that fold (jfet.rs:99).
fn jfet_gate_pullup(model_type: &str, dump: &str) -> f64 {
    let c = &mut build(
        vec![
            elm(1, "rail", &[[0, 200]], &[("maxVoltage", 5.0)]),
            elm_composite(
                2,
                &[[0, 200], [100, 200]],
                &format!("{model_type} 1 2 0"),
                &[1, 2],
                &[dump],
            ),
            elm(
                3,
                "resistor",
                &[[100, 200], [100, 300]],
                &[("resistance", 10000.0)],
            ),
            elm(4, "ground", &[[100, 300]], &[]),
        ],
        opts(1e-5, true),
    );
    let report = c.run(20);
    assert!(report.converged, "did not converge: {:?}", report.error);
    c.node_voltages()[2]
}

#[test]
fn composite_jfet_polarity_fold_acts_on_the_child_flags() {
    // The frontend emits the channel type as flags bit 1 of the child dump
    // (MOSFET_PNP), not as a dump token, so `from_model` must fold that bit
    // into the `pnp` param. A `JfetElm` line (N-channel by class default)
    // carrying the bit must act P: its gate junction is anode-at-post-1, so a
    // gate 5 V above post 1 reverse-biases it and the terminal stays at
    // ground. The N-channel control forward-biases the junction and pulls the
    // terminal up past 3 V.
    let folded = jfet_gate_pullup("JfetElm", "1");
    assert!(
        folded < 0.5,
        "JfetElm with the PNP bit pulled post 1 to {folded} V, expected P-channel"
    );
    let p_named = jfet_gate_pullup("PJfetElm", "1");
    assert!(
        p_named < 0.5,
        "PJfetElm pulled post 1 to {p_named} V, expected P-channel"
    );
    let n_channel = jfet_gate_pullup("NJfetElm", "0");
    assert!(
        n_channel > 3.0,
        "NJfetElm pulled post 1 to only {n_channel} V, expected N-channel"
    );
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

// ─── Live state read-back (`Circuit::state_tokens`) ───

// ─── logic children ───

/// Output voltage of a composite whose model is one gate, driven by rails on
/// the input posts and loaded by 1k to ground on the output post. `model` and
/// `dumps` are the child model line and its dump token, exactly as a `.` line
/// carries them. The posts are laid out left to right; the last is the output.
fn composite_gate_output(model: &str, dumps: &[&str], inputs: &[f64]) -> f64 {
    let mut specs = Vec::new();
    let mut posts = Vec::new();
    for (i, &v) in inputs.iter().enumerate() {
        let y = i as i32 * 32;
        specs.push(elm(i as u32 + 1, "rail", &[[0, y]], &[("maxVoltage", v)]));
        posts.push([0, y]);
    }
    let out = [200, 0];
    posts.push(out);
    let external: Vec<usize> = (1..=posts.len()).collect();
    let composite_id = inputs.len() as u32 + 1;
    specs.push(elm_composite(composite_id, &posts, model, &external, dumps));
    specs.push(elm(
        composite_id + 1,
        "resistor",
        &[out, [200, 200]],
        &[("resistance", 1000.0)],
    ));
    specs.push(elm(composite_id + 2, "ground", &[[200, 200]], &[]));
    let load = specs.len() - 2;
    let mut c = build(specs, opts(1e-5, false));
    c.run(5);
    c.element_voltages()[load]
}

#[test]
fn composite_and_gate_child_follows_its_truth_table() {
    // A gate inside a subcircuit is what the `.`-line decoders in the corpus
    // are built from, and what a user's own Create Subcircuit selection needs
    // before it can hold logic at all.
    let model = "AndGateElm 1 2 3";
    let dump = ["0_2_0_5"];
    assert!(close(
        composite_gate_output(model, &dump, &[5.0, 5.0]),
        5.0,
        1e-9
    ));
    assert!(close(
        composite_gate_output(model, &dump, &[5.0, 0.0]),
        0.0,
        1e-9
    ));
    assert!(close(
        composite_gate_output(model, &dump, &[0.0, 0.0]),
        0.0,
        1e-9
    ));
}

#[test]
fn composite_gate_child_takes_its_input_count_from_the_dump() {
    // The dump's first field is the gate's input count (GateElm.java:55), so
    // a three-input NAND inside a composite must read all three.
    let model = "NandGateElm 1 2 3 4";
    let dump = ["0_3_0_5"];
    assert!(close(
        composite_gate_output(model, &dump, &[5.0, 5.0, 5.0]),
        0.0,
        1e-9
    ));
    assert!(close(
        composite_gate_output(model, &dump, &[5.0, 5.0, 0.0]),
        5.0,
        1e-9
    ));
}

#[test]
fn composite_gate_child_infers_its_input_count_from_the_model_line() {
    // With no dump token the gate would default to two inputs and its
    // post-count check would then throw the line away. The node list names
    // every post, so it is the input count the model meant.
    let three_in = circuit_core::elements::composite::Composite::from_model(
        "OrGateElm 1 2 3 4",
        &[1, 2, 3, 4],
        None,
        "composite",
    );
    assert_eq!(three_in.post_count(), 4);
    assert!(close(
        composite_gate_output("OrGateElm 1 2 3 4", &[], &[0.0, 0.0, 5.0]),
        5.0,
        1e-9
    ));
    assert!(close(
        composite_gate_output("OrGateElm 1 2 3 4", &[], &[0.0, 0.0, 0.0]),
        0.0,
        1e-9
    ));
}

#[test]
fn composite_inverter_child_inverts_and_carries_its_high_level() {
    // The inverter's dump is slew rate then high level (InverterElm.java), so
    // a child at 3.3 V logic must swing to 3.3, not to the 5 V default.
    assert!(close(
        composite_gate_output("InverterElm 1 2", &["0_0.5_5"], &[0.0]),
        5.0,
        1e-6
    ));
    assert!(close(
        composite_gate_output("InverterElm 1 2", &["0_0.5_5"], &[5.0]),
        0.0,
        1e-6
    ));
    assert!(close(
        composite_gate_output("InverterElm 1 2", &["0_0.5_3.3"], &[0.0]),
        3.3,
        1e-6
    ));
}

#[test]
fn composite_gates_chain_through_an_internal_node() {
    // Two gates wired to each other inside the model: a NAND feeding an
    // inverter is an AND, and the internal node between them is the composite's
    // own, never a post.
    let model = "NandGateElm 1 2 4\rInverterElm 4 3";
    let dumps = ["0_2_0_5", "0_0.5_5"];
    assert!(close(
        composite_gate_output(model, &dumps, &[5.0, 5.0]),
        5.0,
        1e-6
    ));
    assert!(close(
        composite_gate_output(model, &dumps, &[5.0, 0.0]),
        0.0,
        1e-6
    ));
}
