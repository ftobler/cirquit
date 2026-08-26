//! The transformer family's DC operating point: under `dc_analysis` every
//! winding stamps a `1 / DC_SHORT` near-short with the mutual terms dropped,
//! the same steady-state shape a plain inductor takes (inductor.rs:94-98),
//! and the file-seeded winding currents still own the transient start state.

use circuit_core::{Circuit, CircuitSpec, ElementSpec};

mod common;
use common::*;

/// A DC loop for one winding: source `v` (bottom post grounded) feeding `r`
/// ohms into the winding's top post, the winding's bottom post grounded. At
/// steady state the winding reads as a 1e-6 ohm short, so the loop current is
/// `v / (r + 1e-6)` and the winding's top node sits `i * 1e-6` above ground.
struct LoopPosts {
    src_bottom: [i32; 2],
    src_top: [i32; 2],
    winding_top: [i32; 2],
    winding_bottom: [i32; 2],
}

fn driven_loop(src_id: u32, r_id: u32, v: f64, r: f64, p: LoopPosts) -> Vec<ElementSpec> {
    vec![
        elm(
            src_id,
            "voltage",
            &[p.src_bottom, p.src_top],
            &[("maxVoltage", v)],
        ),
        elm(
            r_id,
            "resistor",
            &[p.src_top, p.winding_top],
            &[("resistance", r)],
        ),
        elm(r_id + 100, "ground", &[p.winding_bottom], &[]),
        elm(r_id + 101, "ground", &[p.src_bottom], &[]),
    ]
}

/// Ratio-1 basic transformer between two driven loops: the primary hangs off
/// a 10 V source through 1 kOhm, the secondary off a 5 V source through
/// 500 Ohm. With windings as 1e-6 ohm shorts and no coupling at DC, each side
/// solves its own resistive loop by hand.
#[test]
fn transformer_dc_matches_resistive_solution() {
    const R1: f64 = 1000.0;
    const R2: f64 = 500.0;
    let mut elements = Vec::new();
    elements.extend(driven_loop(
        1,
        2,
        10.0,
        R1,
        LoopPosts {
            src_bottom: [0, 100],
            src_top: [0, 0],
            winding_top: [100, 0],
            winding_bottom: [100, 100],
        },
    ));
    elements.push(elm(
        3,
        "transformer",
        &[[100, 0], [300, 0], [100, 100], [300, 100]],
        &[("inductance", 4.0), ("ratio", 1.0), ("couplingCoef", 0.999)],
    ));
    elements.extend(driven_loop(
        4,
        5,
        5.0,
        R2,
        LoopPosts {
            src_bottom: [400, 100],
            src_top: [400, 0],
            winding_top: [300, 0],
            winding_bottom: [300, 100],
        },
    ));
    let c = &mut build(elements, opts(1e-6, true));

    assert_eq!(c.error(), None, "the DC operating point did not solve");
    // Node numbering follows the flattened spec order: 1 is the primary
    // drive, 2 the primary winding top, 3 the secondary winding top, 4 the
    // secondary drive.
    let v = c.node_voltages();
    let ip = 10.0 / (R1 + 1e-6);
    let is = 5.0 / (R2 + 1e-6);
    assert!(close(v[1], 10.0, 1e-9), "primary drive read {}", v[1]);
    assert!(close(v[4], 5.0, 1e-9), "secondary drive read {}", v[4]);
    assert!(
        close(v[2], ip * 1e-6, ip * 1e-6 * 1e-6),
        "primary winding top read {}, expected {}",
        v[2],
        ip * 1e-6
    );
    assert!(
        close(v[3], is * 1e-6, is * 1e-6 * 1e-6),
        "secondary winding top read {}, expected {}",
        v[3],
        is * 1e-6
    );
    // The transformer's reported current is winding 0's: v/DC_SHORT, the
    // primary loop current the resistive solution gives. It sits at index 4:
    // each driven_loop contributes four elements ahead of it.
    let i = c.element_currents()[4];
    assert!(
        close(i, ip, ip * 1e-9),
        "primary current read {i}, expected {ip}"
    );
}

