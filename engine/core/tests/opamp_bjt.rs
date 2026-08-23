//! Op-amps and bipolar transistors, including the Darlington pair.

use circuit_core::{Circuit, ScopeSpec, ScopeValue};

mod common;
use common::*;

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
fn swapped_opamp_still_inverts_through_its_first_post() {
    // Upstream's "+ on top" menu entry is not a second element: OpAmpSwapElm
    // only sets FLAG_SWAP and dumps as OpAmpElm, so the flag moves the drawn
    // input leads and nothing else. Post 0 is the inverting input either way,
    // and the same inverting amplifier must come out at -Rf/Rin.
    const FLAG_SWAP: i64 = 1;
    const FLAG_GAIN: i64 = 8;
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[96, 224], [96, 80]], &[("maxVoltage", 0.5)]),
            // Input resistor into the inverting node, which the swap moves to
            // the far side of the body (amp-follower.txt geometry).
            elm(
                2,
                "resistor",
                &[[96, 80], [192, 176]],
                &[("resistance", 1000.0)],
            ),
            elm(
                3,
                "resistor",
                &[[192, 176], [320, 160]],
                &[("resistance", 10_000.0)],
            ),
            // Posts stay inverting, non-inverting, output; only the two input
            // coordinates trade sides.
            elm_flags(
                4,
                "opamp",
                &[[192, 176], [192, 144], [320, 160]],
                &[("gain", 100_000.0), ("maxOut", 15.0), ("minOut", -15.0)],
                FLAG_SWAP | FLAG_GAIN,
            ),
            elm(5, "ground", &[[192, 144]], &[]),
            elm(6, "ground", &[[96, 224]], &[]),
        ],
        opts(1e-5, true),
    );
    let report = c.run(30);
    assert!(report.converged, "did not converge: {:?}", report.error);
    // The op-amp reports volts[2] - volts[1], and the non-inverting input is
    // grounded, so this is the output itself: 0.5 V * -10k/1k = -5 V. A swap
    // that leaked into the stamp would land on +5 V here.
    let out = c.element_voltages()[3];
    assert!(close(out, -5.0, 0.01), "swapped output was {out}");
}

#[test]
fn asymmetric_rails_idle_at_the_midpoint() {
    // The linear region centres on (maxOut+minOut)/2 (OpAmpElm.java:167,
    // :174-181), so a 5 V / 0 V op-amp with both inputs grounded idles at
    // 2.5 V instead of the old zero-offset 0 V. The output is read through a
    // 1k resistor to ground.
    let c = &mut build(
        vec![
            elm(
                1,
                "opamp",
                &[[100, 0], [100, 100], [300, 0]],
                &[("gain", 1e5), ("maxOut", 5.0), ("minOut", 0.0)],
            ),
            elm(
                2,
                "resistor",
                &[[300, 0], [300, 100]],
                &[("resistance", 1000.0)],
            ),
            elm(3, "ground", &[[100, 0]], &[]),
            elm(4, "ground", &[[100, 100]], &[]),
            elm(5, "ground", &[[300, 100]], &[]),
        ],
        opts(1e-5, true),
    );
    let report = c.run(30);
    assert!(report.converged, "did not converge: {:?}", report.error);
    assert!(
        close(c.element_voltages()[1], 2.5, 1e-3),
        "idle output was {}",
        c.element_voltages()[1]
    );
}

