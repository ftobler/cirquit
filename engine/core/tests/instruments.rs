//! The ohmmeter, test point, wattmeter, data recorder and stop trigger.

use circuit_core::Circuit;

mod common;
use common::*;

#[test]
fn output_element_reads_its_node_voltage_without_loading_it() {
    // The output is upstream's passive readout (OutputElm): one post, no
    // stamps, infinite impedance (OutputElm.java:55, :86). On a 10 V divider
    // midpoint it must read exactly the node voltage and carry no current,
    // and adding one must not move the divider by so much as a volt.
    let divider = |with_output: bool| {
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
        if with_output {
            elements.push(elm(6, "output", &[[100, 0]], &[]));
        }
        elements
    };
    let plain = &mut build(divider(false), opts(1e-5, true));
    plain.run(5);
    let with = &mut build(divider(true), opts(1e-5, true));
    with.run(5);

    assert!(
        close(plain.element_voltages()[2], 5.0, 1e-9),
        "plain midpoint was {}",
        plain.element_voltages()[2]
    );
    assert!(
        close(with.element_voltages()[2], 5.0, 1e-9),
        "the output loaded the midpoint to {}",
        with.element_voltages()[2]
    );
    // The readback is the node voltage it hangs on (a one-post element plots
    // its single node), and an ideal meter reports zero current.
    assert!(
        close(with.element_voltages()[5], 5.0, 1e-9),
        "output read {}",
        with.element_voltages()[5]
    );
    assert_eq!(with.element_currents()[5], 0.0);
}

#[test]
fn ohmmeter_reads_the_resistance_across_its_terminals() {
    // An ohmmeter is a 0.01 A ideal current source (OhmMeterElm extends
    // CurrentElm); connected across an unknown resistor it drives 0.01 A
    // through it and the terminal voltage gives the resistance. The engine's
    // current_source stamp pushes current INTO post 1 from post 0, so the
    // return current through the resistor develops V(post1) - V(post0) =
    // +0.01 * R and value() reads +R: the sign is pinned here.
    let c = &mut build(
        vec![
            elm(
                1,
                "ohmmeter",
                &[[0, 0], [100, 0]],
                &[("current", 0.01), ("maxVoltage", 0.0)],
            ),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 4700.0)],
            ),
            elm(3, "ground", &[[100, 0]], &[]),
        ],
        opts(1e-5, true),
    );
    c.run(5);
    // The drive current puts the ohmmeter's post 0 at -0.01 * R = -47 V and
    // post 1 at ground, so the reading is (V1 - V0)/0.01 = +4700.
    assert!(
        close(c.element_values()[0], 4700.0, 1e-6),
        "ohmmeter read {}",
        c.element_values()[0]
    );
}

#[test]
fn ohmmeter_in_series_with_a_source_reads_the_source_apparent_resistance() {
    // The plan's series topology: source -> resistor -> ohmmeter, back to the
    // source. The current source forces the loop current to 0.01 A regardless
    // of the source, so KVL parks the ohmmeter's terminal voltage at
    // V_source - 0.01*R and value() = (V1 - V0)/current = V_source/0.01. With
    // a 5 V source that is 500, not R: the ohmmeter sees the source's own
    // apparent resistance. This pins the sign and the behaviour so a future
    // reader does not "fix" the reading toward R.
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 5.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(
                3,
                "ohmmeter",
                &[[100, 0], [100, 100]],
                &[("current", 0.01), ("maxVoltage", 0.0)],
            ),
            elm(4, "wire", &[[100, 100], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
        ],
        opts(1e-5, true),
    );
    c.run(5);
    // KVL: V(post1) - V(post0) of the ohmmeter is the source EMF, 5 V, so the
    // reading is 5/0.01 = 500 (the source's apparent resistance, not R).
    assert!(
        close(c.element_values()[2], 500.0, 1e-6),
        "series ohmmeter read {}",
        c.element_values()[2]
    );
}

