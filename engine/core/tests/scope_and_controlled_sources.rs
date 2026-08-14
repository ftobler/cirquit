//! Scope, ammeter, decorations, and the controlled sources: CC2, VCVS, VCCS, CCCS, CCVS and the unijunction transistor.

use circuit_core::{ScopeSpec, ScopeValue};

mod common;
use common::*;

// A scope element has zero posts and no electrical presence, so adding one to
// a circuit must leave every node voltage exactly as it was. The divider below
// is built twice, once with a scope and once without, and both must land on
// the hand-computed midpoint of half the supply. The scope is appended last so
// the divider's element indices stay the same in both circuits.
#[test]
fn scope_changes_no_node_voltage() {
    let build_divider = |with_scope: bool| {
        let mut elements = vec![
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
        ];
        if with_scope {
            elements.push(elm(6, "scope", &[], &[]));
        }
        elements
    };

    let plain = &mut build(build_divider(false), opts(1e-5, true));
    plain.run(5);
    let with_scope = &mut build(build_divider(true), opts(1e-5, true));
    with_scope.run(5);

    let plain_mid = plain.element_voltages()[2];
    let scope_mid = with_scope.element_voltages()[2];
    assert!(
        (plain_mid - 5.0).abs() <= 1e-9,
        "plain divider midpoint was {}",
        plain_mid
    );
    assert!(
        (scope_mid - 5.0).abs() <= 1e-9,
        "divider midpoint with scope was {}",
        scope_mid
    );
    // The scope itself reads and draws no current, and it sits at element
    // index 5 in the with-scope circuit.
    let with_scope_volts = with_scope.element_voltages();
    let with_scope_amps = with_scope.element_currents();
    assert!(
        with_scope_volts[5] == 0.0 && with_scope_amps[5] == 0.0,
        "scope element reported volts {} amps {}",
        with_scope_volts[5],
        with_scope_amps[5]
    );
}

#[test]
fn ammeter_reads_the_series_current_without_loading() {
    // The ammeter is a zero-volt source in series (AmmeterElm.java:211-213),
    // so it must not disturb the loop it measures: a 10 V source through a
    // 2 k resistor reads exactly 5 mA through the meter, positive entering
    // its post 0, and the resistor agrees.
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 10.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 2000.0)],
            ),
            elm(3, "ammeter", &[[100, 0], [100, 100]], &[]),
            elm(4, "wire", &[[100, 100], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
        ],
        opts(1e-5, false),
    );
    c.run(5);
    assert!(
        close(c.element_currents()[1], 5e-3, 1e-12),
        "resistor current was {}",
        c.element_currents()[1]
    );
    assert!(
        close(c.element_currents()[2], 5e-3, 1e-12),
        "ammeter current was {}",
        c.element_currents()[2]
    );
    assert!(
        close(c.element_values()[2], 5e-3, 1e-12),
        "ammeter reading was {}",
        c.element_values()[2]
    );
}

#[test]
fn line_decoration_leaves_the_circuit_unchanged() {
    // A line is pure decoration (LineElm.java): upstream declares no posts
    // (GraphicElm.java:35), so adding one must not shift the divider by so
    // much as a volt.
    let divider = |with_line: bool| {
        let mut elements = vec![
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
        ];
        if with_line {
            // A line carries no posts, so its endpoints merge nothing and it
            // stamps nothing: the divider's matrix is unchanged.
            elements.push(elm(6, "line", &[], &[]));
        }
        elements
    };

    let plain = &mut build(divider(false), opts(1e-5, true));
    let decorated = &mut build(divider(true), opts(1e-5, true));
    plain.run(5);
    decorated.run(5);

    let plain_v = plain.element_voltages();
    let decorated_v = decorated.element_voltages();
    assert!(
        close(plain_v[2], 5.0, 1e-9),
        "plain midpoint was {}",
        plain_v[2]
    );
    assert!(
        close(decorated_v[2], 5.0, 1e-9),
        "decorated midpoint was {}",
        decorated_v[2]
    );
    assert!(
        close(decorated_v[2], plain_v[2], 1e-12),
        "the line moved the midpoint by {}",
        decorated_v[2] - plain_v[2]
    );
}

#[test]
fn box_does_not_perturb_the_divider() {
    // The box is a pure decoration: zero posts, no current path, nothing
    // stamped into the matrix. A circuit must solve identically with one
    // drawn on top, which pins the model to a true shell rather than a
    // device that quietly couples or loads its corners.
    let divider = || {
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
        ]
    };
    let plain = &mut build(divider(), opts(1e-5, true));
    plain.run(5);
    let v_plain = plain.element_voltages()[2];

    let mut with_box = divider();
    with_box.push(elm(6, "box", &[], &[]));
    let decorated = &mut build(with_box, opts(1e-5, true));
    decorated.run(5);
    let v_decorated = decorated.element_voltages()[2];

    assert!(close(v_plain, 5.0, 1e-9), "midpoint was {}", v_plain);
    assert!(
        close(v_decorated, v_plain, 1e-9),
        "the box moved the midpoint from {} to {}",
        v_plain,
        v_decorated,
    );
}