#[test]
fn asymmetric_opamp_amplifies_about_the_midpoint() {
    // Same rails, non-inverting input driven by 1e-5 V. The upper knee sits at
    // (5-2.5)/1e5 = 2.5e-5, so vd = 1e-5 is linear and the output is
    // 2.5 + 1e5*1e-5 = 3.5 (the old zero-offset code returned 1.0).
    let c = &mut build(
        vec![
            elm(
                1,
                "voltage",
                &[[0, 100], [100, 100]],
                &[("maxVoltage", 1e-5)],
            ),
            elm(
                2,
                "opamp",
                &[[100, 0], [100, 100], [300, 0]],
                &[("gain", 1e5), ("maxOut", 5.0), ("minOut", 0.0)],
            ),
            elm(
                3,
                "resistor",
                &[[300, 0], [300, 100]],
                &[("resistance", 1000.0)],
            ),
            elm(4, "ground", &[[100, 0]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
            elm(6, "ground", &[[300, 100]], &[]),
        ],
        opts(1e-5, true),
    );
    let report = c.run(30);
    assert!(report.converged, "did not converge: {:?}", report.error);
    assert!(
        close(c.element_voltages()[2], 3.5, 1e-3),
        "output was {}",
        c.element_voltages()[2]
    );
}

#[test]
fn opamp_scope_plots_output_minus_non_inverting_input() {
    // The inverting amplifier from inverting_opamp_has_the_textbook_gain:
    // Vout = -Rf/Rin * Vin = -10 * 0.5 = -5. A voltage scope on the op-amp
    // samples volts[2] - volts[1] = -5 - 0 (OpAmpElm.java:206), not the
    // generic volts[0] - volts[1] = 0 - 0 the old formula returned.
    let c = &mut build_with(
        vec![
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
        ],
        opts(1e-5, true),
        vec![ScopeSpec {
            element_id: 4,
            value: ScopeValue::Voltage,
            post: 0,
            steps_per_column: 1,
            columns: 1024,
            ac_coupled: false,
            trigger: Default::default(),
            display_width: 0,
        }],
    );
    c.run(30);
    let snap = c.scopes()[0].snapshot();
    let (min, max) = (snap[snap.len() - 2] as f64, snap[snap.len() - 1] as f64);
    assert!(
        close(min, -5.0, 1e-3) && close(max, -5.0, 1e-3),
        "last scope column was {min}/{max}, expected -5"
    );
}

#[test]
fn current_scope_samples_the_dc_branch_current() {
    // A Current scope on a resistor must sample the branch current, not the
    // voltage: 5 V across 100 ohm is 0.05 A. The scope o-line value token 3
    // maps to a Current spec in the frontend, and this pins the engine side
    // of that contract: the sample has to be a real current, or a saved file
    // would reload a current trace as a flat voltage one.
    let c = &mut build_with(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 5.0)]),
            elm(2, "resistor", &[[0, 0], [100, 0]], &[("resistance", 100.0)]),
            elm(3, "wire", &[[100, 0], [100, 100]], &[]),
            elm(4, "wire", &[[100, 100], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
        ],
        opts(1e-5, true),
        vec![ScopeSpec {
            element_id: 2,
            value: ScopeValue::Current,
            post: 0,
            steps_per_column: 1,
            columns: 1024,
            ac_coupled: false,
            trigger: Default::default(),
            display_width: 0,
        }],
    );
    c.run(30);
    let snap = c.scopes()[0].snapshot();
    let (min, max) = (snap[snap.len() - 2] as f64, snap[snap.len() - 1] as f64);
    assert!(
        close(min, 0.05, 1e-6) && close(max, 0.05, 1e-6),
        "current scope sampled {min}/{max}, expected 0.05 A"
    );
}

#[test]
fn opamp_output_current_and_power_match_upstream() {
    // Voltage follower: 5 V into the non-inverting input, the output wired to
    // the inverting input, a 1k load from the output node to ground. The
    // op-amp sources ~5 mA into the load. Upstream's positive current flows
    // INTO the output pin (a sinking op-amp: getCurrentIntoNode(2) ==
    // -current, OpAmpElm.java:227-231), so a sourcing op-amp reports -5e-3;
    // the port's voltage_source(GROUND, node2) unknown is positive into the
    // pin and `calculate_current` negates it, giving the same -5e-3 and the
    // power volts[2]*current = 5 * -5e-3 = -0.025 (OpAmpElm.java:109). The
    // finite open-loop gain drops the follower output to 5 - 5e-5, a deviation
    // the tolerances below cover.
    let c = &mut build_with(
        vec![
            elm(
                1,
                "voltage",
                &[[0, 100], [100, 100]],
                &[("maxVoltage", 5.0)],
            ),
            elm(
                2,
                "resistor",
                &[[200, 0], [200, 100]],
                &[("resistance", 1000.0)],
            ),
            // The inverting input shares the output node, so the follower holds
            // it at the non-inverting voltage.
            elm(
                3,
                "opamp",
                &[[200, 0], [100, 100], [200, 0]],
                &[("gain", 1e5), ("maxOut", 15.0), ("minOut", -15.0)],
            ),
            elm(4, "ground", &[[0, 100]], &[]),
            elm(5, "ground", &[[200, 100]], &[]),
        ],
        opts(1e-5, true),
        vec![
            ScopeSpec {
                element_id: 3,
                value: ScopeValue::Power,
                post: 0,
                steps_per_column: 1,
                columns: 1024,
                ac_coupled: false,
                trigger: Default::default(),
                display_width: 0,
            },
            ScopeSpec {
                element_id: 3,
                value: ScopeValue::Voltage,
                post: 0,
                steps_per_column: 1,
                columns: 1024,
                ac_coupled: false,
                trigger: Default::default(),
                display_width: 0,
            },
        ],
    );
    let report = c.run(30);
    assert!(report.converged, "did not converge: {:?}", report.error);
    assert!(
        close(c.element_currents()[2], -5e-3, 1e-6),
        "op-amp current was {}",
        c.element_currents()[2]
    );
    let power = c.scopes()[0].snapshot();
    let (pmin, pmax) = (power[power.len() - 2] as f64, power[power.len() - 1] as f64);
    assert!(
        close(pmin, -0.025, 1e-6) && close(pmax, -0.025, 1e-6),
        "power scope last column was {pmin}/{pmax}, expected -0.025"
    );
    // And the follower's voltage scope is Vout - V+ = 0, pinning the step-4
    // semantics: the plot is output minus non-inverting input, not the input
    // differential.
    let volt = c.scopes()[1].snapshot();
    let (vmin, vmax) = (volt[volt.len() - 2] as f64, volt[volt.len() - 1] as f64);
    assert!(
        close(vmin, 0.0, 1e-4) && close(vmax, 0.0, 1e-4),
        "follower voltage scope last column was {vmin}/{vmax}, expected 0"
    );
}

