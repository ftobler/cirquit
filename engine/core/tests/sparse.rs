//! Sparse-backend integration tests: the analytic big-grid proof, the
//! dense-vs-sparse parity contract, the deterministic flop measurements and
//! the Auto selection. The engine is headlessly testable, so these run the
//! real `Circuit` with no DOM.

use circuit_core::{Circuit, CircuitSpec, SolverBackend, SolverType};

mod common;
use common::*;

#[test]
fn large_sparse_grid_keeps_the_analytic_far_corner() {
    // A 100x100 fan: 9901 node rows plus the voltage source in one closure,
    // solved through the sparse backend. Each chain drops 1 V per resistor
    // from the 20 V drive, so every far corner reads exactly 20/100 = 0.2 V.
    // The dense equivalent would be ~3.3e11 flops; the sparse factor stays
    // inside CI runtime.
    let c = &mut build(
        fan(100, 100, 20.0, 1),
        opts_solver(1e-5, false, SolverType::Sparse),
    );
    assert_eq!(c.closure_backends(), vec![SolverBackend::Sparse]);
    // The sub-cubic proof: 9902 rows factor in well under the 1e7 flop budget
    // the plan pins, where the dense equivalent is ~3.3e11.
    assert!(
        c.factor_flops() < 10_000_000,
        "the 100x100 fan factored in {} flops",
        c.factor_flops()
    );
    let report = c.run(5);
    assert!(report.converged, "did not converge: {:?}", report.error);
    assert!(
        close(c.node_voltages()[1], 20.0, 1e-6),
        "driven node was {}",
        c.node_voltages()[1]
    );
    for c_idx in 0..100 {
        let v = c.node_voltages()[1 + 99 * (c_idx + 1)];
        assert!(
            close(v, 0.2, 1e-6),
            "far corner of chain {c_idx} was {v}, expected 0.2"
        );
    }
}

#[test]
fn sparse_factor_flops_stay_flat_across_steps() {
    // A linear circuit factors once at build and reuses the factors across
    // steps, so 10 steps must not grow the factor-flop counter. The same
    // property the dense path's `restore_rhs` preserves, now on the sparse
    // backend.
    let c = &mut build(
        fan(100, 100, 20.0, 1),
        opts_solver(1e-5, false, SolverType::Sparse),
    );
    let f0 = c.factor_flops();
    assert!(f0 > 0, "the sparse factor reported no flops");
    let report = c.run(10);
    assert!(report.converged, "did not converge: {:?}", report.error);
    assert_eq!(
        c.factor_flops(),
        f0,
        "linear closure refactored during the steps"
    );
}

#[test]
fn sparse_and_dense_agree_within_tolerance() {
    // The 20x20 grid (382 closure rows, one of the Auto-sparse circuits).
    // Sparse LU is a different algorithm than the dense LU, so the last ulps
    // may differ; the contract is that solved node voltages agree within 1e-9
    // and both runs decide "converged" identically.
    let mut sparse = build(
        fan(20, 20, 20.0, 1),
        opts_solver(1e-5, false, SolverType::Sparse),
    );
    let mut dense = build(
        fan(20, 20, 20.0, 1),
        opts_solver(1e-5, false, SolverType::Dense),
    );
    let rs = sparse.run(5);
    let rd = dense.run(5);
    assert!(rs.converged, "sparse did not converge: {:?}", rs.error);
    assert!(rd.converged, "dense did not converge: {:?}", rd.error);
    let sv = sparse.node_voltages();
    let dv = dense.node_voltages();
    assert_eq!(sv.len(), dv.len());
    for k in 0..sv.len() {
        assert!(
            close(sv[k], dv[k], 1e-9),
            "node {k} diverged: sparse {} vs dense {}",
            sv[k],
            dv[k]
        );
    }
}

