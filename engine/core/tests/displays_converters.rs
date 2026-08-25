//! Decimal display, DAC, noise source, seven-segment reader, LED array, ADC, multiplexer, demultiplexer and VCO.

use circuit_core::elements::instruction_display::InstructionDisplay;
use circuit_core::{Circuit, CircuitSpec, ElementSpec, ScopeSpec, ScopeValue};

mod common;
use common::*;

#[test]
fn instruction_display_maps_the_value_through_the_lookup_table() {
    let lookup = "0=text0\n1=text1\n0x2-0xF=other ({a})\n";
    assert_eq!(InstructionDisplay::display_text(0, lookup), "text0");
    assert_eq!(InstructionDisplay::display_text(1, lookup), "text1");
    // 5 falls in the 0x2-0xF range; the `{a}` placeholder renders the value.
    assert_eq!(InstructionDisplay::display_text(5, lookup), "other (5)");
    // No matching entry falls back to the decimal value.
    assert_eq!(InstructionDisplay::display_text(20, lookup), "20");

    // Binary keys (0b10 == 2) must parse in base 2, not fall back to hex.
    let bin = "0b10=two\n0b11=three\n0x10=sixteen\n";
    assert_eq!(InstructionDisplay::display_text(2, bin), "two");
    assert_eq!(InstructionDisplay::display_text(3, bin), "three");
    assert_eq!(InstructionDisplay::display_text(16, bin), "sixteen");
}

#[test]
fn instruction_display_reads_its_bus_value_from_the_input_levels() {
    // Upstream stacks all N posts on the anchor coordinate with bit tags
    // (InstructionDisplayElm.getPost), so the driver here is a bus logic
    // input whose posts coincide with the display's.
    let c = &mut build(
        vec![
            elm(
                1,
                "busLogicInput",
                &[[0, 0], [0, 0], [0, 0], [0, 0]],
                &[("busWidth", 4.0), ("value", 5.0), ("hiV", 5.0)],
            ),
            elm(
                2,
                "instructionDisplay",
                &[[0, 0], [0, 0], [0, 0], [0, 0]],
                &[("busWidth", 4.0), ("threshold", 2.5)],
            ),
            // A real ground reference off bit 0, so the build does not fall
            // back to grounding the driver's own output node.
            elm(3, "resistor", &[[0, 0], [64, 64]], &[("resistance", 1e9)]),
            elm(4, "ground", &[[64, 64]], &[]),
        ],
        opts(1e-5, false),
    );
    c.run(3);
    // Bits 0 and 2 high, bits 1 and 3 low: 0b0101 = 5. A readout contributes
    // zero matrix unknowns, so the bus value is exactly the thresholded input.
    assert!(
        close(c.element_values()[1], 5.0, 1e-9),
        "bus value was {}",
        c.element_values()[1]
    );
}

#[test]
fn decimal_display_reads_its_input_bits_as_a_binary_number() {
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
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
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
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm(
                5,
                "decimalDisplay",
                &[[0, 0], [0, 32], [0, 64], [0, 96]],
                &[("bits", 4.0), ("highVoltage", 5.0)],
            ),
            elm(
                6,
                "resistor",
                &[[0, 32], [0, 132]],
                &[("resistance", 1000.0)],
            ),
            elm(7, "ground", &[[0, 132]], &[]),
        ],
        opts(1e-5, false),
    );
    c.run(3);
    // The display's value() reads the thresholded bit pattern: 0101 = 5.
    assert!(
        close(c.element_values()[4], 5.0, 1e-9),
        "display read was {}",
        c.element_values()[4]
    );
}