#[test]
fn antenna_across_a_resistor_is_bounded_and_finite() {
    let c = &mut build_with(
        vec![
            elm(1, "antenna", &[[0, 0]], &[]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(3, "wire", &[[100, 0], [100, 100]], &[]),
            elm(4, "ground", &[[100, 100]], &[]),
        ],
        opts(1e-5, false),
        vec![ScopeSpec {
            element_id: 1,
            value: ScopeValue::Voltage,
            post: 0,
            steps_per_column: 1,
            columns: 1024,
            ac_coupled: false,
            trigger: Default::default(),
            display_width: 0,
        }],
    );
    let report = c.run(2000);
    assert!(report.converged, "antenna broke Newton convergence");
    assert!(c.error().is_none(), "error: {:?}", c.error());
    let snap = c.scopes()[0].snapshot();
    assert!(
        snap.len() >= 1024,
        "expected a full scope ring, got {}",
        snap.len()
    );
    // The antenna is an ideal source to ground across a plain resistor, so the
    // node reads the injected value exactly. Each AM carrier is bounded by
    // 3*(1.3+1)*3 = 6.9 V and the FM term by 3 V, so the value never leaves
    // [-23.7, 23.7]; 30 keeps a comfortable headroom while still catching a
    // 2x amplitude or a stamping sign error.
    for v in snap {
        assert!(v.is_finite(), "non-finite antenna sample {v}");
        assert!(
            (-30.0..=30.0).contains(&(v as f64)),
            "antenna sample {v} left [-30, 30]"
        );
    }
}

#[test]
fn cc2_positive_gain_conveys_voltage_and_current() {
    // CCII+ (gain +1): X follows Y and the Z current equals the X current.
    // Y is driven to 1 V, X loaded with 1 k to ground and Z with 1 k to
    // ground, so V(X) = V(Y) = 1 V and V(Z) = 1 V, with 1 mA in both loads.
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 1.0)]),
            elm(2, "wire", &[[0, 0], [50, 200]], &[]),
            // Posts: X (output), Y (input), Z (current output).
            elm(
                3,
                "cc2",
                &[[50, 0], [50, 200], [150, 100]],
                &[("gain", 1.0)],
            ),
            elm(
                4,
                "resistor",
                &[[50, 0], [50, 300]],
                &[("resistance", 1000.0)],
            ),
            elm(
                5,
                "resistor",
                &[[150, 100], [150, 300]],
                &[("resistance", 1000.0)],
            ),
            elm(6, "ground", &[[50, 300]], &[]),
            elm(7, "ground", &[[150, 300]], &[]),
            elm(8, "ground", &[[0, 100]], &[]),
        ],
        opts(1e-5, true),
    );
    let report = c.run(20);
    assert!(report.converged, "did not converge: {:?}", report.error);
    let nodes = c.element_nodes();
    let v = c.node_voltages();
    // The cc2 is element index 2; its three posts start at flattened index
    // 2*2 = 4.
    let (nx, ny, nz) = (nodes[4] as usize, nodes[5] as usize, nodes[6] as usize);
    assert!(
        close(v[nx], 1.0, 1e-6) && close(v[ny], 1.0, 1e-6),
        "X/Y were {}/{}, expected 1 V",
        v[nx],
        v[ny]
    );
    assert!(close(v[nz], 1.0, 1e-6), "Z was {}, expected 1 V", v[nz]);
    let cur = c.element_currents();
    // The X-load and Z-load resistors (elements 4 and 5) both carry 1 mA.
    assert!(
        close(cur[3], 1e-3, 1e-6) && close(cur[4], 1e-3, 1e-6),
        "load currents were {}/{} A, expected 1 mA",
        cur[3],
        cur[4]
    );
}

#[test]
fn cc2_negative_gain_inverts_current() {
    // CCII- (gain -1): X still follows Y but the Z current is negated, so the
    // Z load reads -1 mA while the X load reads +1 mA.
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 1.0)]),
            elm(2, "wire", &[[0, 0], [50, 200]], &[]),
            elm(
                3,
                "cc2",
                &[[50, 0], [50, 200], [150, 100]],
                &[("gain", -1.0)],
            ),
            elm(
                4,
                "resistor",
                &[[50, 0], [50, 300]],
                &[("resistance", 1000.0)],
            ),
            elm(
                5,
                "resistor",
                &[[150, 100], [150, 300]],
                &[("resistance", 1000.0)],
            ),
            elm(6, "ground", &[[50, 300]], &[]),
            elm(7, "ground", &[[150, 300]], &[]),
            elm(8, "ground", &[[0, 100]], &[]),
        ],
        opts(1e-5, true),
    );
    let report = c.run(20);
    assert!(report.converged, "did not converge: {:?}", report.error);
    let nodes = c.element_nodes();
    let v = c.node_voltages();
    let (nx, _ny, nz) = (nodes[4] as usize, nodes[5] as usize, nodes[6] as usize);
    assert!(close(v[nx], 1.0, 1e-6), "X was {}, expected 1 V", v[nx]);
    // V(Z) = gain * V(X) = -1 V.
    assert!(close(v[nz], -1.0, 1e-6), "Z was {}, expected -1 V", v[nz]);
    let cur = c.element_currents();
    assert!(
        close(cur[3], 1e-3, 1e-6),
        "X load current was {}, expected +1 mA",
        cur[3]
    );
    assert!(
        close(cur[4], -1e-3, 1e-6),
        "Z load current was {}, expected -1 mA",
        cur[4]
    );
}

