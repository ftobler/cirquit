//! Flip-flops, counters, the latch, and the PISO/SIPO shift registers and sequence generator.

use circuit_core::Circuit;

mod common;
use common::*;

#[test]
fn d_flip_flop_captures_d_on_the_rising_edge() {
    // D held high, clocked by a logic input. A fresh flip-flop starts Q low
    // and Qbar high; the first rising edge copies D into Q and Qbar follows.
    let c = &mut build(
        vec![
            elm(1, "rail", &[[0, 0]], &[("maxVoltage", 5.0)]),
            elm(
                2,
                "logicInput",
                &[[0, 32]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm(
                3,
                "dFlipFlop",
                &[[0, 0], [96, 0], [96, 64], [0, 32]],
                &[("highVoltage", 5.0)],
            ),
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
                &[[96, 64], [96, 164]],
                &[("resistance", 1000.0)],
            ),
            elm(7, "ground", &[[96, 164]], &[]),
        ],
        opts(1e-5, false),
    );
    c.run(3);
    assert!(
        close(c.element_voltages()[3], 0.0, 1e-9),
        "fresh Q was not low"
    );
    assert!(
        close(c.element_voltages()[5], 5.0, 1e-9),
        "fresh Qbar was not high"
    );
    clock_cycle(c, 2);
    assert!(
        close(c.element_voltages()[3], 5.0, 1e-9),
        "Q did not capture D"
    );
    assert!(
        close(c.element_voltages()[5], 0.0, 1e-9),
        "Qbar did not complement Q"
    );
    clock_cycle(c, 2);
    assert!(
        close(c.element_voltages()[3], 5.0, 1e-9),
        "Q dropped on a later edge"
    );
}

#[test]
fn t_flip_flop_toggles_on_each_rising_edge() {
    // T held high: every rising clock edge flips Q, and Qbar follows.
    let c = &mut build(
        vec![
            elm(1, "rail", &[[0, 0]], &[("maxVoltage", 5.0)]),
            elm(
                2,
                "logicInput",
                &[[0, 32]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm(
                3,
                "tFlipFlop",
                &[[0, 0], [96, 0], [96, 64], [0, 32]],
                &[("highVoltage", 5.0)],
            ),
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
                &[[96, 64], [96, 164]],
                &[("resistance", 1000.0)],
            ),
            elm(7, "ground", &[[96, 164]], &[]),
        ],
        opts(1e-5, false),
    );
    c.run(3);
    assert!(
        close(c.element_voltages()[3], 0.0, 1e-9),
        "fresh Q was not low"
    );
    clock_cycle(c, 2);
    assert!(
        close(c.element_voltages()[3], 5.0, 1e-9),
        "first edge did not set Q"
    );
    clock_cycle(c, 2);
    assert!(
        close(c.element_voltages()[3], 0.0, 1e-9),
        "second edge did not clear Q"
    );
    clock_cycle(c, 2);
    assert!(
        close(c.element_voltages()[3], 5.0, 1e-9),
        "third edge did not set Q"
    );
}

#[test]
fn jk_flip_flop_toggles_on_every_negative_edge() {
    // J = K = 1 turn the JK into a toggle flip-flop. The default triggers on
    // the falling clock edge. A 1 kHz square clock at dt = 1e-5 s has a 100
    // step period, high for 0..48 and low from step 49; the level the chip
    // sees lags one step behind the source, so the first falling edge fires
    // at step 50 and every 100 steps after that.
    let c = &mut build(
        vec![
            elm(1, "rail", &[[0, 0]], &[("maxVoltage", 5.0)]),
            elm(
                2,
                "voltage",
                &[[0, 100], [0, 32]],
                &[
                    ("waveform", 2.0),
                    ("frequency", 1000.0),
                    ("maxVoltage", 2.5),
                    ("bias", 2.5),
                    ("phaseShift", 0.0),
                    ("dutyCycle", 0.5),
                ],
            ),
            elm(3, "ground", &[[0, 100]], &[]),
            elm(4, "rail", &[[0, 64]], &[("maxVoltage", 5.0)]),
            elm(
                5,
                "jkFlipFlop",
                &[[0, 0], [0, 32], [0, 64], [96, 0], [96, 64]],
                &[("highVoltage", 5.0)],
            ),
            elm(
                6,
                "resistor",
                &[[96, 0], [96, 100]],
                &[("resistance", 1000.0)],
            ),
            elm(7, "ground", &[[96, 100]], &[]),
            elm(
                8,
                "resistor",
                &[[96, 64], [96, 164]],
                &[("resistance", 1000.0)],
            ),
            elm(9, "ground", &[[96, 164]], &[]),
        ],
        opts(1e-5, false),
    );
    c.run(3);
    assert!(
        close(c.element_voltages()[5], 0.0, 1e-9),
        "fresh Q was not low"
    );
    assert!(
        close(c.element_voltages()[7], 5.0, 1e-9),
        "fresh Qbar was not high"
    );
    c.run(50); // steps 4..53: the first falling edge at step 50
    assert!(
        close(c.element_voltages()[5], 5.0, 1e-9),
        "first edge did not set Q"
    );
    c.run(100); // the second falling edge at step 150
    assert!(
        close(c.element_voltages()[5], 0.0, 1e-9),
        "second edge did not clear Q"
    );
    c.run(100); // the third falling edge at step 250
    assert!(
        close(c.element_voltages()[5], 5.0, 1e-9),
        "third edge did not set Q"
    );
}

#[test]
fn counter_advances_on_each_clock_edge() {
    // 3-bit counter with no up/down pin, reset active high and held low.
    // Every rising edge adds one, wrapping at 2^3.
    let c = &mut build(
        vec![
            elm(
                1,
                "logicInput",
                &[[0, 0]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm(
                2,
                "logicInput",
                &[[0, 64]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm_flags(
                3,
                "counter",
                &[[0, 0], [0, 64], [96, 0], [96, 32], [96, 64]],
                &[("bits", 3.0), ("invertreset", 0.0), ("modulus", 0.0)],
                0,
            ),
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
            elm(
                8,
                "resistor",
                &[[96, 64], [96, 164]],
                &[("resistance", 1000.0)],
            ),
            elm(9, "ground", &[[96, 164]], &[]),
        ],
        opts(1e-5, false),
    );
    // The output pins run MSB first, so element 3 (Q2) is the 4s column, 5
    // (Q1) the 2s and 7 (Q0) the 1s.
    let count = |c: &Circuit| -> i64 {
        let v = c.element_voltages();
        let bit = |i: usize| if v[i] > 2.5 { 1i64 } else { 0 };
        bit(3) * 4 + bit(5) * 2 + bit(7)
    };
    c.run(3);
    assert_eq!(count(c), 0, "fresh counter did not start at zero");
    for expected in [1, 2, 3, 4, 5, 6, 7, 0] {
        clock_cycle(c, 1);
        assert_eq!(count(c), expected, "count after the next edge");
    }
}

#[test]
fn ring_counter_advances_the_high_bit_each_edge() {
    // 3-bit ring counter, reset active high (FLAG_RESET_HIGH = 4) and held
    // low. A fresh ring starts with Q0 high (the reset that runs when no
    // output is high), and each rising edge moves the single high bit around.
    let c = &mut build(
        vec![
            elm(
                1,
                "logicInput",
                &[[0, 32]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm(
                2,
                "logicInput",
                &[[96, 64]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm_flags(
                3,
                "ringCounter",
                &[[0, 32], [96, 64], [32, -32], [64, -32], [96, -32]],
                &[("bits", 3.0), ("highVoltage", 5.0)],
                4,
            ),
            elm(
                4,
                "resistor",
                &[[32, -32], [32, 68]],
                &[("resistance", 1000.0)],
            ),
            elm(5, "ground", &[[32, 68]], &[]),
            elm(
                6,
                "resistor",
                &[[64, -32], [64, 68]],
                &[("resistance", 1000.0)],
            ),
            elm(7, "ground", &[[64, 68]], &[]),
            elm(
                8,
                "resistor",
                &[[96, -32], [96, 68]],
                &[("resistance", 1000.0)],
            ),
            elm(9, "ground", &[[96, 68]], &[]),
        ],
        opts(1e-5, false),
    );
    let high = |c: &Circuit| -> usize {
        let v = c.element_voltages();
        [3, 5, 7]
            .iter()
            .position(|&i| v[i] > 2.5)
            .expect("no ring output is high")
    };
    c.run(3);
    assert_eq!(high(c), 0, "fresh ring did not start on Q0");
    for expected in [1, 2, 0] {
        clock_cycle(c, 1);
        assert_eq!(high(c), expected, "high bit after the next edge");
    }
}

#[test]
fn latch_outputs_follow_while_load_is_high_and_hold_after() {
    // 2-bit level latch (FLAG_NO_EDGE = 4): transparent while the load clock
    // is high, holding the last sampled bits once it drops.
    let c = &mut build(
        vec![
            elm(
                1,
                "logicInput",
                &[[0, 32]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm(
                2,
                "logicInput",
                &[[0, 0]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm_flags(
                3,
                "latch",
                &[[0, 32], [0, 0], [96, 32], [96, 0], [0, 64]],
                &[("bits", 2.0), ("highVoltage", 5.0)],
                4,
            ),
            elm(
                4,
                "logicInput",
                &[[0, 64]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm(
                5,
                "resistor",
                &[[96, 32], [96, 132]],
                &[("resistance", 1000.0)],
            ),
            elm(6, "ground", &[[96, 132]], &[]),
            elm(
                7,
                "resistor",
                &[[96, 0], [96, 100]],
                &[("resistance", 1000.0)],
            ),
            elm(8, "ground", &[[96, 100]], &[]),
        ],
        opts(1e-5, false),
    );
    // O0 is element 4, O1 element 6; bit 0 from the I0 pin, bit 1 from I1.
    let o = |c: &Circuit| -> i64 {
        let v = c.element_voltages();
        let bit = |i: usize| if v[i] > 2.5 { 1i64 } else { 0 };
        bit(4) | (bit(6) << 1)
    };
    // I0 = I1 = 1 but load is low: nothing is sampled yet.
    c.set_state(1, 1);
    c.set_state(2, 1);
    c.run(3);
    assert_eq!(o(c), 0, "latched with load low");
    // Load high: the outputs mirror the inputs.
    c.set_state(4, 1);
    c.run(3);
    assert_eq!(o(c), 3, "did not follow while transparent");
    // Inputs drop while load stays high: the outputs follow.
    c.set_state(1, 0);
    c.set_state(2, 0);
    c.run(3);
    assert_eq!(o(c), 0, "did not follow the new inputs");
    // Load drops, then the inputs rise: the outputs hold the last sample.
    c.set_state(4, 0);
    c.set_state(1, 1);
    c.set_state(2, 1);
    c.run(3);
    assert_eq!(o(c), 0, "did not hold after load went low");
}

#[test]
fn piso_shift_loads_and_shifts_the_parallel_bits_out() {
    // 3-bit PISO with the default new behavior (FLAG_NEW_BEHAVIOR = 2).
    // Loading D0..D2 = 1,0,1 puts Q at D0 immediately, and each rising clock
    // edge walks Q through the register, feeding the low SER pin in behind.
    let c = &mut build(
        vec![
            elm(
                1,
                "logicInput",
                &[[0, 64]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm(
                2,
                "logicInput",
                &[[0, 96]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm(
                3,
                "logicInput",
                &[[0, 32]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm(
                4,
                "logicInput",
                &[[32, -32]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm(
                5,
                "logicInput",
                &[[64, -32]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm(
                6,
                "logicInput",
                &[[96, -32]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm_flags(
                7,
                "pisoShift",
                &[
                    [0, 64],   // 0 LD
                    [0, 96],   // 1 clock
                    [160, 64], // 2 Q
                    [0, 32],   // 3 SER
                    [32, -32], // 4 D0
                    [64, -32], // 5 D1
                    [96, -32], // 6 D2
                ],
                &[("bits", 3.0), ("highVoltage", 5.0)],
                2,
            ),
            elm(
                8,
                "resistor",
                &[[160, 64], [160, 164]],
                &[("resistance", 1000.0)],
            ),
            elm(9, "ground", &[[160, 164]], &[]),
        ],
        opts(1e-5, false),
    );
    let q = |c: &Circuit| c.element_voltages()[7];
    // Parallel data D0 = 1, D1 = 0, D2 = 1.
    c.set_state(4, 1);
    c.set_state(6, 1);
    c.run(3);
    assert!(close(q(c), 0.0, 1e-9), "fresh Q was not low");
    // A rising LD edge latches the inputs; Q shows D0 immediately.
    c.set_state(1, 1);
    c.run(3);
    c.set_state(1, 0);
    c.run(3);
    assert!(close(q(c), 5.0, 1e-9), "Q did not show D0 after the load");
    // Each clock edge walks Q through the loaded pattern, then onto the low
    // SER bits shifted in behind it.
    clock_cycle(c, 2);
    assert!(close(q(c), 0.0, 1e-9), "Q did not advance to D1");
    clock_cycle(c, 2);
    assert!(close(q(c), 5.0, 1e-9), "Q did not advance to D2");
    clock_cycle(c, 2);
    assert!(
        close(q(c), 0.0, 1e-9),
        "Q did not wrap onto the shifted-in low"
    );
    clock_cycle(c, 2);
    assert!(close(q(c), 0.0, 1e-9), "Q did not wrap to the second low");
}

#[test]
fn sipo_shift_shifts_the_serial_bit_into_the_outputs() {
    // 3-bit SIPO. A rising clock edge loads D into Q0 and pushes every other
    // bit one position toward Q2, so a single 1 walks across the outputs.
    let c = &mut build(
        vec![
            elm(
                1,
                "logicInput",
                &[[0, 32]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm(
                2,
                "logicInput",
                &[[0, 64]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm(
                3,
                "sipoShift",
                &[[0, 32], [0, 64], [96, 0], [96, 32], [96, 64]],
                &[("bits", 3.0), ("highVoltage", 5.0)],
            ),
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
            elm(
                8,
                "resistor",
                &[[96, 64], [96, 164]],
                &[("resistance", 1000.0)],
            ),
            elm(9, "ground", &[[96, 164]], &[]),
        ],
        opts(1e-5, false),
    );
    let value = |c: &Circuit| -> i64 {
        let v = c.element_voltages();
        let bit = |i: usize| if v[i] > 2.5 { 1i64 } else { 0 };
        bit(3) | (bit(5) << 1) | (bit(7) << 2)
    };
    c.run(3);
    assert_eq!(value(c), 0, "fresh register did not start at zero");
    // Feed a single 1 in on D, then clock it out.
    c.set_state(1, 1);
    clock_cycle(c, 2);
    assert_eq!(value(c), 1, "the 1 did not land in Q0");
    c.set_state(1, 0);
    clock_cycle(c, 2);
    assert_eq!(value(c), 2, "the 1 did not shift into Q1");
    clock_cycle(c, 2);
    assert_eq!(value(c), 4, "the 1 did not shift into Q2");
    clock_cycle(c, 2);
    assert_eq!(value(c), 0, "the 1 did not shift out");
}

#[test]
fn seq_gen_emits_the_stored_bit_pattern() {
    // A 4-bit sequence 1,0,1,0 (data0 = 0b0101, bit 0 first) with the reset
    // pin held low. Each rising clock edge emits the next bit and wraps.
    let c = &mut build(
        vec![
            elm(
                1,
                "logicInput",
                &[[0, 32]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm(
                2,
                "logicInput",
                &[[0, 64]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm_flags(
                3,
                "seqGen",
                &[[0, 32], [96, 0], [0, 64]],
                &[("bitCount", 4.0), ("data0", 5.0), ("highVoltage", 5.0)],
                10, // FLAG_NEW_VERSION | FLAG_HAS_RESET
            ),
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
    let q = |c: &Circuit| c.element_voltages()[3];
    c.run(3);
    assert!(close(q(c), 0.0, 1e-9), "fresh Q was not low");
    for (step, expected) in [(1u32, 5.0), (2, 0.0), (3, 5.0), (4, 0.0), (5, 5.0)] {
        clock_cycle(c, 1);
        assert!(close(q(c), expected, 1e-9), "bit {step} was wrong");
    }
    // The reset pin rewinds to the first bit.
    c.set_state(2, 1);
    c.run(3);
    assert!(close(q(c), 5.0, 1e-9), "reset did not rewind to bit 0");
}

#[test]
fn counter2_counts_modulo_the_modulus_token() {
    // 3-bit counter 2 with modulus 5, counting enabled (EnP = EnT = 1) and
    // the clear and load pins held high (both active low). A 1 kHz square
    // clock (100 steps per period) delivers one rising edge every 100 steps,
    // so the count runs 1,2,3,4,0,... and RCO pulses high at count 4. The
    // clock runs from a square source rather than a toggled logic input: a
    // `set_state` re-analysis zeroes every node, which would make the
    // active-low CLR pin read low for a step and spuriously clear.
    let c = &mut build(
        vec![
            elm(
                1,
                "logicInput",
                &[[0, 0]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm(
                2,
                "logicInput",
                &[[0, 32]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm(
                3,
                "logicInput",
                &[[0, 64]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm(
                4,
                "logicInput",
                &[[0, 128]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm(
                5,
                "logicInput",
                &[[0, 160]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm(
                6,
                "logicInput",
                &[[160, 32]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm(
                7,
                "logicInput",
                &[[160, 64]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm(
                8,
                "voltage",
                &[[0, 224], [0, 96]],
                &[
                    ("waveform", 2.0),
                    ("frequency", 1000.0),
                    ("maxVoltage", 2.5),
                    ("bias", 2.5),
                    ("phaseShift", 0.0),
                    ("dutyCycle", 0.5),
                ],
            ),
            elm(9, "ground", &[[0, 224]], &[]),
            elm(
                10,
                "counter2",
                &[
                    [96, 0],   // 0 Q2 (MSB)
                    [96, 32],  // 1 Q1
                    [96, 64],  // 2 Q0 (LSB)
                    [0, 0],    // 3 I2
                    [0, 32],   // 4 I1
                    [0, 64],   // 5 I0
                    [0, 96],   // 6 clk
                    [0, 128],  // 7 clr
                    [0, 160],  // 8 enp
                    [160, 0],  // 9 rco
                    [160, 32], // 10 load
                    [160, 64], // 11 ent
                ],
                &[("bits", 3.0), ("modulus", 5.0), ("highVoltage", 5.0)],
            ),
            elm(
                11,
                "resistor",
                &[[96, 0], [96, 100]],
                &[("resistance", 1000.0)],
            ),
            elm(12, "ground", &[[96, 100]], &[]),
            elm(
                13,
                "resistor",
                &[[96, 32], [96, 132]],
                &[("resistance", 1000.0)],
            ),
            elm(14, "ground", &[[96, 132]], &[]),
            elm(
                15,
                "resistor",
                &[[96, 64], [96, 164]],
                &[("resistance", 1000.0)],
            ),
            elm(16, "ground", &[[96, 164]], &[]),
            elm(
                17,
                "resistor",
                &[[160, 0], [160, 100]],
                &[("resistance", 1000.0)],
            ),
            elm(18, "ground", &[[160, 100]], &[]),
        ],
        opts(1e-5, false),
    );
    // Enable counting and hold clear and load inactive (both active low).
    c.set_state(4, 1);
    c.set_state(5, 1);
    c.set_state(6, 1);
    c.set_state(7, 1);
    let count = |c: &Circuit| -> i64 {
        let v = c.element_voltages();
        let bit = |i: usize| if v[i] > 2.5 { 1i64 } else { 0 };
        bit(14) | (bit(12) << 1) | (bit(10) << 2)
    };
    let rco = |c: &Circuit| c.element_voltages()[16];
    assert_eq!(count(c), 0, "fresh counter did not start at zero");
    // One rising edge every 100 steps: 1, 2, 3, 4, then the wrap to 0.
    for (expected, rco_want) in [(1i64, 0.0), (2, 0.0), (3, 0.0), (4, 5.0), (0, 0.0)] {
        c.run(100);
        assert_eq!(count(c), expected, "count after the next edge");
        assert!(close(rco(c), rco_want, 1e-9), "RCO at count {expected}");
    }
    // The active-low load pin copies the I inputs on the next edge.
    c.set_state(3, 1); // I0 = 1
    c.set_state(2, 1); // I1 = 1
    c.set_state(6, 0); // load = 0
    c.run(100);
    assert_eq!(count(c), 3, "load did not take the I pattern");
    c.set_state(6, 1); // load = 1
                       // The active-low clear is level-based and wins immediately.
    c.set_state(4, 0); // clr = 0
    c.run(3);
    assert_eq!(count(c), 0, "clear did not zero the count");
    c.set_state(4, 1);
}