/// A 1 kHz 10 V sine feeding a resistor, with a one-post instrument hung on
/// the source's positive node (0,0), the node that carries the waveform.
fn instrument_on_sine(instrument: &str, params: &[(&str, f64)]) -> Circuit {
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
            elm(3, instrument, &[[0, 0]], params),
            elm(4, "ground", &[[0, 100]], &[]),
            elm(5, "ground", &[[100, 0]], &[]),
        ],
        opts(1e-6, false),
    )
}

#[test]
fn test_point_measures_rms_max_min_p2p_avg_on_a_sine() {
    // Seven test points, one per selectable meter mode (TestPointElm.java:448-
    // 450): VOL, RMS, AVG, MAX, MIN, P2P, BIN. After two full periods at
    // dt = 1e-6 the last direction change captured a complete half-cycle, so
    // RMS reads 10/sqrt(2) and the peaks read +/-10. The AVG finalises over
    // the half-cycle that just completed: the last one before t = 2 ms is the
    // falling half from the +10 peak to the -10 trough, whose mean is 0.
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
            elm(3, "testPoint", &[[0, 0]], &[("meter", 0.0)]),
            elm(4, "testPoint", &[[0, 0]], &[("meter", 1.0)]),
            elm(5, "testPoint", &[[0, 0]], &[("meter", 10.0)]),
            elm(6, "testPoint", &[[0, 0]], &[("meter", 2.0)]),
            elm(7, "testPoint", &[[0, 0]], &[("meter", 3.0)]),
            elm(8, "testPoint", &[[0, 0]], &[("meter", 4.0)]),
            elm(9, "testPoint", &[[0, 0]], &[("meter", 5.0)]),
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
fn test_point_binary_level_flips_at_two_and_a_half_volts() {
    // The binary threshold is a fixed 2.5 V (TestPointElm.java:233-237). A
    // quarter period into the sine the node sits at +10 V, so BIN reads 1;
    // at three quarters it sits at -10 V, so BIN reads 0.
    let c = &mut instrument_on_sine("testPoint", &[("meter", 5.0)]);
    c.run(250); // t = 250 us = a quarter period, v = 10 V
    assert!(
        close(c.element_values()[2], 1.0, 1e-12),
        "BIN at the peak read {}",
        c.element_values()[2]
    );
    c.run(500); // now t = 750 us = three quarters, v = -10 V
    assert!(
        close(c.element_values()[2], 0.0, 1e-12),
        "BIN at the trough read {}",
        c.element_values()[2]
    );
}

/// A wattmeter with both channels in the load path: the main axis (posts 2,3)
/// carries the load current, and the current channel (posts 0,1) returns it on
/// the ground side, so V(post2) - V(post0) is the full load voltage.
/// source + at post 2, load resistor from post 3 to post 0, post 1 on ground.
fn wattmeter_circuit(waveform: f64, r: f64, meter: f64) -> Circuit {
    build(
        vec![
            elm(
                1,
                "voltage",
                &[[0, 100], [0, 0]],
                &[
                    ("waveform", waveform),
                    ("frequency", 1000.0),
                    ("maxVoltage", 10.0),
                ],
            ),
            elm(2, "resistor", &[[100, 0], [200, 0]], &[("resistance", r)]),
            elm(
                3,
                "wattmeter",
                &[
                    [200, 0], // post 0, load bottom (voltage reference)
                    [300, 0], // post 1, current-channel return, grounded
                    [0, 0],   // post 2, source + (main axis entry)
                    [100, 0], // post 3, load top (main axis exit)
                ],
                &[("width", 32.0), ("meter", meter)],
            ),
            elm(4, "ground", &[[0, 100]], &[]),
            elm(5, "ground", &[[300, 0]], &[]),
        ],
        opts(1e-5, false),
    )
}

#[test]
fn wattmeter_reads_instantaneous_and_average_dc_power() {
    // 10 V across 100 ohm: I = 0.1 A, power = 1 W. The constant power never
    // crosses its own running mean, so no cycle is measured and the average
    // tracker reports the running mean (WattmeterElm.java:199-200), which for
    // a constant load is the same 1 W. Both meter modes agree.
    let c = &mut wattmeter_circuit(0.0, 100.0, 0.0);
    c.run(200);
    assert!(
        close(c.element_values()[2], 1.0, 1e-9),
        "instantaneous power was {}",
        c.element_values()[2]
    );
    assert!(c.set_param(3, "meter", 1.0));
    c.run(5);
    assert!(
        close(c.element_values()[2], 1.0, 1e-6),
        "average power was {}",
        c.element_values()[2]
    );
}

#[test]
fn wattmeter_averages_ac_power_over_whole_cycles() {
    // A 10 V sine across 100 ohm: p(t) = v^2/R = sin^2(w t) W, whose average
    // over any whole cycle is 0.5 W. The tracker delimitates cycles with
    // rising crossings of the running mean (WattmeterElm.java:174-186); the
    // first crossing marks the partial cycle, the second reads the full one.
    let c = &mut wattmeter_circuit(1.0, 100.0, 1.0);
    c.run(3000); // three full periods at dt = 1e-5
    assert!(
        close(c.element_values()[2], 0.5, 0.02),
        "average AC power was {}",
        c.element_values()[2]
    );
}

#[test]
fn data_recorder_captures_and_wraps_the_sampled_waveform() {
    // A 5 V DC source drives the node for ten steps (filling the 10-sample
    // ring), then a live edit drops it to 1 V for five more, wrapping the
    // ring. The oldest-first export must be the five 5 V samples that survive
    // at the tail, then the five 1 V samples at the head
    // (DataRecorderElm.java:108-114).
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 5.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(3, "dataRecorder", &[[0, 0]], &[("dataCount", 10.0)]),
            elm(4, "ground", &[[0, 100]], &[]),
            elm(5, "ground", &[[100, 0]], &[]),
        ],
        opts(1e-5, false),
    );
    c.run(10);
    assert_eq!(c.data_recorder_data(3).len(), 10);
    assert!(c
        .data_recorder_data(3)
        .iter()
        .all(|&s| close(s, 5.0, 1e-12)));

    assert!(c.set_param(1, "maxVoltage", 1.0));
    c.run(5);
    let samples = c.data_recorder_data(3);
    assert_eq!(
        samples.len(),
        10,
        "the ring holds dataCount samples when full"
    );
    let fives = samples.iter().filter(|&&s| close(s, 5.0, 1e-12)).count();
    let ones = samples.iter().filter(|&&s| close(s, 1.0, 1e-12)).count();
    assert_eq!(fives, 5, "oldest 5 V samples survive the wrap: {samples:?}");
    assert_eq!(ones, 5, "newest 1 V samples land at the head: {samples:?}");
    // The export is strictly oldest-first, so every 5 V sample precedes every
    // 1 V sample.
    assert_eq!(
        samples,
        [5.0; 5].into_iter().chain([1.0; 5]).collect::<Vec<_>>()
    );

    // An unknown id and a non-recorder element report nothing.
    assert!(c.data_recorder_data(99).is_empty());
    assert!(c.data_recorder_data(2).is_empty());
}