#[test]
fn vcvs_expression_drives_the_output() {
    // 212 with one input: V(V+) - V(V-) = expr(a). A 1 V input and expr
    // "2*a" put 2 V across the output pair, which a 1 k load sees as 2 mA.
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 1.0)]),
            elm(2, "wire", &[[0, 0], [50, 0]], &[]),
            // Posts: input A, V+, V-.
            elm_expr(3, "vcvs", &[[50, 0], [150, 100], [150, 200]], 1.0, "2*a"),
            elm(4, "wire", &[[150, 200], [150, 300]], &[]),
            elm(
                5,
                "resistor",
                &[[150, 100], [150, 300]],
                &[("resistance", 1000.0)],
            ),
            elm(6, "ground", &[[150, 300]], &[]),
            elm(7, "ground", &[[0, 100]], &[]),
        ],
        opts(1e-5, true),
    );
    let report = c.run(20);
    assert!(report.converged, "did not converge: {:?}", report.error);
    let nodes = c.element_nodes();
    let v = c.node_voltages();
    // The vcvs is element index 2; posts start at flattened index 2*2 = 4.
    let (vp, vn) = (nodes[4 + 1] as usize, nodes[4 + 2] as usize);
    assert!(
        close(v[vp] - v[vn], 2.0, 1e-6),
        "output was {}/{}, expected 2 V",
        v[vp],
        v[vn]
    );
    assert!(
        close(c.element_currents()[4], 2e-3, 1e-6),
        "load current was {}, expected 2 mA",
        c.element_currents()[4]
    );
}

#[test]
fn vcvs_fractional_input_count_truncates_to_the_post_count() {
    // A 2.5 `inputCount` from a hand-edited file must build as 2 inputs
    // (`(2.5 as i64)` truncates), so the post-count guard at build time sees
    // four posts and cannot reject the spec. The frontend normalises the field
    // to the same integer before it ever reaches the engine; this pins the
    // engine's half of that contract.
    let c = &mut build(
        vec![elm_expr(
            1,
            "vcvs",
            &[[0, 0], [50, 0], [50, 100], [100, 0]],
            2.5,
            "2*a",
        )],
        opts(1e-5, false),
    );
    // Four posts: 2 truncated inputs plus the output pair.
    assert_eq!(c.element_nodes().len(), 4);
}

#[test]
fn vcvs_two_input_linear_map() {
    // 212 with two inputs: expr "a+b" with A = 1 V and B = 0.5 V drives the
    // output to 1.5 V.
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 1.0)]),
            elm(2, "ground", &[[0, 100]], &[]),
            elm(3, "wire", &[[0, 0], [50, 0]], &[]),
            elm(4, "voltage", &[[0, 300], [0, 200]], &[("maxVoltage", 0.5)]),
            elm(5, "ground", &[[0, 300]], &[]),
            elm(6, "wire", &[[0, 200], [50, 200]], &[]),
            // Posts: input A, input B, V+, V-.
            elm_expr(
                7,
                "vcvs",
                &[[50, 0], [50, 200], [150, 100], [150, 300]],
                2.0,
                "a+b",
            ),
            elm(
                8,
                "resistor",
                &[[150, 100], [150, 400]],
                &[("resistance", 1000.0)],
            ),
            elm(9, "wire", &[[150, 300], [150, 400]], &[]),
            elm(10, "ground", &[[150, 400]], &[]),
        ],
        opts(1e-5, true),
    );
    let report = c.run(20);
    assert!(report.converged, "did not converge: {:?}", report.error);
    let nodes = c.element_nodes();
    let v = c.node_voltages();
    // The vcvs is element index 6; posts start at flattened index
    // 2 + 1 + 2 + 2 + 1 + 2 = 10.
    let (vp, vn) = (nodes[10 + 2] as usize, nodes[10 + 3] as usize);
    assert!(
        close(v[vp] - v[vn], 1.5, 1e-6),
        "output was {}/{}, expected 1.5 V",
        v[vp],
        v[vn]
    );
}

