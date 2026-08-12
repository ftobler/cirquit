//! Adders, the seven-segment decoder, bus splitter, SRAM, ROM, analog multiplexer and monostable.

use circuit_core::Circuit;

mod common;
use common::*;

#[test]
fn half_adder_sums_the_two_input_bits() {
    // The half adder's truth table, S = A XOR B and C = A AND B, read off
    // resistor loads on the two outputs. Post order is S, C, A, B.
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
                "halfAdder",
                &[[64, 0], [64, 32], [0, 0], [0, 32]],
                &[("highVoltage", 5.0)],
            ),
            elm(
                4,
                "resistor",
                &[[64, 0], [64, 80]],
                &[("resistance", 1000.0)],
            ),
            elm(5, "ground", &[[64, 80]], &[]),
            elm(
                6,
                "resistor",
                &[[64, 32], [64, 112]],
                &[("resistance", 1000.0)],
            ),
            elm(7, "ground", &[[64, 112]], &[]),
        ],
        opts(1e-5, false),
    );
    let s = |c: &Circuit| c.element_voltages()[3];
    let carry = |c: &Circuit| c.element_voltages()[5];
    c.run(3);
    assert!(close(s(c), 0.0, 1e-9), "0 + 0 did not give S 0");
    assert!(close(carry(c), 0.0, 1e-9), "0 + 0 did not give C 0");
    c.set_state(1, 1); // A only
    c.run(3);
    assert!(close(s(c), 5.0, 1e-9), "1 + 0 did not give S 1");
    assert!(close(carry(c), 0.0, 1e-9), "1 + 0 did not give C 0");
    c.set_state(1, 0);
    c.set_state(2, 1); // B only
    c.run(3);
    assert!(close(s(c), 5.0, 1e-9), "0 + 1 did not give S 1");
    assert!(close(carry(c), 0.0, 1e-9), "0 + 1 did not give C 0");
    c.set_state(1, 1); // A and B
    c.run(3);
    assert!(close(s(c), 0.0, 1e-9), "1 + 1 did not give S 0");
    assert!(close(carry(c), 5.0, 1e-9), "1 + 1 did not give C 1");
}

