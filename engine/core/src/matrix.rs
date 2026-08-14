//! Dense linear system with LU factorisation (Doolittle, partial pivoting).
//!
//! The simulator assembles a modified-nodal-analysis system `A x = b` every
//! timestep. For a purely linear circuit `A` is constant, so it is factored
//! once and only the right-hand side is re-solved; nonlinear circuits refactor
//! on every Newton iteration.
//!
//! [`Solver`] is the backend seam [`crate::closure::Closure`] holds. A closure
//! below the sparse threshold keeps the dense [`LinearSystem`]; a large closure
//! can be routed to the sparse backend in [`crate::sparse`].

use crate::sparse::SparseSystem;
use crate::spec::SolverType;

/// Reasons a solve can fail.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SolveError {
    /// The matrix has no usable pivot: typically a floating subcircuit, a
    /// shorted voltage source, or two ideal sources fighting over one node.
    Singular,
}

/// Closure sizes at and above which Auto routes a closure to the sparse
/// backend. Matches upstream's `SimulationManager.SPARSE_THRESHOLD`
/// (SimulationManager.java:46): below it the dense path is already cheap and
/// the sparse path's structure overhead is not worth it.
pub const SPARSE_THRESHOLD: usize = 150;

/// Hard cap on any closure's row count and on the node count feeding it.
/// Applied at the node-count source in `assign_nodes` (so a hand-edited
/// netlist with an absurd number of terminals is rejected as an invalid
/// circuit before anything large is allocated) and again in each backend's
/// `resize` as defense in depth. The sparse backend's O(n) structure could
/// in principle go higher, but no legitimate circuit comes near this: the
/// corpus's largest closure is about 10,000 rows.
pub const MAX_MATRIX_ROWS: usize = 100_000;

/// Largest system the dense backend will size. Dense LU stores three `n x n`
/// copies (`a`, `base_a` and `lu`), so the bound keeps the allocation under
/// about `24 * MAX_DENSE_ROWS²` bytes. It sits far above the largest
/// legitimate forced-dense closure (the corpus's 1,562-row fan) and far
/// below the n whose `n * n` would overflow a 32-bit `usize` (65,536), so a
/// real circuit never comes near it and no size can wrap. A closure this
/// large is pathological and must be reported as an invalid circuit rather
/// than attempted.
pub const MAX_DENSE_ROWS: usize = 4_096;

/// The stable message an oversized system reports. Shared by the node-count
/// source check and both backends so the wasm boundary surfaces one string
/// and the tests can assert on it.
pub(crate) fn matrix_too_large(n: usize, limit: usize) -> String {
    format!("The circuit is too large: it would need {n} rows, above the limit of {limit}.")
}

/// Row-major dense system of size `n`.
#[derive(Default, Clone)]
pub struct LinearSystem {
    n: usize,
    a: Vec<f64>,
    b: Vec<f64>,
    /// Pristine copy taken after the one-off `stamp` pass.
    base_a: Vec<f64>,
    base_b: Vec<f64>,
    /// In-place LU factors of `a`.
    lu: Vec<f64>,
    perm: Vec<usize>,
    pub x: Vec<f64>,
    factored: bool,
    /// Multiply-adds performed by the last factor pass, for the closure-
    /// decomposition speedup test. Deterministic, unlike a wall clock.
    flops: u64,
}

impl LinearSystem {
    pub fn new() -> Self {
        Self::default()
    }

    /// Discards all state and allocates an `n x n` system of zeroes. Errors
    /// when `n` exceeds [`MAX_DENSE_ROWS`]: the dense path stores three `n x n`
    /// copies, so a larger system is a pathological input (a hand-edited
    /// netlist, an explicit forced-Dense choice) that must be reported as an
    /// invalid circuit rather than overflow the size or attempt an unbounded
    /// allocation. The entry count is computed with checked arithmetic, so
    /// `n * n` can never wrap whatever the target pointer width.
    pub fn resize(&mut self, n: usize) -> Result<(), String> {
        let entries = n
            .checked_mul(n)
            .ok_or_else(|| matrix_too_large(n, MAX_DENSE_ROWS))?;
        if n > MAX_DENSE_ROWS {
            return Err(matrix_too_large(n, MAX_DENSE_ROWS));
        }
        self.n = n;
        self.a = vec![0.0; entries];
        self.b = vec![0.0; n];
        self.base_a = vec![0.0; entries];
        self.base_b = vec![0.0; n];
        self.lu = vec![0.0; entries];
        self.perm = (0..n).collect();
        self.x = vec![0.0; n];
        self.factored = false;
        self.flops = 0;
        Ok(())
    }

    #[inline]
    pub fn size(&self) -> usize {
        self.n
    }

