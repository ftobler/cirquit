//! Voltage and current source waveforms (legacy flags, noise, frequency), power/current reporting conventions, and the probe.

use std::f64::consts::PI;

use circuit_core::{Circuit, ScopeSpec, ScopeValue};

mod common;
use common::*;

/// A sine source into a grounded resistor, the shape every source test below
/// shares. Post 0 sits on a ground symbol and the resistor's far end is
/// grounded too, so the described circuit "post 0 grounded, post 1 through a
/// resistor to ground" is real: the source's EMF appears as
/// `V(post1) - V(post0)`, which `element_voltages` reports with the upstream
/// sign, and the resistor carries `EMF/1000`.
fn source_into_resistor(id: u32, params: &[(&str, f64)], dt: f64, dc: bool, flags: i64) -> Circuit {
    build_with(
        vec![
            elm_flags(id, "voltage", &[[0, 100], [0, 0]], params, flags),
            elm(
                id + 1,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(id + 2, "ground", &[[0, 100]], &[]),
            elm(id + 3, "ground", &[[100, 0]], &[]),
        ],
        opts(dt, dc),
        Vec::new(),
    )
}

#[test]
fn legacy_cos_flag_loads_as_cosine() {
    // A file that flagged a sine source with FLAG_COS (2) means "cosine":
    // upstream clears the bit and sets phaseShift = pi/2 on load
    // (VoltageElm.java:80-83). The port used to ignore the flag and evaluate
    // the line as a plain sine, a full pi/2 of phase off.
    let c = &mut source_into_resistor(
        1,
        &[
            ("waveform", 1.0),
            ("frequency", 1000.0),
            ("maxVoltage", 10.0),
            ("phaseShift", 0.0),
            ("dutyCycle", 0.5),
        ],
        1e-4,
        false,
        2,
    );
    c.run(1); // t = 1e-4, phase 2*pi*freq*t = 0.6283 rad
    let v = c.element_voltages()[0];
    let phase = 2.0 * PI * 1000.0 * 1e-4;
    let expected = 10.0 * phase.cos();
    assert!(close(v, expected, 0.05), "got {v}, expected {expected}");
    assert!(
        !close(v, 10.0 * phase.sin(), 0.05),
        "the FLAG_COS line still evaluated as a sine ({v})"
    );
}

#[test]
fn legacy_pulse_without_flag_uses_legacy_duty() {
    // Old pulse files predate a configurable duty cycle, so upstream forces
    // the legacy 1/(2*pi) whenever FLAG_PULSE_DUTY (4) is absent
    // (VoltageElm.java:85-88). At a quarter period (phase pi/2) the legacy
    // 0.159 duty pulse has already fallen, while the 0.5 default would still
    // be high.
    let pulse = |flags: i64| {
        let mut c = source_into_resistor(
            1,
            &[
                ("waveform", 5.0),
                ("frequency", 1000.0),
                ("maxVoltage", 10.0),
                ("bias", 0.0),
                ("dutyCycle", 0.5),
            ],
            1e-6,
            false,
            flags,
        );
        c.run(250); // t = 2.5e-4 = a quarter period, phase pi/2
        c.element_voltages()[0]
    };

    let legacy = pulse(0);
    assert!(close(legacy, 0.0, 0.01), "legacy pulse read {legacy}");
    let flagged = pulse(4);
    assert!(
        close(flagged, 10.0, 0.01),
        "pulse with FLAG_PULSE_DUTY read {flagged}"
    );
}

#[test]
fn noise_holds_constant_across_subiterations() {
    // Upstream samples noise once per converged step in stepFinished, so the
    // value is constant across a step's Newton subiterations
    // (VoltageElm.java:163-166). The port used to draw a fresh sample in
    // do_step, so a noise source in a nonlinear circuit changed the
    // right-hand side every subiteration and Newton could never converge.
    let c = &mut build_with(
        vec![
            elm(
                1,
                "voltage",
                &[[0, 100], [0, 0]],
                &[("waveform", 6.0), ("maxVoltage", 5.0)],
            ),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(3, "diode", &[[100, 0], [100, 100]], &[]),
            elm(4, "wire", &[[100, 100], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
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
    let report = c.run(50);
    assert!(report.converged, "noise source broke Newton convergence");
    assert!(c.error().is_none(), "error: {:?}", c.error());

    let snap = c.scopes()[0].snapshot();
    assert!(
        snap.len() >= 50,
        "expected one column per step, got {}",
        snap.len()
    );
    for v in snap {
        assert!(v.is_finite(), "non-finite noise sample {v}");
        assert!((-5.0..=5.0).contains(&v), "noise sample {v} left [-5, 5]");
    }
}

#[test]
fn noise_is_deterministic_and_uncorrelated() {
    // Two builds of the same circuit (same element ids, so the same per-source
    // seeds) must reproduce the identical trace, and two noise sources with
    // different ids in one circuit must not generate the same sequence.
    let noise_circuit = || {
        build_with(
            vec![
                elm(
                    1,
                    "voltage",
                    &[[0, 100], [0, 0]],
                    &[("waveform", 6.0), ("maxVoltage", 5.0)],
                ),
                elm(
                    2,
                    "resistor",
                    &[[0, 0], [100, 0]],
                    &[("resistance", 1000.0)],
                ),
                elm(3, "diode", &[[100, 0], [100, 100]], &[]),
                elm(4, "wire", &[[100, 100], [0, 100]], &[]),
                elm(5, "ground", &[[0, 100]], &[]),
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
        )
    };
    let mut a = noise_circuit();
    a.run(100);
    let trace_a = a.scopes()[0].snapshot();
    let mut b = noise_circuit();
    b.run(100);
    assert_eq!(
        trace_a,
        b.scopes()[0].snapshot(),
        "noise drifted run to run"
    );

    // Two noise sources in one circuit. Each branch is an independent source
    // into a grounded resistor; the wire ties both negative terminals to the
    // shared ground node.
    let mut two = build_with(
        vec![
            elm(
                1,
                "voltage",
                &[[0, 100], [0, 0]],
                &[("waveform", 6.0), ("maxVoltage", 5.0)],
            ),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(
                3,
                "voltage",
                &[[200, 100], [200, 0]],
                &[("waveform", 6.0), ("maxVoltage", 5.0)],
            ),
            elm(
                4,
                "resistor",
                &[[200, 0], [300, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(5, "wire", &[[300, 0], [300, 100]], &[]),
            elm(6, "wire", &[[300, 100], [200, 100]], &[]),
            elm(7, "wire", &[[200, 100], [0, 100]], &[]),
            elm(8, "ground", &[[0, 100]], &[]),
        ],
        opts(1e-5, false),
        vec![
            ScopeSpec {
                element_id: 1,
                value: ScopeValue::Voltage,
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
    let report = two.run(100);
    assert!(report.converged, "two noise sources did not converge");
    let first = two.scopes()[0].snapshot();
    let second = two.scopes()[1].snapshot();
    assert!(
        first != second,
        "two noise sources with different ids produced the same trace"
    );
}

#[test]
fn frequency_edit_preserves_phase() {
    // A live frequency edit must not jump the waveform to a new phase: the
    // phase reference rewinds so the edit instant is continuous
    // (VoltageElm.java:497-508). Without freqTimeZero the value after the edit
    // snaps to the phase-jumped answer, about -5.88 here.
    let c = &mut source_into_resistor(
        1,
        &[
            ("waveform", 1.0),
            ("frequency", 1000.0),
            ("maxVoltage", 10.0),
            ("bias", 0.0),
        ],
        1e-6,
        false,
        0,
    );
    c.run(400); // t = 4e-4, phase 0.8*pi
    let v_before = c.element_voltages()[0];
    let expected_before = 10.0 * (0.8 * PI).sin();
    assert!(close(v_before, expected_before, 0.05), "got {v_before}");

    assert!(c.set_param(1, "frequency", 4000.0));
    c.run(1); // t = 4.01e-4
    let v = c.element_voltages()[0];
    // Phase at the edit was 0.8*pi; one 1 us step at 4 kHz advances it by
    // 2*pi*4000*1e-6 = 0.008*pi.
    let expected = 10.0 * (0.808 * PI).sin();
    assert!(close(v, expected, 0.05), "got {v}, expected {expected}");
    let jumped = 10.0 * (2.0 * PI * 4000.0 * 4.01e-4).sin();
    assert!(
        !close(v, jumped, 0.05),
        "frequency edit jumped the phase: {v} vs the phase-jumped {jumped}"
    );
}

#[test]
fn frequency_clamps_to_a_solvable_max() {
    // The port has no confirm dialogs, so a frequency the timestep cannot
    // resolve clamps silently to 1/(8*dt) (VoltageElm.java:500). With
    // dt = 1e-5 the bound is 12500 Hz, and one step later the source must
    // still read the clamped waveform rather than the requested 1e9.
    let c = &mut source_into_resistor(
        1,
        &[
            ("waveform", 1.0),
            ("frequency", 1000.0),
            ("maxVoltage", 10.0),
            ("bias", 0.0),
        ],
        1e-5,
        false,
        0,
    );
    assert!(c.set_param(1, "frequency", 1e9));
    c.run(1); // t = 1e-5
    let v = c.element_voltages()[0];
    let expected = 10.0 * (2.0 * PI * 12500.0 * 1e-5).sin();
    assert!(close(v, expected, 0.05), "got {v}, expected {expected}");
    let unclamped = 10.0 * (2.0 * PI * 1e9 * 1e-5).sin();
    assert!(
        !close(v, unclamped, 0.05),
        "frequency was not clamped: {v} matches the 1e9 waveform"
    );
}

#[test]
fn square_and_pulse_honour_rise_time() {
    // With riseTime set, the square ramps its edges instead of switching
    // instantly (VoltageElm.java:179-203) and the pulse ramps between its low
    // and high levels (VoltageElm.java:214-238). At t = 1e-6 the phase is
    // 0.00628 rad, well inside the rising edge centred at phase 0: halfRise =
    // riseTime*freq*pi = 0.314, so both waves sit a fraction t =
    // (phase + halfRise) / (2*halfRise) up their ramp.
    let dt = 1e-6;
    let freq = 1000.0;
    let rise_time = 1e-4;
    let half_rise = rise_time * freq * PI;
    let phase = 2.0 * PI * freq * dt;
    let t = (phase + half_rise) / (2.0 * half_rise);

    let square = &mut source_into_resistor(
        1,
        &[
            ("waveform", 2.0),
            ("frequency", freq),
            ("maxVoltage", 5.0),
            ("bias", 0.0),
            ("dutyCycle", 0.5),
            ("riseTime", rise_time),
        ],
        dt,
        false,
        0,
    );
    square.run(1);
    let v = square.element_voltages()[0];
    let expected = 5.0 * (2.0 * t - 1.0);
    assert!(close(v, expected, 0.05), "square ramp read {v}");
    assert!(
        !close(v, 5.0, 0.05),
        "square still had an instantaneous edge ({v})"
    );

    let pulse = &mut source_into_resistor(
        1,
        &[
            ("waveform", 5.0),
            ("frequency", freq),
            ("maxVoltage", 5.0),
            ("bias", 0.0),
            ("dutyCycle", 0.5),
            ("riseTime", rise_time),
        ],
        dt,
        false,
        0,
    );
    pulse.run(1);
    let v = pulse.element_voltages()[0];
    assert!(close(v, 5.0 * t, 0.05), "pulse ramp read {v}");
    assert!(
        !close(v, 5.0, 0.05),
        "pulse still had an instantaneous edge ({v})"
    );
}

#[test]
fn source_scope_and_readout_use_upstream_sign() {
    // Upstream's sources read out volts[1] - volts[0] (VoltageElm.java:462),
    // so a 5 V source with its negative post grounded displays +5, not the
    // -5 the generic V(post0) - V(post1) convention gives. The scope trace
    // must agree with the Options-panel readout.
    let c = &mut build_with(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 5.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(3, "ground", &[[0, 100]], &[]),
            elm(4, "ground", &[[100, 0]], &[]),
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
    c.run(1);
    assert!(
        close(c.element_voltages()[0], 5.0, 1e-9),
        "source readout was {}",
        c.element_voltages()[0]
    );
    let snap = c.scopes()[0].snapshot();
    assert_eq!(snap.len(), 2, "expected one min/max column");
    assert!(
        close(snap[0] as f64, 5.0, 1e-9),
        "scope min was {}",
        snap[0]
    );
    assert!(
        close(snap[1] as f64, 5.0, 1e-9),
        "scope max was {}",
        snap[1]
    );
}

#[test]
fn source_and_resistor_report_a_consistent_current_loop() {
    // Pins the reported-current sign convention that the dot drawing, the
    // scope and the ammeter all read: a 5 V source delivering into a 1 k
    // resistor reports +5 mA, and the resistor reports +5 mA entering its
    // post 0. The source's MNA unknown is positive when current flows from
    // post 0 to post 1 inside the source, the same `stampVoltageSource`
    // upstream stamps on `(nodes[0], nodes[1])` (VoltageElm.java:149-154,
    // SimulationManager.java:1157-1163), and a delivering source does flow
    // that way, so +5 mA here is the same sign upstream's `getCurrent()`
    // returns. The resistor's +5 mA is (V(post0) - V(post1))/R
    // (ResistorElm.java:109), current entering post 0. Both positive is the
    // loop: out of the source's post 1, into the resistor's post 0, around
    // through ground back to the source's post 0. A draw layer that shows
    // these dots going the other way is the draw's bug, not the engine's.
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 5.0)]),
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
    c.run(5);
    let amps = c.element_currents();
    assert!(
        close(amps[0], 5e-3, 1e-12),
        "source current was {}",
        amps[0]
    );
    assert!(
        close(amps[1], 5e-3, 1e-12),
        "resistor current was {}",
        amps[1]
    );
    assert!(amps[0] * amps[1] > 0.0, "loop currents must agree in sign");
}

#[test]
fn rail_reports_delivery_as_positive_like_upstream() {
    // The rail is a one-post source stamped to ground with the post as the
    // second terminal, `stampVoltageSource(CircuitNode.ground, nodes[0], ...)`
    // (RailElm.java:100-105), so its MNA current is positive when current
    // flows ground to post, i.e. when the rail delivers out of the post. That
    // is why RailElm.draw negates the current for its stem dots (RailElm.java:
    // 61): a delivering rail must draw dots running from the symbol toward the
    // post, and a positive reported current means delivery.
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
    let amps = c.element_currents();
    assert!(
        close(amps[0], 5e-3, 1e-12),
        "delivering rail current was {}",
        amps[0]
    );
}

#[test]
fn element_powers_use_the_scope_convention() {
    // `element_powers` must match what a Power scope samples, so the Options
    // panel readout and the scope agree for a source. The 5 V source delivers
    // 5 mA into the 1 k load: (V(post0) - V(post1)) * current is -25 mW for
    // the source (delivering) and +25 mW for the resistor (dissipating),
    // which is upstream's own -getVoltageDiff()*current.
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 5.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(3, "ground", &[[0, 100]], &[]),
            elm(4, "ground", &[[100, 0]], &[]),
        ],
        opts(1e-5, false),
    );
    c.run(1);
    let powers = c.element_powers();
    assert!(
        close(powers[0], -25e-3, 1e-12),
        "source power was {}",
        powers[0]
    );
    assert!(
        close(powers[1], 25e-3, 1e-12),
        "resistor power was {}",
        powers[1]
    );
    // And a Power scope on the source must sample the same value the readout
    // shows, not the positive EMF*I the display sign would give.
    let mut c = build_with(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 5.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(3, "ground", &[[0, 100]], &[]),
            elm(4, "ground", &[[100, 0]], &[]),
        ],
        opts(1e-5, false),
        vec![ScopeSpec {
            element_id: 1,
            value: ScopeValue::Power,
            post: 0,
            steps_per_column: 1,
            columns: 1024,
            ac_coupled: false,
            trigger: Default::default(),
            display_width: 0,
        }],
    );
    c.run(1);
    let snap = c.scopes()[0].snapshot();
    assert!(
        close(snap[0] as f64, -25e-3, 1e-9),
        "power scope min was {}",
        snap[0]
    );
}

#[test]
fn voltage_limited_current_source_clips() {
    // A 0.01 A source with 5 V compliance into a 1 M load must settle just
    // above 5 V, where the tanh transition has rolled the current off, instead
    // of driving the node to i*R = 1e4 V like an ideal source. The transition
    // spans 0.95*Vmax to Vmax (CurrentElm.java:134-137), so the operating
    // point lands just past 5 V.
    let c = &mut build(
        vec![
            elm(
                1,
                "current",
                &[[0, 100], [0, 0]],
                &[("current", 0.01), ("maxVoltage", 5.0)],
            ),
            elm(2, "resistor", &[[0, 0], [100, 0]], &[("resistance", 1e6)]),
            elm(3, "ground", &[[0, 100]], &[]),
            elm(4, "ground", &[[100, 0]], &[]),
        ],
        opts(1e-5, true),
    );
    let report = c.run(20);
    assert!(report.converged, "did not converge: {:?}", report.error);
    let v = c.element_voltages()[0];
    assert!(
        (4.5..=6.0).contains(&v.abs()),
        "source terminal voltage was {v}, expected it clipped near 5 V"
    );
    let i = c.element_currents()[1];
    assert!(
        i.abs() < 1e-3,
        "resistor current was {i}, the ideal source would push 0.01 A"
    );
}

#[test]
fn current_source_in_series_with_capacitor_settles() {
    // A source with no DC path (series capacitor) used to drive its bare
    // terminal to i/GMIN = 1e7 V through the floating-node pin. Analysis now
    // marks the source broken: it stamps a 100 M resistor and reports zero
    // current, so every node stays near ground.
    let c = &mut build(
        vec![
            elm(1, "current", &[[0, 0], [100, 0]], &[("current", 0.01)]),
            elm(2, "capacitor", &[[100, 0], [100, 100]], &[]),
            elm(3, "ground", &[[100, 100]], &[]),
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
        "broken source reported {} A",
        c.element_currents()[0]
    );
}

#[test]
fn voltage_limited_source_is_never_forced_broken() {
    // Same no-DC-path topology as the broken-source test, but with a 5 V
    // compliance: `setBroken` excludes voltage-limited sources
    // (CurrentElm.java:102-104), so the companion model drives the terminal
    // voltage up near 5 V instead of the source being replaced by a 100 M
    // resistor and sitting near 0 V.
    let c = &mut build(
        vec![
            elm(
                1,
                "current",
                &[[0, 0], [100, 0]],
                &[("current", 0.01), ("maxVoltage", 5.0)],
            ),
            elm(2, "capacitor", &[[100, 0], [100, 100]], &[]),
            elm(3, "ground", &[[100, 100]], &[]),
        ],
        opts(1e-5, true),
    );
    let report = c.run(20);
    assert!(report.converged, "did not converge: {:?}", report.error);
    let v = c.element_voltages()[0];
    assert!(
        (4.0..=6.5).contains(&v.abs()),
        "terminal voltage was {v}, expected it clipped near 5 V rather than being forced broken"
    );
}

#[test]
fn broken_state_tracks_switch_toggles() {
    // A current source driving a loop through a resistor and a switch is fine
    // while the switch is closed and broken once it opens; the check runs from
    // `set_state`'s restamp, so the flag tracks the toggle without a rebuild.
    let c = &mut build(
        vec![
            elm(1, "current", &[[0, 0], [100, 0]], &[("current", 0.01)]),
            elm(
                2,
                "resistor",
                &[[100, 0], [200, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(3, "switch", &[[200, 0], [200, 100]], &[("position", 0.0)]),
            elm(4, "wire", &[[200, 100], [0, 100]], &[]),
            elm(5, "wire", &[[0, 100], [0, 0]], &[]),
            elm(6, "ground", &[[0, 100]], &[]),
        ],
        opts(1e-5, true),
    );
    c.run(5);
    assert!(
        close(c.element_currents()[0], 0.01, 1e-9),
        "closed switch: source reported {} A",
        c.element_currents()[0]
    );

    assert!(c.set_state(3, 1));
    let report = c.run(5);
    assert!(report.converged, "did not converge: {:?}", report.error);
    for (i, v) in c.node_voltages().iter().enumerate() {
        assert!(v.abs() < 1e3, "node {i} reached {} V", v);
    }
    assert!(
        close(c.element_currents()[0], 0.0, 1e-9),
        "open switch: source reported {} A",
        c.element_currents()[0]
    );

    assert!(c.set_state(3, 0));
    c.run(5);
    assert!(
        close(c.element_currents()[0], 0.01, 1e-9),
        "re-closed switch: source reported {} A",
        c.element_currents()[0]
    );
}

#[test]
fn zero_current_source_is_inert_at_engine_level() {
    // A 0 A current source given directly to the engine stays 0 A: the
    // load-time 0 -> 0.01 normalisation is the frontend's job
    // (CurrentElm.java:43-44), and this pins that the model itself does not
    // force it. With nothing driving the load, the divider current is 0.
    let c = &mut build(
        vec![
            elm(1, "current", &[[0, 100], [0, 0]], &[("current", 0.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(3, "ground", &[[0, 100]], &[]),
            elm(4, "ground", &[[100, 0]], &[]),
        ],
        opts(1e-5, true),
    );
    c.run(5);
    assert!(
        close(c.element_currents()[1], 0.0, 1e-12),
        "load current was {}",
        c.element_currents()[1]
    );
}

#[test]
fn probe_series_resistance_loads_the_divider() {
    // A probe across the lower leg of a 10 V / 10k divider puts its series
    // resistance in parallel with that leg (ProbeElm.java:347-350). With
    // resistance 10k the lower leg becomes 5k and the midpoint falls to
    // 10 * 5/(10+5) = 3.333 V, while the reported current is that voltage
    // over the resistance, 3.333e-4 A (ProbeElm.java:343-345). An ideal probe
    // (resistance 0) must leave the divider at 5 V and report zero current.
    let dt = 1e-5;
    let expected_midpoint = 10.0 * 5000.0 / 15000.0;
    let ideal = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 10.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 10_000.0)],
            ),
            elm(
                3,
                "resistor",
                &[[100, 0], [100, 100]],
                &[("resistance", 10_000.0)],
            ),
            elm(4, "wire", &[[100, 100], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
            elm(6, "probe", &[[100, 0], [100, 100]], &[("resistance", 0.0)]),
        ],
        opts(dt, true),
    );
    ideal.run(5);
    assert!(
        close(ideal.element_voltages()[2], 5.0, 1e-9),
        "ideal probe moved the midpoint to {}",
        ideal.element_voltages()[2]
    );
    assert!(
        close(ideal.element_currents()[5], 0.0, 1e-12),
        "ideal probe reported {} A",
        ideal.element_currents()[5]
    );

    // The live edit path: raising the resistance makes the same probe load the
    // divider without a rebuild, and the next steps settle on the loaded point.
    assert!(ideal.set_param(6, "resistance", 10_000.0));
    ideal.run(5);
    assert!(
        close(ideal.element_voltages()[2], expected_midpoint, 1e-3),
        "edited probe left the midpoint at {}",
        ideal.element_voltages()[2]
    );
    assert!(
        close(
            ideal.element_currents()[5],
            expected_midpoint / 10_000.0,
            1e-7
        ),
        "probe current was {}",
        ideal.element_currents()[5]
    );

    // And a probe built with the resistance already set reaches the same point
    // straight off the file.
    let loaded = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 10.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 10_000.0)],
            ),
            elm(
                3,
                "resistor",
                &[[100, 0], [100, 100]],
                &[("resistance", 10_000.0)],
            ),
            elm(4, "wire", &[[100, 100], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
            elm(
                6,
                "probe",
                &[[100, 0], [100, 100]],
                &[("resistance", 10_000.0)],
            ),
        ],
        opts(dt, true),
    );
    loaded.run(5);
    assert!(
        close(loaded.element_voltages()[2], expected_midpoint, 1e-3),
        "loaded probe left the midpoint at {}",
        loaded.element_voltages()[2]
    );
}

/// A 1 kHz, 10 V peak sine into a 1k resistor with a probe across the source
/// terminals, the shape the three measurement tests share. `probe_index` is
/// where the probe lands in the element list.
fn probe_on_sine(meter: f64) -> Circuit {
    build(
        vec![
            elm(
                1,
                "voltage",
                &[[0, 100], [0, 0]],
                &[
                    ("waveform", 1.0),
                    ("frequency", 1000.0),
                    ("maxVoltage", 10.0),
                ],
            ),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(
                3,
                "probe",
                &[[0, 100], [0, 0]],
                &[("resistance", 0.0), ("meter", meter)],
            ),
            elm(4, "ground", &[[0, 100]], &[]),
            elm(5, "ground", &[[100, 0]], &[]),
        ],
        opts(1e-6, false),
    )
}

#[test]
fn probe_measures_rms_on_a_sine() {
    // Two full periods of a 1 kHz sine at dt = 1e-6 is 2000 steps. The last
    // direction change (the peak, half a period earlier) finalised the RMS
    // over a complete half-cycle, so `value()` reads the sine RMS, 10/sqrt(2),
    // within the one-sample discretisation error at the turning point.
    let c = &mut probe_on_sine(1.0);
    c.run(2000);
    let values = c.element_values();
    let expected = 10.0 / 2.0f64.sqrt();
    assert!(
        close(values[2], expected, 0.05),
        "RMS read {}, expected {expected}",
        values[2]
    );
}

#[test]
fn probe_zero_stall_clears_the_reading() {
    // A signal parked at zero for more than five samples zeroes the RMS,
    // average and the peaks (ProbeElm.java:328-340). Kill the drive after two
    // full periods and the accumulator must not keep the stale value.
    let c = &mut probe_on_sine(1.0);
    c.run(2000);
    assert!(
        close(c.element_values()[2], 10.0 / 2.0f64.sqrt(), 0.05),
        "RMS before the stall was {}",
        c.element_values()[2]
    );

    assert!(c.set_param(1, "maxVoltage", 0.0));
    c.run(10);
    assert!(
        close(c.element_values()[2], 0.0, 1e-12),
        "RMS after the stall was {}",
        c.element_values()[2]
    );
}

#[test]
fn each_probe_meter_mode_reads_the_right_quantity() {
    // Seven ideal probes across the source terminals, one per selectable mode
    // (ProbeElm.java:444-446): VOL, RMS, AVG, MAX, MIN, P2P, BIN. After two
    // full periods the last direction changes captured a complete half-cycle
    // of peaks and troughs, and the last sample sits at t = 2 ms.
    let c = &mut build(
        vec![
            elm(
                1,
                "voltage",
                &[[0, 100], [0, 0]],
                &[
                    ("waveform", 1.0),
                    ("frequency", 1000.0),
                    ("maxVoltage", 10.0),
                ],
            ),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(
                3,
                "probe",
                &[[0, 100], [0, 0]],
                &[("resistance", 0.0), ("meter", 0.0)],
            ),
            elm(
                4,
                "probe",
                &[[0, 100], [0, 0]],
                &[("resistance", 0.0), ("meter", 1.0)],
            ),
            elm(
                5,
                "probe",
                &[[0, 100], [0, 0]],
                &[("resistance", 0.0), ("meter", 10.0)],
            ),
            elm(
                6,
                "probe",
                &[[0, 100], [0, 0]],
                &[("resistance", 0.0), ("meter", 2.0)],
            ),
            elm(
                7,
                "probe",
                &[[0, 100], [0, 0]],
                &[("resistance", 0.0), ("meter", 3.0)],
            ),
            elm(
                8,
                "probe",
                &[[0, 100], [0, 0]],
                &[("resistance", 0.0), ("meter", 4.0)],
            ),
            elm(
                9,
                "probe",
                &[[0, 100], [0, 0]],
                &[("resistance", 0.0), ("meter", 5.0)],
            ),
            elm(10, "ground", &[[0, 100]], &[]),
            elm(11, "ground", &[[100, 0]], &[]),
        ],
        opts(1e-6, false),
    );
    c.run(2000);
    let values = c.element_values();
    assert!(close(values[2], 0.0, 1e-6), "VOL read {}", values[2]);
    assert!(
        close(values[3], 10.0 / 2.0f64.sqrt(), 0.05),
        "RMS read {}",
        values[3]
    );
    assert!(close(values[4], 0.0, 0.1), "AVG read {}", values[4]);
    assert!(close(values[5], 10.0, 0.05), "MAX read {}", values[5]);
    assert!(close(values[6], -10.0, 0.05), "MIN read {}", values[6]);
    assert!(close(values[7], 20.0, 0.1), "P2P read {}", values[7]);
    assert!(close(values[8], 0.0, 1e-12), "BIN read {}", values[8]);
}

#[test]
fn probe_series_resistance_rescues_a_floating_node() {
    // The far end of a probe with a series resistor is a node whose only path
    // to the rest of the circuit runs through that resistor, so the probe's
    // `connects()` must tie it to the ground side for the floating-node
    // analysis (ProbeElm.java:397). With an ideal probe (resistance 0) the
    // same node is its own component, flagged and pinned with GMIN instead.
    let dt = 1e-5;
    let circuit = |resistance: f64| {
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
                    "probe",
                    &[[100, 0], [100, 100]],
                    &[("resistance", resistance)],
                ),
                elm(4, "ground", &[[0, 100]], &[]),
            ],
            opts(dt, true),
        )
    };

    let ideal = &mut circuit(0.0);
    assert!(
        ideal
            .warnings()
            .iter()
            .any(|w| w.contains("no path to ground")),
        "an ideal probe should leave the node floating"
    );

    let mut tied = circuit(1e6);
    assert!(
        tied.warnings()
            .iter()
            .all(|w| !w.contains("no path to ground")),
        "warnings: {:?}",
        tied.warnings()
    );
    tied.run(5);
    // The dangling node sits at the source-side 10 V through the 1 M tie, so
    // no current flows and the probe reads zero differential.
    assert!(
        close(tied.element_voltages()[2], 0.0, 1e-6),
        "probe differential was {}",
        tied.element_voltages()[2]
    );
}
