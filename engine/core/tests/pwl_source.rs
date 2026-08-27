//! End-to-end check that a PWL-valued source drives a node along its
//! breakpoint table. The engine has no standalone PWL voltage source element;
//! the piecewise-linear `pwl` expression (expr.rs) is reachable only through
//! the expression-driven controlled sources, which feed `t` into the
//! evaluator each step. A VCVS with an expression `pwl(t, ...)` is therefore
//! a PWL voltage source, and a VCCS the current-source analogue. This test
//! pins that path so a regression in either the `pwl` evaluator or the
//! time coupling of the controlled sources shows up.

use circuit_core::ScopeValue;

mod common;
use common::*;

/// Reference piecewise-linear interpolation matching `Expr.pwl`
/// (Expr.java:154-175): clamps below the first abscissa and above the last,
/// and linearly interpolates between.
fn pwl_ref(x: f64, table: &[(f64, f64)]) -> f64 {
    if x <= table[0].0 {
        return table[0].1;
    }
    let n = table.len();
    if x >= table[n - 1].0 {
        return table[n - 1].1;
    }
    for i in 0..n - 1 {
        let (a, b) = (table[i], table[i + 1]);
        if x >= a.0 && x <= b.0 {
            let frac = (x - a.0) / (b.0 - a.0);
            return a.1 + frac * (b.1 - a.1);
        }
    }
    table[n - 1].1
}

// Breakpoints (seconds, volts) the source must track. Chosen so integer
// multiples of the 0.1 s step land exactly on breakpoints.
const TABLE: &[(f64, f64)] = &[(0.0, 0.0), (1.0, 5.0), (2.0, 2.0), (3.0, 4.0)];

fn pwl_label() -> String {
    // `pwl(t, x0,y0, x1,y1, ...)`: the evaluator substitutes the simulation
    // time for `t` in the controlled sources (vcvs.rs, vccs.rs).
    let mut s = String::from("pwl(t");
    for (x, y) in TABLE {
        s.push_str(&format!(", {}, {}", x, y));
    }
    s.push(')');
    s
}

#[test]
fn pwl_voltage_source_drives_node_along_breakpoints() {
    // A VCVS whose output value is `pwl(t, ...)`. Its input pair is tied to
    // ground (the expression ignores it); the output pair spans a load
    // resistor to ground, so the V+ node voltage equals the PWL value.
    let dt = 0.1;
    let c = &mut build_with(
        vec![
            elm_expr(
                1,
                "vcvs",
                &[[0, 0], [0, 100], [100, 100]],
                1.0,
                &pwl_label(),
            ),
            elm(
                2,
                "resistor",
                &[[0, 100], [0, 200]],
                &[("resistance", 1000.0)],
            ),
            elm(3, "ground", &[[0, 200]], &[]),
            elm(4, "ground", &[[0, 0]], &[]),
            elm(5, "ground", &[[100, 100]], &[]),
        ],
        opts(dt, false),
        vec![tr_scope(1, ScopeValue::NodeVoltage, 1)],
    );

    // Step through the table twice over and compare the measured V+ node
    // voltage against the reference at the reported simulation time.
    let steps = 64;
    for _ in 0..steps {
        c.run(1);
        let t = c.time();
        // Past the last breakpoint the PWL holds its final value.
        let expected = if t > TABLE.last().unwrap().0 {
            TABLE.last().unwrap().1
        } else {
            pwl_ref(t, TABLE)
        };
        let measured = last_sample(c, 0);
        assert!(
            close(measured, expected, 1e-6),
            "t={t}: PWL voltage source gave {measured}, expected {expected}"
        );
    }
}

#[test]
fn pwl_current_source_drives_node_along_breakpoints() {
    // The current-source analogue: a VCCS whose expression is `pwl(t, ...)`
    // delivers a current that, through a 1 ohm load, raises the C+ node to
    // `pwl(t, ...) * 1` above the grounded C-.
    let dt = 0.1;
    let c = &mut build_with(
        vec![
            elm_expr(
                1,
                "vccs",
                &[[0, 0], [0, 100], [100, 100]],
                1.0,
                &pwl_label(),
            ),
            elm(2, "resistor", &[[0, 100], [0, 200]], &[("resistance", 1.0)]),
            elm(3, "ground", &[[0, 200]], &[]),
            elm(4, "ground", &[[0, 0]], &[]),
            elm(5, "ground", &[[100, 100]], &[]),
        ],
        opts(dt, false),
        vec![tr_scope(1, ScopeValue::NodeVoltage, 1)],
    );

    let steps = 64;
    for _ in 0..steps {
        c.run(1);
        let t = c.time();
        let expected = if t > TABLE.last().unwrap().0 {
            TABLE.last().unwrap().1
        } else {
            pwl_ref(t, TABLE)
        };
        let measured = last_sample(c, 0);
        assert!(
            close(measured, expected, 1e-6),
            "t={t}: PWL current source gave {measured}, expected {expected}"
        );
    }
}
