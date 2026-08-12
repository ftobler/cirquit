//! Logic gates, the inverter, Schmitt trigger, tri-state buffer, custom logic, LED, analog switch and memristor.

use circuit_core::{ScopeSpec, ScopeValue};

mod common;
use common::*;

/// Output of a two-input gate driven by rails, read across a load resistor.
/// The gate hangs off `[0,0] -> [96,0]`, so its inputs sit at (0,-16) and
/// (0,16) and the output at (96,0), the upstream setPoints layout.
fn gate2_output(kind: &str, v0: f64, v1: f64, params: &[(&str, f64)]) -> f64 {
    let mut c = build(
        vec![
            elm(1, "rail", &[[0, -16]], &[("maxVoltage", v0)]),
            elm(2, "rail", &[[0, 16]], &[("maxVoltage", v1)]),
            elm(3, kind, &[[0, -16], [0, 16], [96, 0]], params),
            elm(
                4,
                "resistor",
                &[[96, 0], [96, 100]],
                &[("resistance", 1000.0)],
            ),
            elm(5, "ground", &[[96, 100]], &[]),
        ],
        opts(1e-5, false),
    );
    c.run(5);
    c.element_voltages()[3]
}

#[test]
fn and_gate_truth_table() {
    // All four input pairs; the output is high exactly when both inputs are.
    assert!(close(gate2_output("andGate", 5.0, 5.0, &[]), 5.0, 1e-9));
    assert!(close(gate2_output("andGate", 5.0, 0.0, &[]), 0.0, 1e-9));
    assert!(close(gate2_output("andGate", 0.0, 5.0, &[]), 0.0, 1e-9));
    assert!(close(gate2_output("andGate", 0.0, 0.0, &[]), 0.0, 1e-9));
}

#[test]
fn nand_gate_truth_table() {
    // The AND output bubble inverts every row.
    assert!(close(gate2_output("nandGate", 5.0, 5.0, &[]), 0.0, 1e-9));
    assert!(close(gate2_output("nandGate", 5.0, 0.0, &[]), 5.0, 1e-9));
    assert!(close(gate2_output("nandGate", 0.0, 5.0, &[]), 5.0, 1e-9));
    assert!(close(gate2_output("nandGate", 0.0, 0.0, &[]), 5.0, 1e-9));
}

#[test]
fn or_gate_truth_table() {
    // High when either input is high.
    assert!(close(gate2_output("orGate", 5.0, 5.0, &[]), 5.0, 1e-9));
    assert!(close(gate2_output("orGate", 5.0, 0.0, &[]), 5.0, 1e-9));
    assert!(close(gate2_output("orGate", 0.0, 5.0, &[]), 5.0, 1e-9));
    assert!(close(gate2_output("orGate", 0.0, 0.0, &[]), 0.0, 1e-9));
}

#[test]
fn nor_gate_truth_table() {
    assert!(close(gate2_output("norGate", 5.0, 5.0, &[]), 0.0, 1e-9));
    assert!(close(gate2_output("norGate", 5.0, 0.0, &[]), 0.0, 1e-9));
    assert!(close(gate2_output("norGate", 0.0, 5.0, &[]), 0.0, 1e-9));
    assert!(close(gate2_output("norGate", 0.0, 0.0, &[]), 5.0, 1e-9));
}

#[test]
fn xor_gate_truth_table() {
    // High on odd parity.
    assert!(close(gate2_output("xorGate", 5.0, 5.0, &[]), 0.0, 1e-9));
    assert!(close(gate2_output("xorGate", 5.0, 0.0, &[]), 5.0, 1e-9));
    assert!(close(gate2_output("xorGate", 0.0, 5.0, &[]), 5.0, 1e-9));
    assert!(close(gate2_output("xorGate", 0.0, 0.0, &[]), 0.0, 1e-9));
}

#[test]
fn xnor_gate_truth_table() {
    assert!(close(gate2_output("xnorGate", 5.0, 5.0, &[]), 5.0, 1e-9));
    assert!(close(gate2_output("xnorGate", 5.0, 0.0, &[]), 0.0, 1e-9));
    assert!(close(gate2_output("xnorGate", 0.0, 5.0, &[]), 0.0, 1e-9));
    assert!(close(gate2_output("xnorGate", 0.0, 0.0, &[]), 5.0, 1e-9));
}

#[test]
fn and_gate_honours_its_high_logic_voltage() {
    // The threshold is highVoltage/2, so a 5 V input is LOW to a 10 V gate
    // (GateElm.getInput, GateElm.java:248-249).
    assert!(close(
        gate2_output("andGate", 5.0, 5.0, &[("highVoltage", 10.0)]),
        0.0,
        1e-9
    ));
    assert!(close(
        gate2_output("andGate", 10.0, 10.0, &[("highVoltage", 10.0)]),
        10.0,
        1e-9
    ));
}

