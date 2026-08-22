//! Multi-bit buses: the bus-width wire, the splitter's real fan-out, the bus
//! logic input and the bus transceiver. Every assertion is against an ideal
//! analytic result, which is what catches merge and sign errors: before real
//! bus support, every wide pin at one coordinate collapsed into a single node
//! and separately-driven bits shorted together.

use circuit_core::elements::chip::FLAG_BIT_ORDER_BUS;
use circuit_core::{Circuit, CircuitSpec, ElementSpec};

mod common;
use common::*;

/// One N-wide bus wire from `(x1, y)` to `(x2, y)`, posts duplicated per bit
/// the way the frontend sends them: N copies of each endpoint, first-end bits
/// then far-end bits.
fn bus_wire(id: u32, x1: i32, x2: i32, y: i32, width: usize) -> ElementSpec {
    let mut posts = Vec::new();
    for _ in 0..width {
        posts.push([x1, y]);
    }
    for _ in 0..width {
        posts.push([x2, y]);
    }
    elm(id, "wire", &posts, &[("busWidth", width as f64)])
}

/// An N-bit bus logic input anchored at `(x, y)`: every post sits at the
/// anchor carrying its own bit (BusLogicInputElm.getPost).
fn bus_input(id: u32, x: i32, y: i32, width: usize, value: f64) -> ElementSpec {
    let posts = vec![[x, y]; width];
    elm(
        id,
        "busLogicInput",
        &posts,
        &[("busWidth", width as f64), ("value", value), ("hiV", 5.0)],
    )
}

/// A bits-wide splitter: all bus-side pins at the bus coordinate, the
/// individual pins strung out at unique coordinates.
fn splitter(id: u32, bus_x: i32, bus_y: i32, ind_x: i32, bits: usize) -> ElementSpec {
    let mut posts = vec![[bus_x, bus_y]; bits];
    for i in 0..bits {
        posts.push([ind_x, 32 * i as i32]);
    }
    elm(id, "busSplitter", &posts, &[("bits", bits as f64)])
}

/// Absolute node voltage behind one flattened terminal slot.
fn voltage_at(c: &Circuit, flat_index: usize) -> f64 {
    let nodes = c.element_nodes();
    let vn = c.node_voltages();
    vn[nodes[flat_index] as usize]
}

#[test]
fn bus_width_wire_carries_independent_bits() {
    // The alu74181 shape in miniature: a bus logic input drives a chain of
    // two bus wires, and a passive multi-bit readout sits on the far end.
    // Bit 0 is driven high and bit 1 low, and because the bits share raw
    // coordinates everywhere, any collapse back to one node shows up as both
    // readout posts reading the average. A 1 kohm load on bit 0 keeps a real
    // ground in the circuit without touching bit 1, whose ideal source needs
    // no return path.
    let c = &mut build(
        vec![
            bus_input(1, 0, 0, 2, 1.0), // bit 0 = 5 V, bit 1 = 0 V
            bus_wire(2, 0, 64, 0, 2),
            bus_wire(3, 64, 128, 0, 2),
            elm(
                4,
                "instructionDisplay",
                &[[128, 0], [128, 0]],
                &[("busWidth", 2.0), ("threshold", 2.5)],
            ),
            elm(
                5,
                "resistor",
                &[[64, 0], [64, 80]],
                &[("resistance", 1000.0)],
            ),
            elm(6, "ground", &[[64, 80]], &[]),
        ],
        opts(1e-5, false),
    );
    c.run(3);
    // Flat post offsets: driver 2 posts (0-1), wires 4 each (2-5, 6-9),
    // readout 2 posts (10-11), resistor 12-13.
    assert!(
        close(voltage_at(c, 10), 5.0, 1e-9),
        "far-end bit 0 did not carry the high level"
    );
    assert!(
        close(voltage_at(c, 11), 0.0, 1e-9),
        "far-end bit 1 did not stay low"
    );
    assert!(
        close(voltage_at(c, 0), 5.0, 1e-9),
        "driver bit 0 did not read its own level"
    );
    assert!(
        close(voltage_at(c, 1), 0.0, 1e-9),
        "driver bit 1 did not read its own level"
    );
}

