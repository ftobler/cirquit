//! End-to-end tests for the constant-row elimination: a nonlinear element
//! embedded in a large dense passive network must converge to the same answer
//! as the unsimplified path, with the constant rows actually eliminated.

use circuit_core::{ElementSpec, SolverBackend};

mod common;
use common::*;

/// The fan-with-diode plus a capacitor from every chain's far corner to
/// ground. Each capacitor's do_step feeds its rows only on the right-hand
/// side (the companion conductance is stamped in the constant pass), so those
/// rows must be classified constant even though the simulation is a transient.
fn fan_with_diode_and_caps(len: usize) -> Vec<ElementSpec> {
    let mut v = fan_with_diode(len);
    for c in 0..len {
        v.push(elm(
            500 + c as u32,
            "capacitor",
            &[
                [(c as i32) * 16, 16 * (len as i32 - 1)],
                [(c as i32) * 16, 480],
            ],
            &[("capacitance", 1e-6)],
        ));
        v.push(elm(
            510 + c as u32,
            "ground",
            &[[(c as i32) * 16, 480]],
            &[],
        ));
    }
    v
}

#[test]
fn nonlinear_dense_closure_is_simplified_and_converges() {
    // 92 closure rows: a 10x10 fan plus one voltage-source row and the diode.
    let c = &mut build(fan_with_diode(10), opts(1e-5, false));
    let report = c.run(20);
    assert!(report.converged, "did not converge: {:?}", c.error());
    assert_eq!(c.closure_backends(), vec![SolverBackend::Dense]);
    assert_eq!(
        c.closure_simplified(),
        vec![true],
        "the diode-in-network closure must run the elimination"
    );
    let rows = c.closure_rows();
    let reduced = c.closure_reduced_rows();
    assert_eq!(rows, vec![92]);
    assert!(
        reduced[0] < rows[0],
        "the per-step system must be smaller: reduced {} vs full {}",
        reduced[0],
        rows[0]
    );
    // A handful of changing rows (the diode's two), not the whole network.
    assert!(
        reduced[0] <= 8,
        "the reduced system was {} rows",
        reduced[0]
    );
}

#[test]
fn simplified_solve_matches_the_unsimplified_solve() {
    // The same circuit through both paths must land on the same node
    // voltages: the elimination is a solver-internal speedup, never a
    // behaviour change. The elimination engages on the first Newton
    // iteration, so the simplified flag is read after the run.
    let simplified = &mut build(fan_with_diode(10), opts(1e-5, false));
    let unsimplified = &mut build(fan_with_diode(10), opts_no_simplify(1e-5, false));
    assert!(simplified.run(20).converged);
    assert!(unsimplified.run(20).converged);
    assert_eq!(
        simplified.closure_simplified(),
        vec![true],
        "the simplified build must engage the elimination"
    );
    assert_eq!(unsimplified.closure_simplified(), vec![false]);
    let sv = simplified.node_voltages();
    let uv = unsimplified.node_voltages();
    assert_eq!(sv.len(), uv.len());
    for k in 0..sv.len() {
        assert!(
            (sv[k] - uv[k]).abs() < 1e-9,
            "node {k} diverged: simplified {} vs unsimplified {}",
            sv[k],
            uv[k]
        );
    }
    // The far corners of the untouched chains still read the analytic
    // drive/len = 2.0 V to the wire tolerance: the clamp on chain 0 changes
    // its own corner, not the rest of the network.
    for c in 1..10 {
        let corner = 1 + 9 * (c + 1);
        assert!(
            (sv[corner] - 2.0).abs() < 1e-6,
            "chain {c} far corner was {}",
            sv[corner]
        );
    }
}

#[test]
fn reactive_rhs_only_rows_stay_constant_through_the_elimination() {
    // The transient case: a capacitor's companion lives in the constant pass
    // and its do_step writes only right-hand sides, so the elimination must
    // classify the capacitor rows constant and still track the unsimplified
    // transient exactly.
    let simplified = &mut build(fan_with_diode_and_caps(10), opts(1e-5, false));
    let unsimplified = &mut build(fan_with_diode_and_caps(10), opts_no_simplify(1e-5, false));
    assert!(
        simplified.run(30).converged,
        "did not converge: {:?}",
        simplified.error()
    );
    assert!(unsimplified.run(30).converged);
    assert_eq!(simplified.closure_simplified(), vec![true]);
    let sv = simplified.node_voltages();
    let uv = unsimplified.node_voltages();
    for k in 0..sv.len() {
        assert!(
            (sv[k] - uv[k]).abs() < 1e-9,
            "node {k} diverged in the transient: simplified {} vs unsimplified {}",
            sv[k],
            uv[k]
        );
    }
}