// The DAC output source drives `ival * Vplus / (2^bits - 1)`, where `ival` is
// the binary value of the thresholded bit inputs (DACElm.java:42-51). Element
// 7 is the load resistor from the O post to ground, so its voltage diff is the
// output. The source's do_step reads the previous solve's node voltages, so the
// output lags the inputs by one step; running a few steps settles it.
#[test]
fn dac_scales_the_bit_pattern_against_the_vplus_pin() {
    let c = &mut build(
        vec![
            elm(
                1,
                "dac",
                &[[0, 0], [0, 32], [0, 64], [0, 96], [96, 0], [96, 96]],
                &[("bits", 4.0), ("highVoltage", 5.0)],
            ),
            elm(
                2,
                "logicInput",
                &[[0, 0]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 1.0)],
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
                &[[0, 64]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 1.0)],
            ),
            elm(
                5,
                "logicInput",
                &[[0, 96]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm(6, "rail", &[[96, 96]], &[("maxVoltage", 5.0)]),
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
    let output = |c: &Circuit| c.element_voltages()[6];
    // D3..D0 = 0101 gives ival 5, so 5 * 5 / 15 = 1.6667 V.
    c.run(3);
    let got = output(c);
    assert!(
        close(got, 5.0 * 5.0 / 15.0, 1e-9),
        "0101 drove {got}, expected {}",
        5.0 * 5.0 / 15.0
    );
    // All bits high drives the full scale, exactly the V+ pin voltage.
    for id in 2..=5 {
        c.set_state(id, 1);
    }
    c.run(3);
    let got = output(c);
    assert!(close(got, 5.0, 1e-9), "1111 drove {got}, expected 5.0");
    // All bits low drives zero.
    for id in 2..=5 {
        c.set_state(id, 0);
    }
    c.run(3);
    let got = output(c);
    assert!(close(got, 0.0, 1e-9), "0000 drove {got}, expected 0.0");
}

#[test]
fn noise_source_across_a_resistor_is_bounded_and_finite() {
    let c = &mut build_with(
        vec![
            elm(1, "noise", &[[0, 0]], &[("maxVoltage", 5.0), ("bias", 0.0)]),
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
    let report = c.run(200);
    assert!(report.converged, "noise source broke Newton convergence");
    assert!(c.error().is_none(), "error: {:?}", c.error());
    let snap = c.scopes()[0].snapshot();
    assert!(
        snap.len() >= 200,
        "expected one column per step, got {}",
        snap.len()
    );
    for v in snap {
        assert!(v.is_finite(), "non-finite noise sample {v}");
        assert!(
            (-5.0..=5.0).contains(&(v as f64)),
            "noise sample {v} left [-5, 5]"
        );
    }
}

#[test]
fn seven_seg_reads_its_segment_input_bits() {
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
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm(
                6,
                "logicInput",
                &[[0, 160]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm(
                7,
                "logicInput",
                &[[0, 192]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm(
                8,
                "sevenSeg",
                &[
                    [0, 0],
                    [0, 32],
                    [0, 64],
                    [0, 96],
                    [0, 128],
                    [0, 160],
                    [0, 192],
                ],
                &[
                    ("baseSegments", 7.0),
                    ("extraSegment", 0.0),
                    ("diodeDirection", 0.0),
                    ("highVoltage", 5.0),
                ],
            ),
            elm(9, "ground", &[[64, 224]], &[]),
        ],
        opts(1e-5, false),
    );
    let value = |c: &Circuit| c.element_values()[7] as i64;
    c.set_state(1, 1);
    c.run(3);
    assert_eq!(value(c), 1, "segment a alone did not read as bit 0");
    for id in 2..=6 {
        c.set_state(id, 1);
    }
    c.run(3);
    assert_eq!(value(c), 0b011_1111, "digit 0 did not read as 63");
    for id in 1..=7 {
        c.set_state(id, 0);
    }
    c.set_state(2, 1);
    c.set_state(3, 1);
    c.run(3);
    assert_eq!(value(c), 0b000_0110, "digit 1 did not read as 6");
}

#[test]
fn led_array_lights_the_cells_whose_columns_are_driven_low() {
    // A 2x2 LED array: the south columns driven by logic inputs, the west
    // rows pulled to 5 V through 1 k. Each cell is a Shockley diode from its
    // row post (anode) to its column post (cathode), so it conducts when its
    // row sits above its column (LEDArrayElm.java:93-97). A lit cell pulls
    // its row down to the diode drop, roughly 1.6 V at the 3.73-emission
    // default-led model, while the reverse cells stay dark. The value()
    // readout is the lit-cell bit pattern, bit i = the cell (ix, iy) with
    // i = iy*sizeX + ix, so column 0 low lights bits 0 and 2.
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
                &[("hiV", 5.0), ("loV", 0.0), ("position", 1.0)],
            ),
            elm(
                3,
                "resistor",
                &[[64, 0], [64, 100]],
                &[("resistance", 1000.0)],
            ),
            elm(
                4,
                "resistor",
                &[[64, 32], [64, 132]],
                &[("resistance", 1000.0)],
            ),
            elm(5, "rail", &[[64, 100]], &[("maxVoltage", 5.0)]),
            elm(6, "rail", &[[64, 132]], &[("maxVoltage", 5.0)]),
            elm(
                7,
                "ledArray",
                &[[0, 0], [0, 32], [64, 0], [64, 32]],
                &[("sizeX", 2.0), ("sizeY", 2.0)],
            ),
            elm(8, "ground", &[[164, 100]], &[]),
        ],
        opts(1e-5, true),
    );
    let lit = |c: &Circuit| c.element_values()[6] as i64;
    c.run(3);
    assert_eq!(lit(c), 0b0101, "column 0 low lit the wrong cells");
    // The lit cells pull the rows down to the diode drop, so the row0 feed
    // resistor reads about 5 - 1.6 = 3.4 V across it.
    let vd = c.element_voltages()[2];
    assert!((-3.5..-3.0).contains(&vd), "row0 drop was {vd}");
    // Flip the drives: column 1 low lights the cells beside column 0.
    c.set_state(1, 1);
    c.set_state(2, 0);
    c.run(3);
    assert_eq!(lit(c), 0b1010, "column 1 low lit the wrong cells");
    // Both columns high leaves every cell dark: no cell sees its row above
    // its column, the rows sit at the rail unloaded, and the feed resistors
    // carry only the Newton convergence residual (a few tens of microvolts).
    c.set_state(2, 1);
    c.run(3);
    assert_eq!(lit(c), 0, "both columns high lit a cell");
    assert!(
        close(c.element_voltages()[2], 0.0, 1e-3),
        "an unlit row should sit at the rail, got {}",
        c.element_voltages()[2]
    );
    // Both columns low lights the whole grid.
    c.set_state(1, 0);
    c.set_state(2, 0);
    c.run(3);
    assert_eq!(lit(c), 0b1111, "both columns low did not light the grid");
}

#[test]
fn led_array_reports_real_currents_at_each_post() {
    // The grid is a diode crossbar, so the current each post exchanges with
    // its node is the sum over the cells in that row or column: each lit cell
    // carries `current` from its row post into the element and out its column
    // post. The wire-current recovery reads these through
    // `current_into_node`; without the override it would read a silent zero
    // at every post and wires sharing the grid's nodes would animate the
    // wrong current. Column 0 low lights cells (0,0) and (1,0), so column 0
    // receives their sum, each row drains exactly what its feed resistor
    // delivers, and the four post currents sum to zero.
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
                &[("hiV", 5.0), ("loV", 0.0), ("position", 1.0)],
            ),
            elm(
                3,
                "resistor",
                &[[64, 0], [64, 100]],
                &[("resistance", 1000.0)],
            ),
            elm(
                4,
                "resistor",
                &[[64, 32], [64, 132]],
                &[("resistance", 1000.0)],
            ),
            elm(5, "rail", &[[64, 100]], &[("maxVoltage", 5.0)]),
            elm(6, "rail", &[[64, 132]], &[("maxVoltage", 5.0)]),
            elm(
                7,
                "ledArray",
                &[[0, 0], [0, 32], [64, 0], [64, 32]],
                &[("sizeX", 2.0), ("sizeY", 2.0)],
            ),
            elm(8, "ground", &[[164, 100]], &[]),
        ],
        opts(1e-5, true),
    );
    c.run(3);

    // Post order within the 2x2 grid: columns 0,1 then rows 0,1 (the ledArray
    // is element 7, whose four posts start at flat offset 8).
    let posts = c.element_post_currents();
    let (col0, col1, row0, row1) = (posts[8], posts[9], posts[10], posts[11]);
    // Each row drains exactly what its feed resistor delivers into it. The
    // cell currents are the last Newton linearisation, so they carry the
    // iteration's ~1e-8 residual; 1e-7 pins the match while tolerating it.
    assert!(
        close(row0, c.element_currents()[2], 1e-7),
        "row0 post current {row0} did not match its feed {}",
        c.element_currents()[2]
    );
    assert!(
        close(row1, c.element_currents()[3], 1e-7),
        "row1 post current {row1} did not match its feed {}",
        c.element_currents()[3]
    );
    // Column 0 receives the two lit cells' current, column 1 stays dark.
    assert!(
        close(col0, -(row0 + row1), 1e-7),
        "column 0 post current {col0} did not balance the rows {}",
        -(row0 + row1)
    );
    assert!(close(col1, 0.0, 1e-9), "dark column 1 reported {col1}");
    // KCL across the grid: the four post currents sum to zero.
    assert!(
        close(col0 + col1 + row0 + row1, 0.0, 1e-7),
        "grid post currents did not sum to zero"
    );
}

