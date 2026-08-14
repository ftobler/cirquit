//! Constant-row elimination for nonlinear dense closures.
//!
//! A nonlinear closure refactors its whole matrix on every Newton iteration,
//! even when almost all of it is constant: a diode buried in a large passive
//! network changes two rows while the other hundred sit still. This module
//! splits such a closure into the rows `do_step` rewrites (the changing part)
//! and the rows that never move (the fixed part), caches a factor of the
//! fixed part at build, and solves a small reduced system per iteration. This
//! is the port of upstream's classic `simplify`, which precomputed an inverse
//! of the constant block and applied the per-step right-hand-side correction
//! (the modern upstream removed it along with `Matrix.java`); the algorithm
//! here is original.
//!
//! The detection reuses the Stamper's touch recording instead of diffing
//! matrices: the first Newton iteration of a restamp epoch records which
//! closure-local rows `do_step` writes matrix coefficients into
//! ([`crate::stamp::Stamper::set_recording`]). A row a coefficient stamp
//! touches is changing; a row only `do_step` feeds on the right-hand side (a
//! capacitor, a gate) stays fixed, because its coefficients never move.
//!
//! The math, with the changing rows first:
//!
//! ```text
//! [ A_RC  A_RD ] [ x_C ]   [ b_R ]
//! [ A_FC  A_FD ] [ x_D ] = [ b_F ]
//! ```
//!
//! R is the changing rows, C is the columns at those rows' own positions
//! (so `|C| = |R|` and `A_FD` is square), and D is every other column.
//! `A_FC` and `A_FD` are the fixed rows, constant by construction, so `A_FD`
//! is factored once and `E = A_FD^-1 * A_FC` is precomputed. Each iteration
//! then solves `(A_RC - A_RD*E) x_C = b_R - A_RD*A_FD^-1*b_F` for the changing
//! unknowns and back-substitutes `x_D = A_FD^-1*b_F - E*x_C`. The reduced
//! matrix is |R| x |R|, so a closure of n rows with a tiny changing part
//! factors |R|³ per iteration instead of n³.
//!
//! Two guards keep the elimination from ever changing results. The
//! classification is state-dependent in principle (a latch's output-enable
//! pin can switch which rows it rewrites), so every iteration verifies that
//! no fixed row drifted from the snapshot before trusting the reduced solve;
//! a drift, a singular reduced matrix, a non-finite solve or a gross
//! full-system residual all fall back to the full solve, and a closure that
//! falls back stays on the full path for the rest of the epoch. The residual
//! scan covers every row: the changing rows' residual is the reduced
//! system's own, the one first-order witness for a wrong reduced solve,
//! while the fixed rows' residual is satisfied by construction for any x_C
//! (the x_D back-substitution absorbs it) and guards only against non-finite
//! values and cancellation. The fallback solves the exactly-restamped full
//! matrix, so it reproduces the unsimplified path bit for bit.

use crate::closure::Closure;
use crate::matrix::{LinearSystem, SolveError, Solver};

/// The smallest fixed part worth eliminating. Below this the full refactor is
/// cheap enough that the reduced system's machinery would dominate.
const SIMPLIFY_MIN_FIXED_ROWS: usize = 8;
/// The largest changing part the reduced system will cover. A changing part
/// beyond this (a closure full of nonlinear elements) refactors at little
/// savings, so the full path is kept.
const SIMPLIFY_MAX_CHANGING_ROWS: usize = 32;
/// Relative residual above which a reduced solve is declared implausible and
/// the closure falls back to the full path. A backward-stable solve leaves a
/// machine-noise residual (~1e-15), so this bound is crossed only when the
/// reduced solve was genuinely wrong: a near-singular reduced matrix, a
/// non-finite intermediate, or a divergence the full LU's pivoting would
/// have avoided. The ill-conditioned circuit itself is not the trigger: the
/// full path handles it exactly as it always did.
const SIMPLIFY_RESIDUAL_REL: f64 = 1e-6;