#[test]
fn full_adder_ripple_carries_bits_and_has_a_carry_in() {
    // A 2-bit adder under FLAG_BITS (the `2` in the flags is the bit 1 flag):
    // 01 + 01 = 10 with no carry in, 01 + 01 + 1 = 11, and 11 + 11 + 1 wraps
    // to 11 with the carry out high. Post order is A0, A1, B0, B1, S0, S1,
    // Cin, C.
    let c = &mut build(
        vec![
            elm(
                1,
                "logicInput",
                &[[64, 0]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm(
                2,
                "logicInput",
                &[[64, 32]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm(
                3,
                "logicInput",
                &[[64, 64]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm(
                4,
                "logicInput",
                &[[64, 96]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm(
                5,
                "logicInput",
                &[[0, 128]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm_flags(
                6,
                "fullAdder",
                &[
                    [64, 0],
                    [64, 32],
                    [64, 64],
                    [64, 96],
                    [160, 0],
                    [160, 32],
                    [0, 128],
                    [160, 64],
                ],
                &[("bits", 2.0), ("highVoltage", 5.0)],
                2,
            ),
            elm(
                7,
                "resistor",
                &[[160, 0], [160, 80]],
                &[("resistance", 1000.0)],
            ),
            elm(8, "ground", &[[160, 80]], &[]),
            elm(
                9,
                "resistor",
                &[[160, 32], [160, 112]],
                &[("resistance", 1000.0)],
            ),
            elm(10, "ground", &[[160, 112]], &[]),
            elm(
                11,
                "resistor",
                &[[160, 64], [160, 144]],
                &[("resistance", 1000.0)],
            ),
            elm(12, "ground", &[[160, 144]], &[]),
        ],
        opts(1e-5, false),
    );
    let sum = |c: &Circuit| -> i64 {
        let v = c.element_voltages();
        let bit = |i: usize| if v[i] > 2.5 { 1i64 } else { 0 };
        bit(6) | (bit(8) << 1)
    };
    let carry = |c: &Circuit| c.element_voltages()[10];
    c.run(3);
    assert_eq!(sum(c), 0, "0 + 0 did not sum to 0");
    assert!(close(carry(c), 0.0, 1e-9), "0 + 0 produced a carry");
    // A = 01, B = 01.
    c.set_state(1, 1);
    c.set_state(3, 1);
    c.run(3);
    assert_eq!(sum(c), 2, "01 + 01 did not sum to 10");
    assert!(close(carry(c), 0.0, 1e-9), "01 + 01 produced a carry");
    // Add the carry-in: 01 + 01 + 1 = 11.
    c.set_state(5, 1);
    c.run(3);
    assert_eq!(sum(c), 3, "01 + 01 + 1 did not sum to 11");
    assert!(close(carry(c), 0.0, 1e-9), "01 + 01 + 1 produced a carry");
    // A = 11, B = 11, carry in = 1: the carry out goes high and the sum wraps.
    c.set_state(2, 1);
    c.set_state(4, 1);
    c.run(3);
    assert_eq!(sum(c), 3, "11 + 11 + 1 did not sum to 11");
    assert!(close(carry(c), 5.0, 1e-9), "11 + 11 + 1 lost its carry out");
}

#[test]
fn seven_seg_decoder_lights_the_segments_for_the_input_digit() {
    // A 7-segment decoder with the blank pin enabled (FLAG_ENABLE = 2): the
    // input nibble drives the west pins MSB first and the seven east outputs
    // carry the glyph bit pattern, bit 0 = segment a. Pulling the active-low
    // blank pin low blanks everything, and under FLAG_BLANK_F (4) the all-ones
    // input blanks instead of lighting an F.
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
                &[[0, 96]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm(
                5,
                "logicInput",
                &[[0, 128]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 1.0)],
            ),
            elm_flags(
                6,
                "sevenSegDecoder",
                &[
                    [128, 0],
                    [128, 32],
                    [128, 64],
                    [128, 96],
                    [128, 128],
                    [128, 160],
                    [128, 192],
                    [0, 0],
                    [0, 32],
                    [0, 64],
                    [0, 96],
                    [0, 128],
                ],
                &[("segmentType", 0.0), ("highVoltage", 5.0)],
                2,
            ),
            elm(
                7,
                "resistor",
                &[[128, 0], [128, 80]],
                &[("resistance", 1000.0)],
            ),
            elm(8, "ground", &[[128, 80]], &[]),
            elm(
                9,
                "resistor",
                &[[128, 32], [128, 112]],
                &[("resistance", 1000.0)],
            ),
            elm(10, "ground", &[[128, 112]], &[]),
            elm(
                11,
                "resistor",
                &[[128, 64], [128, 144]],
                &[("resistance", 1000.0)],
            ),
            elm(12, "ground", &[[128, 144]], &[]),
            elm(
                13,
                "resistor",
                &[[128, 96], [128, 176]],
                &[("resistance", 1000.0)],
            ),
            elm(14, "ground", &[[128, 176]], &[]),
            elm(
                15,
                "resistor",
                &[[128, 128], [128, 208]],
                &[("resistance", 1000.0)],
            ),
            elm(16, "ground", &[[128, 208]], &[]),
            elm(
                17,
                "resistor",
                &[[128, 160], [128, 240]],
                &[("resistance", 1000.0)],
            ),
            elm(18, "ground", &[[128, 240]], &[]),
            elm(
                19,
                "resistor",
                &[[128, 192], [128, 272]],
                &[("resistance", 1000.0)],
            ),
            elm(20, "ground", &[[128, 272]], &[]),
        ],
        opts(1e-5, false),
    );
    let glyph = |c: &Circuit| -> i64 {
        let v = c.element_voltages();
        let bit = |i: usize| if v[i] > 2.5 { 1i64 } else { 0 };
        bit(6)
            | (bit(8) << 1)
            | (bit(10) << 2)
            | (bit(12) << 3)
            | (bit(14) << 4)
            | (bit(16) << 5)
            | (bit(18) << 6)
    };
    c.run(3);
    assert_eq!(glyph(c), 0x3f, "digit 0 did not light a-f");
    // Digit 5 (0101): the input nibble reads MSB first, so I2 and I0 high.
    c.set_state(1, 0);
    c.set_state(2, 1);
    c.set_state(3, 0);
    c.set_state(4, 1);
    c.run(3);
    assert_eq!(glyph(c), 0x6d, "digit 5 did not light a-f-g-c-d");
    // Digit 7 (0111): I2, I1 and I0 high.
    c.set_state(1, 0);
    c.set_state(2, 1);
    c.set_state(3, 1);
    c.set_state(4, 1);
    c.run(3);
    assert_eq!(glyph(c), 0x07, "digit 7 did not light a-c");
    // The active-low blank pin blanks every segment.
    c.set_state(5, 0);
    c.run(3);
    assert_eq!(glyph(c), 0, "blank pin did not blank the display");
    c.set_state(5, 1);
    // Without FLAG_BLANK_F the all-ones input lights the F glyph (a-e-g-f).
    c.set_state(1, 1);
    c.set_state(2, 1);
    c.set_state(3, 1);
    c.set_state(4, 1);
    c.run(3);
    assert_eq!(glyph(c), 0x71, "all-ones input did not light the F glyph");

    // Under FLAG_BLANK_F the same all-ones input blanks instead of lighting an
    // F. The blank pin is driven high so only the flag can blank the display.
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
                "logicInput",
                &[[0, 32]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 1.0)],
            ),
            elm(
                3,
                "logicInput",
                &[[0, 64]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 1.0)],
            ),
            elm(
                4,
                "logicInput",
                &[[0, 96]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 1.0)],
            ),
            elm(
                5,
                "logicInput",
                &[[0, 128]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 1.0)],
            ),
            elm_flags(
                6,
                "sevenSegDecoder",
                &[
                    [128, 0],
                    [128, 32],
                    [128, 64],
                    [128, 96],
                    [128, 128],
                    [128, 160],
                    [128, 192],
                    [0, 0],
                    [0, 32],
                    [0, 64],
                    [0, 96],
                    [0, 128],
                ],
                &[("segmentType", 0.0), ("highVoltage", 5.0)],
                2 | 4,
            ),
            elm(
                7,
                "resistor",
                &[[128, 0], [128, 80]],
                &[("resistance", 1000.0)],
            ),
            elm(8, "ground", &[[128, 80]], &[]),
            elm(
                9,
                "resistor",
                &[[128, 32], [128, 112]],
                &[("resistance", 1000.0)],
            ),
            elm(10, "ground", &[[128, 112]], &[]),
            elm(
                11,
                "resistor",
                &[[128, 64], [128, 144]],
                &[("resistance", 1000.0)],
            ),
            elm(12, "ground", &[[128, 144]], &[]),
            elm(
                13,
                "resistor",
                &[[128, 96], [128, 176]],
                &[("resistance", 1000.0)],
            ),
            elm(14, "ground", &[[128, 176]], &[]),
            elm(
                15,
                "resistor",
                &[[128, 128], [128, 208]],
                &[("resistance", 1000.0)],
            ),
            elm(16, "ground", &[[128, 208]], &[]),
            elm(
                17,
                "resistor",
                &[[128, 160], [128, 240]],
                &[("resistance", 1000.0)],
            ),
            elm(18, "ground", &[[128, 240]], &[]),
            elm(
                19,
                "resistor",
                &[[128, 192], [128, 272]],
                &[("resistance", 1000.0)],
            ),
            elm(20, "ground", &[[128, 272]], &[]),
        ],
        opts(1e-5, false),
    );
    let glyph = |c: &Circuit| -> i64 {
        let v = c.element_voltages();
        let bit = |i: usize| if v[i] > 2.5 { 1i64 } else { 0 };
        bit(6)
            | (bit(8) << 1)
            | (bit(10) << 2)
            | (bit(12) << 3)
            | (bit(14) << 4)
            | (bit(16) << 5)
            | (bit(18) << 6)
    };
    c.run(3);
    assert_eq!(
        glyph(c),
        0,
        "all-ones input did not blank under FLAG_BLANK_F"
    );
}

#[test]
fn bus_splitter_fans_the_bus_out_to_independent_bits() {
    // A 2-bit splitter: the two bus pins share one node, each individual pin
    // ties to it through its own 0 V source. Driving the bus at 5 V must put
    // 5 V on every individual pin, and each bit carries only its own load
    // current: the per-pin currents sum to the bus injection.
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
                "busSplitter",
                &[[0, 0], [0, 0], [96, 32], [96, 0]],
                &[("bits", 2.0)],
            ),
            elm(
                3,
                "resistor",
                &[[96, 32], [96, 112]],
                &[("resistance", 2000.0)],
            ),
            elm(4, "ground", &[[96, 112]], &[]),
            elm(
                5,
                "resistor",
                &[[96, 0], [96, 80]],
                &[("resistance", 1000.0)],
            ),
            elm(6, "ground", &[[96, 80]], &[]),
        ],
        opts(1e-5, false),
    );
    c.run(3);
    let v = c.element_voltages();
    assert!(
        close(v[2], 5.0, 1e-9),
        "individual pin 0 did not follow the bus"
    );
    assert!(
        close(v[4], 5.0, 1e-9),
        "individual pin 1 did not follow the bus"
    );
    let p = c.element_post_currents();
    // The two bus pins drain their own bit's current from the shared node and
    // the individual pins deliver it: 5/2000 and 5/1000 respectively.
    assert!(
        close(p[1], -2.5e-3, 1e-9),
        "bus pin 0 drained the wrong current"
    );
    assert!(
        close(p[2], -5.0e-3, 1e-9),
        "bus pin 1 drained the wrong current"
    );
    assert!(
        close(p[3], 2.5e-3, 1e-9),
        "individual pin 0 delivered the wrong current"
    );
    assert!(
        close(p[4], 5.0e-3, 1e-9),
        "individual pin 1 delivered the wrong current"
    );
    // The driving source injects the sum, closing KCL at the bus node.
    assert!(
        close(p[0], 7.5e-3, 1e-9),
        "the source current did not sum to both bits"
    );
}