#[test]
fn adc_converts_its_analog_input_into_digital_bits() {
    // A 4-bit ADC with a 5 V reference converts `trunc(15 * V(in) / V(+))`
    // clamped to [0, 15] (ADCElm.java:42-46). Truncation is deliberate:
    // rounding would break the half-flash architecture, so 2.5 V reads 7, not
    // 8. Post order is D0..D3, In, V+ (ADCElm.java:36-39); value() reports
    // the output bits as the code, bit 0 = D0.
    let code = |c: &Circuit| c.element_values()[0] as i64;
    let adc = |vin: f64| {
        build(
            vec![
                elm(
                    1,
                    "adc",
                    &[[0, 0], [0, 32], [0, 64], [0, 96], [0, 128], [0, 160]],
                    &[("bits", 4.0), ("highVoltage", 5.0)],
                ),
                elm(2, "voltage", &[[0, 200], [0, 128]], &[("maxVoltage", vin)]),
                elm(3, "ground", &[[0, 200]], &[]),
                elm(4, "voltage", &[[0, 200], [0, 160]], &[("maxVoltage", 5.0)]),
                elm(5, "ground", &[[0, 200]], &[]),
            ],
            opts(1e-5, false),
        )
    };
    for (vin, expected) in [
        (0.0, 0),  // 15 * 0.0 / 5 = 0
        (0.5, 1),  // 15 * 0.1 = 1.5, truncated to 1
        (2.5, 7),  // 15 * 0.5 = 7.5, truncated to 7, not rounded to 8
        (3.3, 9),  // 15 * 0.66 = 9.9, truncated to 9
        (5.0, 15), // 15 * 1.0 = 15
        (8.0, 15), // over-range input clamps at 15
    ] {
        let mut c = adc(vin);
        c.run(5);
        assert_eq!(
            code(&c),
            expected,
            "V(in) = {vin} V against a 5 V reference"
        );
    }
}