/// The per-closure state of the constant-row elimination.
pub(crate) struct SimplifiedSolve {
    n: usize,
    /// Closure-local rows whose coefficients `do_step` rewrites.
    changing_rows: Vec<usize>,
    /// Closure-local columns in the reduced system: the changing rows' own
    /// column positions, so the reduced matrix is |R| x |R| and the fixed
    /// part is square.
    changing_cols: Vec<usize>,
    /// Closure-local rows and columns the elimination treats as constant, in
    /// ascending order.
    fixed_rows: Vec<usize>,
    fixed_cols: Vec<usize>,
    /// The fixed part `A_FD`, factored once at build. Its `flops()` plus the
    /// reduced system's is what [`SimplifiedSolve::flops`] reports.
    aff: LinearSystem,
    /// `E = A_FD^-1 * A_FC`, row-major `|D| x |R|`. Precomputed so the
    /// reduced matrix's cross term is a per-iteration multiply, not a solve.
    e: Vec<f64>,
    /// The reduced system, sized once and rewritten in place each iteration
    /// (a per-iteration `resize` would reset its flop counter).
    reduced: LinearSystem,
    /// `A_FD^-1 * b_F` for the current iteration, length `|D|`.
    y: Vec<f64>,
    /// The fixed rows' right-hand side for the current iteration, length
    /// `|D|`. Separate from `y` because [`LinearSystem::solve_rhs`] takes the
    /// input and output as distinct slices.
    bf: Vec<f64>,
    /// The back-substituted fixed unknowns, length `|D|`.
    xf: Vec<f64>,
    /// Set when a guard trips; the closure then stays on the full-solve path
    /// for the rest of the epoch.
    unsimplifiable: bool,
}

impl SimplifiedSolve {
    /// The size of the reduced per-iteration system, for the tests that pin
    /// that the constant rows were actually eliminated.
    pub(crate) fn reduced_rows(&self) -> usize {
        self.changing_cols.len()
    }

    /// Whether a guard forced the full path. A test hook and the solver's own
    /// decision point.
    #[cfg(test)]
    pub(crate) fn is_unsimplifiable(&self) -> bool {
        self.unsimplifiable
    }

    /// Factor flops accumulated by the fixed part (once) and the reduced
    /// factors (every iteration). Same scope as [`LinearSystem::flops`]:
    /// factorization only, never the solves. The per-iteration O(n²) guard
    /// work (fixed-row drift scan, the `A_FD^-1*b_F` solve, the residual
    /// scan) is deliberately outside this count, so a factor-flop ratio is
    /// an upper bound on the win, not the win itself.
    pub(crate) fn flops(&self) -> u64 {
        self.aff.flops() + self.reduced.flops()
    }

