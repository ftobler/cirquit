//! Regression coverage for the expression-derivative controlled sources.
//!
//! Every one of `vccs`/`vcvs`/`cccs`/`ccvs` set `state.t = ctx.time` in
//! `do_step` but left `state.time_step` at zero, so `dadt`/`dcdt` divided by
//! zero (`Expr.java:145-146` reads the simulator's global `timeStep`; the port
//! carries it on the state instead). The `inf`/`NaN` that produced singularised
//! the Newton matrix, and every circuit whose expression names a derivative
//! reported "The circuit has no solution". The tests below drive each source
//! from a `dadt`/`dcdt` expression at DC and under a sine, and all of them fail
//! without the one-line `state.time_step = ctx.dt` per element.
//!
//! This retires the corpus entries for `cs-varicap.txt` (VCCS `dadt`/`dcdt`
//! feedback) and `cs-varinduct.txt` (CCVS `dadt` feedback).
//!
//! `cs-opamprail.txt` is a separate problem and still fails: see
//! [`clamped_high_gain_amplifier_needs_the_adaptive_step`].

use circuit_core::Circuit;

mod common;
use common::*;

/// Reads a post's node voltage. `post_offset` is the element's first index in
/// the flattened `element_nodes()` array, i.e. the total post count of every
/// element ahead of it in the builder vec.
fn v_of(c: &Circuit, post_offset: usize, post: usize) -> f64 {
    let nodes = c.element_nodes();
    c.node_voltages()[nodes[post_offset + post] as usize]
}

/// The VCCS sits sixth in the builder vec below, behind five 2-post elements.
const VCCS_POSTS: usize = 10;
/// The CCVS sits seventh, behind six 2-post elements.
const CCVS_POSTS: usize = 12;
/// The CCCS sits fourth, behind three 2-post elements.
const CCCS_POSTS: usize = 6;
/// The VCVS sits sixth, behind five 2-post elements.
const VCVS_POSTS: usize = 10;

/// `cs-varicap.txt`'s shape: a VCCS whose output current is a voltage
/// derivative fed back through its own input node.
fn varicap(sine: bool, dc: bool) -> Circuit {
    let source = if sine {
        vec![
            ("maxVoltage", 1.0),
            ("waveform", 1.0),
            ("frequency", 1000.0),
        ]
    } else {
        vec![("maxVoltage", 1.0)]
    };
    build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &source),
            elm(2, "wire", &[[0, 0], [50, 0]], &[]),
            elm(
                3,
                "resistor",
                &[[50, 0], [50, 100]],
                &[("resistance", 180.0)],
            ),
            elm(
                4,
                "voltage",
                &[[50, 200], [50, 100]],
                &[("maxVoltage", 2.0)],
            ),
            elm(
                5,
                "resistor",
                &[[150, 0], [150, 100]],
                &[("resistance", 1000.0)],
            ),
            elm_expr(
                6,
                "vccs",
                &[[50, 0], [50, 100], [150, 0], [150, 100]],
                2.0,
                "-(dadt-dcdt)*b*.00001",
            ),
            elm(
                7,
                "capacitor",
                &[[150, 0], [150, 100]],
                &[("capacitance", 1e-9)],
            ),
            elm(8, "ground", &[[0, 100]], &[]),
            elm(9, "ground", &[[50, 200]], &[]),
            elm(10, "ground", &[[150, 100]], &[]),
        ],
        opts(5e-6, dc),
    )
}

#[test]
fn vccs_dadt_feedback_settles_at_dc() {
    // At DC the time derivatives vanish, so the delivered current is exactly
    // zero. Pre-fix `dadt` divided by zero and the matrix went singular.
    let c = &mut varicap(false, true);
    let report = c.run(40);
    assert!(
        report.converged,
        "VCCS dadt circuit did not converge: {:?}",
        report.error
    );
    let i = c.element_currents()[5];
    assert!(
        i.is_finite() && i.abs() < 1e-6,
        "DC dadt current was {}, expected ~0",
        i
    );
}