#[test]
fn and_gate_takes_an_editable_input_count() {
    // A three-input gate: i0 = -1, 0, 1, so the posts hang at (0,-16), (0,0)
    // and (0,16) with the output at (96,0).
    let out = |a: f64, b: f64, c: f64| {
        let mut c = build(
            vec![
                elm(1, "rail", &[[0, -16]], &[("maxVoltage", a)]),
                elm(2, "rail", &[[0, 0]], &[("maxVoltage", b)]),
                elm(3, "rail", &[[0, 16]], &[("maxVoltage", c)]),
                elm(
                    4,
                    "andGate",
                    &[[0, -16], [0, 0], [0, 16], [96, 0]],
                    &[("inputCount", 3.0)],
                ),
                elm(
                    5,
                    "resistor",
                    &[[96, 0], [96, 100]],
                    &[("resistance", 1000.0)],
                ),
                elm(6, "ground", &[[96, 100]], &[]),
            ],
            opts(1e-5, false),
        );
        c.run(5);
        c.element_voltages()[4]
    };
    assert!(close(out(5.0, 5.0, 5.0), 5.0, 1e-9));
    assert!(close(out(5.0, 5.0, 0.0), 0.0, 1e-9));
    assert!(close(out(0.0, 5.0, 0.0), 0.0, 1e-9));
}

#[test]
fn two_inverter_chain_reproduces_the_input() {
    // NOT(NOT(x)) = x, proving a signal propagates across two elements whose
    // posts only meet through a wire. Run long enough that a wrongly wired
    // oscillation counter would freeze the output.
    for v in [0.0, 5.0] {
        let c = &mut build(
            vec![
                elm(1, "rail", &[[0, 0]], &[("maxVoltage", v)]),
                elm(2, "inverter", &[[0, 0], [80, 0]], &[]),
                elm(3, "wire", &[[80, 0], [80, -16]], &[]),
                elm(4, "inverter", &[[80, -16], [160, -16]], &[]),
                elm(
                    5,
                    "resistor",
                    &[[160, -16], [160, 84]],
                    &[("resistance", 1000.0)],
                ),
                elm(6, "ground", &[[160, 84]], &[]),
            ],
            opts(1e-5, false),
        );
        c.run(100);
        assert!(
            close(c.element_voltages()[4], v, 1e-9),
            "inverter chain with input {v} settled at {}",
            c.element_voltages()[4]
        );
    }
}

/// Output of a one-input slew-limited element (inverter or Schmitt trigger)
/// driven by a rail, read across a load resistor.
fn slew_output(kind: &str, input_v: f64, params: &[(&str, f64)], dt: f64, steps: u32) -> f64 {
    let mut c = build(
        vec![
            elm(1, "rail", &[[0, 0]], &[("maxVoltage", input_v)]),
            elm(2, kind, &[[0, 0], [96, 0]], params),
            elm(
                3,
                "resistor",
                &[[96, 0], [96, 100]],
                &[("resistance", 1000.0)],
            ),
            elm(4, "ground", &[[96, 100]], &[]),
        ],
        opts(dt, false),
    );
    c.run(steps);
    c.element_voltages()[2]
}

#[test]
fn inverter_outputs_the_inverse_logic_level() {
    assert!(close(slew_output("inverter", 5.0, &[], 1e-5, 5), 0.0, 1e-9));
    assert!(close(slew_output("inverter", 0.0, &[], 1e-5, 5), 5.0, 1e-9));
}

#[test]
fn inverter_is_slew_rate_limited() {
    // slewRate 0.25 V/ns at dt = 1e-8 s allows 2.5 V per step, so a low input
    // (target high) reaches 5 V in exactly two steps (InverterElm.java:124-125).
    let params = &[("slewRate", 0.25)];
    assert!(close(
        slew_output("inverter", 0.0, params, 1e-8, 1),
        2.5,
        1e-6
    ));
    assert!(close(
        slew_output("inverter", 0.0, params, 1e-8, 2),
        5.0,
        1e-6
    ));
}

#[test]
fn schmitt_trigger_buffers_and_is_slew_limited() {
    // The non-inverting Schmitt follows the input at the extremes. The first
    // step still sees the pre-solve input (0), which parks the output low; the
    // rail's 5 V then arrives, so the ramp to the on level at 2.5 V/step takes
    // two more: 0 -> 2.5 -> 5.
    let params = &[("slewRate", 0.25)];
    assert!(close(
        slew_output("schmitt", 5.0, params, 1e-8, 2),
        2.5,
        1e-6
    ));
    assert!(close(
        slew_output("schmitt", 5.0, params, 1e-8, 3),
        5.0,
        1e-6
    ));
}