#[test]
fn gain_flags_select_the_open_loop_gain() {
    // The flags decide the gain on load (OpAmpElm.java:63-70): FLAG_GAIN (8)
    // keeps the stored value, FLAG_LOWGAIN (4) forces 1000, and no flag forces
    // 100000. Symmetric rails put the midpoint offset at zero, so the linear
    // output is gain*vd, and every vd used here sits below its knee.
    let linear_out = |flags: i64, file_gain: f64, vd: f64| {
        let c = &mut build(
            vec![
                elm(1, "voltage", &[[0, 100], [100, 100]], &[("maxVoltage", vd)]),
                elm_flags(
                    2,
                    "opamp",
                    &[[100, 0], [100, 100], [300, 0]],
                    &[("gain", file_gain), ("maxOut", 15.0), ("minOut", -15.0)],
                    flags,
                ),
                elm(
                    3,
                    "resistor",
                    &[[300, 0], [300, 100]],
                    &[("resistance", 1000.0)],
                ),
                elm(4, "ground", &[[100, 0]], &[]),
                elm(5, "ground", &[[0, 100]], &[]),
                elm(6, "ground", &[[300, 100]], &[]),
            ],
            opts(1e-5, true),
        );
        let report = c.run(30);
        assert!(report.converged, "did not converge: {:?}", report.error);
        c.element_voltages()[2]
    };

    let flagged = linear_out(8, 12345.0, 1e-4);
    assert!(
        close(flagged, 1.2345, 1e-3),
        "FLAG_GAIN did not keep the file gain: {flagged}"
    );
    let low = linear_out(4, 12345.0, 1e-3);
    assert!(close(low, 1.0, 1e-3), "FLAG_LOWGAIN gain was {low}");
    let legacy = linear_out(0, 12345.0, 1e-4);
    assert!(close(legacy, 10.0, 1e-3), "unflagged gain was {legacy}");
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

/// The NPN common-emitter stage the scope-value readback tests share: a 5 V
/// rail, a 470 k base resistor, a 1 k collector load, beta 100. The
/// transistor's posts are base, collector, emitter and its flattened node
/// slice starts at index 5 (1 + 2 + 2 posts precede it).
fn biased_common_emitter() -> Circuit {
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
                &[("pnp", 1.0), ("beta", 100.0)],
            ),
            elm(5, "ground", &[[200, 100]], &[]),
        ],
        opts(1e-5, true),
    )
}