    #[inline]
    pub fn add(&mut self, row: usize, col: usize, v: f64) {
        debug_assert!(row < self.n && col < self.n);
        if v != 0.0 {
            self.a[row * self.n + col] += v;
        }
    }

    #[inline]
    pub fn add_rhs(&mut self, row: usize, v: f64) {
        debug_assert!(row < self.n);
        self.b[row] += v;
    }

    #[inline]
    pub fn get(&self, row: usize, col: usize) -> f64 {
        self.a[row * self.n + col]
    }

    /// Snapshots the current matrix as the reusable base for later timesteps.
    pub fn snapshot(&mut self) {
        self.base_a.copy_from_slice(&self.a);
        self.base_b.copy_from_slice(&self.b);
        self.factored = false;
    }

    /// Restores the snapshot so the per-timestep contributions can be re-added.
    pub fn restore(&mut self) {
        self.a.copy_from_slice(&self.base_a);
        self.b.copy_from_slice(&self.base_b);
    }

    /// Restores only the right-hand side. Valid when nothing has touched the
    /// matrix since the snapshot, which is the case for linear circuits.
    pub fn restore_rhs(&mut self) {
        self.b.copy_from_slice(&self.base_b);
    }

    /// Invalidates cached LU factors.
    pub fn invalidate(&mut self) {
        self.factored = false;
    }

    #[inline]
    pub fn is_factored(&self) -> bool {
        self.factored
    }

    /// Multiply-adds accumulated by factor passes since the last `resize`.
    pub fn flops(&self) -> u64 {
        self.flops
    }

    /// LU-factors `a` in place with partial pivoting. Cheap no-op if the cached
    /// factorisation is still valid.
    pub fn factor(&mut self) -> Result<(), SolveError> {
        if self.factored {
            return Ok(());
        }
        let n = self.n;
        if n == 0 {
            self.factored = true;
            return Ok(());
        }
        self.lu.copy_from_slice(&self.a);
        for (i, p) in self.perm.iter_mut().enumerate() {
            *p = i;
        }

        // Scale factor per row, so pivoting compares relative rather than
        // absolute magnitudes. Circuit matrices mix siemens and volts and are
        // badly scaled without it.
        let mut scale = vec![0.0f64; n];
        for (i, s) in scale.iter_mut().enumerate() {
            // `f64::max` ignores a NaN operand, so track non-finite entries
            // explicitly: any NaN or Inf anywhere in the row must poison the
            // row maximum, and a non-finite maximum is as unsolvable as a
            // zero row. This is the port's matrix-entry NaN/Inf scan,
            // upstream's `SimulationManager.java:1348-1361` loop folded into
            // the factor pass.
            let largest = self.lu[i * n..(i + 1) * n].iter().fold(0.0f64, |acc, v| {
                let m = acc.max(v.abs());
                if !acc.is_finite() || !v.is_finite() {
                    f64::NAN
                } else {
                    m
                }
            });
            if largest == 0.0 || !largest.is_finite() {
                return Err(SolveError::Singular);
            }
            *s = 1.0 / largest;
        }

        for j in 0..n {
            // Find the pivot row for column j.
            let mut pivot = j;
            let mut largest = 0.0f64;
            for (i, sc) in scale.iter().enumerate().skip(j) {
                let v = self.lu[i * n + j].abs() * sc;
                if v > largest {
                    largest = v;
                    pivot = i;
                }
            }
            if largest == 0.0 {
                return Err(SolveError::Singular);
            }
            if pivot != j {
                for k in 0..n {
                    self.lu.swap(pivot * n + k, j * n + k);
                }
                self.perm.swap(pivot, j);
                scale.swap(pivot, j);
            }

            let diag = self.lu[j * n + j];
            if diag == 0.0 {
                return Err(SolveError::Singular);
            }
            let inv = 1.0 / diag;
            for i in (j + 1)..n {
                let mult = self.lu[i * n + j] * inv;
                self.lu[i * n + j] = mult;
                if mult != 0.0 {
                    for k in (j + 1)..n {
                        self.lu[i * n + k] -= mult * self.lu[j * n + k];
                        self.flops += 1;
                    }
                }
            }
        }
        self.factored = true;
        Ok(())
    }

    /// Solves for the current right-hand side using the cached factors.
    /// The result lands in [`LinearSystem::x`].
    pub fn solve(&mut self) -> Result<(), SolveError> {
        self.factor()?;
        let n = self.n;

        // Forward substitution through the permutation.
        for i in 0..n {
            let mut sum = self.b[self.perm[i]];
            for k in 0..i {
                sum -= self.lu[i * n + k] * self.x[k];
            }
            self.x[i] = sum;
        }
        // Back substitution.
        for i in (0..n).rev() {
            let mut sum = self.x[i];
            for k in (i + 1)..n {
                sum -= self.lu[i * n + k] * self.x[k];
            }
            self.x[i] = sum / self.lu[i * n + i];
        }
        for v in self.x.iter() {
            if !v.is_finite() {
                return Err(SolveError::Singular);
            }
        }
        Ok(())
    }
}