/// Same shorted-winding shape on the tapped (169) and custom (406) rows. The
/// tapped transformer drives its primary and one secondary half while the
/// other half hangs off the grounded tap with a dangling far post, which
/// stays well posed without any special case. Each of the custom
/// description's three coils gets its own driven loop.
#[test]
fn tapped_and_custom_transformer_dc_shapes() {
    // Tapped: windings (p0,p1), (p2,p3), (p3,p4); p3 is the tap. The
    // primary's two posts are 0 and 1, so its loop grounds post 1 and the
    // driven half hangs off posts 2 and 3, leaving half B as a dangling
    // stub on the grounded tap.
    let mut elements = Vec::new();
    elements.extend(driven_loop(
        1,
        2,
        10.0,
        1000.0,
        LoopPosts {
            src_bottom: [0, 100],
            src_top: [0, 0],
            winding_top: [200, 0],
            winding_bottom: [200, 100],
        },
    ));
    elements.push(elm(
        3,
        "tappedTransformer",
        &[[200, 0], [200, 100], [300, 0], [300, 100], [300, 200]],
        &[("inductance", 4.0), ("ratio", 2.0), ("couplingCoef", 0.99)],
    ));
    elements.extend(driven_loop(
        4,
        5,
        5.0,
        500.0,
        LoopPosts {
            src_bottom: [400, 100],
            src_top: [400, 0],
            winding_top: [300, 0],
            winding_bottom: [300, 100],
        },
    ));
    let c = &mut build(elements, opts(1e-6, true));
    assert_eq!(c.error(), None, "tapped DC operating point did not solve");
    let ip = 10.0 / (1000.0 + 1e-6);
    let is = 5.0 / (500.0 + 1e-6);
    // Node 2 is the primary winding top, 3 the driven half's top and 4 the
    // undriven half's dangling far post, which rides the grounded tap.
    let v = c.node_voltages();
    assert!(
        close(v[2], ip * 1e-6, ip * 1e-6 * 1e-6),
        "primary winding top read {}, expected {}",
        v[2],
        ip * 1e-6
    );
    assert!(
        close(v[3], is * 1e-6, is * 1e-6 * 1e-6),
        "secondary half top read {}, expected {}",
        v[3],
        is * 1e-6
    );
    assert!(
        close(c.element_currents()[4], ip, ip * 1e-9),
        "tapped primary current read {}",
        c.element_currents()[4]
    );
    assert!(
        close(v[4], 0.0, 1e-12),
        "dangling half's far post read {}",
        v[4]
    );

    // Custom "1,1:1": three independent coils at posts (0,1), (2,3), (4,5).
    let mut tr = elm(
        11,
        "customTransformer",
        &[
            [100, 0],
            [100, 100],
            [200, 0],
            [200, 100],
            [300, 0],
            [300, 100],
        ],
        &[("inductance", 4.0), ("couplingCoef", 0.999)],
    );
    tr.label = Some("1,1:1".into());
    let mut elements = Vec::new();
    elements.extend(driven_loop(
        10,
        12,
        8.0,
        800.0,
        LoopPosts {
            src_bottom: [0, 200],
            src_top: [0, 0],
            winding_top: [100, 0],
            winding_bottom: [100, 100],
        },
    ));
    elements.push(tr);
    elements.extend(driven_loop(
        13,
        14,
        4.0,
        400.0,
        LoopPosts {
            src_bottom: [250, 200],
            src_top: [250, 0],
            winding_top: [200, 0],
            winding_bottom: [200, 100],
        },
    ));
    elements.extend(driven_loop(
        16,
        17,
        2.0,
        200.0,
        LoopPosts {
            src_bottom: [350, 200],
            src_top: [350, 0],
            winding_top: [300, 0],
            winding_bottom: [300, 100],
        },
    ));
    let c = &mut build(elements, opts(1e-6, true));
    assert_eq!(c.error(), None, "custom DC operating point did not solve");
    // Every coil closes its own v/(r + DC_SHORT) loop; each coil's top node
    // sits i * DC_SHORT above ground.
    let v = c.node_voltages();
    for (k, (drive, r, top)) in [(8.0, 800.0, 2usize), (4.0, 400.0, 3), (2.0, 200.0, 4)]
        .iter()
        .enumerate()
    {
        let i = drive / (r + 1e-6);
        assert!(
            close(v[*top], i * 1e-6, i * 1e-6 * 1e-6),
            "coil {k} top read {}, expected {}",
            v[*top],
            i * 1e-6
        );
    }
    let ia = 8.0 / (800.0 + 1e-6);
    assert!(
        close(c.element_currents()[4], ia, ia * 1e-9),
        "custom coil A current read {}",
        c.element_currents()[4]
    );
}