#[test]
fn inverting_schmitt_trigger_inverts_and_is_slew_limited() {
    // Low input, inverting output high, same 2.5 V/step ramp as the others.
    let params = &[("slewRate", 0.25)];
    assert!(close(
        slew_output("invertingSchmitt", 0.0, params, 1e-8, 1),
        2.5,
        1e-6
    ));
    assert!(close(
        slew_output("invertingSchmitt", 0.0, params, 1e-8, 2),
        5.0,
        1e-6
    ));
}

/// Runs a Schmitt trigger through one triangle input cycle and returns the
/// (input, output) pairs, sampling once per step.
fn schmitt_walk(kind: &str) -> Vec<(f64, f64)> {
    // Triangle source, 0 V bias, 6 V amplitude at 100 Hz: the input sweeps
    // -6..+6..0 over the 750 sampled steps, crossing the default 3.33 upper
    // trigger on the way up and the 1.66 lower one on the way down.
    let mut c = build(
        vec![
            elm(
                1,
                "voltage",
                &[[0, 0], [0, -16]],
                &[
                    ("waveform", 3.0),
                    ("maxVoltage", 6.0),
                    ("bias", 0.0),
                    ("frequency", 100.0),
                ],
            ),
            elm(2, "ground", &[[0, 0]], &[]),
            elm(3, kind, &[[0, -16], [96, -16]], &[]),
            elm(
                4,
                "resistor",
                &[[96, -16], [96, 84]],
                &[("resistance", 1000.0)],
            ),
            elm(5, "ground", &[[96, 84]], &[]),
        ],
        opts(1e-5, false),
    );
    let mut walk = Vec::with_capacity(750);
    for _ in 0..750 {
        c.run(1);
        walk.push((c.element_voltages()[0], c.element_voltages()[3]));
    }
    walk
}

#[test]
fn non_inverting_schmitt_has_hysteresis() {
    // Below the lower trigger the output is off; above the upper trigger it is
    // on; in between it keeps the last value, so the band on the way up reads
    // off and the band on the way down reads on (SchmittElm.java:40-65). A
    // do_step reads the previous step's solved input, so each output is
    // paired with the input one sample earlier.
    let walk = schmitt_walk("schmitt");
    let mut crossed_upper = false;
    let mut crossed_lower = false;
    for i in 1..walk.len() {
        let (prev_in, _) = walk[i - 1];
        let vout = walk[i].1;
        if prev_in > 3.33 && !crossed_upper {
            crossed_upper = true;
        }
        if crossed_upper && prev_in < 1.66 && !crossed_lower {
            crossed_lower = true;
        }
        if prev_in < 1.66 {
            assert!(vout < 0.1, "below lower, out {vout}, in {prev_in}");
        } else if prev_in > 3.33 {
            assert!(vout > 4.9, "above upper, out {vout}, in {prev_in}");
        } else if crossed_upper && !crossed_lower {
            assert!(
                vout > 4.9,
                "hysteresis band on the way down, out {vout}, in {prev_in}"
            );
        } else {
            assert!(
                vout < 0.1,
                "hysteresis band on the way up, out {vout}, in {prev_in}"
            );
        }
    }
    assert!(crossed_upper, "input never crossed the upper trigger");
    assert!(crossed_lower, "input never fell below the lower trigger");
}

#[test]
fn inverting_schmitt_has_hysteresis() {
    // The inverting mirror image: off above the upper trigger, on below the
    // lower one, memory in between (InvertingSchmittElm.java:123-146).
    let walk = schmitt_walk("invertingSchmitt");
    let mut crossed_upper = false;
    let mut crossed_lower = false;
    for i in 1..walk.len() {
        let (prev_in, _) = walk[i - 1];
        let vout = walk[i].1;
        if prev_in > 3.33 && !crossed_upper {
            crossed_upper = true;
        }
        if crossed_upper && prev_in < 1.66 && !crossed_lower {
            crossed_lower = true;
        }
        if prev_in < 1.66 {
            assert!(vout > 4.9, "below lower, out {vout}, in {prev_in}");
        } else if prev_in > 3.33 {
            assert!(vout < 0.1, "above upper, out {vout}, in {prev_in}");
        } else if crossed_upper && !crossed_lower {
            assert!(
                vout < 0.1,
                "hysteresis band on the way down, out {vout}, in {prev_in}"
            );
        } else {
            assert!(
                vout > 4.9,
                "hysteresis band on the way up, out {vout}, in {prev_in}"
            );
        }
    }
    assert!(crossed_upper, "input never crossed the upper trigger");
    assert!(crossed_lower, "input never fell below the lower trigger");
}