#[test]
fn sram_stores_and_reads_back_the_data_bits() {
    // A 2-bit by 2-bit SRAM. Post order: WE, OE, A1, A0, D1, D0. WE low
    // samples the data pins into the addressed word (the map), and with WE
    // high and OE low the stored word drives the pins through a 1 ohm
    // coupling. The write drivers hang off closed switches so the read phase
    // can open them and leave the pins to the SRAM.
    let c = &mut build(
        vec![
            elm(
                1,
                "logicInput",
                &[[0, 0]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ), // WE, low to write
            elm(
                2,
                "logicInput",
                &[[96, 0]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 1.0)],
            ), // OE
            elm(
                3,
                "logicInput",
                &[[0, 32]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ), // A1
            elm(
                4,
                "logicInput",
                &[[0, 64]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 1.0)],
            ), // A0
            elm(
                5,
                "sram",
                &[[0, 0], [96, 0], [0, 32], [0, 64], [96, 32], [96, 64]],
                &[
                    ("addressBits", 2.0),
                    ("dataBits", 2.0),
                    ("highVoltage", 5.0),
                ],
            ),
            elm(
                6,
                "resistor",
                &[[96, 32], [96, 112]],
                &[("resistance", 10000.0)],
            ),
            elm(7, "ground", &[[96, 112]], &[]),
            elm(
                8,
                "resistor",
                &[[96, 64], [96, 144]],
                &[("resistance", 10000.0)],
            ),
            elm(9, "ground", &[[96, 144]], &[]),
            elm(10, "switch", &[[96, 32], [160, 32]], &[("position", 0.0)]), // closed: D1 driver
            elm(
                11,
                "logicInput",
                &[[160, 32]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 1.0)],
            ), // D1 driver high
            elm(12, "switch", &[[96, 64], [160, 64]], &[("position", 0.0)]), // closed: D0 driver
            elm(
                13,
                "logicInput",
                &[[160, 64]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ), // D0 driver low
        ],
        opts(1e-5, false),
    );
    let d1 = |c: &Circuit| c.element_voltages()[5];
    let d0 = |c: &Circuit| c.element_voltages()[7];
    // Write 10 to address 01 (WE low, OE high, drivers connected), then switch
    // to read: WE high, OE low, drivers opened.
    c.run(3);
    c.set_state(1, 1); // WE high
    c.set_state(2, 0); // OE low
    c.set_state(10, 1); // open the D1 driver switch
    c.set_state(12, 1); // open the D0 driver switch
    c.run(3);
    assert!(close(d1(c), 5.0, 1e-3), "stored bit 1 did not read high");
    assert!(close(d0(c), 0.0, 1e-3), "stored bit 0 did not read low");
    // An un-written address reads 0: address 10.
    c.set_state(3, 1); // A1 high
    c.set_state(4, 0); // A0 low
    c.run(3);
    assert!(
        close(d1(c), 0.0, 1e-3),
        "un-written address read a high bit"
    );
    assert!(
        close(d0(c), 0.0, 1e-3),
        "un-written address read a high bit"
    );
    // Write 01 to address 10 and read it back.
    c.set_state(1, 0); // WE low
    c.set_state(2, 1); // OE high
    c.set_state(10, 0); // close the D1 driver switch
    c.set_state(12, 0); // close the D0 driver switch
    c.set_state(11, 0); // D1 driver low
    c.set_state(13, 1); // D0 driver high
    c.run(3);
    c.set_state(1, 1); // WE high
    c.set_state(2, 0); // OE low
    c.set_state(10, 1); // open both drivers again
    c.set_state(12, 1);
    c.run(3);
    assert!(
        close(d1(c), 0.0, 1e-3),
        "second stored bit 1 did not read low"
    );
    assert!(
        close(d0(c), 5.0, 1e-3),
        "second stored bit 0 did not read high"
    );
}