#[test]
fn vccs_expression_current_into_load() {
    // 213 with one input: the output current is expr(a). A 5 V input and expr
    // "0.001*a" push 5 mA through a 1 k load, so V(C+) = 5 V.
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 5.0)]),
            elm(2, "wire", &[[0, 0], [50, 0]], &[]),
            // Posts: input A, C+, C-.
            elm_expr(
                3,
                "vccs",
                &[[50, 0], [150, 100], [150, 200]],
                1.0,
                "0.001*a",
            ),
            elm(
                4,
                "resistor",
                &[[150, 100], [150, 300]],
                &[("resistance", 1000.0)],
            ),
            elm(5, "wire", &[[150, 200], [150, 300]], &[]),
            elm(6, "ground", &[[150, 300]], &[]),
            elm(7, "ground", &[[0, 100]], &[]),
        ],
        opts(1e-5, true),
    );
    let report = c.run(20);
    assert!(report.converged, "did not converge: {:?}", report.error);
    let nodes = c.element_nodes();
    let v = c.node_voltages();
    // The vccs is element index 2; posts start at flattened index 2*2 = 4.
    let (vc, _vm) = (nodes[4 + 1] as usize, nodes[4 + 2] as usize);
    assert!(
        close(v[vc], 5.0, 1e-4),
        "C+ was {}, expected 5 V across the 1 k load",
        v[vc]
    );
    assert!(
        close(c.element_currents()[3], 5e-3, 1e-5),
        "load current was {}, expected 5 mA",
        c.element_currents()[3]
    );
}

#[test]
fn vccs_with_no_dc_path_reports_zero_current() {
    // A vccs whose output pair has no DC path (C- hangs off a capacitor) is
    // marked broken like an independent current source: it stamps a 1e8 ohm
    // resistor and reports zero current, so every node stays near ground.
    let c = &mut build(
        vec![
            elm_expr(1, "vccs", &[[0, 0], [100, 0], [100, 100]], 1.0, "0.001*a"),
            elm(2, "capacitor", &[[100, 100], [200, 100]], &[]),
            elm(3, "ground", &[[200, 100]], &[]),
        ],
        opts(1e-5, true),
    );
    let report = c.run(20);
    assert!(report.converged, "did not converge: {:?}", report.error);
    for (i, v) in c.node_voltages().iter().enumerate() {
        assert!(v.abs() < 1e3, "node {i} reached {} V", v);
    }
    assert!(
        close(c.element_currents()[0], 0.0, 1e-9),
        "broken vccs reported {} A",
        c.element_currents()[0]
    );
}

#[test]
fn open_current_source_output_is_pinned_before_the_opamp_runaway() {
    // The qam-256 failure shape: a multiplier vccs (an ideal current source)
    // drives a node whose only load is an open analog switch's `r_off`, here a
    // plain 1e10 ohm resistor. The exact solution is I/G ~ 5e8 V, and that
    // megavolt differential keeps the op-amp follower on the node from ever
    // settling (its convergence test needs vd <= 1000, opamp.rs). The solver
    // pins the effectively-open current-source output to ground, so the
    // follower idles near 0 V and every step converges to finite voltages.
    let c = &mut build(
        vec![
            // Two 5 V rails feed the multiplier inputs, so expr = 0.05 A.
            elm(1, "rail", &[[-100, 0]], &[("maxVoltage", 5.0)]),
            elm(2, "rail", &[[-100, 100]], &[("maxVoltage", 5.0)]),
            // Posts: input A, input B, C+, C-.
            elm_expr(
                3,
                "vccs",
                &[[-100, 0], [-100, 100], [0, 0], [0, 100]],
                2.0,
                "a*b*2/1000",
            ),
            // The open switch's off-resistance: the only load on C+.
            elm(4, "resistor", &[[0, 0], [0, 200]], &[("resistance", 1e10)]),
            // Unity-gain follower whose non-inverting input (post 1) is the
            // C+ node; V- (post 0) ties to the output (post 2).
            elm(
                5,
                "opamp",
                &[[200, 0], [0, 0], [200, 0]],
                &[("gain", 100_000.0), ("maxOut", 15.0), ("minOut", -15.0)],
            ),
            elm(6, "ground", &[[0, 100]], &[]),
            elm(7, "ground", &[[0, 200]], &[]),
        ],
        opts(2e-5, true),
    );
    let report = c.run(50);
    assert!(
        report.converged,
        "step failed: {}",
        report.error.unwrap_or_default()
    );
    for (i, v) in c.node_voltages().iter().enumerate() {
        assert!(v.is_finite(), "node {i} went non-finite");
        assert!(
            v.abs() < 1e6,
            "node {i} reached {v} V, expected a bounded solve"
        );
    }
    // C+ is the vccs's third post (element index 2, flattened post offset 2).
    let nodes = c.element_nodes();
    let cplus = nodes[2 + 2] as usize;
    assert!(
        c.node_voltages()[cplus].abs() < 100.0,
        "the vccs output was {} V, expected it pinned to ground",
        c.node_voltages()[cplus]
    );
    // The follower (element index 4) plots Vout - V+, and its V+ is the pinned
    // node, so the diff is the output voltage: it must idle low, not at the
    // rail it would chase on a megavolt input.
    assert!(
        c.element_voltages()[4].abs() < 100.0,
        "op-amp output was {} V",
        c.element_voltages()[4]
    );
}