#[test]
fn transistor_scope_currents_match_the_analytic_operating_point() {
    // The readback currents must be the device's own terminal figures: in the
    // active region Ic obeys the collector-load law exactly and Ib is Ic/beta,
    // so either derived from the wrong internal field fails here.
    let c = &mut biased_common_emitter();
    c.run(50);

    let sv = c.element_scope_values(4);
    assert_eq!(sv.len(), 6, "scope table was {sv:?}");
    let (ib, ic, ie) = (sv[0], sv[1], sv[2]);

    let nodes = c.element_nodes();
    let v = c.node_voltages();
    let nc = nodes[6] as usize;
    let ic_law = (5.0 - v[nc]) / 1000.0;
    assert!(close(ic, ic_law, 1e-7), "Ic {} vs load law {ic_law}", ic);
    assert!(
        close(ib, ic / 100.0, ic * 2e-3),
        "Ib {} vs Ic/beta {}",
        ib,
        ic / 100.0
    );
    assert!(ib > 0.0 && ic > 0.0, "currents were ib={ib} ic={ic}");
    // KCL at the device: ie exits while ib and ic enter.
    assert!(close(ie, -(ib + ic), 1e-12), "ie was {ie}");
}

#[test]
fn transistor_power_matches_upstreams_get_power() {
    // Upstream's getPower (TransistorElm.java:206-208) is Vbe*Ib + Vce*Ic on
    // the raw node volts, so an active NPN dissipating ~4.3 mW reads positive.
    // The flat power array feeds both the Power scope trace and the info
    // box's P row, so it must carry that same figure, not Vbc*Ic.
    let c = &mut biased_common_emitter();
    c.run(50);

    let sv = c.element_scope_values(4);
    let nodes = c.element_nodes();
    let v = c.node_voltages();
    let (nb, nc, ne) = (nodes[5] as usize, nodes[6] as usize, nodes[7] as usize);
    let expect = (v[nb] - v[ne]) * sv[0] + (v[nc] - v[ne]) * sv[1];

    let p = c.element_powers()[3];
    assert!(close(p, expect, 1e-12), "power {p} vs getPower {expect}");
    assert!(p > 0.0, "an absorbing stage read {p}");
}

#[test]
fn element_scope_values_walks_the_declared_table_in_order() {
    // At this bias every slot carries a distinguishable value with its own
    // sign pattern, so any permutation fails: [Ib, Ic, Ie, Vbe, Vbc, Vce]
    // reads two positive currents, one negative current, then vbe > 0,
    // vbc < 0 and vce > 0 as raw node differences over the base, collector
    // and emitter posts.
    let c = &mut biased_common_emitter();
    c.run(50);

    let sv = c.element_scope_values(4);
    let nodes = c.element_nodes();
    let v = c.node_voltages();
    let (nb, nc, ne) = (nodes[5] as usize, nodes[6] as usize, nodes[7] as usize);

    assert!(sv[0] > 0.0 && sv[0] < 1e-4, "slot 0 (Ib) was {}", sv[0]);
    let ic_law = (5.0 - v[nc]) / 1000.0;
    assert!(close(sv[1], ic_law, 1e-7), "slot 1 (Ic) was {}", sv[1]);
    assert!(sv[2] < 0.0, "slot 2 (Ie) was {}", sv[2]);
    assert!(
        close(sv[3], v[nb] - v[ne], 1e-12),
        "slot 3 (Vbe) was {}",
        sv[3]
    );
    assert!(
        close(sv[4], v[nb] - v[nc], 1e-12),
        "slot 4 (Vbc) was {}",
        sv[4]
    );
    assert!(
        close(sv[5], v[nc] - v[ne], 1e-12),
        "slot 5 (Vce) was {}",
        sv[5]
    );
}

