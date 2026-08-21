//! Multi-bit buses: the bus-width wire, the splitter's real fan-out, the bus
//! logic input and the bus transceiver. Every assertion is against an ideal
//! analytic result, which is what catches merge and sign errors: before real
//! bus support, every wide pin at one coordinate collapsed into a single node
//! and separately-driven bits shorted together.

use circuit_core::{Circuit, ElementSpec};

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