#[test]
fn linear_circuit_pins_an_open_current_source_output() {
    // The same open-output runaway in a fully linear circuit: a plain current
    // source (no compliance limit, so `nonlinear()` is false) drives a node
    // whose only load is a 1e10 ohm resistor, an open switch's `r_off`. A
    // linear closure factors once and reuses the cached LU across the whole
    // run (`restore_rhs` never invalidates), so the pin must invalidate the
    // factorisation when it stamps into the matrix, or the solve keeps using
    // the unpinned factors and the node stays at I*1e10 = 1e7 V. With the
    // invalidate the pin lands in the refactored matrix and the node settles
    // at ~I/1.0 = 1e-3 V (OPEN_PIN_G = 1.0).
    let c = &mut build(
        vec![
            // Post 1 receives the delivered current.
            elm(1, "current", &[[0, 0], [100, 0]], &[("current", 1e-3)]),
            // The open output's only load, on post 1's node.
            elm(
                2,
                "resistor",
                &[[100, 0], [100, 200]],
                &[("resistance", 1e10)],
            ),
            // Post 0 grounds through 1 ohm, keeping the output pair
            // DC-connected so the source is not marked broken.
            elm(3, "resistor", &[[0, 0], [0, 200]], &[("resistance", 1.0)]),
            elm(4, "ground", &[[100, 200]], &[]),
            elm(5, "ground", &[[0, 200]], &[]),
        ],
        opts(1e-5, true),
    );
    let report = c.run(10);
    assert!(
        report.converged,
        "step failed: {}",
        report.error.unwrap_or_default()
    );
    for (i, v) in c.node_voltages().iter().enumerate() {
        assert!(v.is_finite(), "node {i} went non-finite");
        assert!(
            v.abs() < 1e4,
            "node {i} reached {v} V, expected a pinned solve"
        );
    }
    // The driven node (post 1, flattened index 1) settles at ~I/1.0 = 1e-3 V,
    // not at the unpinned I*1e10 = 1e7 V.
    let nodes = c.element_nodes();
    let driven = nodes[1] as usize;
    let vd = c.node_voltages()[driven];
    assert!(
        close(vd, 1e-3, 1e-4),
        "driven node was {vd} V, expected ~1e-3 V under the pin"
    );
}

#[test]
fn many_open_current_source_outputs_stay_pinned() {
    // The single-output linear case scaled to a dozen open outputs, so the
    // pin re-derivation checks one effectively-open current-source output per
    // source per Newton iteration: enough open nodes that a linear membership
    // scan over the previous iteration's pin set would have been quadratic.
    // Each source is a plain `current` (no voltage compliance, so the circuit
    // is linear) whose post 1 node is loaded only by a 1e10 ohm resistor, an
    // open switch's `r_off`. Without the pin every driven node sits at
    // I*1e10 = 1e7 V; with it (OPEN_PIN_G = 1.0) each settles at
    // ~I/1.0 = 1e-3 V. Every driven node must land on the pinned value, not
    // just the first one.
    let n = 12;
    let mut elements = Vec::new();
    let mut id = 1;
    for i in 0..n as i32 {
        let x = i * 16;
        elements.push(elm(
            id,
            "current",
            &[[x, 0], [x + 100, 0]],
            &[("current", 1e-3)],
        ));
        id += 1;
        elements.push(elm(
            id,
            "resistor",
            &[[x + 100, 0], [x + 100, 200]],
            &[("resistance", 1e10)],
        ));
        id += 1;
        // Post 0 grounds through 1 ohm, keeping the output pair DC-connected
        // so the source is not marked broken.
        elements.push(elm(
            id,
            "resistor",
            &[[x, 0], [x, 200]],
            &[("resistance", 1.0)],
        ));
        id += 1;
        elements.push(elm(id, "ground", &[[x + 100, 200]], &[]));
        id += 1;
        elements.push(elm(id, "ground", &[[x, 200]], &[]));
        id += 1;
    }
    let c = &mut build(elements, opts(1e-5, true));
    let report = c.run(50);
    assert!(
        report.converged,
        "step failed: {}",
        report.error.unwrap_or_default()
    );
    for (i, v) in c.node_voltages().iter().enumerate() {
        assert!(v.is_finite(), "node {i} went non-finite");
        assert!(
            v.abs() < 1e4,
            "node {i} reached {v} V, expected a pinned solve"
        );
    }
    // Each source block contributes 8 flattened posts: current (2), the open
    // resistor (2), the grounding resistor (2), ground (1), ground (1). The
    // driven terminal is the source's post 1, at offset 8*i + 1.
    let nodes = c.element_nodes();
    for i in 0..n {
        let driven = nodes[8 * i + 1] as usize;
        let vd = c.node_voltages()[driven];
        assert!(
            close(vd, 1e-3, 1e-4),
            "driven node {driven} of source {i} was {vd} V, expected ~1e-3 V under the pin"
        );
    }
}

