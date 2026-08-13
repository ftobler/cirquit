//! Deterministic solver benchmark: flop counters, closure structure and
//! analytic node voltages over a representative circuit set, gateable under
//! `cargo test --workspace`. The assertions are exact where the structure is
//! a promise (factors-once flatness, closure decomposition, dense/sparse
//! ratio) and ranged where a legitimate LU optimisation changes the count.
//! Nothing here asserts wall clock.
//!
//! `just bench` runs this same binary with `--nocapture` single-threaded so
//! the printed lines assemble into the table; the ms columns are debug-build
//! and informational only.

use std::sync::Once;
use std::time::Instant;

use circuit_core::{Circuit, ElementSpec, SimOptions, SolverBackend, SolverType};

mod common;
use common::*;

// ─── Measurement helpers ───

/// The measured numbers for one benchmark row, plus the live `Circuit` so a
/// test can read node voltages and element currents after the run.
struct BenchRow {
    name: String,
    circuit: Circuit,
    node_count: usize,
    vs_count: usize,
    closure_rows: Vec<usize>,
    closure_backends: Vec<SolverBackend>,
    /// Per-closure factor flops right after build; sums to `build_flops`.
    closure_flops: Vec<u64>,
    /// Factor flops right after build: exactly one factor of each closure for
    /// a linear circuit.
    build_flops: u64,
    build_ms: u64,
    /// Factor flops after the run: unchanged for a linear circuit, the total
    /// nonlinear refactor work for a nonlinear one.
    run_flops: u64,
    run_ms: u64,
    converged: bool,
    iterations: u32,
}

/// Build the circuit, snapshot the deterministic counters, run `steps`
/// timesteps and snapshot again. The single source of truth for both the
/// assertions and the printed table.
fn row(name: &str, elements: Vec<ElementSpec>, options: SimOptions, steps: u32) -> BenchRow {
    let t0 = Instant::now();
    let mut circuit = build(elements, options);
    let build_ms = t0.elapsed().as_millis() as u64;
    let node_count = circuit.node_count();
    let vs_count = circuit.vs_count();
    let closure_rows = circuit.closure_rows();
    let closure_backends = circuit.closure_backends();
    let closure_flops = circuit.closure_flops();
    let build_flops = circuit.factor_flops();
    let t1 = Instant::now();
    let report = circuit.run(steps);
    let run_ms = t1.elapsed().as_millis() as u64;
    let run_flops = circuit.factor_flops();
    BenchRow {
        name: name.into(),
        circuit,
        node_count,
        vs_count,
        closure_rows,
        closure_backends,
        closure_flops,
        build_flops,
        build_ms,
        run_flops,
        run_ms,
        converged: report.converged,
        iterations: report.iterations,
    }
}

fn thousands(n: u64) -> String {
    let s = n.to_string();
    let mut out = String::new();
    for (i, ch) in s.chars().enumerate() {
        if i > 0 && (s.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(ch);
    }
    out
}

fn backend_name(b: SolverBackend) -> &'static str {
    match b {
        SolverBackend::Dense => "Dense",
        SolverBackend::Sparse => "Sparse",
    }
}

/// One table line, header first. Only the first printed line is the header;
/// `just bench` runs the tests single-threaded so the lines assemble in order.
fn print_row(r: &BenchRow) {
    static PRINTED_HEADER: Once = Once::new();
    PRINTED_HEADER.call_once(|| {
        println!(
            "{:<30}{:>7}{:>4}{:>9} {:<13}{:>13}{:>9}{:>7}  result",
            "circuit", "rows", "vs", "closures", "backends", "factor flops", "build ms", "run ms"
        );
    });
    let rows: usize = r.closure_rows.iter().sum();
    let backends = r
        .closure_backends
        .iter()
        .map(|&b| backend_name(b))
        .collect::<Vec<_>>()
        .join(",");
    println!(
        "{:<30}{:>7}{:>4}{:>9} {:<13}{:>13}{:>9}{:>7}  {}",
        r.name,
        rows,
        r.vs_count,
        r.closure_rows.len(),
        backends,
        thousands(r.run_flops),
        r.build_ms,
        r.run_ms,
        if r.converged { "converged" } else { "FAILED" }
    );
}