#[test]
fn sram_reloads_its_initial_contents_on_reset() {
    // FLAG_RELOAD_ON_RESET (2): a written word is discarded on reset and the
    // map returns to the contents the file carried, here {1: 2} as the flat
    // addr0/val0 param pair. Post order is WE, OE, A1, A0, D1, D0.
    let c = &mut build(
        vec![
            elm(
                1,
                "logicInput",
                &[[0, 0]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ), // WE, low to write
            elm(
                2,
                "logicInput",
                &[[96, 0]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 1.0)],
            ), // OE
            elm(
                3,
                "logicInput",
                &[[0, 32]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ), // A1
            elm(
                4,
                "logicInput",
                &[[0, 64]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 1.0)],
            ), // A0
            elm_flags(
                5,
                "sram",
                &[[0, 0], [96, 0], [0, 32], [0, 64], [96, 32], [96, 64]],
                &[
                    ("addressBits", 2.0),
                    ("dataBits", 2.0),
                    ("highVoltage", 5.0),
                    ("addr0", 1.0),
                    ("val0", 2.0),
                ],
                2,
            ),
            elm(
                6,
                "resistor",
                &[[96, 32], [96, 112]],
                &[("resistance", 10000.0)],
            ),
            elm(7, "ground", &[[96, 112]], &[]),
            elm(
                8,
                "resistor",
                &[[96, 64], [96, 144]],
                &[("resistance", 10000.0)],
            ),
            elm(9, "ground", &[[96, 144]], &[]),
            elm(10, "switch", &[[96, 32], [160, 32]], &[("position", 0.0)]), // closed: D1 driver
            elm(
                11,
                "logicInput",
                &[[160, 32]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 1.0)],
            ), // D1 driver high
            elm(12, "switch", &[[96, 64], [160, 64]], &[("position", 0.0)]), // closed: D0 driver
            elm(
                13,
                "logicInput",
                &[[160, 64]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 1.0)],
            ), // D0 driver high
        ],
        opts(1e-5, false),
    );
    let d1 = |c: &Circuit| c.element_voltages()[5];
    let d0 = |c: &Circuit| c.element_voltages()[7];
    // The initial contents {1: 2} read as 10 on address 01.
    c.set_state(1, 1); // WE high
    c.set_state(2, 0); // OE low
    c.set_state(10, 1); // open the drivers
    c.set_state(12, 1);
    c.run(3);
    assert!(
        close(d1(c), 5.0, 1e-3),
        "initial contents bit 1 did not read high"
    );
    assert!(
        close(d0(c), 0.0, 1e-3),
        "initial contents bit 0 did not read low"
    );
    // Overwrite address 01 with 11, then reset: the written word must vanish.
    c.set_state(1, 0); // WE low
    c.set_state(2, 1); // OE high
    c.set_state(10, 0); // close the drivers
    c.set_state(12, 0);
    c.run(3);
    c.set_state(1, 1); // WE high
    c.set_state(2, 0); // OE low
    c.set_state(10, 1); // open the drivers
    c.set_state(12, 1);
    c.run(3);
    assert!(
        close(d1(c), 5.0, 1e-3),
        "written word bit 1 did not read high"
    );
    assert!(
        close(d0(c), 5.0, 1e-3),
        "written word bit 0 did not read high"
    );
    c.reset();
    c.run(3);
    assert!(
        close(d1(c), 5.0, 1e-3),
        "reset did not restore bit 1 of the initial contents"
    );
    assert!(
        close(d0(c), 0.0, 1e-3),
        "reset did not restore bit 0 of the initial contents"
    );
}