#[test]
fn cccs_sense_current_drives_the_output_into_a_load() {
    // 215 with one pair: the sense current is the expression variable, so
    // expr "i*2" over the 0.01 A sense loop delivers 0.02 A into the 1 k load
    // and the O+ node sits at 20 V (reference tests/cccs.txt:1).
    let c = &mut build(
        vec![
            // The current source pushes 0.01 A into the A+ post.
            elm(1, "current", &[[0, 0], [50, 0]], &[("current", 0.01)]),
            // Posts: A+, A-, O+, O-.
            elm_expr(
                2,
                "cccs",
                &[[50, 0], [50, 100], [150, 0], [150, 100]],
                2.0,
                "i*2",
            ),
            elm(
                3,
                "resistor",
                &[[150, 0], [150, 200]],
                &[("resistance", 1000.0)],
            ),
            elm(4, "wire", &[[150, 100], [150, 200]], &[]),
            elm(5, "ground", &[[150, 200]], &[]),
            elm(6, "ground", &[[50, 100]], &[]),
            elm(7, "ground", &[[0, 0]], &[]),
        ],
        opts(1e-5, true),
    );
    let report = c.run(20);
    assert!(report.converged, "did not converge: {:?}", report.error);
    let nodes = c.element_nodes();
    let v = c.node_voltages();
    // The cccs is element index 1; its four posts start at flattened index
    // 2 + 2*0 = 2.
    let (nop, _nom) = (nodes[2 + 2] as usize, nodes[2 + 3] as usize);
    assert!(
        close(v[nop], 20.0, 1e-3),
        "O+ was {} V, expected 20 V across the 1 k load",
        v[nop]
    );
    assert!(
        close(c.element_currents()[2], 0.02, 1e-5),
        "load current was {} A, expected 20 mA",
        c.element_currents()[2]
    );
}

#[test]
fn ccvs_sense_current_scales_into_the_output_pair() {
    // 214 with one pair and expr "2*i": a 5 mA sense loop holds 10 mV across
    // the V+/V- output source.
    let c = &mut build(
        vec![
            elm(1, "current", &[[0, 0], [50, 0]], &[("current", 0.005)]),
            // Posts: A+, A-, V+, V-.
            elm_expr(
                2,
                "ccvs",
                &[[50, 0], [50, 100], [150, 0], [150, 100]],
                2.0,
                "2*i",
            ),
            elm(
                3,
                "resistor",
                &[[150, 0], [150, 200]],
                &[("resistance", 1000.0)],
            ),
            elm(4, "wire", &[[150, 100], [150, 200]], &[]),
            elm(5, "ground", &[[150, 200]], &[]),
            elm(6, "ground", &[[50, 100]], &[]),
            elm(7, "ground", &[[0, 0]], &[]),
        ],
        opts(1e-5, true),
    );
    let report = c.run(20);
    assert!(report.converged, "did not converge: {:?}", report.error);
    let nodes = c.element_nodes();
    let v = c.node_voltages();
    // The ccvs is element index 1; posts start at flattened index 2.
    let (nvp, nvm) = (nodes[2 + 2] as usize, nodes[2 + 3] as usize);
    assert!(
        close(v[nvp] - v[nvm], 0.01, 1e-6),
        "output was {}/{}, expected 10 mV",
        v[nvp],
        v[nvm]
    );
}

#[test]
fn ccvs_derivative_expression_stamps_the_squared_current() {
    // expr "i*i" over a 0.01 A sense loop holds 1e-4 V across the output
    // pair. The nonlinear expression is what exercises the `-dx` coupling and
    // the right-hand side: the linearised row is rebuilt from the numerical
    // derivative every iteration (CCVSElm.java:118-139).
    let c = &mut build(
        vec![
            elm(1, "current", &[[0, 0], [50, 0]], &[("current", 0.01)]),
            elm_expr(
                2,
                "ccvs",
                &[[50, 0], [50, 100], [150, 0], [150, 100]],
                2.0,
                "i*i",
            ),
            elm(
                3,
                "resistor",
                &[[150, 0], [150, 200]],
                &[("resistance", 1000.0)],
            ),
            elm(4, "wire", &[[150, 100], [150, 200]], &[]),
            elm(5, "ground", &[[150, 200]], &[]),
            elm(6, "ground", &[[50, 100]], &[]),
            elm(7, "ground", &[[0, 0]], &[]),
        ],
        opts(1e-5, true),
    );
    let report = c.run(20);
    assert!(report.converged, "did not converge: {:?}", report.error);
    let nodes = c.element_nodes();
    let v = c.node_voltages();
    let (nvp, nvm) = (nodes[2 + 2] as usize, nodes[2 + 3] as usize);
    assert!(
        close(v[nvp] - v[nvm], 1e-4, 1e-6),
        "output was {}/{}, expected 1e-4 V",
        v[nvp],
        v[nvm]
    );
}