// ─── Tests ───

#[test]
fn bench_closure_decomposition_halves_factor_cost() {
    // Two detached 60-node chains are two closures of 61 rows; the same 120
    // nodes as one 121-row chain. LU flops grow faster than linearly, so the
    // split must be strictly cheaper (M7) and neither path may re-factor
    // across steps (M5 on the dense path).
    let two = row(
        "linear chain 60 x2",
        [resistor_chain(60, 0, 1), resistor_chain(60, 2000, 100)].concat(),
        opts(1e-5, false),
        10,
    );
    assert_eq!(two.closure_rows, vec![61, 61]);
    assert_eq!(two.node_count, 121);
    assert_eq!(
        two.closure_backends,
        vec![SolverBackend::Dense, SolverBackend::Dense]
    );
    assert_eq!(two.vs_count, 2);
    let f2 = two.build_flops;
    assert_eq!(two.closure_flops.iter().sum::<u64>(), f2);
    assert!(
        (6000.0..9000.0).contains(&(f2 as f64)),
        "two 61-row chains factored {f2} flops, expected ~7318"
    );
    assert!(two.converged, "two-chain run did not converge");
    assert_eq!(
        two.run_flops, f2,
        "the two-chain closure re-factored across the run"
    );

    let one = row(
        "linear chain 120",
        resistor_chain(120, 0, 1),
        opts(1e-5, false),
        10,
    );
    assert_eq!(one.closure_rows, vec![121]);
    assert_eq!(one.node_count, 121);
    assert_eq!(one.closure_backends, vec![SolverBackend::Dense]);
    assert!(
        one.build_flops > f2,
        "one {}-row chain factored {} flops, two 61-row chains {}: the split must be cheaper",
        one.closure_rows[0],
        one.build_flops,
        f2
    );
    assert!(
        one.converged,
        "one-chain run did not converge: {:?}",
        one.circuit.error()
    );
    assert_eq!(
        one.run_flops, one.build_flops,
        "the 121-row closure re-factored across the run"
    );
    print_row(&two);
    print_row(&one);
}

#[test]
fn bench_linear_circuits_keep_the_factors_once_property() {
    // The regression the whole benchmark exists to prevent: a linear circuit
    // must never re-factor. Each row factors once at build, then 10 steps
    // only swap the right-hand sides in and out.
    let cases: Vec<(String, Vec<ElementSpec>)> = vec![
        ("fan 20x20 (Auto)".into(), fan(20, 20, 20.0, 1)),
        ("fan 40x40 (Auto)".into(), fan(40, 40, 20.0, 1)),
        ("fan 100x100 (Auto)".into(), fan(100, 100, 20.0, 1)),
        ("mesh 30x30 (Auto)".into(), resistor_mesh(30)),
    ];
    let expected_rows: Vec<Vec<usize>> = vec![vec![382], vec![1562], vec![9902], vec![961]];
    for (case, (name, els)) in cases.into_iter().enumerate() {
        let r = row(&name, els, opts(1e-5, false), 10);
        assert_eq!(
            r.closure_rows, expected_rows[case],
            "{name}: unexpected closure rows"
        );
        assert_eq!(
            r.closure_backends,
            vec![SolverBackend::Sparse],
            "{name}: the {}-row closure should route to Sparse under Auto",
            r.closure_rows[0]
        );
        assert_eq!(
            r.closure_flops.iter().sum::<u64>(),
            r.build_flops,
            "{name}: closure flops must sum to the circuit total"
        );
        assert!(r.converged, "{name} did not converge");
        assert_eq!(
            r.run_flops, r.build_flops,
            "{name}: a linear closure re-factored across the run"
        );
        assert!(r.build_flops > 0, "{name} reported no factor flops");
        print_row(&r);
    }
}