#[test]
fn bus_wire_without_a_width_token_stays_one_node() {
    // The fallback for old files: no token, one electrical node, exactly as
    // the port always behaved. A splitter hanging off the plain wire gets bit
    // 0 connected and the rest left floating (gmin-pinned, effectively 0 V).
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[-64, 64], [-64, 0]], &[("maxVoltage", 5.0)]),
            elm(2, "ground", &[[-64, 64]], &[]),
            elm(3, "wire", &[[-64, 0], [64, 0]], &[]),
            splitter(4, 64, 0, 128, 2),
            elm(
                5,
                "resistor",
                &[[128, 0], [128, 64]],
                &[("resistance", 1000.0)],
            ),
            elm(6, "ground", &[[128, 64]], &[]),
            elm(
                7,
                "resistor",
                &[[128, 32], [128, 96]],
                &[("resistance", 1000.0)],
            ),
            elm(8, "ground", &[[128, 96]], &[]),
        ],
        opts(1e-5, false),
    );
    c.run(3);
    let v = c.element_voltages();
    // Resistor 5 hangs off individual pin 0, which the 0 V source ties to bus
    // bit 0: the full source voltage across it (everything is ideal).
    assert!(
        close(v[4], 5.0, 1e-9),
        "bit 0 lost the connection through the plain wire: {}",
        v[4]
    );
    // Individual pin 1 belongs to bus bit 1, which nothing drives; its only
    // load pulls it to ground.
    assert!(
        v[6].abs() < 1e-9,
        "bit 1 picked up a voltage from nowhere: {}",
        v[6]
    );
}

#[test]
fn bus_splitter_fans_out_without_shorting() {
    // The alu74181 S0-S3 pattern: four differently-driven signals enter one
    // splitter's individual pins, cross its bus side onto one 4-bit bus wire,
    // and come back out of a second splitter to four separate loads. Each
    // load reads its own drive voltage exactly, because every link in the
    // chain is ideal; a single merged bus node would drag them all toward one
    // common level.
    let drives = [1.0, 2.0, 3.0, 4.0];
    let mut elements = vec![
        splitter(1, 0, 0, 96, 4),
        bus_wire(2, 0, 192, 0, 4),
        splitter(3, 192, 0, 288, 4),
    ];
    let mut id = 4;
    for (i, &drive) in drives.iter().enumerate() {
        let y = 32 * i as i32;
        // Ideal source straight onto individual pin i of splitter 1. Post 0
        // grounds, post 1 drives, the port-wide source convention.
        elements.push(elm(
            id,
            "voltage",
            &[[48, y], [96, y]],
            &[("maxVoltage", drive)],
        ));
        id += 1;
        elements.push(elm(id, "ground", &[[48, y]], &[]));
        id += 1;
        // 1 kohm load on individual pin i of splitter 2, referenced to ground.
        elements.push(elm(
            id,
            "resistor",
            &[[288, y], [352, y]],
            &[("resistance", 1000.0)],
        ));
        id += 1;
        elements.push(elm(id, "ground", &[[352, y]], &[]));
        id += 1;
    }
    let c = &mut build(elements, opts(1e-5, false));
    c.run(3);
    let v = c.element_voltages();
    // Element order: three fixed parts, then four ids per channel (source,
    // ground, resistor, ground). Load resistors sit at indices 5, 9, 13, 17;
    // their ground end makes the voltage difference the absolute node value.
    for (i, &drive) in drives.iter().enumerate() {
        let idx = 5 + i * 4;
        assert!(
            close(v[idx], drive, 1e-9),
            "load {} read {} instead of {}",
            i,
            v[idx],
            drive
        );
    }
    // Per-bit currents stay reportable through the fan-in splitter's 0 V
    // sources: the drive enters at individual pin i (the splitter drains it)
    // and leaves at bus bit i (the splitter pushes it onto the wire).
    let p = c.element_post_currents();
    for (i, &drive) in drives.iter().enumerate() {
        let expected = drive / 1000.0;
        // Splitter 1 is element index 0: its eight flattened post entries are
        // the four bus bits then the four individual pins.
        assert!(
            close(p[i], expected, 1e-9),
            "fan-in bus bit {} injected {} not {}",
            i,
            p[i],
            expected
        );
        assert!(
            close(p[4 + i], -expected, 1e-9),
            "fan-in individual pin {} drained {} not {}",
            i,
            p[4 + i],
            -expected
        );
    }
}