#[test]
fn cccs_with_no_dc_path_reports_zero_current() {
    // A cccs whose output pair has no DC path (O+/O- hang off nothing) is
    // marked broken like the VCCS: it stamps a 1e8 ohm resistor and reports
    // zero current, so every node stays near ground and the matrix stays
    // solvable.
    let c = &mut build(
        vec![
            // Posts: A+, A-, O+, O-; the output pair floats.
            elm_expr(
                2,
                "cccs",
                &[[50, 0], [50, 100], [150, 0], [150, 100]],
                2.0,
                "i*2",
            ),
            elm(1, "current", &[[0, 0], [50, 0]], &[("current", 0.01)]),
            elm(3, "ground", &[[0, 0]], &[]),
            elm(4, "ground", &[[50, 100]], &[]),
        ],
        opts(1e-5, true),
    );
    let report = c.run(20);
    assert!(report.converged, "did not converge: {:?}", report.error);
    for (i, v) in c.node_voltages().iter().enumerate() {
        assert!(v.abs() < 1e3, "node {i} reached {} V", v);
    }
    assert!(
        close(c.element_currents()[0], 0.0, 1e-9),
        "broken cccs reported {} A",
        c.element_currents()[0]
    );
}

#[test]
fn ccvs_i_alias_reads_the_first_sense_current() {
    // A two-pair 214 (four input pins) with expr "i": the alias slot, not the
    // fourth variable, is the first pair's current. The first pair senses the
    // 0.01 A loop and the second sits open on its 0 V short, so the output
    // holds 10 mV and a stray `d` (slot 3, the open pair) would read zero.
    let c = &mut build(
        vec![
            elm(1, "current", &[[0, 0], [50, 0]], &[("current", 0.01)]),
            // Posts: A+, A-, B+, B-, V+, V-.
            elm_expr(
                2,
                "ccvs",
                &[
                    [50, 0],
                    [50, 100],
                    [50, 200],
                    [50, 300],
                    [150, 0],
                    [150, 100],
                ],
                4.0,
                "i",
            ),
            elm(
                3,
                "resistor",
                &[[150, 0], [150, 200]],
                &[("resistance", 1000.0)],
            ),
            elm(4, "wire", &[[150, 100], [150, 200]], &[]),
            elm(5, "ground", &[[150, 200]], &[]),
            elm(6, "ground", &[[50, 100]], &[]),
            elm(7, "ground", &[[50, 300]], &[]),
            elm(8, "ground", &[[0, 0]], &[]),
        ],
        opts(1e-5, true),
    );
    let report = c.run(20);
    assert!(report.converged, "did not converge: {:?}", report.error);
    let nodes = c.element_nodes();
    let v = c.node_voltages();
    // The ccvs is element index 1; its six posts start at flattened index
    // 2 + 2*0 = 2.
    let (nvp, nvm) = (nodes[2 + 4] as usize, nodes[2 + 5] as usize);
    assert!(
        close(v[nvp] - v[nvm], 0.01, 1e-6),
        "output was {}/{}, expected 10 mV from the first sense current",
        v[nvp],
        v[nvm]
    );
}

#[test]
fn cccs_odd_input_count_truncates_to_even_pairs() {
    // The inputs are pairs; an odd file count (3) is truncated to the even
    // value below, so the element simulates as a single-pair source and never
    // allocates a dangling half-pair pin (CCVSElm.setChipEditValue). The
    // 0.01 A sense loop still drives 20 V into the 1 k load.
    let c = &mut build(
        vec![
            elm(1, "current", &[[0, 0], [50, 0]], &[("current", 0.01)]),
            // Posts: A+, A-, O+, O-.
            elm_expr(
                2,
                "cccs",
                &[[50, 0], [50, 100], [150, 0], [150, 100]],
                3.0,
                "i*2",
            ),
            elm(
                3,
                "resistor",
                &[[150, 0], [150, 200]],
                &[("resistance", 1000.0)],
            ),
            elm(4, "wire", &[[150, 100], [150, 200]], &[]),
            elm(5, "ground", &[[150, 200]], &[]),
            elm(6, "ground", &[[50, 100]], &[]),
            elm(7, "ground", &[[0, 0]], &[]),
        ],
        opts(1e-5, true),
    );
    let report = c.run(20);
    assert!(report.converged, "did not converge: {:?}", report.error);
    let nodes = c.element_nodes();
    let v = c.node_voltages();
    let nop = nodes[2 + 2] as usize;
    assert!(
        close(v[nop], 20.0, 1e-3),
        "O+ was {} V, expected 20 V across the 1 k load",
        v[nop]
    );
}

