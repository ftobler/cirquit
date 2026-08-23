//! The bus/bus multiplexer input mode (INPUT_MODE_BUS_BUS,
//! MultiplexerElm.java:87-150, :278-287): the west side is `outputCount`
//! buses of `dataBusWidth` bits, the east side one `dataBusWidth`-wide output
//! bus. Every assertion checks the routed byte against the selected input
//! group. The deferred bus/bit mode (im=1) is covered only as a negative
//! control: the engine treats it exactly like mode 0.

use std::collections::HashMap;

use circuit_core::elements::build_element;
use circuit_core::{Circuit, CircuitSpec, ElementSpec};

mod common;
use common::*;

/// Number of posts the bus/bus mux exposes before the output bus, used to find
/// the flat offset of the output bus in `element_nodes()`.
fn bus_mux_output_pin(select_bits: usize, data_width: usize) -> usize {
    (1 << select_bits) * data_width + select_bits
}

/// Builds a bus/bus mux (kind "multiplexer", inputMode 2) with one bus logic
/// input driving each input group and one logic input driving each select
/// bit. The mux is element 1, so its flat post offset in `element_nodes()` is
/// 0. `flags` carries FLAG_INVERTED_OUTPUT (2) and FLAG_STROBE (4); the strobe
/// driver is held low unless `strobe_high` is set.
fn bus_mux(
    select_bits: usize,
    data_width: usize,
    flags: i64,
    group_values: &[u32],
    select: u32,
    strobe_high: bool,
) -> Circuit {
    let output_count = 1 << select_bits;
    let mut posts: Vec<[i32; 2]> = Vec::new();
    // Input buses: group g sits at (0, 32*g), its data_width bits share the
    // coordinate and differ only by bus index.
    for g in 0..output_count {
        for _i in 0..data_width {
            posts.push([0, 32 * g as i32]);
        }
    }
    // Select bits on the south.
    for s in 0..select_bits {
        posts.push([64 + 32 * s as i32, 160]);
    }
    // Output bus on the east.
    for i in 0..data_width {
        posts.push([128, 32 * i as i32]);
    }
    if flags & 2 != 0 {
        for i in 0..data_width {
            posts.push([160, 32 * i as i32]);
        }
    }
    if flags & 4 != 0 {
        posts.push([64, 192]);
    }
    let mut mux = elm_flags(1, "multiplexer", &posts, &[], flags);
    mux.params.insert("inputMode".into(), 2.0);
    mux.params.insert("dataBusWidth".into(), data_width as f64);
    mux.params.insert("bits".into(), select_bits as f64);
    mux.params.insert("highVoltage".into(), 5.0);
    let mut elements: Vec<ElementSpec> = vec![mux];

    let mut id = 2;
    for (g, &val) in group_values.iter().enumerate().take(output_count) {
        let gp = vec![[0, 32 * g as i32]; data_width];
        let mut e = elm(id, "busLogicInput", &gp, &[]);
        e.params.insert("busWidth".into(), data_width as f64);
        e.params.insert("value".into(), val as f64);
        e.params.insert("hiV".into(), 5.0);
        e.params.insert("loV".into(), 0.0);
        elements.push(e);
        id += 1;
    }
    for s in 0..select_bits {
        let sp = vec![[64 + 32 * s as i32, 160]];
        let mut e = elm(id, "logicInput", &sp, &[]);
        e.params.insert("hiV".into(), 5.0);
        e.params.insert("loV".into(), 0.0);
        e.params
            .insert("position".into(), ((select >> s) & 1) as f64);
        elements.push(e);
        id += 1;
    }
    if flags & 4 != 0 {
        let sp = vec![[64, 192]];
        let mut e = elm(id, "logicInput", &sp, &[]);
        e.params.insert("hiV".into(), 5.0);
        e.params.insert("loV".into(), 0.0);
        e.params
            .insert("position".into(), (strobe_high as u8) as f64);
        elements.push(e);
    }

    let spec = CircuitSpec {
        preserve_run: false,
        elements,
        options: Some(opts(1e-5, false)),
        scopes: Vec::new(),
    };
    let mut c = Circuit::new();
    c.set_circuit(&spec)
        .expect("bus/bus mux circuit should analyse");
    c.run(3);
    c
}