#[test]
fn data_recorder_live_size_change_reallocates_and_clears() {
    // setDataCount reallocates the ring and drops the samples
    // (DataRecorderElm.java:78-83); the live set_param path returns true so
    // the edit does not force a full rebuild.
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 5.0)]),
            elm(3, "dataRecorder", &[[0, 0]], &[("dataCount", 10.0)]),
            elm(4, "ground", &[[0, 100]], &[]),
        ],
        opts(1e-5, false),
    );
    c.run(4);
    assert_eq!(c.data_recorder_data(3).len(), 4);
    assert!(c.set_param(3, "dataCount", 3.0));
    c.run(2);
    let samples = c.data_recorder_data(3);
    assert_eq!(
        samples.len(),
        2,
        "the ring shrank and the old samples were cleared"
    );
    assert!(samples.iter().all(|&s| close(s, 5.0, 1e-12)));
}

#[test]
fn data_recorder_samples_every_committed_step_at_nominal_dt() {
    // Control for the bucket gating: with dt == nominal every commit closes
    // its own sampling bucket (SimulationManager.java:1413-1419), so even
    // with adaptation switched on the recorder gains exactly one row per
    // committed step, today's ungated cadence.
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 5.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(3, "dataRecorder", &[[0, 0]], &[("dataCount", 64.0)]),
            elm(4, "ground", &[[0, 100]], &[]),
            elm(5, "ground", &[[100, 0]], &[]),
        ],
        adaptive_opts(1e-5, 50e-12, 100),
    );
    let r = c.run(25);
    assert!(r.converged, "the control run must converge: {:?}", r.error);
    assert_eq!(r.rejected_steps, 0, "a linear circuit must never reject");
    let samples = c.data_recorder_data(3);
    assert_eq!(samples.len(), 25, "one row per committed step");
    assert!(samples.iter().all(|&s| close(s, 5.0, 1e-12)));
}