/// Backend seam for a closure's system: the dense [`LinearSystem`] by default,
/// or the sparse [`crate::sparse::SparseSystem`] for closures that cross the
/// sparse threshold. Every method mirrors [`LinearSystem`]'s surface so
/// [`crate::closure::Closure`] and the Stamper never see which backend a
/// closure uses.
///
/// The variants are deliberately unboxed: `Solver` sits on the per-frame hot
/// path (every element stamps through it), so a heap pointer per backend
/// would add indirection where the dense default is otherwise a plain by-value
/// system.
#[allow(clippy::large_enum_variant)]
#[derive(Clone)]
pub enum Solver {
    Dense(LinearSystem),
    Sparse(SparseSystem),
}

/// Which backend a [`Solver`] actually solves through. A test hook for the
/// Auto-selection parity tests; the frontend never needs it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SolverBackend {
    Dense,
    Sparse,
}

impl Default for Solver {
    fn default() -> Self {
        Solver::Dense(LinearSystem::default())
    }
}

impl Solver {
    pub fn new() -> Self {
        Solver::Dense(LinearSystem::new())
    }

    /// The backend this solver solves through.
    pub fn backend(&self) -> SolverBackend {
        match self {
            Solver::Dense(_) => SolverBackend::Dense,
            Solver::Sparse(_) => SolverBackend::Sparse,
        }
    }

    /// Discards all state and allocates an `n x n` system of zeroes. The
    /// backend is chosen from `solver_type`: forced dense/sparse honour the
    /// request, Auto picks sparse only at or above [`SPARSE_THRESHOLD`].
    /// Errors when the size exceeds the backend's cap (see
    /// [`MAX_MATRIX_ROWS`] and [`MAX_DENSE_ROWS`]); an oversized system is a
    /// pathological input that must be reported as an invalid circuit, not
    /// allocated.
    pub fn resize(&mut self, n: usize, solver_type: SolverType) -> Result<(), String> {
        let want_sparse = match solver_type {
            SolverType::Auto => n >= SPARSE_THRESHOLD,
            SolverType::Dense => false,
            SolverType::Sparse => true,
        };
        if want_sparse {
            match self {
                Solver::Sparse(s) => s.resize(n)?,
                Solver::Dense(_) => {
                    let mut s = SparseSystem::new();
                    s.resize(n)?;
                    *self = Solver::Sparse(s);
                }
            }
        } else {
            match self {
                Solver::Dense(s) => s.resize(n)?,
                Solver::Sparse(_) => {
                    let mut s = LinearSystem::new();
                    s.resize(n)?;
                    *self = Solver::Dense(s);
                }
            }
        }
        Ok(())
    }

    #[inline]
    pub fn size(&self) -> usize {
        match self {
            Solver::Dense(s) => s.size(),
            Solver::Sparse(s) => s.size(),
        }
    }

    #[inline]
    pub fn add(&mut self, row: usize, col: usize, v: f64) {
        match self {
            Solver::Dense(s) => s.add(row, col, v),
            Solver::Sparse(s) => s.add(row, col, v),
        }
    }

    #[inline]
    pub fn add_rhs(&mut self, row: usize, v: f64) {
        match self {
            Solver::Dense(s) => s.add_rhs(row, v),
            Solver::Sparse(s) => s.add_rhs(row, v),
        }
    }

    #[inline]
    pub fn get(&self, row: usize, col: usize) -> f64 {
        match self {
            Solver::Dense(s) => s.get(row, col),
            Solver::Sparse(s) => s.get(row, col),
        }
    }

    /// Snapshots the current matrix as the reusable base for later timesteps.
    pub fn snapshot(&mut self) {
        match self {
            Solver::Dense(s) => s.snapshot(),
            Solver::Sparse(s) => s.snapshot(),
        }
    }

    /// Restores the snapshot so the per-timestep contributions can be re-added.
    pub fn restore(&mut self) {
        match self {
            Solver::Dense(s) => s.restore(),
            Solver::Sparse(s) => s.restore(),
        }
    }

    /// Restores only the right-hand side. Valid when nothing has touched the
    /// matrix since the snapshot, which is the case for linear circuits.
    pub fn restore_rhs(&mut self) {
        match self {
            Solver::Dense(s) => s.restore_rhs(),
            Solver::Sparse(s) => s.restore_rhs(),
        }
    }