/// Node voltage behind the mux's output bit `i` (the mux is element 1, so the
/// flat offset is 0).
fn out_voltage(c: &Circuit, select_bits: usize, data_width: usize, i: usize) -> f64 {
    let nodes = c.element_nodes();
    let vn = c.node_voltages();
    let off = bus_mux_output_pin(select_bits, data_width) + i;
    vn[nodes[off] as usize]
}

#[test]
fn bus_bus_mux_routes_the_selected_group_to_the_output_bus() {
    // The td4 shape: 2 select bits, 4-bit data buses, four groups. Group 3
    // carries 0b1011; the other groups carry different words so a wrong select
    // would show. Selecting group 3 must copy its four bits onto the four
    // output bits.
    let groups = [0b0001u32, 0b0010, 0b0100, 0b1011];
    let c = bus_mux(2, 4, 0, &groups, 3, false);
    assert!(
        close(out_voltage(&c, 2, 4, 0), 5.0, 1e-6),
        "output bit 0 should be high (0b1011)"
    );
    assert!(
        close(out_voltage(&c, 2, 4, 1), 5.0, 1e-6),
        "output bit 1 should be high (0b1011)"
    );
    assert!(
        close(out_voltage(&c, 2, 4, 2), 0.0, 1e-6),
        "output bit 2 should be low (0b1011)"
    );
    assert!(
        close(out_voltage(&c, 2, 4, 3), 5.0, 1e-6),
        "output bit 3 should be high (0b1011)"
    );
}

#[test]
fn bus_bus_mux_select_bits_choose_the_group() {
    // Changing the select lines must re-route to the new group without
    // rebuilding: group 0 holds 0b1111 and group 2 holds 0b0000.
    let groups = [0b1111u32, 0b0011, 0b0000, 0b0101];
    let mut c = bus_mux(2, 4, 0, &groups, 0, false);
    for i in 0..4 {
        assert!(
            close(out_voltage(&c, 2, 4, i), 5.0, 1e-6),
            "select 0 should route group 0 (all high)"
        );
    }
    // Re-select group 2 by flipping the select drivers.
    c.set_state(6, 0); // S0 low
    c.set_state(7, 1); // S1 high -> 0b10 = 2
    c.run(3);
    for i in 0..4 {
        assert!(
            close(out_voltage(&c, 2, 4, i), 0.0, 1e-6),
            "select 2 should route group 2 (all low)"
        );
    }
}

#[test]
fn bus_bus_mux_strobe_forces_the_output_bus_low() {
    // A high strobe overrides the data and drives every output bit low
    // (MultiplexerElm.java:279-283).
    let groups = [0b1111u32, 0b1111, 0b1111, 0b1111];
    let c = bus_mux(2, 4, 4, &groups, 3, true);
    for i in 0..4 {
        assert!(
            close(out_voltage(&c, 2, 4, i), 0.0, 1e-6),
            "strobe high must force output bit {i} low"
        );
    }
}

#[test]
fn bus_bus_mux_inverted_output_mirrors_each_bit() {
    // FLAG_INVERTED_OUTPUT adds a second dataBusWidth-wide bus whose every bit
    // is the complement of the main output (MultiplexerElm.java:284-287).
    let groups = [0b0101u32, 0b0000, 0b0000, 0b1010];
    let c = bus_mux(2, 4, 2, &groups, 3, false);
    // Main output reads group 3 = 0b1010.
    assert!(
        close(out_voltage(&c, 2, 4, 0), 0.0, 1e-6),
        "main output bit 0 low (0b1010)"
    );
    assert!(
        close(out_voltage(&c, 2, 4, 1), 5.0, 1e-6),
        "main output bit 1 high (0b1010)"
    );
    assert!(
        close(out_voltage(&c, 2, 4, 2), 0.0, 1e-6),
        "main output bit 2 low (0b1010)"
    );
    assert!(
        close(out_voltage(&c, 2, 4, 3), 5.0, 1e-6),
        "main output bit 3 high (0b1010)"
    );
    // Inverted bus sits at the inverted offset: output_pin + dataBusWidth + i.
    let nodes = c.element_nodes();
    let vn = c.node_voltages();
    let off = bus_mux_output_pin(2, 4) + 4;
    for i in 0..4 {
        let expect = if (0b1010 >> i) & 1 == 1 { 0.0 } else { 5.0 };
        assert!(
            close(vn[nodes[off + i] as usize], expect, 1e-6),
            "inverted bit {i} should mirror the main output"
        );
    }
}