#[test]
fn data_recorder_gains_one_row_per_nominal_step_while_adapting() {
    // Upstream gates the recorder on its nominal-step bucket counter
    // (DataRecorderElm.java:68-71): while adaptation halves the working step,
    // several committed steps share one bucket and only the last writes. The
    // compliance island forces real halvings (see common::compliance_circuit),
    // so 60 committed steps cover well under 300 us of simulated time and the
    // row count must track elapsed time, not the commit count.
    const NOMINAL: f64 = 5e-6;
    let mut els = compliance_circuit(0.0);
    els.push(elm(6, "dataRecorder", &[[0, 0]], &[("dataCount", 1024.0)]));
    let c = &mut build(els, adaptive_opts(NOMINAL, 50e-12, 4));
    let mut rejected = 0u32;
    for _ in 0..60 {
        let r = c.run(1);
        assert!(r.converged, "halving must rescue every step: {:?}", r.error);
        rejected += r.rejected_steps;
    }
    assert!(
        rejected >= 2,
        "adaptation never engaged, so this test proves nothing"
    );
    let rows = c.data_recorder_data(6).len() as i64;
    let expected = (c.time() / NOMINAL) as i64;
    assert!(
        (rows - expected).abs() <= 1,
        "{rows} rows after {} s: expected about {expected}, one per nominal step",
        c.time()
    );
    assert!(
        rows < 60,
        "with halved steps in the mix the recorder must fall behind the commit count"
    );
}

#[test]
fn stop_trigger_fires_after_the_delay_and_latches_stopped() {
    // A DC source steps from 0 V to 2 V, crossing the 1 V trigger (type 0,
    // >=). The edge arms the trigger at the crossing step's end-of-step time;
    // the latch flips stopped after the 0.1 ms delay and stays set until
    // reset() (StopTriggerElm.java:91-110).
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 0.0)]),
            elm(
                2,
                "stopTrigger",
                &[[0, 0]],
                &[
                    ("triggerVoltage", 1.0),
                    ("type", 0.0),
                    ("delay", 1e-4),
                    ("count", 1.0),
                ],
            ),
            elm(3, "ground", &[[0, 100]], &[]),
        ],
        opts(1e-5, false),
    );
    c.run(5);
    assert_eq!(c.element_states()[1], 0.0, "trigger fired below threshold");

    assert!(c.set_param(1, "maxVoltage", 2.0));
    // The crossing step commits at t = 6e-5, so stopped lands at
    // t >= 6e-5 + 1e-4 = 1.6e-4, the eleventh step after the edit. Nine more
    // steps keep the latch clear; two more flip it.
    c.run(9);
    assert_eq!(
        c.element_states()[1],
        0.0,
        "trigger fired before the delay elapsed"
    );
    c.run(2);
    assert_eq!(
        c.element_states()[1],
        1.0,
        "trigger did not fire after the delay"
    );
    // The latch persists until reset (the engine cannot pause itself).
    c.run(3);
    assert_eq!(c.element_states()[1], 1.0, "stopped latch did not persist");
    c.reset();
    assert_eq!(c.element_states()[1], 0.0, "reset did not clear the latch");
}