/// The 20x20 fan with a diode and a diode-connected transistor dropped onto
/// chain 0's far corner (see `fan_with_nonlinear_arm` in common). The corner
/// clamps through the two junctions, which makes the whole circuit nonlinear:
/// every closure refactors every Newton iteration on both paths.
#[test]
fn nonlinear_circuit_solves_identically_on_both_paths() {
    let mut sparse = build(
        fan_with_nonlinear_arm(),
        opts_solver(1e-5, false, SolverType::Sparse),
    );
    let mut dense = build(
        fan_with_nonlinear_arm(),
        opts_solver(1e-5, false, SolverType::Dense),
    );
    let rs = sparse.run(5);
    let rd = dense.run(5);
    assert!(rs.converged, "sparse did not converge: {:?}", rs.error);
    assert!(rd.converged, "dense did not converge: {:?}", rd.error);
    let sv = sparse.node_voltages();
    let dv = dense.node_voltages();
    assert_eq!(sv.len(), dv.len());
    for k in 0..sv.len() {
        assert!(
            close(sv[k], dv[k], 1e-6),
            "node {k} diverged: sparse {} vs dense {}",
            sv[k],
            dv[k]
        );
    }
}

#[test]
fn large_singular_circuit_is_rejected_on_the_sparse_path() {
    // A 200-resistor chain (200 node rows plus the source) with a second
    // voltage source shorted across the first: duplicate constraint rows, so
    // the eager build-time factor must reject it on the sparse path exactly as
    // it does on the dense path.
    let mut sparse_els = resistor_chain(200, 0, 1);
    sparse_els.push(elm(
        300,
        "voltage",
        &[[0, 100], [0, 0]],
        &[("maxVoltage", 3.0)],
    ));
    let mut sparse = Circuit::new();
    assert!(
        sparse
            .set_circuit(&CircuitSpec {
                preserve_run: false,
                elements: sparse_els,
                options: Some(opts_solver(1e-5, false, SolverType::Sparse)),
                scopes: Vec::new(),
            })
            .is_err(),
        "sparse accepted the shorted circuit at set_circuit"
    );

    let mut dense_els = resistor_chain(200, 0, 1);
    dense_els.push(elm(
        300,
        "voltage",
        &[[0, 100], [0, 0]],
        &[("maxVoltage", 3.0)],
    ));
    let mut dense = Circuit::new();
    assert!(
        dense
            .set_circuit(&CircuitSpec {
                preserve_run: false,
                elements: dense_els,
                options: Some(opts_solver(1e-5, false, SolverType::Dense)),
                scopes: Vec::new(),
            })
            .is_err(),
        "dense accepted the shorted circuit at set_circuit"
    );
}

#[test]
fn auto_picks_sparse_above_the_threshold() {
    // Auto routes closures at or above SPARSE_THRESHOLD to the sparse backend
    // and keeps everything below it dense.
    let grid = build(fan(20, 20, 20.0, 1), opts(1e-5, false));
    assert_eq!(
        grid.closure_backends(),
        vec![SolverBackend::Sparse],
        "the 382-row grid closure should be sparse under Auto"
    );
    let small = build(resistor_chain(100, 0, 1), opts(1e-5, false));
    assert_eq!(
        small.closure_backends(),
        vec![SolverBackend::Dense],
        "the 101-row chain closure should stay dense under Auto"
    );
}

#[test]
fn sparse_handles_voltage_source_rows() {
    // 60 resistors in series with an ideal ammeter (a 0 V voltage source)
    // between each pair: 120 node rows plus 61 voltage-source rows = 181
    // closure rows, forced Sparse. The ammeters add unsymmetric constraint
    // rows, and each must read the exact chain current 10/(60*1000) = 1/6000 A.
    let mut els = vec![
        elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 10.0)]),
        elm(2, "ground", &[[0, 100]], &[]),
    ];
    let mut id = 3u32;
    let mut x = 0i32;
    for _ in 0..60 {
        els.push(elm(
            id,
            "resistor",
            &[[x, 0], [x + 16, 0]],
            &[("resistance", 1000.0)],
        ));
        id += 1;
        x += 16;
        els.push(elm(id, "ammeter", &[[x, 0], [x + 16, 0]], &[]));
        id += 1;
        x += 16;
    }
    els.push(elm(id, "ground", &[[x, 0]], &[]));

    let c = &mut build(els, opts_solver(1e-5, false, SolverType::Sparse));
    assert_eq!(c.closure_backends(), vec![SolverBackend::Sparse]);
    let report = c.run(5);
    assert!(report.converged, "did not converge: {:?}", report.error);
    // Ammeter k sits at element index 3 + 2k.
    let currents = c.element_currents();
    for k in 0..60 {
        let i = currents[3 + 2 * k];
        assert!(
            close(i.abs(), 1.0 / 6000.0, 1e-9),
            "ammeter {k} read {i}, expected 1/6000 A"
        );
    }
}