#[test]
fn vccs_dadt_feedback_runs_dynamically() {
    // A sine input makes dadt/dcdt non-zero; the circuit must still converge
    // with finite node voltages and a bounded output current.
    let c = &mut varicap(true, false);
    let report = c.run(40);
    assert!(
        report.converged,
        "VCCS dynamic dadt did not converge: {:?}",
        report.error
    );
    let v = c.node_voltages();
    assert!(
        v.iter().all(|x| x.is_finite()),
        "node voltages were not all finite: {:?}",
        v
    );
    // The VCCS input pair sees the 180 ohm divider, so the fed-back current
    // stays microscopic; anything near an amp means the derivative blew up.
    let i = c.element_currents()[5];
    assert!(
        i.is_finite() && i.abs() < 1.0,
        "VCCS current was {}, expected finite and bounded",
        i
    );
    assert!(
        v_of(c, VCCS_POSTS, 2).abs() > 1e-9,
        "the VCCS output node never moved, so the sine never reached it"
    );
}

/// `cs-varinduct.txt`'s shape: a CCVS whose output voltage is the derivative
/// of its own sense current.
fn varinduct(sine: bool, dc: bool) -> Circuit {
    let source = if sine {
        vec![
            ("maxVoltage", 5.0),
            ("waveform", 1.0),
            ("frequency", 1000.0),
        ]
    } else {
        vec![("maxVoltage", 5.0)]
    };
    build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &source),
            elm(2, "resistor", &[[0, 0], [50, 0]], &[("resistance", 100.0)]),
            elm(3, "wire", &[[50, 100], [0, 100]], &[]),
            elm(
                4,
                "voltage",
                &[[100, 100], [100, 0]],
                &[("maxVoltage", 2.0)],
            ),
            elm(
                5,
                "resistor",
                &[[100, 0], [150, 0]],
                &[("resistance", 100.0)],
            ),
            elm(6, "wire", &[[150, 100], [100, 100]], &[]),
            elm_expr(
                7,
                "ccvs",
                &[
                    [50, 0],
                    [50, 100],
                    [150, 0],
                    [150, 100],
                    [250, 0],
                    [250, 100],
                ],
                4.0,
                "dadt*b*400",
            ),
            elm(
                8,
                "resistor",
                &[[250, 0], [350, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(9, "ground", &[[0, 100]], &[]),
            elm(10, "ground", &[[100, 100]], &[]),
            elm(11, "ground", &[[250, 100]], &[]),
            elm(12, "ground", &[[350, 0]], &[]),
        ],
        opts(5e-6, dc),
    )
}

#[test]
fn ccvs_dadt_feedback_settles_at_dc() {
    // At DC the sense current is constant, so dadt = 0 and the output pair
    // sits at exactly 0 V. Pre-fix this divided by zero and had no solution.
    let c = &mut varinduct(false, true);
    let report = c.run(40);
    assert!(
        report.converged,
        "CCVS dadt circuit did not converge: {:?}",
        report.error
    );
    let vout = v_of(c, CCVS_POSTS, 4) - v_of(c, CCVS_POSTS, 5);
    assert!(
        vout.is_finite() && vout.abs() < 1e-6,
        "DC dadt output was {}, expected ~0",
        vout
    );
}

#[test]
fn ccvs_dadt_feedback_runs_dynamically() {
    // A sine-driven sense loop makes dadt non-zero; the circuit must converge
    // with finite node voltages and a moved output.
    let c = &mut varinduct(true, false);
    let report = c.run(40);
    assert!(
        report.converged,
        "CCVS dynamic dadt did not converge: {:?}",
        report.error
    );
    let v = c.node_voltages();
    assert!(
        v.iter().all(|x| x.is_finite()),
        "node voltages were not all finite: {:?}",
        v
    );
    let vout = v_of(c, CCVS_POSTS, 4) - v_of(c, CCVS_POSTS, 5);
    assert!(
        vout.abs() > 1e-9,
        "the CCVS output stayed at 0 V, so dadt never became non-zero"
    );
}