/// Output of a tri-state buffer driven by rails, read across a load resistor.
fn tristate_output(input_v: f64, control_v: f64, params: &[(&str, f64)]) -> f64 {
    let mut c = build(
        vec![
            elm(1, "rail", &[[0, 0]], &[("maxVoltage", input_v)]),
            elm(2, "rail", &[[48, -16]], &[("maxVoltage", control_v)]),
            elm(3, "triState", &[[0, 0], [96, 0], [48, -16]], params),
            elm(
                4,
                "resistor",
                &[[96, 0], [96, 100]],
                &[("resistance", 1000.0)],
            ),
            elm(5, "ground", &[[96, 100]], &[]),
        ],
        opts(1e-5, false),
    );
    c.run(5);
    c.element_voltages()[3]
}

#[test]
fn tri_state_buffers_when_enabled() {
    // Control high closes the 0.1 ohm path, so the output follows the input's
    // logic level through a negligible divider drop.
    assert!(
        close(tristate_output(5.0, 5.0, &[]), 5.0, 0.01),
        "enabled high input should read near 5 V"
    );
    assert!(
        close(tristate_output(0.0, 5.0, &[]), 0.0, 1e-6),
        "enabled low input should read 0 V"
    );
}

#[test]
fn tri_state_disables_into_high_impedance() {
    // Control low opens the 1e10 path, so the output floats to the load and
    // reads 0; the optional pulldown (the file's r_off_ground token) makes it
    // sit at 0 even without the load pulling it.
    assert!(
        tristate_output(5.0, 0.0, &[]) < 1e-3,
        "disabled output with no pulldown should float to the load, got {}",
        tristate_output(5.0, 0.0, &[])
    );
    assert!(
        tristate_output(5.0, 0.0, &[("r_off_ground", 1e8)]) < 1e-3,
        "disabled output with a pulldown should sit at 0"
    );
}

/// Output voltage of a 2-in/2-out custom-logic chip's `out`-th output, driven
/// by rails on the inputs. Posts: the inputs at (0,0) and (0,32), the outputs
/// at (96,0) and (96,32), each output pulled to ground through a 1k load whose
/// drop is what `element_voltages` reads back.
fn custom_output(a: f64, b: f64, rules: &[(&str, &str)], out: usize) -> f64 {
    let mut c = build(
        vec![
            elm(1, "rail", &[[0, 0]], &[("maxVoltage", a)]),
            elm(2, "rail", &[[0, 32]], &[("maxVoltage", b)]),
            elm_model(3, &[[0, 0], [0, 32], [96, 0], [96, 32]], 2, 2, false, rules),
            elm(
                4,
                "resistor",
                &[[96, 0], [96, 100]],
                &[("resistance", 1000.0)],
            ),
            elm(5, "ground", &[[96, 100]], &[]),
            elm(
                6,
                "resistor",
                &[[96, 32], [96, 132]],
                &[("resistance", 1000.0)],
            ),
            elm(7, "ground", &[[96, 132]], &[]),
        ],
        opts(1e-5, false),
    );
    c.run(5);
    // The output's own voltage_diff is `V(input0) - V(input1)`, useless here,
    // so read the load resistor's drop, which is the output node to ground.
    c.element_voltages()[if out == 0 { 3 } else { 5 }]
}

#[test]
fn custom_logic_evaluates_its_truth_table() {
    // A 2-in/2-out model where output 0 is the AND and output 1 the OR of the
    // inputs, one rule per input pair (the ledarray smiley's shape). Every
    // left string is exactly the input count, every right string the output
    // count.
    let rules = [("00", "00"), ("01", "01"), ("10", "01"), ("11", "11")];
    for (a, b, and, or) in [
        (0.0, 0.0, 0.0, 0.0),
        (0.0, 5.0, 0.0, 5.0),
        (5.0, 0.0, 0.0, 5.0),
        (5.0, 5.0, 5.0, 5.0),
    ] {
        assert!(
            close(custom_output(a, b, &rules, 0), and, 1e-6),
            "AND of {a} and {b} should read {and}"
        );
        assert!(
            close(custom_output(a, b, &rules, 1), or, 1e-6),
            "OR of {a} and {b} should read {or}"
        );
    }
}