#[test]
fn multiplexer_routes_the_selected_data_input_to_the_output() {
    // A 4-to-1 multiplexer (bits 2): I0 driven high, I1..I3 low. With both
    // select bits low the output mirrors I0; raising S0 picks I1, S1 alone
    // picks I2 and both pick I3, so the output tracks the level of whichever
    // input the little-endian select address names. The mux is combinational,
    // so three steps after each change settle it onto the new input.
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
                &[[64, 160]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm(
                6,
                "logicInput",
                &[[96, 160]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm(
                7,
                "multiplexer",
                &[
                    [0, 0],
                    [0, 32],
                    [0, 64],
                    [0, 96],
                    [64, 160],
                    [96, 160],
                    [128, 0],
                ],
                &[("bits", 2.0), ("highVoltage", 5.0)],
            ),
            elm(
                8,
                "resistor",
                &[[128, 0], [128, 100]],
                &[("resistance", 1000.0)],
            ),
            elm(9, "ground", &[[128, 100]], &[]),
        ],
        opts(1e-5, false),
    );
    // The mux readout reports the Q level as 0 V or 5 V.
    let out = |c: &Circuit| -> f64 { c.element_values()[6] };
    c.run(3);
    assert!(
        close(out(c), 5.0, 1e-9),
        "select 00 did not route I0, read {}",
        out(c)
    );
    c.set_state(5, 1); // select 01: I1, still low
    c.run(3);
    assert!(
        close(out(c), 0.0, 1e-9),
        "select 01 did not route I1, read {}",
        out(c)
    );
    c.set_state(2, 1); // I1 goes high
    c.run(3);
    assert!(
        close(out(c), 5.0, 1e-9),
        "I1 rising did not reach the output, read {}",
        out(c)
    );
    c.set_state(5, 0);
    c.set_state(6, 1); // select 10: I2, still low
    c.run(3);
    assert!(
        close(out(c), 0.0, 1e-9),
        "select 10 did not route I2, read {}",
        out(c)
    );
    c.set_state(3, 1); // I2 goes high
    c.run(3);
    assert!(
        close(out(c), 5.0, 1e-9),
        "I2 rising did not reach the output, read {}",
        out(c)
    );
    c.set_state(5, 1); // S0 rises on top of the high S1: select 11 picks I3, still low
    c.run(3);
    assert!(
        close(out(c), 0.0, 1e-9),
        "select 11 did not route I3, read {}",
        out(c)
    );
    c.set_state(4, 1); // I3 goes high
    c.run(3);
    assert!(
        close(out(c), 5.0, 1e-9),
        "I3 rising did not reach the output, read {}",
        out(c)
    );
}

#[test]
fn demultiplexer_routes_the_data_bit_to_the_selected_output() {
    // 2 select bits and a 5 V data input: exactly the selected output reads
    // high, the idle outputs stay low, and re-selecting moves the high output.
    // Post order of the demux: Q0..Q3 on the east, S0 and S1 on the south,
    // the data input on the west, so the resistor voltages at element indices
    // 4, 6, 8, 10 are the Q0..Q3 node levels.
    let o = |c: &Circuit| -> i64 {
        let v = c.element_voltages();
        let bit = |i: usize| if v[i] > 2.5 { 1i64 } else { 0 };
        bit(4) | (bit(6) << 1) | (bit(8) << 2) | (bit(10) << 3)
    };
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
                &[[32, 160]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm(
                3,
                "logicInput",
                &[[64, 160]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm(
                4,
                "deMultiplexer",
                &[
                    [128, 0],
                    [128, 32],
                    [128, 64],
                    [128, 96],
                    [32, 160],
                    [64, 160],
                    [0, 0],
                ],
                &[("selectBits", 2.0), ("highVoltage", 5.0)],
            ),
            elm(
                5,
                "resistor",
                &[[128, 0], [128, 80]],
                &[("resistance", 1000.0)],
            ),
            elm(6, "ground", &[[128, 80]], &[]),
            elm(
                7,
                "resistor",
                &[[128, 32], [128, 112]],
                &[("resistance", 1000.0)],
            ),
            elm(8, "ground", &[[128, 112]], &[]),
            elm(
                9,
                "resistor",
                &[[128, 64], [128, 144]],
                &[("resistance", 1000.0)],
            ),
            elm(10, "ground", &[[128, 144]], &[]),
            elm(
                11,
                "resistor",
                &[[128, 96], [128, 176]],
                &[("resistance", 1000.0)],
            ),
            elm(12, "ground", &[[128, 176]], &[]),
        ],
        opts(1e-5, false),
    );
    c.run(3);
    assert_eq!(o(c), 1, "select 0 did not route the data to Q0");
    c.set_state(2, 1); // S0 high -> select 1
    c.run(3);
    assert_eq!(o(c), 2, "select 1 did not route the data to Q1");
    c.set_state(3, 1); // S1 high -> select 3
    c.run(3);
    assert_eq!(o(c), 8, "select 3 did not route the data to Q3");
    c.set_state(2, 0); // S0 low -> select 2
    c.run(3);
    assert_eq!(o(c), 4, "select 2 did not route the data to Q2");

    // FLAG_INVERT_OUTPUTS (16) idles the inactive outputs high, the 74139
    // rule. With the data input low and select 0 only Q0 reads low; moving
    // the select drops exactly the new output and the old one idles high.
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
                &[[32, 160]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm(
                3,
                "logicInput",
                &[[64, 160]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm_flags(
                4,
                "deMultiplexer",
                &[
                    [128, 0],
                    [128, 32],
                    [128, 64],
                    [128, 96],
                    [32, 160],
                    [64, 160],
                    [0, 0],
                ],
                &[("selectBits", 2.0), ("highVoltage", 5.0)],
                16,
            ),
            elm(
                5,
                "resistor",
                &[[128, 0], [128, 80]],
                &[("resistance", 1000.0)],
            ),
            elm(6, "ground", &[[128, 80]], &[]),
            elm(
                7,
                "resistor",
                &[[128, 32], [128, 112]],
                &[("resistance", 1000.0)],
            ),
            elm(8, "ground", &[[128, 112]], &[]),
            elm(
                9,
                "resistor",
                &[[128, 64], [128, 144]],
                &[("resistance", 1000.0)],
            ),
            elm(10, "ground", &[[128, 144]], &[]),
            elm(
                11,
                "resistor",
                &[[128, 96], [128, 176]],
                &[("resistance", 1000.0)],
            ),
            elm(12, "ground", &[[128, 176]], &[]),
        ],
        opts(1e-5, false),
    );
    c.run(3);
    assert_eq!(o(c), 0b1110, "inverted select 0 did not idle Q1..Q3 high");
    c.set_state(2, 1); // S0 high -> select 1
    c.run(3);
    assert_eq!(
        o(c),
        0b1101,
        "inverted select 1 did not move the low output"
    );
}

// The VCO mirrors the currents through its external R1 and R2 resistors into
// the capacitor across the C pins. With Vi = 5 V and R1 = R2 = 10k both to
// ground, the mirror current is Vi/R1 + 5/R2 = 1 mA, and the cap voltage
// integrates it, so a half-cycle swings the 4 V between the 0.5 V and 4.5 V
// comparator levels at 1 mA / 1e-7 F = 1e4 V/s: 0.4 ms, which is 40 steps at
// dt = 1e-5. Each crossing adds one or two steps of comparator dead time (the
// threshold check reads the previous step's cap voltage) and the internal 1 M
// bleeder slows the charge a couple of percent, so consecutive 2.5 V
// crossings of the output land about 41 to 43 steps apart. The output itself
// is a 0 V / 5 V source, so the sampled node swings between the two rails.
//
// The load resistor at the Vo pin is only there so the scope has a two-pin
// element to plot: its voltage diff is the Vo node voltage itself.
#[test]
fn vco_output_oscillates_at_the_control_frequency() {
    let dt = 1e-5;
    let c = &mut build_with(
        vec![
            elm(
                1,
                "vco",
                &[[0, 0], [0, 96], [48, 0], [48, 32], [48, 64], [48, 96]],
                &[],
            ),
            elm(2, "voltage", &[[0, 64], [0, 0]], &[("maxVoltage", 5.0)]),
            elm(3, "ground", &[[0, 64]], &[]),
            elm(
                4,
                "resistor",
                &[[48, 64], [48, 128]],
                &[("resistance", 10000.0)],
            ),
            elm(5, "ground", &[[48, 128]], &[]),
            elm(
                6,
                "resistor",
                &[[48, 96], [48, 160]],
                &[("resistance", 10000.0)],
            ),
            elm(7, "ground", &[[48, 160]], &[]),
            elm(
                8,
                "capacitor",
                &[[48, 0], [48, 32]],
                &[("capacitance", 1e-7), ("voltDiff", 0.0)],
            ),
            elm(
                9,
                "resistor",
                &[[0, 96], [0, 160]],
                &[("resistance", 1000.0)],
            ),
            elm(10, "ground", &[[0, 160]], &[]),
        ],
        opts(dt, false),
        vec![ScopeSpec {
            element_id: 9,
            value: ScopeValue::Voltage,
            post: 0,
            steps_per_column: 1,
            columns: 1024,
            ac_coupled: false,
            trigger: Default::default(),
            display_width: 0,
        }],
    );
    let report = c.run(800);
    assert!(
        report.converged,
        "VCO broke Newton convergence: {:?}",
        report.failing
    );
    let snap = c.scopes()[0].snapshot();
    assert!(
        snap.len() >= 1600,
        "expected a min/max column per step, got {}",
        snap.len()
    );
    // The output source drives 0 V and 5 V exactly, so the swing must reach
    // both rails and cross 2.5 V about once per half-cycle.
    let max = snap.iter().copied().fold(f32::MIN, f32::max);
    let min = snap.iter().copied().fold(f32::MAX, f32::min);
    assert!(max > 4.9, "output never reached the high rail, max {max}");
    assert!(min < 0.1, "output never reached the low rail, min {min}");
    let crossings = vco_crossing_steps(&snap);
    assert!(
        crossings.len() >= 10,
        "output did not oscillate, {} crossings in 800 steps",
        crossings.len()
    );
    // The mean gap between crossings is the half-period. The first gap spans
    // the startup ramp (the cap starts at 0 V, not at the 0.5 V comparator
    // level), so it is dropped.
    let gaps: Vec<usize> = crossings.windows(2).map(|w| w[1] - w[0]).skip(1).collect();
    let mean_gap = gaps.iter().sum::<usize>() as f64 / gaps.len() as f64;
    assert!(
        (40.0..=44.0).contains(&mean_gap),
        "mean output half-period was {mean_gap} steps, expected ~40 at 1250 Hz"
    );
}

/// The step indices where the output crosses the 2.5 V mid level, a rising or
/// falling edge. The snapshot interleaves a min/max column per step, so a
/// crossing is detected at the boundary between two steps' samples and its
/// index halves to the step number.
fn vco_crossing_steps(snap: &[f32]) -> Vec<usize> {
    let mut out = Vec::new();
    for i in 1..snap.len() {
        if (snap[i - 1] < 2.5) != (snap[i] < 2.5) {
            out.push(i / 2);
        }
    }
    out
}

// ─── LED array grid clamps ───

/// An ledArray spec carrying the given raw grid tokens. The post list stays
/// a 4-post placeholder: build_element runs before the post-count check, so
/// an out-of-range grid is rejected by name first, which is also why a
/// refused line can arrive with any posts at all.
fn led_array_raw(id: u32, size_x: f64, size_y: f64) -> ElementSpec {
    elm(
        id,
        "ledArray",
        &[[0, 0], [0, 16], [16, 0], [16, 16]],
        &[("sizeX", size_x), ("sizeY", size_y)],
    )
}

/// An ledArray spec with the full post list its grid implies, columns on
/// y = 200 then rows down x = -16, matching what the legal-build tests wire.
fn led_array_posts(id: u32, sx: usize, sy: usize, params: &[(&str, f64)]) -> ElementSpec {
    let mut posts: Vec<[i32; 2]> = (0..sx).map(|i| [(16 * i) as i32, 200]).collect();
    posts.extend((0..sy).map(|i| [-16, (16 * i) as i32]));
    ElementSpec {
        id,
        kind: "ledArray".into(),
        posts,
        params: params
            .iter()
            .map(|(k, v)| (k.to_string(), *v))
            .collect(),
        label: None,
        model: None,
        flags: 0,
    }
}

fn lone(spec: ElementSpec) -> CircuitSpec {
    CircuitSpec {
        preserve_run: false,
        elements: vec![spec],
        options: Some(opts(1e-5, false)),
        scopes: Vec::new(),
    }
}

#[test]
fn led_array_grid_over_the_dialog_maximum_is_rejected_by_name() {
    // Upstream's dialog is the only sanctioned range, setChipEditValue's
    // "must be between 2 and 16" (LEDArrayElm.java:194-216); 17 sits just
    // above the clamp and must name kind, id, dimension and value.
    let err = Circuit::new()
        .set_circuit(&lone(led_array_raw(7, 17.0, 8.0)))
        .expect_err("a 17-wide grid must be rejected");
    assert_eq!(
        err,
        "led array (id 7) grid width must be between 2 and 16, got 17"
    );
}

#[test]
fn led_array_below_the_dialog_minimum_is_rejected() {
    let err = Circuit::new()
        .set_circuit(&lone(led_array_raw(8, 1.0, 2.0)))
        .expect_err("a 1-wide grid must be rejected");
    assert!(
        err.contains("led array") && err.contains("width") && err.contains("got 1"),
        "{err}"
    );
}

#[test]
fn led_array_grid_bounds_are_inclusive() {
    // 2x2 and 16x16 are the legal extremes; both build with exactly the post
    // count the frontend derives from the same numbers, and both step.
    for &(sx, sy) in [(2usize, 2usize), (16usize, 16usize)].iter() {
        let mut c = build(
            vec![led_array_posts(
                7,
                sx,
                sy,
                &[("sizeX", sx as f64), ("sizeY", sy as f64)],
            )],
            opts(1e-5, false),
        );
        assert_eq!(
            c.element_post_currents().len(),
            sx + sy,
            "{sx}x{sy} should carry {} posts",
            sx + sy
        );
        let report = c.run(3);
        assert!(report.converged, "{sx}x{sy} failed to step");
        assert!(c.element_post_currents().iter().all(|v| v.is_finite()));
    }
}

#[test]
fn led_array_sixteen_by_sixteen_lights_every_cell_from_one_low_column_bus() {
    // The boundary-legal simulate case: all 16 columns wired into one bus a
    // logic input drives low, every row fed by its own 1k resistor from a 5 V
    // rail. Each cell then sees its row about a diode drop above its column,
    // so all 256 light and `value()` keeps the low 64 bits all set; driving
    // the bus high leaves every cell dark. The sixteen feeds are symmetric,
    // so their currents must agree to within the Newton residual, an analytic
    // check over the whole grid at once.
    //
    // Insertion order pins the flat indices: input 0, ledArray 1, then the
    // column stubs (2..18), bus segments (18..33), row feed wires (33..49),
    // feed resistors (49..65) and rails (65..81).
    let mut elements = vec![
        // The input sits directly on a bus segment endpoint, so the whole
        // column net is one driven node.
        elm(
            100,
            "logicInput",
            &[[128, 240]],
            &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
        ),
        led_array_posts(
            7,
            16,
            16,
            &[("sizeX", 16.0), ("sizeY", 16.0)],
        ),
    ];
    for i in 0..16usize {
        elements.push(elm(
            200 + i as u32,
            "wire",
            &[[(16 * i) as i32, 200], [(16 * i) as i32, 240]],
            &[],
        ));
    }
    for i in 0..15usize {
        elements.push(elm(
            300 + i as u32,
            "wire",
            &[[(16 * i) as i32, 240], [(16 * (i + 1)) as i32, 240]],
            &[],
        ));
    }
    for i in 0..16usize {
        let y = (16 * i) as i32;
        elements.push(elm(
            400 + i as u32,
            "wire",
            &[[-48, y], [-16, y]],
            &[],
        ));
        elements.push(elm(
            500 + i as u32,
            "resistor",
            &[[-80, y], [-48, y]],
            &[("resistance", 1000.0)],
        ));
        elements.push(elm(
            600 + i as u32,
            "rail",
            &[[-80, y]],
            &[("maxVoltage", 5.0)],
        ));
    }
    let c = &mut build(elements, opts(1e-5, true));
    c.run(3);
    // Cells 0..63 lit is the most `value()` can report; the rest of the
    // pattern cannot ride an f64.
    assert_eq!(
        c.element_values()[1] as u64,
        u64::MAX,
        "a low column bus must light every cell"
    );
    let currents = c.element_currents();
    for i in 0..16usize {
        let feed = currents[49 + i];
        // Identical feeds up to the per-bank Newton linearisation residual:
        // each row's sixteen junctions limit independently, so exact equality
        // is not available, but a microamp pins the symmetric behaviour.
        assert!(
            close(feed, currents[49], 1e-6),
            "row {i} fed {feed}, row 0 fed {}",
            currents[49]
        );
        // Each row drains a few milliamps from its rail through its cells,
        // the direction the diode drop sets (row above column, current
        // flowing rail to row).
        assert!(
            feed > 0.001 && feed < 0.01,
            "row {i} feed {feed} off the diode-drop scale"
        );
    }
    c.set_state(100, 1);
    c.run(3);
    assert_eq!(
        c.element_values()[1] as u64,
        0,
        "a high column bus must leave every cell dark"
    );
}

#[test]
fn led_array_zero_and_garbage_sizes_keep_the_eight_fallback() {
    // Missing params, zeros, NaN, negatives and sub-one fractions keep the
    // documented 8x8 fallback (LEDArrayElm.java:60-64), 16 posts, exactly as
    // before the clamp landed.
    let cases: Vec<(Option<f64>, Option<f64>)> = vec![
        (None, None),
        (Some(0.0), Some(0.0)),
        (Some(f64::NAN), Some(f64::NAN)),
        (Some(-4.0), Some(8.0)),
        (Some(8.0), Some(-1.0)),
        (Some(0.4), Some(8.0)),
    ];
    for (sx, sy) in cases {
        let mut e = led_array_posts(7, 8, 8, &[]);
        if let Some(x) = sx {
            e.params.insert("sizeX".into(), x);
        }
        if let Some(y) = sy {
            e.params.insert("sizeY".into(), y);
        }
        // The frontend derives 16 posts for whatever an 8x8 fallback
        // produces, so the placeholder list must say 8x8 even while the
        // tokens themselves are garbage.
        let c = build(vec![e], opts(1e-5, false));
        assert_eq!(
            c.element_post_currents().len(),
            16,
            "({sx:?}, {sy:?}) must fall back to 8x8"
        );
    }
}

#[test]
fn oversized_led_array_line_cannot_hang_the_build() {
    // A single hostile line used to attempt 1e10 cells inside LedArray::new;
    // the rejection now fires before any allocation, promptly.
    let err = Circuit::new()
        .set_circuit(&lone(led_array_raw(7, 100000.0, 100000.0)))
        .expect_err("the bomb line must be rejected");
    assert!(err.contains("led array") && err.contains("got 100000"), "{err}");
}