#[test]
fn bus_logic_input_drives_all_bits() {
    // One part, four levels: value 0b0101 drives bits 0 and 2 high and bits 1
    // and 3 low, straight into a splitter's bus side (the shared-anchor
    // contact upstream relies on) and out to four 1 kohm loads.
    let c = &mut build(
        vec![
            bus_input(1, 0, 0, 4, 5.0),
            splitter(2, 0, 0, 96, 4),
            elm(
                3,
                "resistor",
                &[[96, 0], [160, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(4, "ground", &[[160, 0]], &[]),
            elm(
                5,
                "resistor",
                &[[96, 32], [160, 32]],
                &[("resistance", 1000.0)],
            ),
            elm(6, "ground", &[[160, 32]], &[]),
            elm(
                7,
                "resistor",
                &[[96, 64], [160, 64]],
                &[("resistance", 1000.0)],
            ),
            elm(8, "ground", &[[160, 64]], &[]),
            elm(
                9,
                "resistor",
                &[[96, 96], [160, 96]],
                &[("resistance", 1000.0)],
            ),
            elm(10, "ground", &[[160, 96]], &[]),
        ],
        opts(1e-5, false),
    );
    c.run(3);
    let v = c.element_voltages();
    let expect = [5.0, 0.0, 5.0, 0.0];
    for (i, &level) in expect.iter().enumerate() {
        // Resistors are element indices 2, 4, 6, 8; their grounded far end
        // makes the difference the absolute level.
        assert!(
            close(v[2 + i * 2], level, 1e-9),
            "load {} read {} instead of {}",
            i,
            v[2 + i * 2],
            level
        );
    }
    // The driver's per-bit source currents equal what each load pulls: 5 mA
    // delivered on the high bits, nothing on the low ones. The driver is
    // element index 0, so its posts are the first four entries.
    let p = c.element_post_currents();
    for (i, &level) in expect.iter().enumerate() {
        let expected = level / 1000.0;
        assert!(
            close(p[i], expected, 1e-9),
            "driver bit {} reported {} not {}",
            i,
            p[i],
            expected
        );
    }
}

#[test]
fn bus_transceiver_isolates_when_disabled() {
    // One bit, A to B, B terminated in 1 kohm. With OE high the destination
    // coupling is 1e10 ohm, so B sits within a microvolt of ground even while
    // A is held high; with OE low the 1 ohm coupling divides the internal
    // 5 V against the load and B reads 5 * 1000/1001.
    let make = |oe_high: bool| {
        build(
            vec![
                // OE: post 1 drives the pin (the port-wide source convention).
                elm(
                    1,
                    "voltage",
                    &[[-64, -64], [-64, 0]],
                    &[("maxVoltage", if oe_high { 5.0 } else { 0.0 })],
                ),
                elm(2, "ground", &[[-64, -64]], &[]),
                // DIR high: A drives B.
                elm(
                    3,
                    "voltage",
                    &[[-64, 128], [-64, 64]],
                    &[("maxVoltage", 5.0)],
                ),
                elm(4, "ground", &[[-64, 128]], &[]),
                // A held high.
                elm(
                    5,
                    "voltage",
                    &[[-64, -192], [-64, -128]],
                    &[("maxVoltage", 5.0)],
                ),
                elm(6, "ground", &[[-64, -192]], &[]),
                elm(
                    7,
                    "busTransceiver",
                    &[
                        [-64, 0],    // OE
                        [-64, 64],   // DIR
                        [-64, -128], // A
                        [64, -128],  // B
                    ],
                    &[("dataBits", 1.0), ("highVoltage", 5.0)],
                ),
                elm(
                    8,
                    "resistor",
                    &[[64, -128], [64, -64]],
                    &[("resistance", 1000.0)],
                ),
                elm(9, "ground", &[[64, -64]], &[]),
            ],
            opts(1e-5, true),
        )
    };

    let disabled = &mut make(true);
    disabled.run(30);
    let v = disabled.element_voltages();
    // The load resistor is element index 7; its grounded end makes the
    // difference the absolute B voltage.
    assert!(
        close(v[7], 0.0, 1e-4),
        "disabled output did not isolate: {}",
        v[7]
    );

    let enabled = &mut make(false);
    enabled.run(30);
    let v = enabled.element_voltages();
    assert!(
        close(v[7], 5.0 * 1000.0 / 1001.0, 1e-6),
        "enabled output did not follow A: {}",
        v[7]
    );
}

// ─── Bus-mode chips (BIT_ORDER_BUS, ChipElm.java:35-37) ───

/// A 2-bit counter in bus mode, upstream's td4 shape: both Q pins share one
/// coordinate and both I pins another, told apart only by the engine's
/// per-post bit tags. Pin order is Q1, Q0, I1, I0, clk, clr, enp, rco, load,
/// ent; the control pins sit on distinct coordinates.
fn bus_counter(id: u32, msb_state: f64, lsb_state: f64) -> ElementSpec {
    let mut e = elm(
        id,
        "counter2",
        &[
            [96, 32],  // 0 Q1, bit 1
            [96, 32],  // 1 Q0, bit 0
            [0, 32],   // 2 I1, bit 1
            [0, 32],   // 3 I0, bit 0
            [0, 0],    // 4 clk
            [0, 64],   // 5 clr
            [0, 96],   // 6 enp
            [160, 0],  // 7 rco
            [160, 64], // 8 load
            [160, 96], // 9 ent
        ],
        &[
            ("bits", 2.0),
            ("modulus", 0.0),
            ("highVoltage", 5.0),
            ("voltage0", msb_state),
            ("voltage1", lsb_state),
        ],
    );
    e.flags = FLAG_BIT_ORDER_BUS;
    e
}

#[test]
fn bus_mode_counter_keeps_its_collapsed_output_pins_distinct() {
    // The minimal td4 failure in miniature: a bus-mode counter whose two Q
    // sources share one coordinate, a 2-wide wire out of it and a splitter
    // fanning the bits onto individual loads. The stored state is 0b10, so
    // bit 1 must read exactly 5 V and bit 0 exactly 0 V through their loads.
    // Without the per-post bit tags both sources collapse onto one node,
    // short each other and the build fails as singular, which is precisely
    // how td4.txt failed before the conversion carried the bit order.
    let c = &mut build(
        vec![
            bus_counter(1, 5.0, 0.0),
            bus_wire(2, 96, 224, 32, 2),
            splitter(3, 224, 32, 288, 2),
            elm(
                4,
                "resistor",
                &[[288, 0], [288, 100]],
                &[("resistance", 1000.0)],
            ),
            elm(5, "ground", &[[288, 100]], &[]),
            elm(
                6,
                "resistor",
                &[[288, 32], [288, 132]],
                &[("resistance", 1000.0)],
            ),
            elm(7, "ground", &[[288, 132]], &[]),
            // Hold the active-low CLR high: a floating clear pin would wipe
            // the preloaded state on the first executed step.
            elm(
                8,
                "logicInput",
                &[[0, 64]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 1.0)],
            ),
        ],
        opts(5e-6, false),
    );
    c.run(3);
    let nodes = c.element_nodes();
    let vn = c.node_voltages();
    // Splitter individual pins: post bits+0 is bit 0's fan-out at flat index
    // 14 + 2 + 0 (counter has 10 posts, the wire 4), post bits+1 is bit 1's.
    assert!(
        close(vn[nodes[16] as usize], 0.0, 1e-9),
        "bit 0 load should read 0 V"
    );
    assert!(
        close(vn[nodes[17] as usize], 5.0, 1e-9),
        "bit 1 load should read 5 V"
    );
}

#[test]
fn a_non_bus_counter_still_shorts_coincident_outputs_loudly() {
    // The mirror-image control: the same collapsed geometry without the bus
    // tag must stay a hard short of two ideal sources, because that is what
    // a non-bus file with overlapping output pins genuinely is. A grounded
    // load far away keeps the auto-reference off the Q net, so the shorted
    // sources really are two identical constraint rows. This is what keeps
    // the fix from silently absorbing real source conflicts.
    let mut bad = bus_counter(1, 5.0, 0.0);
    bad.flags = 0;
    let spec = CircuitSpec {
        preserve_run: false,
        elements: vec![
            bad,
            elm(
                9,
                "resistor",
                &[[160, 0], [160, 100]],
                &[("resistance", 1000.0)],
            ),
            elm(10, "ground", &[[160, 100]], &[]),
        ],
        options: Some(opts(5e-6, false)),
        scopes: Vec::new(),
    };
    let mut c = Circuit::new();
    let build_err = c.set_circuit(&spec).err();
    let run_err = if build_err.is_some() {
        None
    } else {
        c.run(1).error
    };
    assert!(
        build_err.is_some() || run_err.is_some(),
        "two coincident ideal outputs without bus tags must be singular"
    );
}

#[test]
fn bus_mode_full_adder_sums_through_its_shared_pin_groups() {
    // A bus-mode 2-bit adder: the A bank, B bank and S bank each live on one
    // coordinate, driven or read through bus logic inputs and a splitter.
    // 01 + 01 = 0b10, so S bit 0 reads 0 V, S bit 1 reads 5 V and the carry
    // stays low.
    let c = &mut build(
        vec![
            // A = 0b01 anchored right on the adder's A coordinate.
            bus_input(1, 64, 0, 2, 1.0),
            // B = 0b01 on the B coordinate.
            bus_input(2, 64, 32, 2, 1.0),
            elm_flags(
                3,
                "fullAdder",
                &[
                    [64, 0], // A bank: both pins here, tagged per bit
                    [64, 0],
                    [64, 32], // B bank
                    [64, 32],
                    [160, 32], // S bank
                    [160, 32],
                    [64, 96], // Cin, left low
                    [160, 0], // C out
                ],
                &[("bits", 2.0), ("highVoltage", 5.0)],
                2 | FLAG_BIT_ORDER_BUS,
            ),
            bus_wire(4, 160, 224, 32, 2),
            splitter(5, 224, 32, 288, 2),
            elm(
                6,
                "resistor",
                &[[288, 0], [288, 100]],
                &[("resistance", 1000.0)],
            ),
            elm(7, "ground", &[[288, 100]], &[]),
            elm(
                8,
                "resistor",
                &[[288, 32], [288, 132]],
                &[("resistance", 1000.0)],
            ),
            elm(9, "ground", &[[288, 132]], &[]),
            elm(
                10,
                "resistor",
                &[[160, 0], [160, 100]],
                &[("resistance", 1000.0)],
            ),
            elm(11, "ground", &[[160, 100]], &[]),
        ],
        opts(5e-6, false),
    );
    c.run(3);
    let nodes = c.element_nodes();
    let vn = c.node_voltages();
    // Flats: bli 0-1, bli 2-3, fullAdder 4-11, wire 12-15, splitter 16-19;
    // individual pin for bit k sits at 16 + 2 + k, the carry at 11.
    assert!(
        close(vn[nodes[18] as usize], 0.0, 1e-9),
        "S bit 0 should read 0 V"
    );
    assert!(
        close(vn[nodes[19] as usize], 5.0, 1e-9),
        "S bit 1 should read 5 V"
    );
    assert!(
        close(vn[nodes[11] as usize], 0.0, 1e-9),
        "carry out should read 0 V"
    );
}

#[test]
fn bus_mode_rom_decodes_address_and_drives_its_data_bus() {
    // A bus-mode ROM with 2 address bits and 2 data bits, address 0b01
    // holding 0b10: OE low enables the output, the data bank shares one
    // coordinate, and the splitter's individual pins must read exactly
    // D0 = 0 V and D1 = 5 V.
    let mut rom = elm(
        1,
        "rom",
        &[
            [0, 0],    // OE
            [0, 32],   // A1, bit 1
            [0, 32],   // A0, bit 0
            [160, 32], // D1, bit 1
            [160, 32], // D0, bit 0
        ],
        &[
            ("addressBits", 2.0),
            ("dataBits", 2.0),
            ("addr0", 1.0),
            ("val0", 2.0),
        ],
    );
    rom.flags = FLAG_BIT_ORDER_BUS;
    let c = &mut build(
        vec![
            rom,
            bus_input(2, 0, 32, 2, 1.0), // address 0b01
            elm(3, "ground", &[[0, 0]], &[]),
            bus_wire(4, 160, 224, 32, 2),
            splitter(5, 224, 32, 288, 2),
            elm(
                6,
                "resistor",
                &[[288, 0], [288, 100]],
                &[("resistance", 1000.0)],
            ),
            elm(7, "ground", &[[288, 100]], &[]),
            elm(
                8,
                "resistor",
                &[[288, 32], [288, 132]],
                &[("resistance", 1000.0)],
            ),
            elm(9, "ground", &[[288, 132]], &[]),
        ],
        opts(5e-6, true),
    );
    c.run(3);
    let nodes = c.element_nodes();
    let vn = c.node_voltages();
    // Flats: rom 0-4, bli 5-6, ground 7, wire 8-11, splitter 12-15;
    // individual pin for bit k sits at 12 + 2 + k.
    assert!(
        close(vn[nodes[14] as usize], 0.0, 1e-6),
        "D0 should read 0 V"
    );
    assert!(
        close(vn[nodes[15] as usize], 5.0 * 1000.0 / 1001.0, 1e-6),
        "D1 should read 5 V through its 1 ohm coupling"
    );
}

// ─── Labeled nodes on buses (LabeledNodeElm.java:126-140) ───

/// An N-bit labeled node anchored at `(x, y)`: every post sits at the anchor
/// carrying its own bit, exactly like the bus logic input's posts. `busWidth`
/// is what the frontend's width resolver injects; the text format itself
/// never saves a width token.
fn labeled(id: u32, x: i32, y: i32, width: usize, text: &str) -> ElementSpec {
    let posts = vec![[x, y]; width];
    let mut e = elm(id, "labeledNode", &posts, &[("busWidth", width as f64)]);
    e.label = Some(text.into());
    e
}

#[test]
fn labeled_node_joins_two_buses_per_bit() {
    // Two 2-bit banks joined ONLY by two labels sharing one text. The driver
    // holds 0b01 with hiV 5 and loV 3, so bit 0 carries 5 V and bit 1 carries
    // 3 V, deliberately two distinguishable levels: had the label carried only
    // bit 0 across (the old behaviour), far bit 1 would sit on nothing and
    // float to its gmin pin instead of reading exactly 3 V.
    let c = &mut build(
        vec![
            elm(
                1,
                "busLogicInput",
                &[[0, 0]; 2],
                &[
                    ("busWidth", 2.0),
                    ("value", 1.0),
                    ("hiV", 5.0),
                    ("loV", 3.0),
                ],
            ),
            labeled(2, 0, 0, 2, "A"),
            labeled(3, 128, 64, 2, "A"),
            splitter(4, 128, 64, 224, 2),
            elm(
                5,
                "resistor",
                &[[224, 0], [288, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(6, "ground", &[[288, 0]], &[]),
            elm(
                7,
                "resistor",
                &[[224, 32], [288, 32]],
                &[("resistance", 1000.0)],
            ),
            elm(8, "ground", &[[288, 32]], &[]),
        ],
        opts(1e-5, false),
    );
    c.run(3);
    let v = c.element_voltages();
    // Element order: driver, two labels, splitter, then load/ground pairs, so
    // the loads sit at indices 4 and 6; each is grounded at its far end.
    assert!(close(v[4], 5.0, 1e-9), "far bit 0 read {} not 5", v[4]);
    assert!(close(v[6], 3.0, 1e-9), "far bit 1 read {} not 3", v[6]);
    // The labels themselves read out their bit-0 level, upstream's
    // getVoltageDiff returns volts[0] (LabeledNodeElm.java:243), never a
    // bit-to-bit difference. The near label is index 1, the far one index 2.
    assert!(
        close(v[1], 5.0, 1e-9),
        "near label readout was {} not 5",
        v[1]
    );
    assert!(
        close(v[2], 5.0, 1e-9),
        "far label readout was {} not 5",
        v[2]
    );
}

#[test]
fn narrow_and_wide_labels_with_one_text_stay_apart() {
    // Upstream writes two disjoint closure-key namespaces, `label:text` and
    // `label:text:b` (LabeledNodeElm.java:137-140), so a single-post label
    // named A and a 2-post label named A are different nets. If they merged,
    // the 5 V ideal source below would fight the driver's 4 V bit-0 source
    // and the build would fail as singular.
    let spec = CircuitSpec {
        preserve_run: false,
        elements: vec![
            elm(1, "voltage", &[[-160, 0], [-96, 0]], &[("maxVoltage", 5.0)]),
            elm(2, "ground", &[[-160, 0]], &[]),
            labeled(3, -96, 0, 1, "A"),
            elm(
                4,
                "busLogicInput",
                &[[96, 32]; 2],
                &[
                    ("busWidth", 2.0),
                    ("value", 1.0),
                    ("hiV", 4.0),
                    ("loV", 1.0),
                ],
            ),
            labeled(5, 96, 32, 2, "A"),
        ],
        options: Some(opts(1e-5, false)),
        scopes: Vec::new(),
    };

    let c = &mut Circuit::new();
    c.set_circuit(&spec)
        .expect("narrow and wide A must not merge");
    c.run(3);
    // Flat slots: source 0-1, ground 2, narrow label 3, driver 4-5, wide
    // label 6-7. Each side holds its own levels exactly.
    assert!(close(voltage_at(c, 3), 5.0, 1e-9), "narrow A lost its net");
    assert!(close(voltage_at(c, 6), 4.0, 1e-9), "wide A bit 0 drifted");
    assert!(close(voltage_at(c, 7), 1.0, 1e-9), "wide A bit 1 drifted");
}

#[test]
fn wide_label_meets_a_plain_wire_only_at_bit_0() {
    // The everyday drawing: a plain single-bit wire runs into a wide label's
    // anchor. Bit 0 must join the wire, bit 1 must stay off it, which is what
    // the (coordinate, bit) merge gives once the label presents real per-bit
    // posts.
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[-160, 0], [-96, 0]], &[("maxVoltage", 2.5)]),
            elm(2, "ground", &[[-160, 0]], &[]),
            elm(3, "wire", &[[-96, 0], [0, 0]], &[]),
            labeled(4, 0, 0, 2, "B"),
            // Only bit 0 has a return path, so bit 1 floats to ~0 V while the
            // wire side reads the full 2.5 V.
            elm(5, "resistor", &[[0, 0], [0, 64]], &[("resistance", 1000.0)]),
            elm(6, "ground", &[[0, 64]], &[]),
        ],
        opts(1e-5, false),
    );
    c.run(3);
    let nodes = c.element_nodes();
    let vn = c.node_voltages();
    // Flats: source 0-1, ground 2, wire 3-4, label 5-6, load 7-8.
    assert!(
        close(vn[nodes[5] as usize], 2.5, 1e-9),
        "label bit 0 did not join the wire"
    );
    assert!(
        vn[nodes[6] as usize].abs() < 1e-6,
        "label bit 1 leaked onto the plain wire: {}",
        vn[nodes[6] as usize]
    );
}