#[test]
fn custom_logic_pattern_and_dont_care_rules_match_like_upstream() {
    // The first rule `aA=10` matches exactly when the two inputs are equal:
    // `a` saves input 0 into the pattern table, `A` compares input 1 against
    // it (the parseRules dedup turns the second occurrence of the letter into
    // the compare form). The `??` fallback matches every other input pair with
    // both positions don't-care, so unequal inputs take the second rule.
    let rules = [("aA", "10"), ("??", "01")];
    for (a, b) in [(0.0, 0.0), (5.0, 5.0)] {
        assert!(
            close(custom_output(a, b, &rules, 0), 5.0, 1e-6),
            "equal inputs {a},{b}: output 0 should be high"
        );
        assert!(
            close(custom_output(a, b, &rules, 1), 0.0, 1e-6),
            "equal inputs {a},{b}: output 1 should be low"
        );
    }
    for (a, b) in [(0.0, 5.0), (5.0, 0.0)] {
        assert!(
            close(custom_output(a, b, &rules, 0), 0.0, 1e-6),
            "unequal inputs {a},{b}: output 0 should be low"
        );
        assert!(
            close(custom_output(a, b, &rules, 1), 5.0, 1e-6),
            "unequal inputs {a},{b}: output 1 should be high"
        );
    }
}

#[test]
fn custom_logic_tri_state_output_goes_high_impedance() {
    // A 1-in/1-out tri-state model: input high drives the output through the
    // 1e-3 ohm path, input low sets `_` and opens the 1e8 path, leaving the
    // output to whatever the circuit pins it to. The output node sits in the
    // middle of a 5 V / ground 1k divider: driven, it pins the midpoint; at
    // high impedance it floats to the 2.5 V divider point, which a driven-low
    // output could never reach. The midpoint is resistor R2's drop.
    let midpoint = |input: f64| {
        let mut c = build(
            vec![
                elm(1, "rail", &[[0, 0]], &[("maxVoltage", input)]),
                elm_model(
                    2,
                    &[[0, 0], [200, 100]],
                    1,
                    1,
                    true,
                    &[("1", "1"), ("0", "_")],
                ),
                elm(
                    3,
                    "resistor",
                    &[[200, 0], [200, 100]],
                    &[("resistance", 1000.0)],
                ),
                elm(4, "rail", &[[200, 0]], &[("maxVoltage", 5.0)]),
                elm(
                    5,
                    "resistor",
                    &[[200, 100], [200, 200]],
                    &[("resistance", 1000.0)],
                ),
                elm(6, "ground", &[[200, 200]], &[]),
            ],
            opts(1e-5, false),
        );
        c.run(5);
        c.element_voltages()[4]
    };
    assert!(
        close(midpoint(5.0), 5.0, 1e-3),
        "driven output pins the divider midpoint high, got {}",
        midpoint(5.0)
    );
    assert!(
        close(midpoint(0.0), 2.5, 1e-3),
        "high-impedance output floats to the 2.5 V divider point, got {}",
        midpoint(0.0)
    );
}

#[test]
fn and_gate_with_schmitt_inputs_has_input_hysteresis() {
    // FLAG_SCHMITT gives each input a hysteresis band: it trips high above
    // 0.55*highVoltage and holds until the input falls below 0.35*highVoltage,
    // with the band holding whichever state the input last settled in
    // (GateElm.getInput, GateElm.java:250-256). Drive a one-input AND through
    // the band by changing a rail's voltage live and check the output only
    // flips at the two trips. Each rail change needs two steps: one for the
    // solve to apply it, one for the gate to evaluate the new input.
    let mut c = build(
        vec![
            elm(1, "rail", &[[0, 0]], &[("maxVoltage", 5.0)]),
            elm_flags(2, "andGate", &[[0, 0], [96, 0]], &[("inputCount", 1.0)], 2),
            elm(
                3,
                "resistor",
                &[[96, 0], [96, 100]],
                &[("resistance", 1000.0)],
            ),
            elm(4, "ground", &[[96, 100]], &[]),
        ],
        opts(1e-5, false),
    );
    // Settle high at 5 V (well above 2.75), then drop into the band at 2 V:
    // the 1.75 V lower trip has not been crossed, so the output holds high.
    c.run(5);
    assert!(
        close(c.element_voltages()[2], 5.0, 1e-9),
        "sanity: high input, out {}",
        c.element_voltages()[2]
    );
    assert!(c.set_param(1, "maxVoltage", 2.0));
    c.run(2);
    assert!(
        close(c.element_voltages()[2], 5.0, 1e-9),
        "band on the way down held {}",
        c.element_voltages()[2]
    );

    // Below 1.75 V the input flips low and the output follows.
    assert!(c.set_param(1, "maxVoltage", 1.0));
    c.run(2);
    assert!(
        close(c.element_voltages()[2], 0.0, 1e-9),
        "below the lower trip, out {}",
        c.element_voltages()[2]
    );

    // Back in the band at 2 V, still below the 2.75 V upper trip: holds low.
    assert!(c.set_param(1, "maxVoltage", 2.0));
    c.run(2);
    assert!(
        close(c.element_voltages()[2], 0.0, 1e-9),
        "band on the way up held {}",
        c.element_voltages()[2]
    );

    // Above 2.75 V the input flips high again.
    assert!(c.set_param(1, "maxVoltage", 3.0));
    c.run(2);
    assert!(
        close(c.element_voltages()[2], 5.0, 1e-9),
        "above the upper trip, out {}",
        c.element_voltages()[2]
    );
}

