//! The LED array: lit cells, post currents and the grid clamps.

use circuit_core::{Circuit, CircuitSpec, ElementSpec};

mod common;
use common::*;

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
        params: params.iter().map(|(k, v)| (k.to_string(), *v)).collect(),
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
        led_array_posts(7, 16, 16, &[("sizeX", 16.0), ("sizeY", 16.0)]),
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
    // Grouped by kind in row order so the flat index ranges pinned above
    // hold exactly: every feed wire lands in 33..49, every resistor in
    // 49..65, every rail in 65..81.
    for i in 0..16usize {
        let y = (16 * i) as i32;
        elements.push(elm(400 + i as u32, "wire", &[[-48, y], [-16, y]], &[]));
    }
    for i in 0..16usize {
        let y = (16 * i) as i32;
        elements.push(elm(
            500 + i as u32,
            "resistor",
            &[[-80, y], [-48, y]],
            &[("resistance", 1000.0)],
        ));
    }
    for i in 0..16usize {
        let y = (16 * i) as i32;
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
    assert!(
        err.contains("led array") && err.contains("got 100000"),
        "{err}"
    );
}