#[test]
fn bench_sparse_beats_dense_on_the_40x40_fan() {
    // Re-homes the old `sparse_factor_flops_are_much_smaller_than_dense` ratio
    // assertion so the expensive dense factor runs exactly once in the gate.
    // The 40x40 fan (1561 node rows plus the source row) factors 11,289x
    // cheaper on the sparse path, and both paths converge to the same 0.5 V
    // far corners.
    let sparse = row(
        "fan 40x40 (Sparse)",
        fan(40, 40, 20.0, 1),
        opts_solver(1e-5, false, SolverType::Sparse),
        5,
    );
    let dense = row(
        "fan 40x40 (Dense)",
        fan(40, 40, 20.0, 1),
        opts_solver(1e-5, false, SolverType::Dense),
        5,
    );
    assert_eq!(sparse.closure_backends, vec![SolverBackend::Sparse]);
    assert_eq!(dense.closure_backends, vec![SolverBackend::Dense]);
    assert_eq!(sparse.closure_rows, vec![1562]);
    assert_eq!(dense.closure_rows, vec![1562]);
    assert_eq!(sparse.node_count, 1562);
    assert_eq!(dense.node_count, 1562);
    assert_eq!(sparse.closure_flops.iter().sum::<u64>(), sparse.build_flops);
    assert!(
        dense.build_flops > sparse.build_flops * 1000,
        "dense factored {} flops, sparse only {}: the ratio must exceed 1000x",
        dense.build_flops,
        sparse.build_flops
    );
    assert!(
        (25_000_000.0..45_000_000.0).contains(&(dense.build_flops as f64)),
        "dense 40x40 factor was {} flops, expected ~34,318,441",
        dense.build_flops
    );
    assert!(
        (2000.0..6000.0).contains(&(sparse.build_flops as f64)),
        "sparse 40x40 factor was {} flops, expected ~3,040",
        sparse.build_flops
    );
    assert!(sparse.converged && dense.converged);
    let sv = sparse.circuit.node_voltages();
    let dv = dense.circuit.node_voltages();
    for c in 0..40 {
        let corner = 1 + 39 * (c + 1);
        assert!(
            close(sv[corner], 0.5, 1e-9),
            "sparse far corner was {}",
            sv[corner]
        );
        assert!(
            close(dv[corner], 0.5, 1e-9),
            "dense far corner was {}",
            dv[corner]
        );
        assert!(
            close(sv[corner], dv[corner], 1e-9),
            "backends disagree on far corner {corner}"
        );
    }
    print_row(&dense);
    print_row(&sparse);
}

#[test]
fn bench_thousands_of_nodes_fit_the_budget() {
    // The sub-cubic guard: 9902 closure rows must factor in well under the
    // 1e7 flop budget the dense equivalent (~3.3e11) blows through, and every
    // chain's far corner reads exactly 20/100 = 0.2 V.
    let r = row(
        "fan 100x100 (Auto)",
        fan(100, 100, 20.0, 1),
        opts(1e-5, false),
        5,
    );
    assert_eq!(r.closure_backends, vec![SolverBackend::Sparse]);
    assert_eq!(r.closure_rows, vec![9902]);
    assert_eq!(r.node_count, 9902);
    assert_eq!(r.closure_flops.iter().sum::<u64>(), r.build_flops);
    assert!(
        (10_000.0..10_000_000.0).contains(&(r.build_flops as f64)),
        "the 100x100 fan factored {} flops, expected ~19,600",
        r.build_flops
    );
    assert!(r.converged, "did not converge: {:?}", r.circuit.error());
    assert!(close(r.circuit.node_voltages()[1], 20.0, 1e-6));
    for c in 0..100 {
        let v = r.circuit.node_voltages()[1 + 99 * (c + 1)];
        assert!(close(v, 0.2, 1e-6), "far corner of chain {c} was {v}");
    }
    assert_eq!(r.run_flops, r.build_flops, "linear closure re-factored");
    print_row(&r);
}

