//! The transmission line, variable rail, sweep, AM/FM sources, audio and data inputs, delay buffer, and 555 timer divider.

use std::f64::consts::PI;

use circuit_core::{Circuit, ScopeValue};

mod common;
use common::*;

#[test]
fn transmission_line_step_reaches_open_far_end_after_delay() {
    // A 10 V step drives the left port through a matched 75 ohm source
    // resistor; the right port is open. After exactly one delay the far-end
    // post rises from 0 to 10 V and holds there.
    let dt = 5e-6;
    let len = 10;
    let delay = len as f64 * dt;
    let c = &mut build_with(
        vec![
            elm(
                1,
                "transmissionLine",
                &[[0, 100], [400, 100], [0, 0], [400, 0]],
                &[("delay", delay), ("imped", 75.0)],
            ),
            elm(2, "ground", &[[0, 100]], &[]),
            elm(3, "ground", &[[400, 100]], &[]),
            elm(
                4,
                "voltage",
                &[[-100, 100], [-100, 0]],
                &[("maxVoltage", 10.0)],
            ),
            elm(5, "resistor", &[[-100, 0], [0, 0]], &[("resistance", 75.0)]),
            elm(6, "ground", &[[-100, 100]], &[]),
        ],
        opts(dt, false),
        vec![tr_scope(1, ScopeValue::NodeVoltage, 3)],
    );
    c.run(len);
    assert!(
        close(last_sample(c, 0), 0.0, 1e-9),
        "far end should be 0 before the delay"
    );
    c.run(1);
    assert!(
        close(last_sample(c, 0), 10.0, 1e-3),
        "far end should reach the source value"
    );
    c.run(len);
    assert!(
        close(last_sample(c, 0), 10.0, 1e-3),
        "far end must hold after the round trip"
    );
}