#[test]
fn unijunction_fires_when_the_emitter_is_driven_high() {
    // The UJT's internal CCVS makes V(node6) = 1000 * I(emitter) and the VCCS
    // feedback is what fires the emitter-to-B1 path. B2 sits on a 10 V rail
    // and B1 on a 100 ohm load: with E held at 0 V the device is off (B1 near
    // ground, no emitter current), and once E is driven above the peak point
    // (about 6.6 V here) the emitter conducts and B1 is pulled up by the
    // E-B1 current. This asserts the static operating point rather than a full
    // relaxation oscillation, which needs the adaptive timestep upstream turns
    // on for this element (UnijunctionElm.java:46) and is hard to pin
    // analytically. The fired operating point needs the gmin ramps room to
    // climb, so its Newton budget is the app's default 1000, not the test
    // helper's 100.
    let off = &mut build(
        vec![
            elm(1, "voltage", &[[0, 200], [0, 0]], &[("maxVoltage", 0.0)]),
            elm(2, "wire", &[[0, 0], [100, 0]], &[]),
            // Posts: emitter E, base-one B1, base-two B2.
            elm(3, "unijunction", &[[100, 0], [100, 300], [100, 500]], &[]),
            elm(
                4,
                "resistor",
                &[[100, 300], [100, 400]],
                &[("resistance", 100.0)],
            ),
            elm(5, "ground", &[[100, 400]], &[]),
            elm(6, "rail", &[[300, 500]], &[("maxVoltage", 10.0)]),
            elm(7, "wire", &[[300, 500], [100, 500]], &[]),
            elm(8, "ground", &[[0, 200]], &[]),
        ],
        opts(1e-5, true),
    );
    let report = off.run(10);
    assert!(report.converged, "did not converge: {:?}", report.error);
    let v = off.node_voltages();
    // The unijunction is element index 2; its three posts start at flattened
    // index 2 + 2 = 4.
    let nb1 = off.element_nodes()[4 + 1] as usize;
    let ie = off.element_currents()[0];
    assert!(
        v[nb1] < 0.5,
        "not-fired B1 was {} V, expected near ground",
        v[nb1]
    );
    assert!(
        ie.abs() < 1e-4,
        "not-fired emitter current was {} A, expected near zero",
        ie
    );

    // The same circuit with E driven above the peak point fires: B1 is pulled
    // up to a few volts and the emitter conducts tens of milliamps.
    let fired = &mut build(
        vec![
            elm(1, "voltage", &[[0, 200], [0, 0]], &[("maxVoltage", 8.0)]),
            elm(2, "wire", &[[0, 0], [100, 0]], &[]),
            elm(3, "unijunction", &[[100, 0], [100, 300], [100, 500]], &[]),
            elm(
                4,
                "resistor",
                &[[100, 300], [100, 400]],
                &[("resistance", 100.0)],
            ),
            elm(5, "ground", &[[100, 400]], &[]),
            elm(6, "rail", &[[300, 500]], &[("maxVoltage", 10.0)]),
            elm(7, "wire", &[[300, 500], [100, 500]], &[]),
            elm(8, "ground", &[[0, 200]], &[]),
        ],
        opts_budget(1e-5, true, 1000),
    );
    let report = fired.run(10);
    assert!(
        report.converged,
        "fired circuit did not converge: {:?}",
        report.error
    );
    let v = fired.node_voltages();
    let nb1 = fired.element_nodes()[4 + 1] as usize;
    let ie = fired.element_currents()[0];
    assert!(
        v[nb1] > 2.0,
        "fired B1 was {} V, expected the E-B1 path pulled up",
        v[nb1]
    );
    assert!(
        ie > 1e-2,
        "fired emitter current was {} A, expected tens of milliamps",
        ie
    );
}

#[test]
fn charge_scope_samples_capacitance_times_plate_voltage() {
    // A charge scope on a capacitor must sample C*Vplate, upstream's
    // `getScopeValue(VAL_CHARGE)` (CapacitorElm.java:225-229). The DC
    // operating point charges the cap to the 10 V rail, so the stored charge
    // is 1e-4 * 10 = 1e-3 C. The engine side of the port's o-line token 8
    // contract: a saved file's charge trace has to reload as a real charge,
    // or it would redraw as a flat voltage waveform.
    let c = &mut build_with(
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
                &[("capacitance", 1e-4)],
            ),
            elm(4, "wire", &[[100, 100], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
        ],
        opts(1e-5, true),
        vec![ScopeSpec {
            element_id: 3,
            value: ScopeValue::Charge,
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
        close(min, 1e-3, 1e-6) && close(max, 1e-3, 1e-6),
        "charge scope sampled {min}/{max}, expected 1e-3 C"
    );
}

// ─── Composite elements and the OTA (Milestone B subcircuits) ───