    /// Solves the closure's system through the reduced path, or falls back to
    /// the full path when a guard trips. The caller has already restored and
    /// re-stamped `sys`, so a fallback solve sees exactly the matrix the
    /// unsimplified path would solve.
    pub(crate) fn solve_into(&mut self, sys: &mut LinearSystem) -> Result<(), SolveError> {
        if self.unsimplifiable {
            return sys.solve();
        }
        let n = self.n;
        let a = sys.a();
        let b = sys.b();
        let base_a = sys.base_a();

        // The classification is state-dependent in principle (a latch's
        // output-enable pin switches which rows it rewrites, an analog mux
        // which input carries r_on), so verify every fixed row against the
        // snapshot before trusting the reduced solve. A drift means the
        // detection missed a row this epoch: fall back to the full solve and
        // stay there, which reproduces the unsimplified path exactly.
        for &r in &self.fixed_rows {
            if a[r * n..(r + 1) * n] != base_a[r * n..(r + 1) * n] {
                self.unsimplifiable = true;
                sys.invalidate();
                return sys.solve();
            }
        }

        // y = A_FD^-1 * b_F: the fixed rows' answer as if nothing changed.
        for (i, &r) in self.fixed_rows.iter().enumerate() {
            self.bf[i] = b[r];
        }
        if self.aff.solve_rhs(&self.bf, &mut self.y).is_err() {
            self.unsimplifiable = true;
            sys.invalidate();
            return sys.solve();
        }

        // Rebuild the reduced system from the freshly re-stamped matrix. The
        // cross term A_RD*E folds the fixed columns' coupling into the
        // changing subsystem, so the reduced matrix is exact, not an
        // approximation.
        let c = self.changing_cols.len();
        let d = self.fixed_cols.len();
        for i in 0..c {
            let cr = self.changing_rows[i];
            for j in 0..c {
                let cc = self.changing_cols[j];
                let mut m = a[cr * n + cc];
                for k in 0..d {
                    m -= a[cr * n + self.fixed_cols[k]] * self.e[k * c + j];
                }
                self.reduced.a_mut()[i * c + j] = m;
            }
            let mut bc = b[cr];
            for k in 0..d {
                bc -= a[cr * n + self.fixed_cols[k]] * self.y[k];
            }
            self.reduced.b_mut()[i] = bc;
        }
        self.reduced.invalidate();
        if self.reduced.solve().is_err() {
            self.unsimplifiable = true;
            sys.invalidate();
            return sys.solve();
        }

        // x_D = y - E*x_C, then assemble in natural row order.
        let xc = &self.reduced.x;
        for i in 0..d {
            let mut v = self.y[i];
            for (j, &x) in xc.iter().enumerate() {
                v -= self.e[i * c + j] * x;
            }
            self.xf[i] = v;
        }
        {
            let x = &mut sys.x;
            for (i, &cr) in self.changing_rows.iter().enumerate() {
                x[cr] = xc[i];
            }
            for (i, &fr) in self.fixed_rows.iter().enumerate() {
                x[fr] = self.xf[i];
            }
        }

        // Plausibility: a backward-stable reduced solve leaves the full
        // residual at machine noise, so a gross residual means the reduced
        // solve went genuinely wrong (a near-singular reduced system) or a
        // non-finite value leaked into the assembled vector. The changing
        // rows' residual is the reduced system's own residual, the one
        // first-order witness for a wrong reduced solve; the fixed rows'
        // residual is satisfied by construction for any x_C, because the
        // x_D back-substitution absorbs the compensation, so their scan is a
        // non-finite and cancellation guard only. Reads the assembled `sys.x`
        // and a fresh view of the matrix, so the earlier immutable borrow of
        // `a` is long gone.
        let a = sys.a();
        let b = sys.b();
        for r in 0..n {
            let mut res = -b[r];
            for k in 0..n {
                res += a[r * n + k] * sys.x[k];
            }
            if res.abs() > SIMPLIFY_RESIDUAL_REL * (1.0 + b[r].abs()) {
                self.unsimplifiable = true;
                sys.invalidate();
                return sys.solve();
            }
        }
        Ok(())
    }
}

/// Splits every nonlinear dense closure into a cached fixed part and a
/// per-iteration reduced system, from the coefficient touches the first
/// Newton iteration of the epoch recorded. A closure that misses the
/// threshold, has no constant rows, or whose fixed part is singular keeps the
/// full path (`simplified` stays `None`).
pub(crate) fn build_simplified(closures: &mut [Closure], touches: &[(usize, usize, usize)]) {
    // Per-closure touch lists, one slot per closure so the pass below can
    // index without scanning. A touch whose closure index is out of range is
    // a bug in the maps that produced it; dropping it degrades that closure
    // to the full path (the classification would under-cover, and the
    // verification falls back) rather than panicking the whole run.
    let mut by_closure: Vec<Vec<(usize, usize)>> = vec![Vec::new(); closures.len()];
    for &(c, row, col) in touches {
        if let Some(list) = by_closure.get_mut(c) {
            list.push((row, col));
        }
    }
    for (ci, c) in closures.iter_mut().enumerate() {
        if !c.nonlinear {
            continue;
        }
        // Built once per restamp epoch: `restamp` rebuilds the closures with
        // `simplified = None`, so a system already present is from the
        // current epoch and must not be rebuilt (the fixed part's factor
        // would be recomputed every step for nothing).
        if c.simplified.is_some() {
            continue;
        }
        let Solver::Dense(sys) = &c.sys else {
            // The sparse path refactors cheaply (its LU is O(nnz*fill), not
            // O(n³)), so the dense reduced system's overhead would not pay
            // for itself on it; keep the sparse path exactly as it is.
            continue;
        };
        c.simplified = try_build(sys.size(), sys.base_a(), &by_closure[ci]);
    }
}