#[test]
fn and_gate_with_inverted_inputs_behaves_as_nor() {
    // FLAG_INVERT_INPUTS bubbles every input (GateElm.java:28, :246-249), so
    // a two-input AND evaluates NOT(a) AND NOT(b), which is NOR. Drive the
    // four input pairs and check the truth table.
    let out = |a: f64, b: f64| {
        let mut c = build(
            vec![
                elm(1, "rail", &[[0, -16]], &[("maxVoltage", a)]),
                elm(2, "rail", &[[0, 16]], &[("maxVoltage", b)]),
                elm_flags(3, "andGate", &[[0, -16], [0, 16], [96, 0]], &[], 4),
                elm(
                    4,
                    "resistor",
                    &[[96, 0], [96, 100]],
                    &[("resistance", 1000.0)],
                ),
                elm(5, "ground", &[[96, 100]], &[]),
            ],
            opts(1e-5, false),
        );
        c.run(5);
        c.element_voltages()[3]
    };
    assert!(close(out(5.0, 5.0), 0.0, 1e-9));
    assert!(close(out(5.0, 0.0), 0.0, 1e-9));
    assert!(close(out(0.0, 5.0), 0.0, 1e-9));
    assert!(close(out(0.0, 0.0), 5.0, 1e-9));
}

#[test]
fn gate_restores_last_output_from_the_file_token() {
    // The `lastOutputVoltage` token restores the gate's committed output, and
    // setupVolts seeds the inputs to reproduce it, so the first step does not
    // glitch (GateElm.java:56-62, :168-174). A non-inverting AND whose token
    // says high starts high even with its input left floating at the seed; a
    // NAND remembers high too, because its seed fills the inputs with the low
    // level the inverted function turns back into a high output.
    let out = |kind: &str, last_output_v: f64| {
        let mut c = build(
            vec![
                elm_flags(
                    1,
                    kind,
                    &[[0, 0], [96, 0]],
                    &[("inputCount", 1.0), ("lastOutputVoltage", last_output_v)],
                    0,
                ),
                elm(
                    2,
                    "resistor",
                    &[[96, 0], [96, 100]],
                    &[("resistance", 1000.0)],
                ),
                elm(3, "ground", &[[96, 100]], &[]),
            ],
            opts(1e-5, false),
        );
        c.run(1);
        c.element_voltages()[1]
    };
    assert!(close(out("andGate", 5.0), 5.0, 1e-9), "AND remembers high");
    assert!(
        close(out("nandGate", 5.0), 5.0, 1e-9),
        "NAND remembers high"
    );
    assert!(close(out("andGate", 0.0), 0.0, 1e-9), "AND remembers low");
}

