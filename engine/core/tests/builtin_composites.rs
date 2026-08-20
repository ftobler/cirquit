//! The built-in composite elements: 401 comparator, 409 realistic op-amp,
//! 407 optocoupler, 412 crystal. These are the CompositeElm types built
//! through the composite machinery (ota.rs), not the `.`-line custom
//! composites, so their tests pin the composite child wiring plus an analytic
//! result per element.

use std::collections::HashMap;

use circuit_core::{ElementSpec, ScopeSpec, ScopeValue};

mod common;
use common::*;

/// A built-in composite spec. `tokens` are the `_`-joined child dumps a saved
/// line carries, reaching the engine in `spec.model` exactly like the OTA's.
fn elm_composite(
    id: u32,
    kind: &str,
    posts: &[[i32; 2]],
    tokens: &[&str],
    params: &[(&str, f64)],
) -> ElementSpec {
    ElementSpec {
        id,
        kind: kind.into(),
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

/// The node id of the element's `p`-th post, given the flattened offset
/// (post-count sum of every earlier element) into `element_nodes()`.
fn post_node(c: &mut circuit_core::Circuit, offset: usize) -> usize {
    c.element_nodes()[offset] as usize
}

// ─── 401 comparator ───

/// The comparator test circuit: V- and V+ driven, the open-drain output
/// raised by a 10k pull-up to 5 V. Returns the output node voltage.
fn comparator_out(v_minus: f64, v_plus: f64) -> f64 {
    let c = &mut build(
        vec![
            elm(
                1,
                "voltage",
                &[[0, 0], [100, 0]],
                &[("maxVoltage", v_minus)],
            ),
            elm(
                2,
                "voltage",
                &[[0, 100], [100, 100]],
                &[("maxVoltage", v_plus)],
            ),
            // Posts: V-, V+, output (ComparatorElm.java:86-88).
            elm_composite(3, "comparator", &[[100, 0], [100, 100], [300, 0]], &[], &[]),
            elm(
                4,
                "resistor",
                &[[300, 0], [400, 0]],
                &[("resistance", 10000.0)],
            ),
            elm(5, "rail", &[[400, 0]], &[("maxVoltage", 5.0)]),
            elm(6, "ground", &[[0, 0]], &[]),
            elm(7, "ground", &[[0, 100]], &[]),
        ],
        opts(1e-5, true),
    );
    let report = c.run(30);
    assert!(report.converged, "did not converge: {:?}", report.error);
    let n = post_node(c, 6); // comparator post 2 (offset 4 + 2)
    c.node_voltages()[n]
}

#[test]
fn comparator_drives_its_open_drain_output_low_and_releases_high() {
    // The model wires the op-amp's non-inverting input to the V- post and its
    // inverting input to the V+ post (ComparatorElm.java:8-9, external nodes
    // {2, 1, 4}: node 2 = V- post = the op-amp's in+, node 1 = V+ post = the
    // op-amp's in-). The switch's pull-to-ground action then inverts back, so
    // the net behaviour is a standard comparator: V+ above V- rails the
    // op-amp negative, opening the switch and releasing the output to the
    // pull-up; V+ below V- closes it and pulls the output to the ground
    // child's node.
    let high = comparator_out(1.5, 2.5);
    assert!(
        high > 4.9,
        "positive differential should release the output to the pull-up, got {high} V"
    );
    let low = comparator_out(1.5, 0.5);
    assert!(
        low < 0.1,
        "negative differential should pull the output low, got {low} V"
    );
}

// ─── 412 crystal ───

/// The crystal test circuit: a source drives the crystal through a 1k series
/// resistor, the far post grounded.
fn crystal_circuit(params: &[(&str, f64)], freq: f64, dc: bool) -> circuit_core::Circuit {
    let els = vec![
        elm(
            1,
            "voltage",
            &[[0, 100], [0, 0]],
            &[
                ("waveform", if dc { 0.0 } else { 1.0 }),
                ("frequency", freq),
                ("maxVoltage", 5.0),
            ],
        ),
        elm(
            2,
            "resistor",
            &[[0, 0], [100, 0]],
            &[("resistance", 1000.0)],
        ),
        elm_composite(3, "crystal", &[[100, 0], [100, 100]], &[], params),
        elm(4, "ground", &[[0, 100]], &[]),
        elm(5, "ground", &[[100, 100]], &[]),
    ];
    build_with(
        els,
        opts(1e-5, dc),
        vec![ScopeSpec {
            element_id: 3,
            value: ScopeValue::Voltage,
            post: 0,
            steps_per_column: 50,
            columns: 4096,
            ac_coupled: false,
            trigger: Default::default(),
            display_width: 0,
        }],
    )
}

/// Peak amplitude of a scope trace's steady-state tail: the largest column
/// max over the second half of the buffer. The series branch starts from rest
/// and rings at turn-on, so measuring the whole run would catch the overshoot
/// rather than the settled amplitude.
fn sine_peak(c: &circuit_core::Circuit, i: usize) -> f64 {
    let snap = c.scopes()[i].snapshot();
    assert!(snap.len() >= 4, "scope captured nothing");
    let tail = &snap[snap.len() / 2..];
    tail.chunks_exact(2)
        .map(|ch| ch[1] as f64)
        .fold(0.0f64, f64::max)
}

#[test]
fn crystal_is_an_open_circuit_at_dc() {
    // Both branches are capacitive, so no DC current flows and the full
    // source sits across the crystal. The DC operating point pins the caps as
    // 100M opens, so a hair of leakage current drops a few millivolts across
    // the 1k drive resistor.
    let c = &mut crystal_circuit(&[], 1000.0, true);
    let report = c.run(30);
    assert!(report.converged, "did not converge: {:?}", report.error);
    let n = post_node(c, 4); // crystal post 0 (offset 4)
    let v = c.node_voltages()[n];
    assert!(
        close(v, 5.0, 1e-3),
        "crystal should hold almost the full 5 V at DC, got {v}"
    );
}

#[test]
fn crystal_impedance_vanishes_at_series_resonance() {
    // The motional branch resonates when L and Cs cancel: at fs = 1/(2π√(LCs))
    // the crystal reads just its resistance, so a 5 V sine through 1k splits
    // as 5·R/(R+1k). Away from resonance the series capacitance dominates and
    // the divider swings most of the source onto the crystal.
    let params = [
        ("seriesCapacitance", 1e-6),
        ("inductance", 0.02533),
        ("resistance", 100.0),
        ("parallelCapacitance", 28.7e-12),
    ];
    // fs = 1/(2π√(LCs)) for the values above, 1 kHz to well inside the 100 kHz
    // Nyquist of the 1e-5 step.
    let fs = 1000.0;
    let expected = 5.0 * 100.0 / (100.0 + 1000.0);

    let at_res = &mut crystal_circuit(&params, fs, false);
    let report = at_res.run(2000);
    assert!(
        report.converged,
        "resonant run did not converge: {:?}",
        report.error
    );
    let peak = sine_peak(at_res, 0);
    assert!(
        close(peak, expected, 0.1),
        "crystal voltage at resonance was {peak}, expected about {expected}"
    );

    let off_res = &mut crystal_circuit(&params, fs / 4.0, false);
    let report = off_res.run(2000);
    assert!(
        report.converged,
        "off-resonant run did not converge: {:?}",
        report.error
    );
    let far = sine_peak(off_res, 0);
    assert!(
        far > 1.4,
        "crystal voltage at 250 Hz was {far}, expected well above the resonant {expected}"
    );
}

// ─── 407 optocoupler ───

/// The optocoupler test circuit: a 1 mA current source drives the LED, and
/// the phototransistor collector is loaded by 1k to a 5 V rail. Returns the
/// collector node voltage.
fn opto_collector(ctr: f64) -> f64 {
    let c = &mut build(
        vec![
            // The LED current is set exactly by the source: everything it
            // delivers flows through the LED into the CCCS sense pair and on
            // to ground, so the CCCS input is known without modelling the
            // LED's forward drop.
            elm(
                1,
                "current",
                &[[0, 100], [0, 0]],
                &[("current", 0.001), ("maxVoltage", 5.0)],
            ),
            // Posts: LED anode, LED return, collector, emitter.
            elm_composite(
                2,
                "optocoupler",
                &[[0, 0], [0, 100], [300, 0], [300, 100]],
                &[],
                &[("ctr", ctr)],
            ),
            elm(
                3,
                "resistor",
                &[[300, 0], [400, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(4, "rail", &[[400, 0]], &[("maxVoltage", 5.0)]),
            elm(5, "ground", &[[0, 100]], &[]),
            elm(6, "ground", &[[300, 100]], &[]),
        ],
        opts(1e-5, true),
    );
    let report = c.run(30);
    assert!(report.converged, "did not converge: {:?}", report.error);
    let n = post_node(c, 4); // optocoupler post 2 (offset 2 + 2)
    c.node_voltages()[n]
}

/// The optocoupler CTR curve evaluated at `i` amps, the polynomial upstream
/// fits for a ~100% device (OptocouplerElm.java:70-72).
fn ctr_curve(i: f64) -> f64 {
    let v = if i < 0.003 {
        (-80000000000.0 * i.powi(5) + 800000000.0 * i.powi(4) - 3000000.0 * i.powi(3)
            + 5177.2 * i.powi(2)
            + 0.2453 * i
            - 0.00005)
            * 1.04
            / 700.0
    } else {
        (9000000.0 * i.powi(5) - 998113.0 * i.powi(4) + 42174.0 * i.powi(3) - 861.32 * i.powi(2)
            + 9.0836 * i
            - 0.0078)
            * 0.945
            / 700.0
    };
    v.clamp(0.0, 0.0001)
}

#[test]
fn optocoupler_transfers_led_current_to_the_collector_through_the_ctr_curve() {
    // The CCCS delivers ctr·curve(1 mA) into the base and draws the same
    // current back out of the collector node, so the external collector load
    // carries base plus the amplified (beta = 700) transistor current, i.e.
    // (1+700)·ctr·curve. The 1k load turns that into a voltage below the 5 V
    // rail. Both ctr scalings must reproduce the same formula independently of
    // the LED model; the transistor's reverse saturation leakage takes a few
    // millivolts off, hence the 10 mV tolerance.
    for ctr in [0.25, 0.5, 1.0] {
        let base = ctr * ctr_curve(0.001);
        let expected = 5.0 - 701.0 * base * 1000.0;
        let v = opto_collector(ctr);
        assert!(
            close(v, expected, 0.01),
            "collector at ctr {ctr} was {v} V, expected about {expected} (base {base})"
        );
    }
    // A ctr high enough to demand more collector current than the 1k load can
    // carry drives the phototransistor into saturation: the collector parks at
    // the ~0.2 V Vce_sat instead of the unphysical negative value the linear
    // formula would give.
    let sat = opto_collector(2.0);
    assert!(
        (0.0..0.6).contains(&sat),
        "saturated collector was {sat}, expected near Vce_sat"
    );
}

/// The LED forward drop at a known LED current: a current source pins the LED
/// current, and the voltage between the two LED posts is exactly that current's
/// forward drop (the CCCS sense pair shorts the LED cathode to the LED-return
/// post, so `V(post0) - V(post1)` is the junction drop). The phototransistor
/// side is left open.
fn opto_led_forward_drop(led_current: f64) -> f64 {
    let c = &mut build(
        vec![
            elm(
                1,
                "current",
                &[[0, 100], [0, 0]],
                &[("current", led_current), ("maxVoltage", 5.0)],
            ),
            // Posts: LED anode, LED return, collector, emitter.
            elm_composite(
                2,
                "optocoupler",
                &[[0, 0], [0, 100], [300, 0], [300, 100]],
                &[],
                &[],
            ),
            elm(5, "ground", &[[0, 100]], &[]),
        ],
        opts(1e-5, true),
    );
    let report = c.run(30);
    assert!(report.converged, "did not converge: {:?}", report.error);
    let n0 = post_node(c, 2); // optocoupler post 0 (offset 2 + 0)
    let n1 = post_node(c, 3); // optocoupler post 1 (offset 2 + 1)
    let v = c.node_voltages();
    v[n0] - v[n1]
}

#[test]
fn optocoupler_led_uses_the_default_optocoupler_led_model() {
    // Upstream forces the internal LED to `default-optocoupler-led`
    // (DiodeModel.java:92: Is = 1.714e-7, n = 4.077). The port default diode is
    // Is = 1.714e-7 but n = 2, so at a given current its forward drop is ~half;
    // this test pins the drop and would fail against n = 2.
    const VT: f64 = 0.025_865;
    let is = 1.714e-7;
    let n = 4.077;
    let vscale = n * VT;
    for &i in &[0.001, 0.003, 0.01] {
        let expected = vscale * (i / is + 1.0_f64).ln();
        let measured = opto_led_forward_drop(i);
        assert!(
            close(measured, expected, expected * 0.03),
            "LED drop at {i} A was {measured} V, expected about {expected} \
             (default-optocoupler-led, n={n})"
        );
    }
}

// ─── 409 realistic op-amp ───

#[test]
fn opamp_real_follower_tracks_its_input_within_the_741_offset() {
    // The transistor-level 741 in unity-gain feedback: a 1 V input on the
    // non-inverting pin, the output wired back to the inverting pin, +/-15 V
    // rails. Closed-loop gain is one, so the output should track the input to
    // within the offset the diff pair leaves on the summing node (tens of
    // millivolts, as on the real part).
    let c = &mut build(
        vec![
            elm(
                1,
                "voltage",
                &[[0, 100], [100, 100]],
                &[("maxVoltage", 1.0)],
            ),
            // Posts: V-, V+, out, V+ supply, V- supply (OpAmpRealElm.java:18).
            elm_composite(
                2,
                "opampReal",
                &[[100, 0], [100, 100], [300, 0], [300, -100], [300, -200]],
                &[],
                &[
                    ("slewRate", 0.6),
                    ("capValue", 2.5),
                    ("currentLimit", 0.0231),
                ],
            ),
            elm(
                3,
                "resistor",
                &[[300, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(4, "rail", &[[300, -100]], &[("maxVoltage", 15.0)]),
            elm(5, "rail", &[[300, -200]], &[("maxVoltage", -15.0)]),
            elm(6, "ground", &[[0, 100]], &[]),
        ],
        opts(1e-5, true),
    );
    let report = c.run(30);
    assert!(report.converged, "did not converge: {:?}", report.error);
    let n = post_node(c, 4); // the opampReal output post (offset 2 + 2)
    let out = c.node_voltages()[n];
    assert!(
        close(out, 1.0, 0.05),
        "follower output was {out}, expected about 1 V"
    );
}