/// A CCCS delivering the derivative of its own sense current. No bundled
/// corpus file exercises this, but the CCCS carried the same missing
/// `time_step`, so it gets the same pin.
fn cccs_dadt(sine: bool, dc: bool) -> Circuit {
    let source = if sine {
        vec![
            ("maxVoltage", 5.0),
            ("waveform", 1.0),
            ("frequency", 1000.0),
        ]
    } else {
        vec![("maxVoltage", 5.0)]
    };
    build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &source),
            elm(2, "resistor", &[[0, 0], [50, 0]], &[("resistance", 100.0)]),
            elm(3, "wire", &[[50, 100], [0, 100]], &[]),
            elm_expr(
                4,
                "cccs",
                &[[50, 0], [50, 100], [150, 0], [150, 100]],
                2.0,
                "dadt*.0001",
            ),
            elm(
                5,
                "resistor",
                &[[150, 0], [150, 100]],
                &[("resistance", 100.0)],
            ),
            elm(6, "ground", &[[0, 100]], &[]),
            elm(7, "ground", &[[150, 100]], &[]),
        ],
        opts(5e-6, dc),
    )
}

#[test]
fn cccs_dadt_feedback_settles_at_dc() {
    let c = &mut cccs_dadt(false, true);
    let report = c.run(40);
    assert!(
        report.converged,
        "CCCS dadt circuit did not converge: {:?}",
        report.error
    );
    let i = c.element_currents()[3];
    assert!(
        i.is_finite() && i.abs() < 1e-9,
        "DC dadt current was {}, expected ~0",
        i
    );
}

#[test]
fn cccs_dadt_feedback_runs_dynamically() {
    let c = &mut cccs_dadt(true, false);
    let report = c.run(40);
    assert!(
        report.converged,
        "CCCS dynamic dadt did not converge: {:?}",
        report.error
    );
    // i(sense) = 5*sin(wt)/100, so dadt = 0.05*w*cos(wt) and the delivered
    // current is 1e-4 times that: tens of milliamps into the 100 ohm load.
    let i = c.element_currents()[3];
    assert!(
        i.is_finite() && i.abs() > 1e-6 && i.abs() < 1.0,
        "CCCS current was {}, expected a bounded non-zero derivative current",
        i
    );
    assert!(
        v_of(c, CCCS_POSTS, 2).abs() > 1e-6,
        "the CCCS output node never moved"
    );
}