#[test]
fn logic_input_high_drives_a_divider() {
    // A logic input at position 1 is a 5 V source to ground; across two equal
    // 1 k resistors the midpoint sits at half its output and the source
    // delivers the divider current.
    let c = &mut build(
        vec![
            elm(
                1,
                "logicInput",
                &[[0, 0]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 1.0)],
            ),
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
    assert!(close(volts[2], 2.5, 1e-9), "midpoint was {}", volts[2]);
    assert!(
        close(amps[1], 2.5e-3, 1e-12),
        "source current was {}",
        amps[1]
    );
    assert!(
        close(amps[2], 2.5e-3, 1e-12),
        "first resistor current was {}",
        amps[2]
    );
}

#[test]
fn logic_output_reads_its_node_voltage() {
    // A 5 V rail drives a logic output with the pull-down flag set: the 1 M
    // pull-down to ground must not drag the node down. The element's readout
    // is the node voltage itself, and a voltage scope on the element samples
    // that same value (getVoltageDiff, LogicOutputElm.java:97).
    let c = &mut build_with(
        vec![
            elm(1, "rail", &[[0, 0]], &[("maxVoltage", 5.0)]),
            elm(2, "ground", &[[100, 0]], &[]),
            elm_flags(3, "logicOutput", &[[0, 0]], &[("threshold", 2.5)], 4),
        ],
        opts(1e-5, true),
        vec![ScopeSpec {
            element_id: 3,
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
        close(c.element_voltages()[2], 5.0, 1e-9),
        "logic output readout was {}",
        c.element_voltages()[2]
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
fn led_drops_about_two_volts_forward() {
    // A 5 V source through 1 k drives a few mA into the LED. The LED's
    // forward drop is 2.1024259 V at 1 A (LEDElm.java:41), so at a few mA it
    // sits just under 2 V and the loop current is roughly (5 - 2.1)/R.
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 5.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(3, "led", &[[100, 0], [100, 100]], &[]),
            elm(4, "wire", &[[100, 100], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
        ],
        opts(1e-5, true),
    );
    c.run(20);

    let vd = c.element_voltages()[2];
    let i = c.element_currents()[1];
    assert!((1.5..2.4).contains(&vd), "forward drop was {vd}");
    assert!(close(i, (5.0 - vd) / 1000.0, 1e-5), "current was {i}");
    assert!(close(i, (5.0 - 2.1) / 1000.0, 0.5e-3), "current was {i}");
}

#[test]
fn analog_switch_passes_signal_above_threshold_only() {
    // A 5 V source drives a 1 k feed through the analog switch to ground; the
    // control post is driven by its own 5 V source. With the control above
    // the 2.5 V threshold the switch stamps r_on, so the loop current is
    // 5/(R + r_on).
    let closed = &mut build(
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
                "analogSwitch",
                &[[100, 0], [100, 100], [84, 50]],
                &[("r_on", 20.0), ("r_off", 1e10), ("threshold", 2.5)],
            ),
            elm(4, "wire", &[[100, 100], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
            elm(6, "voltage", &[[84, 34], [84, 50]], &[("maxVoltage", 5.0)]),
            elm(7, "ground", &[[84, 34]], &[]),
        ],
        opts(1e-5, true),
    );
    closed.run(5);
    let expected = 5.0 / (1000.0 + 20.0);
    assert!(
        close(closed.element_currents()[1], expected, 1e-12),
        "closed switch drew {}, expected {expected}",
        closed.element_currents()[1]
    );

    let open = &mut build(
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
                "analogSwitch",
                &[[100, 0], [100, 100], [84, 50]],
                &[("r_on", 20.0), ("r_off", 1e10), ("threshold", 2.5)],
            ),
            elm(4, "wire", &[[100, 100], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
            elm(6, "voltage", &[[84, 34], [84, 50]], &[("maxVoltage", 0.0)]),
            elm(7, "ground", &[[84, 34]], &[]),
        ],
        opts(1e-5, true),
    );
    open.run(5);
    assert!(
        close(open.element_currents()[1], 0.0, 1e-8),
        "open switch should pass no current, got {}",
        open.element_currents()[1]
    );
}

#[test]
fn analog_switch2_routes_current_to_the_selected_throw_only() {
    // A 5 V source through a 1k resistor into the SPDT analog switch's common
    // post. The control rail sits at 5 V, above the 2.5 V threshold, so throw
    // 1 carries r_on and is grounded, carrying I = 5/(R+r_on). Throw 2
    // carries r_off and reads zero.
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
                "analogSwitch2",
                &[[100, 0], [300, -16], [300, 16], [200, -16]],
                &[("r_on", 20.0), ("r_off", 1e10), ("threshold", 2.5)],
            ),
            elm(4, "ground", &[[300, -16]], &[]),
            elm(
                5,
                "resistor",
                &[[300, 16], [300, 116]],
                &[("resistance", 1000.0)],
            ),
            elm(6, "ground", &[[300, 116]], &[]),
            elm(7, "rail", &[[200, -16]], &[("maxVoltage", 5.0)]),
            elm(8, "ground", &[[0, 100]], &[]),
        ],
        opts(1e-5, true),
    );
    let report = c.run(5);
    assert!(report.converged, "did not converge: {:?}", report.error);
    let expected = 5.0 / (1000.0 + 20.0);
    let amps = c.element_currents();
    assert!(
        close(amps[1], expected, 1e-9),
        "divider current was {}, expected {}",
        amps[1],
        expected
    );
    assert!(
        close(amps[2], expected, 1e-9),
        "switch current was {}, expected {}",
        amps[2],
        expected
    );
    assert!(
        close(c.element_voltages()[2], 5.0 * 20.0 / (1000.0 + 20.0), 1e-9),
        "common voltage was {}, expected the r_on divider drop",
        c.element_voltages()[2]
    );
    assert!(
        close(amps[4], 0.0, 1e-9),
        "unselected throw's resistor carried {}, expected none",
        amps[4]
    );
}

#[test]
fn analog_switch2_pulldown_grounds_the_unselected_throw() {
    // The same divider as the routing test above, with FLAG_PULLDOWN (2) set:
    // the unselected throw is no longer stamped with `r_off` to the common, it
    // is tied to ground through `r_off` for the whole run instead, so its node
    // reads zero while the common carries the divider drop
    // (AnalogSwitch2Elm.java:100-117).
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 5.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm_flags(
                3,
                "analogSwitch2",
                &[[100, 0], [300, -16], [300, 16], [200, -16]],
                &[("r_on", 20.0), ("r_off", 1e10), ("threshold", 2.5)],
                2,
            ),
            elm(4, "ground", &[[300, -16]], &[]),
            elm(
                5,
                "resistor",
                &[[300, 16], [300, 116]],
                &[("resistance", 1000.0)],
            ),
            elm(6, "ground", &[[300, 116]], &[]),
            elm(7, "rail", &[[200, -16]], &[("maxVoltage", 5.0)]),
            elm(8, "ground", &[[0, 100]], &[]),
        ],
        opts(1e-5, true),
    );
    let report = c.run(5);
    assert!(report.converged, "did not converge: {:?}", report.error);
    let expected = 5.0 / (1000.0 + 20.0);
    let amps = c.element_currents();
    assert!(
        close(amps[1], expected, 1e-9),
        "divider current was {}, expected {}",
        amps[1],
        expected
    );
    assert!(
        close(amps[2], expected, 1e-9),
        "switch current was {}, expected {}",
        amps[2],
        expected
    );
    assert!(
        close(c.element_voltages()[2], 5.0 * 20.0 / (1000.0 + 20.0), 1e-9),
        "common voltage was {}, expected the r_on divider drop",
        c.element_voltages()[2]
    );
    // The switch's posts start at flattened index 4 (2 for the source, 2 for
    // the divider); throw 2 is its third post. The pulldown leaves it at
    // ground exactly, unlike the `r_off`-to-common stamp the routing test
    // relies on, which would leave it at the divider's drop.
    let nodes = c.element_nodes();
    let throw2 = nodes[6] as usize;
    assert!(
        close(c.node_voltages()[throw2], 0.0, 1e-9),
        "unselected throw sat at {}, expected the pulldown's ground",
        c.node_voltages()[throw2]
    );
    assert!(
        close(amps[4], 0.0, 1e-9),
        "unselected throw's load carried {}, expected none",
        amps[4]
    );
}