#[test]
fn stop_trigger_with_count_two_requires_two_edges() {
    // A count-2 trigger arms only on the second rising edge: triggerCount
    // reaches the required count on that edge, and only then does the delay
    // clock start (StopTriggerElm.java:94-100). One edge alone must not fire
    // even after the delay would have elapsed.
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 0.0)]),
            elm(
                2,
                "stopTrigger",
                &[[0, 0]],
                &[
                    ("triggerVoltage", 1.0),
                    ("type", 0.0),
                    ("delay", 1e-4),
                    ("count", 2.0),
                ],
            ),
            elm(3, "ground", &[[0, 100]], &[]),
        ],
        opts(1e-5, false),
    );
    // First edge: 0 V -> 2 V.
    assert!(c.set_param(1, "maxVoltage", 2.0));
    c.run(20);
    assert_eq!(
        c.element_states()[1],
        0.0,
        "one edge must not fire a count-2 trigger"
    );
    // Second edge: drop back below the threshold and rise again.
    assert!(c.set_param(1, "maxVoltage", 0.0));
    c.run(2);
    assert!(c.set_param(1, "maxVoltage", 2.0));
    c.run(20);
    assert_eq!(
        c.element_states()[1],
        1.0,
        "the second edge did not fire the trigger"
    );
}

#[test]
fn stop_trigger_clear_stops_re_arms_without_rewinding_time() {
    // A fired stop latches display_state at 1. clear_stops is the dedicated
    // re-arm the frontend calls on the pause -> run edge: the latch clears
    // without rewinding time, so the same circuit keeps stepping and reports 0
    // until the threshold is crossed again.
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 0.0)]),
            elm(
                2,
                "stopTrigger",
                &[[0, 0]],
                &[
                    ("triggerVoltage", 1.0),
                    ("type", 0.0),
                    ("delay", 1e-4),
                    ("count", 1.0),
                ],
            ),
            elm(3, "ground", &[[0, 100]], &[]),
        ],
        opts(1e-5, false),
    );
    c.run(2);
    assert_eq!(c.element_states()[1], 0.0, "trigger fired below threshold");

    // First edge: the source steps to 2 V and the trigger fires after the
    // delay, latching stopped.
    assert!(c.set_param(1, "maxVoltage", 2.0));
    c.run(20);
    assert_eq!(c.element_states()[1], 1.0, "trigger did not latch stopped");

    // Drop below the threshold so the re-armed trigger stays quiet, then clear
    // the latch. Stepping again must report 0: clear_stops is a re-arm, not a
    // rewind.
    assert!(c.set_param(1, "maxVoltage", 0.0));
    c.run(2);
    c.clear_stops();
    assert_eq!(
        c.element_states()[1],
        0.0,
        "clear_stops did not clear the latch"
    );
    c.run(2);
    assert_eq!(
        c.element_states()[1],
        0.0,
        "stepping after clear_stops re-fired below threshold"
    );

    // A second edge arms the trigger from the waiting state and fires again.
    assert!(c.set_param(1, "maxVoltage", 2.0));
    c.run(20);
    assert_eq!(
        c.element_states()[1],
        1.0,
        "the trigger did not re-fire after clear_stops"
    );
}