#[test]
fn element_scope_values_is_empty_for_kinds_without_a_table() {
    // A resistor answers no scope values and an unknown id maps to nothing:
    // both come back empty so the frontend can call this for one kind
    // without knowing which elements carry tables.
    let c = biased_common_emitter();
    assert!(c.element_scope_values(3).is_empty(), "resistor answered");
    assert!(c.element_scope_values(99).is_empty(), "unknown id answered");
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
fn transistor_model_line_resolves_saturation_current_into_the_engine() {
    // The `32` line is the transistor twin of the `34` diode-model line: a
    // TransistorModel table the element's model name looks up. The port's
    // Ebers-Moll consumes only satCur and betaR (as `saturationCurrent` and
    // `betaReverse`), so this builds exactly the spec that resolution writes
    // and checks the engine uses it: a current source forces a known base
    // current, which pins the operating point without a load-line coupling.
    //
    // In the active region (vbc << 0, so rev ~ -sat) the port's model gives
    //   ib = fwd/bf - sat/br,   fwd = sat*(exp(Vbe/VT) - 1)
    //   => Vbe = VT*ln(1 + bf*(ib + sat/br)/sat)
    //   => Ic = fwd + sat*(1 + 1/br) = bf*ib + sat*(bf/br + 1 + 1/br)
    // The early.txt model `early` (satCur 1e-13, betaR 1) resolves to the
    // port's own defaults, so the corpus file must not change behaviour; a
    // model whose satCur is 1e-9 shifts Vbe down by exactly
    // VT*ln((1 + bf*(ib + sat2/br)/sat2)/(1 + bf*(ib + sat1/br)/sat1))
    // ~ 0.238 V, proving the resolved saturation current is not ignored.
    let stage = |sat: f64, br: f64, beta: f64| {
        build(
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
                        ("saturationCurrent", sat),
                        ("betaReverse", br),
                        ("beta", beta),
                    ],
                ),
                elm(5, "ground", &[[100, 200]], &[]),
                elm(6, "ground", &[[0, 0]], &[]),
            ],
            opts(1e-5, true),
        )
    };

    // The resolved spec for early.txt's `early` model: beta 100 from the
    // element line, satCur and betaR from the `32` line. At ib = 1e-6 the
    // equations give Vbe = 0.53601 V, Ic ~ 1e-4 A and a collector at
    // 5 - Ic*10k ~ 4 V, all active-region values.
    let c = &mut stage(1e-13, 1.0, 100.0);
    c.run(20);
    let v = c.node_voltages();
    let nodes = c.element_nodes();
    let (nb, nc, ne) = (nodes[5] as usize, nodes[6] as usize, nodes[7] as usize);
    let vbe = v[nb] - v[ne];
    assert!(close(vbe, 0.5360, 5e-3), "early-model Vbe was {vbe}");
    assert!(
        close(v[nc], 4.0, 1e-2),
        "early-model collector was {}",
        v[nc]
    );
    let currents = c.element_currents();
    let ic = currents[2]; // the 10k collector load
    assert!(close(ic, 1e-4, 1e-6), "early-model Ic was {ic}");
    assert!(
        (95.0..105.0).contains(&(ic / 1e-6)),
        "early-model gain was {}",
        ic / 1e-6
    );

    // A model whose satCur differs (1e-9, documented as not in the corpus)
    // drops Vbe to 0.2978 V, the exact Ebers-Moll prediction for the same
    // forced base current, while Ic stays at bf*ib (the extra 2*sat ~ 2e-9 A
    // of junction leakage is far below the assertion tolerance).
    let c2 = &mut stage(1e-9, 1.0, 100.0);
    c2.run(20);
    let v = c2.node_voltages();
    let nodes = c2.element_nodes();
    let (nb, _nc, ne) = (nodes[5] as usize, nodes[6] as usize, nodes[7] as usize);
    let vbe_high = v[nb] - v[ne];
    assert!(close(vbe_high, 0.2978, 5e-3), "high-Is Vbe was {vbe_high}");
    assert!(
        close(vbe - vbe_high, 0.2382, 1e-2),
        "Vbe shift was {}",
        vbe - vbe_high
    );
    assert!(
        close(c2.element_currents()[2], 1e-4, 1e-6),
        "high-Is Ic was {}",
        c2.element_currents()[2]
    );
}

#[test]
fn transistor_spice_default_raises_vbe_against_the_default() {
    // The built-in `spice-default` transistor (TransistorModel.java:119) has
    // satCur 1e-16 against the `default` 1e-13, so the same forced base
    // current lands at a much higher Vbe. The stage is the
    // transistor_model_line_resolves_saturation_current_into_the_engine
    // harness: a current source forces 1e-6 A into the base, beta 100, betaR 1.
    // In the active region the Ebers-Moll prediction is
    //   Vbe = VT*ln(1 + bf*(ib + sat/br)/sat):
    // 0.5360 V for the default satCur, 0.7145 V for spice-default, a shift of
    // 0.1785 V. Asserting both pins the resolved saturation current the same
    // way the `32`-line test does, for a name a file never carries a line for.
    let stage = |sat: f64| {
        build(
            vec![
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
                        ("saturationCurrent", sat),
                        ("betaReverse", 1.0),
                        ("beta", 100.0),
                    ],
                ),
                elm(5, "ground", &[[100, 200]], &[]),
                elm(6, "ground", &[[0, 0]], &[]),
            ],
            opts(1e-5, true),
        )
    };
    let vbe_of = |sat: f64| {
        let c = &mut stage(sat);
        c.run(20);
        let v = c.node_voltages();
        let nodes = c.element_nodes();
        let (nb, _nc, ne) = (nodes[5] as usize, nodes[6] as usize, nodes[7] as usize);
        v[nb] - v[ne]
    };

    let vbe_default = vbe_of(1e-13);
    assert!(
        close(vbe_default, 0.5360, 5e-3),
        "default Vbe was {vbe_default}"
    );
    let vbe_spice = vbe_of(1e-16);
    assert!(
        close(vbe_spice, 0.7145, 5e-3),
        "spice-default Vbe was {vbe_spice}"
    );
    assert!(
        close(vbe_spice - vbe_default, 0.1785, 1e-2),
        "Vbe shift was {}",
        vbe_spice - vbe_default
    );
}