/// Attempts to build the elimination for one closure. Returns `None` when the
/// closure does not warrant it or the fixed part does not factor.
fn try_build(n: usize, base_a: &[f64], touches: &[(usize, usize)]) -> Option<SimplifiedSolve> {
    if n == 0 {
        return None;
    }
    // The changing rows are the rows any coefficient stamp touched. The
    // changing columns are those rows' own positions, so the fixed part
    // `A_FD` is square and factorable; the other columns a changing row
    // writes (an op-amp's input columns, say) land in `A_RD` and are folded
    // into the reduced matrix per iteration.
    let mut row_set = vec![false; n];
    for &(r, _) in touches {
        // A touch outside the system is a map bug; degrade to the full path
        // rather than panic. The verification would catch the under-covered
        // classification if it were a genuine row.
        if r >= n {
            return None;
        }
        row_set[r] = true;
    }
    let changing_rows: Vec<usize> = (0..n).filter(|&r| row_set[r]).collect();
    let changing_cols = changing_rows.clone();
    let fixed_rows: Vec<usize> = (0..n).filter(|&r| !row_set[r]).collect();
    let fixed_cols: Vec<usize> = (0..n).filter(|&r| !row_set[r]).collect();

    let changing = changing_rows.len();
    let fixed = fixed_rows.len();
    if changing == 0 || fixed < SIMPLIFY_MIN_FIXED_ROWS {
        return None;
    }
    if changing > SIMPLIFY_MAX_CHANGING_ROWS || changing * 2 > n {
        return None;
    }

    // A_FD = fixed rows x fixed columns from the snapshot, factored once. A
    // singular fixed part means this split is unusable; keep the full path.
    let mut aff = LinearSystem::new();
    aff.resize(fixed).ok()?;
    for (i, &r) in fixed_rows.iter().enumerate() {
        for j in 0..fixed {
            aff.add(i, j, base_a[r * n + fixed_cols[j]]);
        }
    }
    if aff.factor().is_err() {
        return None;
    }

    // E = A_FD^-1 * A_FC, solved column by column against the cached factor.
    let c = changing;
    let mut e = vec![0.0; fixed * c];
    for j in 0..c {
        let cc = changing_cols[j];
        let mut afc = vec![0.0; fixed];
        for (i, &r) in fixed_rows.iter().enumerate() {
            afc[i] = base_a[r * n + cc];
        }
        let mut col = vec![0.0; fixed];
        if aff.solve_rhs(&afc, &mut col).is_err() {
            return None;
        }
        for (i, &v) in col.iter().enumerate() {
            e[i * c + j] = v;
        }
    }

    let mut reduced = LinearSystem::new();
    reduced.resize(c).ok()?;
    Some(SimplifiedSolve {
        n,
        changing_rows,
        changing_cols,
        fixed_rows,
        fixed_cols,
        aff,
        e,
        reduced,
        y: vec![0.0; fixed],
        bf: vec![0.0; fixed],
        xf: vec![0.0; fixed],
        unsimplifiable: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A small hand-built system with two changing rows embedded in a larger
    /// constant network. The elimination must reproduce the full solve
    /// exactly for arbitrary per-iteration coefficient changes.
    fn make_system() -> (LinearSystem, Vec<(usize, usize)>) {
        let n = 12;
        let mut sys = LinearSystem::new();
        sys.resize(n).unwrap();
        // Constant network: a dense mesh across rows 2..n (the "passive"
        // part) coupled to the changing rows 0 and 1, plus a fixed right-hand
        // side spread over the fixed rows.
        for r in 0..n {
            sys.add(r, r, 3.0);
        }
        for r in 0..n {
            for c in 0..n {
                if r != c {
                    sys.add(r, c, -0.2);
                }
            }
        }
        sys.add(0, 2, -1.0);
        sys.add(2, 0, -1.0);
        sys.add(1, n - 1, -1.0);
        sys.add(n - 1, 1, -1.0);
        for (i, r) in (2..n).enumerate() {
            sys.add_rhs(r, 1.0 + i as f64 * 0.5);
        }
        sys.snapshot();
        // The changing rows: coefficients re-stamped every iteration.
        let touches = vec![(0, 0), (0, 1), (1, 0), (1, 1)];
        (sys, touches)
    }

    #[test]
    fn reduced_solve_matches_the_full_solve_exactly() {
        let (mut sys, touches) = make_system();
        let mut ss = try_build(sys.size(), sys.base_a(), &touches)
            .expect("the constant rows should be eliminated");
        assert_eq!(ss.reduced_rows(), 2);
        assert!(ss.reduced_rows() < sys.size());

        // Three Newton iterations with different coefficients on the changing
        // rows; the reduced solve must track the full solve each time.
        let mut niter = 0;
        for (g, rhs) in [(2.0, 1.0), (7.0, -1.0), (0.5, 4.0)] {
            sys.restore();
            sys.add(0, 0, g);
            sys.add(0, 1, -g);
            sys.add(1, 0, -g);
            sys.add(1, 1, g);
            sys.add_rhs(0, rhs);
            sys.add_rhs(1, -rhs);

            let mut full = sys.clone();
            full.invalidate();
            full.solve().unwrap();

            sys.invalidate();
            ss.solve_into(&mut sys).unwrap();
            for k in 0..sys.size() {
                assert!(
                    (sys.x[k] - full.x[k]).abs() < 1e-12,
                    "row {k} diverged: reduced {} vs full {}",
                    sys.x[k],
                    full.x[k]
                );
            }
            niter += 1;
        }
        assert_eq!(niter, 3);
    }

    #[test]
    fn a_drifted_fixed_row_falls_back_to_the_full_solve() {
        let (mut sys, touches) = make_system();
        let mut ss = try_build(sys.size(), sys.base_a(), &touches).unwrap();
        // A latch-style flip: iteration 0 detected no changing row 2, but a
        // later state rewrites it. The verification must catch the drift and
        // route through the full solve, reproducing the unsimplified answer.
        sys.restore();
        sys.add(0, 0, 2.0);
        sys.add(0, 1, -2.0);
        sys.add(1, 0, -2.0);
        sys.add(1, 1, 2.0);
        sys.add(2, 2, 1.0);
        sys.add_rhs(0, 1.0);

        let mut full = sys.clone();
        full.invalidate();
        full.solve().unwrap();

        sys.invalidate();
        ss.solve_into(&mut sys).unwrap();
        assert!(ss.is_unsimplifiable(), "the drift must mark the closure");
        for k in 0..sys.size() {
            assert!(
                (sys.x[k] - full.x[k]).abs() < 1e-12,
                "row {k} diverged after the fallback"
            );
        }
    }

    #[test]
    fn no_elimination_when_everything_changes() {
        let (sys, _) = make_system();
        // Every row changing: the whole matrix is the changing part.
        let touches: Vec<(usize, usize)> = (0..sys.size())
            .flat_map(|r| (0..sys.size()).map(move |c| (r, c)))
            .collect();
        let ss = try_build(sys.size(), sys.base_a(), &touches);
        assert!(
            ss.is_none(),
            "a fully-changing closure must stay unsimplified"
        );
    }
}