/// The file-seeded winding currents survive the autoDC solve and still seed
/// the transient: a circuit built with the DC option on and seeded tokens
/// keeps them after the build, and its first committed step matches a twin
/// built without the DC option from the same seeds.
#[test]
fn transformer_dc_preserves_seeded_currents() {
    fn spec(dc: bool) -> CircuitSpec {
        CircuitSpec {
            preserve_run: false,
            elements: vec![
                elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 10.0)]),
                elm(
                    2,
                    "resistor",
                    &[[0, 0], [100, 0]],
                    &[("resistance", 1000.0)],
                ),
                elm(
                    3,
                    "transformer",
                    &[[100, 0], [300, 0], [100, 100], [300, 100]],
                    &[
                        ("inductance", 4.0),
                        ("ratio", 1.0),
                        ("couplingCoef", 0.999),
                        ("current0", 0.05),
                        ("current1", -0.02),
                    ],
                ),
                elm(
                    4,
                    "resistor",
                    &[[300, 0], [300, 100]],
                    &[("resistance", 1000.0)],
                ),
                elm(5, "ground", &[[100, 100]], &[]),
                elm(6, "ground", &[[0, 100]], &[]),
            ],
            options: Some(opts(1e-6, dc)),
            scopes: Vec::new(),
        }
    }

    let mut fixed = Circuit::new();
    fixed
        .set_circuit(&spec(false))
        .expect("the fixed-step twin should build");
    fixed.run(1);

    let mut dc = Circuit::new();
    dc.set_circuit(&spec(true))
        .expect("the autoDC twin should build");
    // The DC pass ran during this build, against these very seeds: the guard
    // in calculate_current must have left both winding currents alone.
    let toks = &dc.state_tokens()[2];
    let token = |name: &str| {
        toks.iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| *v)
            .expect("token missing")
    };
    assert!(
        close(token("current0"), 0.05, 1e-15),
        "seeded primary read {}",
        token("current0")
    );
    assert!(
        close(token("current1"), -0.02, 1e-15),
        "seeded secondary read {}",
        token("current1")
    );

    // And the transient continues identically from either start. Not bit
    // for bit: the autoDC twin carries the solved operating point into its
    // first trapezoidal history term, and that term is a*winding drop, here
    // O(1e-12) A against the 0.05 A seed. Real state corruption shows orders
    // of magnitude above that (the companion-shaped voltages the old DC
    // stamp left behind moved this node by half a volt).
    dc.run(1);
    let a = fixed.node_voltages();
    let b = dc.node_voltages();
    assert_eq!(a.len(), b.len());
    for k in 0..a.len() {
        assert!(
            close(a[k], b[k], a[k].abs() * 1e-9),
            "node {k} diverged: {} vs {}",
            a[k],
            b[k]
        );
    }
}