#[test]
fn darlington_current_gain_is_the_product_of_the_two_betas() {
    // A darlington is two Ebers-Moll transistors in cascade: Q1's emitter
    // feeds Q2's base and the collectors share one post, so the current gain
    // compounds. In the linear region Ic = ic1 + ic2 = beta*ib +
    // beta*(beta+1)*ib = beta*(beta+2)*ib, which is 10200 with beta = 100.
    // That ratio, not an absolute current, is the hand-derivable assertion:
    // it follows from the Ebers-Moll equations alone, so the pair of series
    // Vbe drops cancels out of it. The 47 M base resistor keeps the ~0.85 mA
    // collector current well below the 5 mA saturation of the 1 k load, so
    // the pair stays in the linear region where the ratio holds.
    let c = &mut build(
        vec![
            elm(1, "rail", &[[0, 0]], &[("maxVoltage", 5.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 47_000_000.0)],
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
                "darlington",
                &[[100, 0], [200, 0], [200, 100]],
                &[("pnp", 1.0)],
            ),
            elm(5, "ground", &[[200, 100]], &[]),
        ],
        opts_budget(1e-5, true, 1000),
    );
    c.run(50);

    let currents = c.element_currents();
    let ib = currents[1]; // through the 47 M base resistor
    let ic = currents[2]; // through the 1 k collector load
    assert!(ib > 1e-8 && ib < 2e-7, "base current was {ib}");
    assert!(ic > 5e-4 && ic < 1.5e-3, "collector current was {ic}");
    let measured_gain = ic / ib;
    assert!(
        (10_000.0..10_400.0).contains(&measured_gain),
        "darlington gain was {measured_gain}, expected beta*(beta+2) = 10200"
    );

    // The operating point follows from the gain and the load line: Vb =
    // Vbe1 + Vbe2 ~ 1.06 V and Vc = 5 - Ic*1k ~ 4.15 V. The reported element
    // current is the collector current into the device.
    let nodes = c.element_nodes();
    let v = c.node_voltages();
    let (nb, nc, _ne) = (nodes[5] as usize, nodes[6] as usize, nodes[7] as usize);
    assert!((0.98..1.14).contains(&v[nb]), "base was {}", v[nb]);
    assert!((4.0..4.3).contains(&v[nc]), "collector was {}", v[nc]);
    assert!(
        currents[3] > 0.0,
        "reported darlington current was {}",
        currents[3]
    );

    // The PNP in the same orientation is reverse biased and off: the base is
    // pulled to the rail, no base current flows and the collector load draws
    // nothing, the darlington's mirror of the transistor's own polarity test.
    let mut pnp = build(
        vec![
            elm(1, "rail", &[[0, 0]], &[("maxVoltage", 5.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 47_000_000.0)],
            ),
            elm(
                3,
                "resistor",
                &[[0, 0], [200, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(
                4,
                "darlington",
                &[[100, 0], [200, 0], [200, 100]],
                &[("pnp", -1.0)],
            ),
            elm(5, "ground", &[[200, 100]], &[]),
        ],
        opts_budget(1e-5, true, 1000),
    );
    pnp.run(50);
    let nodes = pnp.element_nodes();
    let v = pnp.node_voltages();
    let (nb, nc, _ne) = (nodes[5] as usize, nodes[6] as usize, nodes[7] as usize);
    assert!(
        (4.9..5.1).contains(&v[nb]) && (4.9..5.1).contains(&v[nc]),
        "PNP base and collector were {} and {}",
        v[nb],
        v[nc]
    );
    assert!(
        pnp.element_currents()[2].abs() < 1e-9,
        "PNP leaked {} A through the collector load",
        pnp.element_currents()[2]
    );
}