#[test]
fn rom_reads_its_programmed_words_and_never_writes() {
    // A 2-bit by 2-bit ROM with initial contents {1: 2}, no WE pin. Post
    // order: OE, A1, A0, D1, D0. OE low drives the addressed word out through
    // the 1 ohm couplings; the un-programmed address reads 0, and holding a
    // data pin high through the output coupling changes nothing on the next
    // read because a ROM has no write path.
    let c = &mut build(
        vec![
            elm(
                1,
                "logicInput",
                &[[0, 0]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ), // OE, low to read
            elm(
                2,
                "logicInput",
                &[[0, 32]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ), // A1
            elm(
                3,
                "logicInput",
                &[[0, 64]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 1.0)],
            ), // A0
            elm(
                4,
                "rom",
                &[[0, 0], [0, 32], [0, 64], [96, 32], [96, 64]],
                &[
                    ("addressBits", 2.0),
                    ("dataBits", 2.0),
                    ("highVoltage", 5.0),
                    ("addr0", 1.0),
                    ("val0", 2.0),
                ],
            ),
            elm(
                5,
                "resistor",
                &[[96, 32], [96, 112]],
                &[("resistance", 10000.0)],
            ),
            elm(6, "ground", &[[96, 112]], &[]),
            elm(
                7,
                "resistor",
                &[[96, 64], [96, 144]],
                &[("resistance", 10000.0)],
            ),
            elm(8, "ground", &[[96, 144]], &[]),
        ],
        opts(1e-5, false),
    );
    let d1 = |c: &Circuit| c.element_voltages()[4];
    let d0 = |c: &Circuit| c.element_voltages()[6];
    c.run(3);
    // Address 01 reads data 2 (10): D1 high, D0 low.
    assert!(
        close(d1(c), 5.0, 1e-3),
        "programmed word bit 1 did not read high"
    );
    assert!(
        close(d0(c), 0.0, 1e-3),
        "programmed word bit 0 did not read low"
    );
    // Address 10 has no entry and reads 0.
    c.set_state(2, 1); // A1 high
    c.set_state(3, 0); // A0 low
    c.run(3);
    assert!(
        close(d1(c), 0.0, 1e-3),
        "un-programmed address read a high bit"
    );
    assert!(
        close(d0(c), 0.0, 1e-3),
        "un-programmed address read a high bit"
    );
    // OE high disables the output and lets the pins float down to the write
    // pulldown; re-enabling reads the same stored word, so nothing wrote.
    c.set_state(2, 0); // A1 low
    c.set_state(3, 1); // A0 high
    c.set_state(1, 1); // OE high
    c.run(3);
    c.set_state(1, 0); // OE low
    c.run(3);
    assert!(close(d1(c), 5.0, 1e-3), "the ROM lost its programmed bit 1");
    assert!(close(d0(c), 0.0, 1e-3), "the ROM lost its programmed bit 0");
}

#[test]
fn analog_mux_routes_the_selected_input_to_the_output() {
    // A 2-select-bit mux with the inputs at 5/0/5/0 V and Z loaded by 10k.
    // The select pins read LSB first (S0 is bit 0): S1S0 = 01 routes I1 (0 V)
    // to Z, S1S0 = 10 routes I2 (5 V). Post order is I0, I1, I2, I3, S0, S1, Z.
    let c = &mut build(
        vec![
            elm(
                1,
                "logicInput",
                &[[0, 0]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 1.0)],
            ), // I0
            elm(
                2,
                "logicInput",
                &[[0, 32]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ), // I1
            elm(
                3,
                "logicInput",
                &[[0, 64]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 1.0)],
            ), // I2
            elm(
                4,
                "logicInput",
                &[[0, 96]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ), // I3
            elm(
                5,
                "analogMux",
                &[
                    [0, 0],
                    [0, 32],
                    [0, 64],
                    [0, 96],
                    [64, 160],
                    [96, 160],
                    [128, 0],
                ],
                &[
                    ("selectBitCount", 2.0),
                    ("r_on", 20.0),
                    ("r_off", 1e10),
                    ("threshold", 2.5),
                ],
            ),
            elm(
                6,
                "logicInput",
                &[[64, 160]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 1.0)],
            ), // S0
            elm(
                7,
                "logicInput",
                &[[96, 160]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ), // S1
            elm(
                8,
                "resistor",
                &[[128, 0], [128, 80]],
                &[("resistance", 10000.0)],
            ),
            elm(9, "ground", &[[128, 80]], &[]),
        ],
        opts(1e-5, false),
    );
    let z = |c: &Circuit| c.element_voltages()[7];
    // S1S0 = 01 selects I1, which sits at 0 V.
    c.run(3);
    assert!(
        close(z(c), 0.0, 1e-2),
        "select 01 did not route the low input"
    );
    // S1S0 = 10 selects I2, which sits at 5 V.
    c.set_state(6, 0); // S0 low
    c.set_state(7, 1); // S1 high
    c.run(3);
    assert!(
        close(z(c), 5.0, 1e-2),
        "select 10 did not route the high input"
    );
    // The selected input drains its resistor current from its node and Z
    // delivers it: with the 10k load both sit at ~0.5 mA (the r_off couplings
    // to the unselected inputs are negligible).
    let p = c.element_post_currents();
    assert!(
        close(p[6], -5.0e-4, 1e-5),
        "selected input drained the wrong current"
    );
    assert!(
        close(p[10], 5.0e-4, 1e-5),
        "the output delivered the wrong current"
    );
    // S1S0 = 00 selects I0 back at 5 V.
    c.set_state(7, 0);
    c.run(3);
    assert!(
        close(z(c), 5.0, 1e-2),
        "select 00 did not route the high input"
    );
}

#[test]
fn analog_mux_pulldowns_the_unselected_inputs() {
    // Under FLAG_PULLDOWN (2) the unselected inputs pull to ground through
    // r_off instead of coupling to the output, so an unselected input's
    // current_into_node drains out of its node (upstream's
    // pins[i].current = -volts[i]/r_off, AnalogMuxElm.java:149-151) and Z
    // carries only the selected input's current.
    let c = &mut build(
        vec![
            elm(
                1,
                "logicInput",
                &[[0, 0]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 1.0)],
            ), // I0
            elm(
                2,
                "logicInput",
                &[[0, 32]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ), // I1
            elm(
                3,
                "logicInput",
                &[[0, 64]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 1.0)],
            ), // I2
            elm(
                4,
                "logicInput",
                &[[0, 96]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ), // I3
            elm_flags(
                5,
                "analogMux",
                &[
                    [0, 0],
                    [0, 32],
                    [0, 64],
                    [0, 96],
                    [64, 160],
                    [96, 160],
                    [128, 0],
                ],
                &[
                    ("selectBitCount", 2.0),
                    ("r_on", 20.0),
                    ("r_off", 1e10),
                    ("threshold", 2.5),
                ],
                2,
            ),
            elm(
                6,
                "logicInput",
                &[[64, 160]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 1.0)],
            ), // S0, selects I1
            elm(
                7,
                "logicInput",
                &[[96, 160]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ), // S1
            elm(
                8,
                "resistor",
                &[[128, 0], [128, 80]],
                &[("resistance", 10000.0)],
            ),
            elm(9, "ground", &[[128, 80]], &[]),
        ],
        opts(1e-5, false),
    );
    c.run(3);
    // Z follows I1 at 0 V; the high unselected inputs I0 and I2 drain their
    // pulldown currents out of their nodes (current_into_node negative).
    assert!(
        close(c.element_voltages()[7], 0.0, 1e-2),
        "select 01 did not route"
    );
    let p = c.element_post_currents();
    assert!(
        p[6] < 0.0,
        "the high unselected input did not drain into its pulldown"
    );
    assert!(
        close(p[6], -5.0e-10, 1e-12),
        "the pulldown current was not -V/r_off"
    );
    // Z delivers only the selected (0 V) input's current, near zero.
    assert!(
        close(p[10], 0.0, 1e-12),
        "the output picked up a pulldown current"
    );
}

#[test]
fn monostable_pulse_width_matches_the_delay() {
    // A retriggerable one-shot with a 0.01 s delay at dt = 1e-5 s: the pulse
    // runs for 1000 steps and Qbar mirrors it low.
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
                "monostable",
                &[[0, 32], [96, 0], [96, 64]],
                &[
                    ("retriggerable", 1.0),
                    ("delay", 0.01),
                    ("highVoltage", 5.0),
                ],
            ),
            elm(
                3,
                "resistor",
                &[[96, 0], [96, 100]],
                &[("resistance", 1000.0)],
            ),
            elm(4, "ground", &[[96, 100]], &[]),
            elm(
                5,
                "resistor",
                &[[96, 64], [96, 164]],
                &[("resistance", 1000.0)],
            ),
            elm(6, "ground", &[[96, 164]], &[]),
        ],
        opts(1e-5, false),
    );
    let q = |c: &Circuit| c.element_voltages()[2];
    let qbar = |c: &Circuit| c.element_voltages()[4];
    c.run(3);
    assert!(close(q(c), 0.0, 1e-9), "fresh Q was not low");
    assert!(close(qbar(c), 5.0, 1e-9), "fresh Qbar was not high");
    // The rising trigger starts the 1000-step pulse.
    c.set_state(1, 1);
    c.run(5);
    assert!(close(q(c), 5.0, 1e-9), "trigger did not raise Q");
    assert!(close(qbar(c), 0.0, 1e-9), "trigger did not drop Qbar");
    // Well before the 0.01 s delay has passed the pulse is still running.
    c.run(900);
    assert!(close(q(c), 5.0, 1e-9), "pulse ended too early");
    // Past the delay it has expired.
    c.run(200);
    assert!(close(q(c), 0.0, 1e-9), "pulse did not end after the delay");
    assert!(close(qbar(c), 5.0, 1e-9), "Qbar did not return high");
}

#[test]
fn monostable_retrigger_extends_the_pulse() {
    // Same 0.01 s / 1000-step one-shot, but a second rising trigger halfway
    // through the pulse restarts the delay, keeping Q high past the original
    // expiry.
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
                "monostable",
                &[[0, 32], [96, 0], [96, 64]],
                &[
                    ("retriggerable", 1.0),
                    ("delay", 0.01),
                    ("highVoltage", 5.0),
                ],
            ),
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
    let q = |c: &Circuit| c.element_voltages()[2];
    c.set_state(1, 1);
    c.run(5);
    // Drop and re-raise the trigger 500 steps in, well inside the pulse.
    c.run(500);
    c.set_state(1, 0);
    c.run(5);
    c.set_state(1, 1);
    c.run(5);
    // Past the original 1000-step expiry, but still inside the restarted one.
    c.run(700);
    assert!(
        close(q(c), 5.0, 1e-9),
        "retriggered pulse ended at the old expiry"
    );
    // And it does end eventually.
    c.run(400);
    assert!(close(q(c), 0.0, 1e-9), "retriggered pulse never expired");
}