    /// Invalidates cached LU factors.
    pub fn invalidate(&mut self) {
        match self {
            Solver::Dense(s) => s.invalidate(),
            Solver::Sparse(s) => s.invalidate(),
        }
    }

    #[inline]
    pub fn is_factored(&self) -> bool {
        match self {
            Solver::Dense(s) => s.is_factored(),
            Solver::Sparse(s) => s.is_factored(),
        }
    }

    /// Multiply-adds accumulated by factor passes since the last `resize`.
    pub fn flops(&self) -> u64 {
        match self {
            Solver::Dense(s) => s.flops(),
            Solver::Sparse(s) => s.flops(),
        }
    }

    /// LU-factors the matrix, no-op if the cached factorisation is valid.
    pub fn factor(&mut self) -> Result<(), SolveError> {
        match self {
            Solver::Dense(s) => s.factor(),
            Solver::Sparse(s) => s.factor(),
        }
    }

    /// Solves for the current right-hand side using the cached factors. The
    /// result lands in [`Solver::x`].
    pub fn solve(&mut self) -> Result<(), SolveError> {
        match self {
            Solver::Dense(s) => s.solve(),
            Solver::Sparse(s) => s.solve(),
        }
    }

    /// The solved vector, indexed by closure-local row.
    pub fn x(&self) -> &[f64] {
        match self {
            Solver::Dense(s) => &s.x,
            Solver::Sparse(s) => &s.x,
        }
    }

    /// Mutable view of the solved vector, for the committed-solution copies.
    pub fn x_mut(&mut self) -> &mut [f64] {
        match self {
            Solver::Dense(s) => &mut s.x,
            Solver::Sparse(s) => &mut s.x,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn solves_a_two_by_two() {
        let mut s = LinearSystem::new();
        s.resize(2).unwrap();
        // [2 1; 1 3] x = [5; 10]  ->  x = [1; 3]
        s.add(0, 0, 2.0);
        s.add(0, 1, 1.0);
        s.add(1, 0, 1.0);
        s.add(1, 1, 3.0);
        s.add_rhs(0, 5.0);
        s.add_rhs(1, 10.0);
        s.solve().unwrap();
        assert!((s.x[0] - 1.0).abs() < 1e-12);
        assert!((s.x[1] - 3.0).abs() < 1e-12);
    }

    #[test]
    fn detects_a_singular_matrix() {
        let mut s = LinearSystem::new();
        s.resize(2).unwrap();
        s.add(0, 0, 1.0);
        s.add(0, 1, 1.0);
        s.add(1, 0, 2.0);
        s.add(1, 1, 2.0);
        s.add_rhs(0, 1.0);
        assert_eq!(s.solve(), Err(SolveError::Singular));
    }

    #[test]
    fn reuses_factors_across_right_hand_sides() {
        let mut s = LinearSystem::new();
        s.resize(2).unwrap();
        s.add(0, 0, 4.0);
        s.add(1, 1, 5.0);
        s.add_rhs(0, 8.0);
        s.snapshot();
        s.solve().unwrap();
        assert!((s.x[0] - 2.0).abs() < 1e-12);

        s.restore_rhs();
        s.add_rhs(1, 15.0);
        assert!(s.is_factored());
        s.solve().unwrap();
        assert!((s.x[0] - 2.0).abs() < 1e-12);
        assert!((s.x[1] - 3.0).abs() < 1e-12);
    }

    #[test]
    fn rejects_an_oversized_resize_instead_of_overflowing() {
        // A hand-edited netlist can derive a closure size whose dense
        // allocation is absurd, and whose `n * n` would overflow a 32-bit
        // `usize`. The resize must report the guard (checked multiplication
        // and the row cap), never panic, wrap a size, or attempt the
        // allocation.
        let mut s = LinearSystem::new();
        let err = s.resize(MAX_DENSE_ROWS + 1).unwrap_err();
        assert!(err.contains("too large"), "{err}");
        assert_eq!(s.size(), 0, "a rejected resize must leave the system empty");
        let err = s.resize(usize::MAX).unwrap_err();
        assert!(err.contains("too large"), "{err}");
        assert_eq!(s.size(), 0, "a rejected resize must leave the system empty");
    }

    #[test]
    fn solver_resize_reports_the_guard() {
        let mut s = Solver::new();
        let err = s
            .resize(MAX_MATRIX_ROWS + 1, SolverType::Sparse)
            .unwrap_err();
        assert!(err.contains("too large"), "{err}");
        let err = s.resize(MAX_DENSE_ROWS + 1, SolverType::Dense).unwrap_err();
        assert!(err.contains("too large"), "{err}");
    }
}