#[test]
fn bus_bus_mux_value_returns_the_routed_integer() {
    // A Q scope plots `value()`: in bus/bus mode that is the whole output bus
    // reassembled into one integer.
    let groups = [0u32, 0, 0, 0b1101];
    let c = bus_mux(2, 4, 0, &groups, 3, false);
    assert!(
        close(c.element_values()[0], 0b1101 as f64, 1e-9),
        "value() should report the routed byte 0b1101"
    );
}

#[test]
fn bus_bus_mux_matches_upstream_post_and_source_counts() {
    // getPostCount / getVoltageSourceCount for bus/bus
    // (MultiplexerElm.java:247-263): outputCount*dataBusWidth + select +
    // dataBusWidth (+ dataBusWidth inverted) (+ strobe).
    let spec = |flags: i64| {
        let posts = vec![[0, 0]; 22];
        ElementSpec {
            id: 1,
            kind: "multiplexer".into(),
            posts,
            params: HashMap::from([
                ("inputMode".into(), 2.0),
                ("dataBusWidth".into(), 4.0),
                ("bits".into(), 2.0),
                ("highVoltage".into(), 5.0),
            ]),
            label: None,
            model: None,
            flags,
        }
    };
    let mux = build_element(&spec(0)).expect("bus/bus mux builds");
    assert_eq!(mux.post_count(), 16 + 2 + 4);
    assert_eq!(mux.voltage_source_count(), 4);
    let mi = build_element(&spec(2)).expect("bus/bus mux with inverted builds");
    assert_eq!(mi.post_count(), 16 + 2 + 4 + 4);
    assert_eq!(mi.voltage_source_count(), 8);
}

#[test]
fn mode_zero_mux_still_routes_one_selected_input() {
    // Negative control: with no inputMode param the engine must behave exactly
    // as the individual-inputs layout did before this feature. A 2-select-bit
    // mux routes the single selected data input (0/5 V) to the single output.
    let posts = vec![
        [0, 0],    // I0
        [0, 32],   // I1
        [0, 64],   // I2
        [0, 96],   // I3
        [64, 160], // S0
        [96, 160], // S1
        [128, 0],  // Q
    ];
    let mut elements: Vec<ElementSpec> = Vec::new();
    for (i, v) in [(0u32, 5.0), (1, 0.0), (2, 5.0), (3, 0.0)] {
        let mut e = elm(i + 1, "logicInput", &[posts[i as usize]], &[]);
        e.params.insert("hiV".into(), 5.0);
        e.params.insert("loV".into(), 0.0);
        e.params.insert("position".into(), v / 5.0);
        elements.push(e);
    }
    let mut mux = elm_flags(5, "multiplexer", &posts, &[], 0);
    mux.params.insert("bits".into(), 2.0);
    mux.params.insert("highVoltage".into(), 5.0);
    elements.push(mux);
    // Selects: S0 high, S1 low -> select 1.
    let mut s0 = elm(6, "logicInput", &[posts[4]], &[]);
    s0.params.insert("hiV".into(), 5.0);
    s0.params.insert("loV".into(), 0.0);
    s0.params.insert("position".into(), 1.0);
    elements.push(s0);
    let mut s1 = elm(7, "logicInput", &[posts[5]], &[]);
    s1.params.insert("hiV".into(), 5.0);
    s1.params.insert("loV".into(), 0.0);
    s1.params.insert("position".into(), 0.0);
    elements.push(s1);

    let spec = CircuitSpec {
        preserve_run: false,
        elements,
        options: Some(opts(1e-5, false)),
        scopes: Vec::new(),
    };
    let mut c = Circuit::new();
    c.set_circuit(&spec).expect("mode 0 mux should analyse");
    c.run(3);
    // Output is post 6 of the mux element (element 5, index 4). The flat post
    // offset is the 4 logic-input posts (4) plus 6 = 10.
    let nodes = c.element_nodes();
    let vn = c.node_voltages();
    assert!(
        close(vn[nodes[10] as usize], 0.0, 1e-6),
        "mode 0 select 01 should route I1 (0 V)"
    );
}