#[test]
fn memristor_biased_with_constant_current_integrates_linearly() {
    // A current source in series with a memristor to ground forces a constant
    // 1 mA through it, so dopeWidth integrates linearly and the resistance
    // sweeps from r_off toward r_on. The discrete update (MemristorElm.java:
    // 119-127) advances dopeWidth from the *previous* step's converged current,
    // and a fresh element starts with current 0, so step 1 stamps the initial
    // r_off and advances nothing; from step 2 on each step moves dopeWidth by
    // delta = dt*mobility*r_on*I/totalWidth. The resistance a step stamps uses
    // the wd captured *before* that step's advance (the same capture-before-
    // advance order as the lamp), so step N stamps the blend at
    // wd = (N-2)*delta/totalWidth. With these numbers delta = totalWidth/10,
    // so after 10 steps the last stamped resistance is at wd = 0.8,
    // R = 3280 ohm, V = 3.28 V.
    let dt = 1e-6;
    let i = 1e-3;
    let r_on = 100.0;
    let r_off = 16000.0;
    let total_width = 1e-8;
    let mobility = 1e-10;
    let steps = 10u32;

    let delta = dt * mobility * r_on * i / total_width; // 1e-9 m per step
    let wd = (steps - 2) as f64 * delta / total_width; // 0.8
    let resistance = r_on * wd + r_off * (1.0 - wd); // 3280 ohm

    let c = &mut build(
        vec![
            elm(1, "current", &[[0, 0], [100, 0]], &[("current", i)]),
            elm(
                2,
                "memristor",
                &[[100, 0], [200, 0]],
                &[
                    ("r_on", r_on),
                    ("r_off", r_off),
                    ("totalWidth", total_width),
                    ("mobility", mobility),
                ],
            ),
            elm(3, "ground", &[[0, 0]], &[]),
            elm(4, "ground", &[[200, 0]], &[]),
        ],
        opts(dt, false),
    );
    c.run(steps);

    let volts = c.element_voltages();
    let amps = c.element_currents();
    assert!(
        close(volts[1], i * resistance, 1e-9),
        "memristor voltage {}, expected {} (R = {})",
        volts[1],
        i * resistance,
        resistance
    );
    assert!(
        close(amps[1], i, 1e-12),
        "memristor current {}, expected the source's {} A",
        amps[1],
        i
    );
}

// ─── Digital chip family ───