/// `cs-opamprail.txt`: a non-inverting amplifier built from a gain-1000 VCVS
/// clamped to a +/-10 V rail pair, `clamp((a-b)*1000, d, c)`.
///
/// This is the port's remaining `cs-*` corpus failure, and the cause is not the
/// clamp itself but the secant derivative around it. `VCVSElm.doStep` slopes
/// each input as `(expr(v) - expr(v - dv))/dv` with `dv` the distance from the
/// previous iterate (VCVSElm.java:71-83, ported in
/// `controlled_source::input_derivative`). Once the amplifier is driven past a
/// rail both sample points sit in saturation, the slope collapses to the
/// `1e-6` floor, and the linearised source becomes a constant. Newton then
/// solves the feedback divider against a constant `-10`, lands at `+3.33 V` on
/// the inverting input, saturates the other way, and flip-flops between the
/// rails forever. Upstream hits the same limit cycle in `OpAmpElm.doStep` and
/// breaks it with randomised hysteresis (`app.getrand(4) == 1`,
/// OpAmpElm.java:176-181); `VCVSElm` has no equivalent, so a fixed-step run
/// exhausts its Newton budget.
///
/// The adaptive timestep is what settles it: halving the step shrinks the
/// per-iteration excursion until the two secant samples straddle the knee
/// again. `cs-opamprail.txt`'s own header leaves flag bit 64 clear, so the
/// corpus runs it fixed-step and it fails there; this pins the behaviour the
/// engine does have, and that the clamp maths is right on both sides of it.
#[test]
fn clamped_high_gain_amplifier_needs_the_adaptive_step() {
    let elements = || {
        vec![
            elm(
                1,
                "voltage",
                &[[96, 336], [96, 176]],
                &[("maxVoltage", 5.0), ("waveform", 1.0), ("frequency", 40.0)],
            ),
            elm(2, "wire", &[[160, 208], [160, 336]], &[]),
            elm(3, "wire", &[[352, 176], [352, 336]], &[]),
            elm(
                4,
                "resistor",
                &[[160, 336], [352, 336]],
                &[("resistance", 2000.0)],
            ),
            elm(
                5,
                "resistor",
                &[[96, 336], [160, 336]],
                &[("resistance", 1000.0)],
            ),
            elm_expr(
                6,
                "vcvs",
                &[
                    [224, 176],
                    [224, 208],
                    [224, 240],
                    [224, 272],
                    [320, 176],
                    [320, 208],
                ],
                4.0,
                "clamp((a-b)*1000,d,c)",
            ),
            elm(7, "wire", &[[320, 176], [352, 176]], &[]),
            elm(8, "wire", &[[160, 208], [224, 208]], &[]),
            elm(9, "wire", &[[96, 176], [224, 176]], &[]),
            elm(10, "ground", &[[96, 336]], &[]),
            elm(11, "ground", &[[320, 208]], &[]),
            elm(12, "rail", &[[224, 240]], &[("maxVoltage", 10.0)]),
            elm(13, "rail", &[[224, 272]], &[("maxVoltage", -10.0)]),
        ]
    };

    // Fixed step: the saturation flip-flop, still the corpus failure.
    let fixed = &mut build(elements(), opts_budget(5e-6, false, 1000));
    let report = fixed.run(100);
    assert!(
        !report.converged,
        "the fixed-step run converged; cs-opamprail.txt can leave \
         DIAGNOSED_SIM_FAILURES"
    );

    // Adaptive step: converges, and the clamp is exact on both sides.
    let c = &mut build(elements(), adaptive_opts(5e-6, 5e-11, 1000));
    // 600 steps of 5 us is 3 ms of the 40 Hz sine, still inside the linear
    // region; the closed-loop gain is 3000/1003 = 2.991 with the 1000x
    // forward gain, not the ideal 3.
    let report = c.run(600);
    assert!(
        report.converged,
        "adaptive linear region did not converge: {:?}",
        report.error
    );
    let a = v_of(c, VCVS_POSTS, 0);
    let vout = v_of(c, VCVS_POSTS, 4) - v_of(c, VCVS_POSTS, 5);
    assert!(
        close(vout, 2.991 * a, 0.01),
        "vout {} did not track the 2.991a amplifier gain for a = {}",
        vout,
        a
    );

    // By 1000 steps (5 ms) the input is past 3.34 V and the output is pinned
    // at the rail the `c` input carries, exactly, like upstream's hard clamp.
    let report = c.run(400);
    assert!(
        report.converged,
        "adaptive saturated region did not converge: {:?}",
        report.error
    );
    let vout = v_of(c, VCVS_POSTS, 4) - v_of(c, VCVS_POSTS, 5);
    assert!(
        close(vout, 10.0, 1e-9),
        "clamped output {} should sit exactly at the +10 V rail",
        vout
    );

    // Half a period later the sine has driven it into the other rail.
    let report = c.run(2500);
    assert!(
        report.converged,
        "adaptive negative rail did not converge: {:?}",
        report.error
    );
    let vout = v_of(c, VCVS_POSTS, 4) - v_of(c, VCVS_POSTS, 5);
    assert!(
        close(vout, -10.0, 1e-9),
        "clamped output {} should sit exactly at the -10 V rail",
        vout
    );
}