#[test]
fn var_rail_feeds_its_voltage_into_a_divider() {
    let c = &mut build(
        vec![
            elm(1, "varRail", &[[0, 0]], &[("voltage", 3.0)]),
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
    let volts = c.element_voltages();
    let amps = c.element_currents();
    assert!(close(volts[0], 3.0, 1e-9), "rail readout was {}", volts[0]);
    assert!(close(volts[2], 1.5, 1e-9), "midpoint was {}", volts[2]);
    assert!(close(amps[1], 1.5e-3, 1e-12), "current was {}", amps[1]);
    assert!(c.set_param(1, "voltage", 6.0));
    c.run(5);
    let volts = c.element_voltages();
    let amps = c.element_currents();
    assert!(close(volts[0], 6.0, 1e-9), "rail readout was {}", volts[0]);
    assert!(close(volts[2], 3.0, 1e-9), "midpoint was {}", volts[2]);
    assert!(close(amps[1], 3e-3, 1e-12), "current was {}", amps[1]);
}

#[test]
fn ext_voltage_feeds_the_divider() {
    let c = &mut build(
        vec![
            elm(1, "extVoltage", &[[0, 0]], &[("voltage", 5.0)]),
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
    let volts = c.element_voltages();
    let amps = c.element_currents();
    assert!(
        close(volts[0], 5.0, 1e-9),
        "source readout was {}",
        volts[0]
    );
    assert!(close(volts[2], 2.5, 1e-9), "midpoint was {}", volts[2]);
    assert!(close(amps[1], 2.5e-3, 1e-12), "current was {}", amps[1]);
}

#[test]
fn sweep_with_constant_frequency_degenerates_to_ac_source() {
    let freq = 100.0;
    let dt = 1e-5;
    let c = &mut build(
        vec![
            elm(
                1,
                "sweep",
                &[[0, 100]],
                &[
                    ("minF", freq),
                    ("maxF", freq),
                    ("maxV", 5.0),
                    ("sweepTime", 0.1),
                ],
            ),
            elm(
                2,
                "resistor",
                &[[0, 100], [0, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(3, "ground", &[[0, 0]], &[]),
        ],
        opts(dt, false),
    );
    c.run(250);
    let v = c.element_voltages()[1];
    assert!(close(v, 5.0, 1e-9), "quarter-period voltage was {v}");
    c.run(500);
    let v = c.element_voltages()[1];
    assert!(close(v, -5.0, 1e-9), "three-quarter voltage was {v}");
}

#[test]
fn sweep_integrates_the_frequency_ramp_in_phase() {
    let c = &mut build(
        vec![
            elm_flags(
                1,
                "sweep",
                &[[0, 100]],
                &[
                    ("minF", 100.0),
                    ("maxF", 200.0),
                    ("maxV", 5.0),
                    ("sweepTime", 0.1),
                ],
                2, // FLAG_BIDIR
            ),
            elm(
                2,
                "resistor",
                &[[0, 100], [0, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(3, "ground", &[[0, 0]], &[]),
        ],
        opts(1e-5, false),
    );
    c.run(5000);
    let v = c.element_voltages()[1];
    assert!(close(v, 5.0, 1e-9), "mid-ramp voltage was {v}");
    c.run(5000);
    let v = c.element_voltages()[1];
    assert!(close(v, 0.0, 1e-9), "ramp-top voltage was {v}");
    c.run(5000);
    let v = c.element_voltages()[1];
    assert!(close(v, -5.0, 1e-9), "return-ramp voltage was {v}");
}

#[test]
fn am_source_swings_its_envelope_between_zero_and_max_voltage() {
    // V(t) = ((sin(2π·sf·t)+1)/2)·sin(2π·cf·t)·maxV (AMElm.java:80-83). The
    // envelope (sin+1)/2 spans [0, 1], so at the signal's quarter period the
    // carrier rides at its full maxV and at the three-quarter period it is
    // suppressed to zero; a third sample at an arbitrary time pins the exact
    // waveform, not just the envelope.
    let dt = 1e-5;
    let c = &mut build(
        vec![
            elm(
                1,
                "am",
                &[[0, 100]],
                &[
                    ("carrierFreq", 1000.0),
                    ("signalFreq", 40.0),
                    ("maxVoltage", 5.0),
                ],
            ),
            elm(
                2,
                "resistor",
                &[[0, 100], [0, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(3, "ground", &[[0, 0]], &[]),
        ],
        opts(dt, false),
    );
    let v = |c: &Circuit| c.element_voltages()[1];
    let i = |c: &Circuit| c.element_currents()[1];

    // t = 0.0007: both factors mid-flight, the exact formula must hold.
    c.run(70);
    let expected =
        ((2.0 * PI * 40.0 * 0.0007).sin() + 1.0) / 2.0 * (2.0 * PI * 1000.0 * 0.0007).sin() * 5.0;
    assert!(close(v(c), expected, 1e-9), "mid-flight AM read {}", v(c));

    // t = 1/(4·sf): envelope at its peak, carrier at its peak.
    c.run(555);
    assert!(
        close(v(c), 5.0, 1e-9),
        "AM envelope peak read {} V, expected 5",
        v(c)
    );
    assert!(
        close(i(c), 5e-3, 1e-12),
        "AM envelope peak current read {} A, expected 5 mA",
        i(c)
    );

    // t = 3/(4·sf): envelope at zero, the carrier suppressed.
    c.run(1250);
    assert!(
        close(v(c), 0.0, 1e-9),
        "AM envelope trough read {} V, expected 0",
        v(c)
    );
}

#[test]
fn fm_source_tracks_the_integrated_instantaneous_frequency() {
    // The instantaneous frequency is cf + dev·sin(2π·sf·t) (FMElm.java:86-93),
    // so the phase is the exact integral cf·t + dev·(1−cos(2π·sf·t))/(2π·sf)
    // and V(t) = maxV·sin(2π·phase). Upstream accumulates that integral as a
    // per-step right-point sum that drifts with the timestep; the port
    // evaluates the closed form (see fm.rs), so the asserted values are the
    // continuous-limit waveform.
    let dt = 1e-5;
    let c = &mut build(
        vec![
            elm(
                1,
                "fm",
                &[[0, 100]],
                &[
                    ("carrierFreq", 800.0),
                    ("signalFreq", 40.0),
                    ("maxVoltage", 5.0),
                    ("deviation", 200.0),
                ],
            ),
            elm(
                2,
                "resistor",
                &[[0, 100], [0, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(3, "ground", &[[0, 0]], &[]),
        ],
        opts(dt, false),
    );
    let expected = |t: f64| {
        let phase = 800.0 * t + 200.0 * (1.0 - (2.0 * PI * 40.0 * t).cos()) / (2.0 * PI * 40.0);
        5.0 * (2.0 * PI * phase).sin()
    };

    // t = 0.0125: a signal half period, where the modulation term (the cosine
    // integral) peaks.
    c.run(1250);
    assert!(
        close(c.element_voltages()[1], expected(0.0125), 1e-9),
        "FM at t=0.0125 read {}, expected {}",
        c.element_voltages()[1],
        expected(0.0125)
    );

    // t = 0.025: one full signal period, where cos(2π·sf·t) = 1 and the phase
    // reduces to cf·t, so V = maxV·sin(40π) ≈ 0.
    c.run(1250);
    assert!(
        close(c.element_voltages()[1], expected(0.025), 1e-9),
        "FM at t=0.025 read {}, expected {}",
        c.element_voltages()[1],
        expected(0.025)
    );

    // t = 0.03125: a signal quarter period later, the modulation pushes the
    // phase up by dev/(2π·sf) and the value away from the plain carrier.
    c.run(625);
    assert!(
        close(c.element_voltages()[1], expected(0.03125), 1e-9),
        "FM at t=0.03125 read {}, expected {}",
        c.element_voltages()[1],
        expected(0.03125)
    );
}

#[test]
fn audio_input_interpolates_its_samples_and_freezes_during_dc() {
    // V = lerp(samples, timeOffset*samplingRate)·maxVoltage
    // (AudioInputElm.java:129-142). With sr 10000 and dt 1e-4 the cursor
    // advances one sample per step, so the first step reads sample 0, the
    // second sample 1, and a half-sample start position puts the first cursor
    // between samples, exercising the linear interpolation. During the DC
    // solve the source freezes at its 0 V bias like the AC source
    // (VoltageElm.java:168-169).
    let audio = |start_position: f64, dc: bool| {
        let model = serde_json::json!({
            "samples": [0.5, 1.0, 0.0],
            "samplingRate": 10000.0,
        });
        let mut e = elm(
            1,
            "audioInput",
            &[[0, 100]],
            &[
                ("maxVoltage", 2.0),
                ("startPosition", start_position),
                ("fileNum", 0.0),
            ],
        );
        e.model = Some(model.to_string());
        build(
            vec![
                e,
                elm(
                    2,
                    "resistor",
                    &[[0, 100], [0, 0]],
                    &[("resistance", 1000.0)],
                ),
                elm(3, "ground", &[[0, 0]], &[]),
            ],
            opts(1e-4, dc),
        )
    };
    let v = |c: &Circuit| c.element_voltages()[1];

    // The DC build lands on 0: the source is frozen at its bias during the
    // solve, so the loaded node has not started playing yet.
    let c = audio(0.0, true);
    assert!(close(v(&c), 0.0, 1e-12), "DC froze the source at {}", v(&c));

    // Without the solve the transient plays sample 0, then one 1e-4 s step
    // moves the cursor to sample 1, then sample 2, then off the end.
    let mut c = audio(0.0, false);
    c.run(1);
    assert!(
        close(v(&c), 0.5 * 2.0, 1e-12),
        "first sample read {}",
        v(&c)
    );
    c.run(1);
    assert!(
        close(v(&c), 1.0 * 2.0, 1e-12),
        "second sample read {}",
        v(&c)
    );
    c.run(1);
    assert!(close(v(&c), 0.0 * 2.0, 1e-9), "third sample read {}", v(&c));
    c.run(1);
    assert!(close(v(&c), 0.0, 1e-9), "past the end read {}", v(&c));

    // A half-sample start position: the first cursor is at 0.5 samples, so
    // the first step is the interpolation between samples 0 and 1.
    let mut c = audio(0.5e-4, false);
    c.run(1);
    assert!(
        close(v(&c), (0.5 * 0.5 + 1.0 * 0.5) * 2.0, 1e-12),
        "interpolated read {}",
        v(&c)
    );
}

#[test]
fn data_input_steps_through_its_samples_and_wraps_under_repeat() {
    // V = samples[timeOffset / sampleLength]·scaleFactor (DataInputElm.java:
    // 116-130). sampleLength 1e-3 at dt 1e-4 advances a tenth of a sample per
    // step, so sample 0 holds for ten steps and sample 1 follows; past the
    // end the value clamps to the last sample, or wraps to the first under
    // FLAG_REPEAT.
    let data = |repeat: bool| {
        let model = serde_json::json!({ "samples": [2.0, 4.0] });
        let mut e = elm(
            1,
            "dataInput",
            &[[0, 100]],
            &[
                ("sampleLength", 1e-3),
                ("scaleFactor", 0.5),
                ("fileNum", 0.0),
            ],
        );
        e.model = Some(model.to_string());
        e.flags = if repeat { 256 } else { 0 };
        build(
            vec![
                e,
                elm(
                    2,
                    "resistor",
                    &[[0, 100], [0, 0]],
                    &[("resistance", 1000.0)],
                ),
                elm(3, "ground", &[[0, 0]], &[]),
            ],
            opts(1e-4, false),
        )
    };
    let v = |c: &Circuit| c.element_voltages()[1];

    let mut c = data(false);
    c.run(1);
    assert!(
        close(v(&c), 2.0 * 0.5, 1e-12),
        "first sample read {}",
        v(&c)
    );
    c.run(10);
    assert!(
        close(v(&c), 4.0 * 0.5, 1e-12),
        "second sample read {}",
        v(&c)
    );
    // Past the end the value clamps to the last sample.
    c.run(40);
    assert!(close(v(&c), 4.0 * 0.5, 1e-12), "end clamp read {}", v(&c));

    // Under FLAG_REPEAT the cursor wraps back to the start of the buffer once
    // it runs past the end (every 20 steps at this dt/length), so the last
    // sample before the wrap reads 2.0 and the wrap step itself reads the
    // first sample again.
    let mut c = data(true);
    c.run(20);
    assert!(close(v(&c), 4.0 * 0.5, 1e-12), "pre-wrap read {}", v(&c));
    c.run(1);
    assert!(close(v(&c), 2.0 * 0.5, 1e-12), "repeat wrap read {}", v(&c));
}

#[test]
fn delay_buffer_defers_the_rising_edge_and_rejects_a_short_pulse() {
    // The output follows the input `delay` after the input's last stable
    // state (DelayBufferElm.java:107-116). The input is a 50 Hz pulse shifted
    // half a period, so it sits low for the first 10 ms and then goes high; a
    // 0.75 duty gives a 15 ms high (well past the 10 ms delay, so the flip
    // lands inside it), a 0.2 duty a 4 ms high, the latter shorter than the
    // delay.
    let dt = 1e-5;
    let pulse = |duty: f64| {
        vec![
            elm_flags(
                1,
                "rail",
                &[[0, 100]],
                &[
                    ("waveform", 5.0),
                    ("frequency", 50.0),
                    ("maxVoltage", 5.0),
                    ("bias", 0.0),
                    ("phaseShift", PI),
                    ("dutyCycle", duty),
                ],
                4, // FLAG_PULSE_DUTY: the duty token is authoritative
            ),
            elm(
                2,
                "delayBuffer",
                &[[0, 100], [100, 100]],
                &[("delay", 0.01), ("threshold", 2.5), ("highVoltage", 5.0)],
            ),
            elm(
                3,
                "resistor",
                &[[100, 100], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(4, "ground", &[[100, 0]], &[]),
        ]
    };
    let out = |c: &Circuit| c.element_voltages()[2];

    // Long pulse (0.75 duty, 15 ms high): the edge arrives at t = 10 ms and
    // the output flips high `delay` later (the flip step lands at 20.02 ms:
    // the input's change is seen one step late, which re-arms the pending
    // change at 10.01 ms); before that it is still low.
    let mut c = build(pulse(0.75), opts(dt, false));
    c.run(1000); // t = 10 ms, edge has just arrived
    assert!(
        close(out(&c), 0.0, 1e-12),
        "output rose early at {}",
        out(&c)
    );
    c.run(999); // t = 19.99 ms, well before the flip
    assert!(
        close(out(&c), 0.0, 1e-12),
        "output rose one step early at {}",
        out(&c)
    );
    c.run(3); // t = 20.02 ms = edge + delay
    assert!(
        close(out(&c), 5.0, 1e-9),
        "output did not follow after the delay: {}",
        out(&c)
    );

    // Short pulse (0.2 duty, 4 ms high): the input is back low before the
    // delay elapses, so the output never moves.
    let mut c = build(pulse(0.2), opts(dt, false));
    c.run(3000); // t = 30 ms
    assert!(
        close(out(&c), 0.0, 1e-12),
        "short pulse leaked through: {}",
        out(&c)
    );
}

#[test]
fn audio_output_reads_its_node_voltage_and_draws_no_current() {
    let c = &mut build(
        vec![
            elm(1, "rail", &[[0, 0]], &[("maxVoltage", 5.0)]),
            elm(2, "wire", &[[0, 0], [100, 0]], &[]),
            elm(
                3,
                "audioOutput",
                &[[100, 0]],
                &[
                    ("duration", 1.0),
                    ("samplingRate", 8000.0),
                    ("labelNum", 1.0),
                ],
            ),
            elm(4, "ground", &[[200, 200]], &[]),
        ],
        opts(1e-5, true),
    );
    c.run(5);
    let volts = c.element_voltages();
    let amps = c.element_currents();
    assert!(
        close(volts[2], 5.0, 1e-9),
        "audio output read {} V, expected the rail's 5 V",
        volts[2]
    );
    assert!(
        close(amps[2], 0.0, 1e-12),
        "audio output carried {} A, expected none",
        amps[2]
    );
}

#[test]
fn timer_divider_biases_ctl_and_trigger_sets_out() {
    // The 555's internal divider stamps VCC->CTL 5000 ohm and CTL->ground
    // 10000 ohm, so CTL sits at two thirds of VCC, and pulling TRIG below
    // CTL/2 drives OUT to the rail. RST is held high, THRES tied below CTL,
    // DIS parked on ground.
    let c = &mut build(
        vec![
            elm(1, "rail", &[[64, 0]], &[("maxVoltage", 5.0)]),
            elm(2, "ground", &[[64, 288]], &[]),
            elm_flags(
                3,
                "timer",
                &[
                    [0, 96],    // 0 DIS
                    [0, 192],   // 1 TRIG
                    [0, 240],   // 2 THRES
                    [64, 0],    // 3 VCC
                    [64, 336],  // 4 CTL
                    [128, 192], // 5 OUT
                    [128, 96],  // 6 RST
                    [64, 288],  // 7 GND
                ],
                &[("highVoltage", 5.0)],
                6, // FLAG_RESET | FLAG_GROUND
            ),
            elm(4, "wire", &[[128, 96], [64, 0]], &[]), // RST to VCC
            elm(5, "wire", &[[0, 240], [64, 288]], &[]), // THRES to ground
            elm(6, "ground", &[[0, 192]], &[]),         // TRIG below CTL/2
            elm(7, "wire", &[[0, 96], [64, 288]], &[]), // DIS to ground
        ],
        opts(1e-5, false),
    );
    c.run(5);
    let nodes = c.element_nodes();
    let volts = c.node_voltages();
    // The timer is element index 2; its posts start at flattened index 2 (the
    // rail and ground before it each carry one post).
    let n_ctl = nodes[2 + 4] as usize;
    let n_out = nodes[2 + 5] as usize;
    assert!(
        close(volts[n_ctl], 5.0 * 2.0 / 3.0, 1e-6),
        "CTL was {} V, expected two thirds of VCC",
        volts[n_ctl]
    );
    assert!(
        volts[n_out] > 4.9,
        "OUT was {} V, expected the rail",
        volts[n_out]
    );
}