#[test]
fn bench_mesh_30x30_stays_within_fill_budget() {
    // The true 2D mesh the fan families were not: without column ordering it
    // fills, but stays inside the 4e6 flop guard. The two analytic facts pin
    // the geometry: the driven corner reads 10 V, and by the 180 degree
    // symmetry of the drive the center reads exactly 5 V.
    let n = 30;
    let r = row("mesh 30x30 (Auto)", resistor_mesh(n), opts(1e-5, false), 10);
    assert_eq!(r.closure_backends, vec![SolverBackend::Sparse]);
    assert_eq!(r.closure_rows, vec![961]);
    assert_eq!(r.node_count, 961);
    assert_eq!(r.closure_flops.iter().sum::<u64>(), r.build_flops);
    assert!(
        (100_000.0..4_000_000.0).contains(&(r.build_flops as f64)),
        "the 30x30 mesh factored {} flops, expected ~800k",
        r.build_flops
    );
    assert!(r.converged, "did not converge: {:?}", r.circuit.error());
    let v = r.circuit.node_voltages();
    assert!(close(v[1], 10.0, 1e-9), "driven corner was {}", v[1]);
    let node = |x: usize, y: usize| y * (n + 1) + x + 1;
    assert!(
        close(v[node(n / 2, n / 2)], 5.0, 1e-9),
        "center was {}",
        v[node(n / 2, n / 2)]
    );
    for (x, y) in [(5, 17), (23, 9), (12, 29)] {
        assert!(
            close(v[node(x, y)], v[node(y, x)], 1e-9),
            "V({x},{y}) = {} but V({y},{x}) = {}",
            v[node(x, y)],
            v[node(y, x)]
        );
    }
    assert_eq!(r.run_flops, r.build_flops, "linear closure re-factored");
    print_row(&r);
}

#[test]
fn bench_nonlinear_circuits_bound_the_refactor_cost() {
    // Nonlinear circuits refactor every Newton iteration, so after the run
    // `factor_flops` is the total nonlinear refactor work. The diode chain is
    // the small dense case, the fan with a nonlinear arm the big sparse one.
    // The bounds are generous upper bounds on purpose: the linear-closure
    // isolation follow-up will legitimately DROP these totals.
    let chain = row(
        "diode chain x10 (Auto)",
        diode_chain(10, 10.0, 1e3),
        opts(1e-5, false),
        10,
    );
    assert!(
        chain.converged,
        "did not converge: {:?}",
        chain.circuit.error()
    );
    assert_eq!(chain.closure_rows, vec![12]);
    assert_eq!(chain.node_count, 12);
    assert_eq!(chain.closure_backends, vec![SolverBackend::Dense]);
    assert_eq!(chain.closure_flops.iter().sum::<u64>(), chain.build_flops);
    assert!(
        chain.iterations > 0,
        "a nonlinear circuit ran zero iterations"
    );
    let i = chain.circuit.element_currents()[2];
    assert!(
        (1e-3..1e-2).contains(&i),
        "diode chain current was {i} A, expected ~4.7 mA"
    );
    assert!(
        chain.run_flops > chain.build_flops,
        "nonlinear chain refactored {} flops, the build factor was {}",
        chain.run_flops,
        chain.build_flops
    );
    assert!(
        (500.0..50_000.0).contains(&(chain.run_flops as f64)),
        "diode chain refactor cost was {} flops, expected ~3,537",
        chain.run_flops
    );
    let per_iter = chain.run_flops as f64 / chain.iterations as f64;
    assert!(
        per_iter < 5_000.0,
        "per-iteration dense refactor cost was {per_iter} flops, expected ~131"
    );

    let mixed = row(
        "fan 20x20 + nonlinear arm (Auto)",
        fan_with_nonlinear_arm(),
        opts(1e-5, false),
        10,
    );
    assert_eq!(mixed.closure_backends, vec![SolverBackend::Sparse]);
    assert_eq!(mixed.closure_rows, vec![382]);
    assert_eq!(mixed.node_count, 382);
    assert!(
        mixed.converged,
        "did not converge: {:?}",
        mixed.circuit.error()
    );
    let corner = mixed.circuit.node_voltages()[20];
    assert!(
        (0.6..0.95).contains(&corner),
        "chain 0's far corner was {corner} V, expected ~0.72 (clamped below the 1.0 V unclamped value)"
    );
    // Upper bound only: the linear-closure isolation follow-up legitimately
    // drops this total, so the bound must stay generous.
    assert!(
        mixed.run_flops < 500_000,
        "the mixed sparse refactor cost was {} flops, expected ~22,320",
        mixed.run_flops
    );
    print_row(&chain);
    print_row(&mixed);
}
