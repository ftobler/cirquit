//! Sparse linear-system backend for large closures.
//!
//! Dense LU is `O(n^3)`, fine to a few hundred rows per closure and unusable
//! in the thousands. This module is a hand-rolled left-looking sparse LU with
//! column partial pivoting and row scaling over CSC, the same algorithm family
//! upstream runs (SparseLU.java, itself EJML's left-looking solver, selected at
//! the same 150-row threshold). The dense path stays the default and the
//! correctness baseline below the threshold; [`SparseSystem`] mirrors
//! [`crate::matrix::LinearSystem`]'s method surface so
//! [`crate::closure::Closure`] can hold either backend behind the
//! [`crate::matrix::Solver`] enum.
//!
//! The stamped matrix lives in a row-major accumulator of `BTreeMap`s (column
//! -> value). `BTreeMap` keeps iteration deterministic and lets a pair, once
//! introduced, stay a member of the structure until resize: the monotone pair
//! set. That is what makes `restore()` structure-preserving, so the LU pattern
//! is stable across Newton iterations even for the op-amp, whose `do_step`
//! introduces pairs the constant stamp never wrote.
//!
//! The factor consumes the matrix column by column, so the accumulator is
//! converted to CSC once per structural change. A structure-version counter,
//! bumped only when `add` introduces a brand-new pair, lets a refactor skip
//! the conversion when nothing structural changed.

use std::collections::BTreeMap;

use crate::matrix::{matrix_too_large, SolveError, MAX_MATRIX_ROWS};

/// Row-major accumulator of the stamped matrix, plus its snapshot.
///
/// `rows[row]` maps column to value. `add` inserts the pair even when the
/// value is zero, so the pair set is monotone within a resize: once a pair
/// exists it stays, which keeps the factor's pattern (and therefore its LU
/// structure) stable across Newton iterations. `restore` rewrites the
/// snapshot's values back and zeroes any pair the snapshot never wrote,
/// without removing it.
#[derive(Clone)]
pub(crate) struct CscMatrix {
    n: usize,
    rows: Vec<BTreeMap<usize, f64>>,
    /// Snapshot of `rows`, in the same row-major shape so `restore` can
    /// reconcile a touched row against it without scanning the whole matrix.
    base_rows: Vec<BTreeMap<usize, f64>>,
    /// Rows modified since the last `restore`/`snapshot`, so `restore` only
    /// walks the rows that changed.
    touched: Vec<usize>,
    touched_mark: Vec<bool>,
    /// Monotone structure version: bumps when `add` introduces a brand-new
    /// pair. The factor skips the accumulator -> CSC conversion when the
    /// version is unchanged.
    version: u64,
}

impl CscMatrix {
    fn new(n: usize) -> Self {
        Self {
            n,
            rows: (0..n).map(|_| BTreeMap::new()).collect(),
            base_rows: (0..n).map(|_| BTreeMap::new()).collect(),
            touched: Vec::new(),
            touched_mark: vec![false; n],
            version: 0,
        }
    }

    /// Adds `v` to `(row, col)`. A brand-new pair bumps the structure version;
    /// a value change on an existing pair does not. The pair is inserted even
    /// for `v == 0.0`, the property that keeps the pair set monotone.
    fn add(&mut self, row: usize, col: usize, v: f64) {
        debug_assert!(row < self.n && col < self.n);
        let map = &mut self.rows[row];
        match map.entry(col) {
            std::collections::btree_map::Entry::Vacant(e) => {
                e.insert(v);
                self.version += 1;
            }
            std::collections::btree_map::Entry::Occupied(mut e) => {
                *e.get_mut() += v;
            }
        }
        if !self.touched_mark[row] {
            self.touched_mark[row] = true;
            self.touched.push(row);
        }
    }

    fn get(&self, row: usize, col: usize) -> f64 {
        debug_assert!(row < self.n && col < self.n);
        self.rows[row].get(&col).copied().unwrap_or(0.0)
    }

    /// Snapshots the working matrix as the base for later timesteps.
    fn snapshot(&mut self) {
        for (dst, src) in self.base_rows.iter_mut().zip(self.rows.iter()) {
            dst.clone_from(src);
        }
        self.touched.clear();
        self.touched_mark.iter_mut().for_each(|m| *m = false);
    }

    /// Restores the snapshot so the per-timestep contributions can be re-added.
    /// Base values are written back and post-snapshot pairs are zeroed but
    /// kept, so the structure version stays put and the factor's cached
    /// pattern survives the Newton iterations.
    fn restore(&mut self) {
        let Self {
            rows,
            base_rows,
            touched,
            touched_mark,
            ..
        } = self;
        for r in touched.drain(..) {
            touched_mark[r] = false;
            let wm = &mut rows[r];
            let bm = &base_rows[r];
            for (&c, &v) in bm.iter() {
                wm.insert(c, v);
            }
            let extra: Vec<usize> = wm
                .keys()
                .filter(|&&c| !bm.contains_key(&c))
                .copied()
                .collect();
            for c in extra {
                wm.insert(c, 0.0);
            }
        }
    }
}

/// Left-looking sparse LU over CSC, with column partial pivoting and row
/// scaling (the Gilbert-Peierls family).
///
/// The numeric pass factors column by column. For each column `k`, the reach
/// of A's column `k` through the already-factored columns of L is computed by
/// a DFS over L's pattern: the sparse forward substitution that produces one
/// column of the Schur complement. The pivot is the reach row of largest
/// magnitude with first-seen tie-breaking, matching the dense path's strict
/// `>` selection. A zero or absent pivot, or any non-finite accumulated entry,
/// reports [`SolveError::Singular`].
#[derive(Clone)]
pub(crate) struct SparseLU {
    n: usize,
    /// A's pattern as CSC, cached across numeric passes by `pattern_version`.
    a_col_ptr: Vec<usize>,
    a_row_ids: Vec<usize>,
    /// Version of the accumulator the `a_*` pattern was built from.
    pattern_version: u64,
    /// L and U as CSC. L's row ids are original rows during the numeric pass
    /// and are remapped to the permuted space at the end, which is what the
    /// forward and back substitutions read.
    l_col_ptr: Vec<usize>,
    l_row_ids: Vec<usize>,
    l_values: Vec<f64>,
    u_col_ptr: Vec<usize>,
    u_row_ids: Vec<usize>,
    u_values: Vec<f64>,
    /// `pinv[row]` = the pivot column where `row` is the diagonal of L and U.
    pinv: Vec<usize>,
    /// Scratch: the forward-substitution vector for the current column.
    x: Vec<f64>,
    /// Scratch: DFS stack and reach, rows `top..n` after each column pass.
    xi: Vec<usize>,
    /// Scratch: DFS visited marks and per-stack-slot column resume indices.
    w: Vec<usize>,
    /// Multiply-adds performed by numeric passes since the last resize, for
    /// the deterministic speedup tests. Same scope as the dense counter:
    /// factorization only, never the solves.
    flops: u64,
}

impl SparseLU {
    fn new(n: usize) -> Self {
        Self {
            n,
            a_col_ptr: Vec::new(),
            a_row_ids: Vec::new(),
            pattern_version: u64::MAX,
            l_col_ptr: Vec::new(),
            l_row_ids: Vec::new(),
            l_values: Vec::new(),
            u_col_ptr: Vec::new(),
            u_row_ids: Vec::new(),
            u_values: Vec::new(),
            pinv: vec![usize::MAX; n],
            x: vec![0.0; n],
            xi: vec![0; n],
            w: vec![0; 2 * n],
            flops: 0,
        }
    }

    /// Rebuilds A's CSC pattern from the accumulator when its structure
    /// version moved. A cheap no-op when nothing structural changed: the
    /// numeric pass reads values straight from the accumulator, so a value
    /// change never needs the pattern rebuilt.
    fn symbolic(&mut self, matrix: &CscMatrix) {
        if self.pattern_version == matrix.version {
            return;
        }
        let n = self.n;
        let mut counts = vec![0usize; n];
        for map in matrix.rows.iter() {
            for &c in map.keys() {
                counts[c] += 1;
            }
        }
        self.a_col_ptr = Vec::with_capacity(n + 1);
        self.a_col_ptr.push(0);
        for count in counts {
            let prev = *self.a_col_ptr.last().unwrap();
            self.a_col_ptr.push(prev + count);
        }
        self.a_row_ids = vec![0usize; self.a_col_ptr[n]];
        // Rows are walked in order, so every column's entries come out sorted
        // by row: deterministic, and the forward substitution can rely on it.
        let mut cursor = self.a_col_ptr.clone();
        for (r, map) in matrix.rows.iter().enumerate() {
            for &c in map.keys() {
                let pos = cursor[c];
                self.a_row_ids[pos] = r;
                cursor[c] += 1;
            }
        }
        self.pattern_version = matrix.version;
    }

    /// Factors A. The non-finite scan and the per-row scaling both mirror the
    /// dense pass (matrix.rs:139-162): any NaN or Inf anywhere poisons the
    /// factor, a row with no finite magnitude is Singular, and pivoting
    /// compares `|entry| / max|row|` so siemens and volt rows stay on the
    /// same footing.
    fn numeric(&mut self, matrix: &CscMatrix) -> Result<(), SolveError> {
        let n = self.n;
        let mut scale = vec![0.0f64; n];
        for (r, map) in matrix.rows.iter().enumerate() {
            let mut largest = 0.0f64;
            for &v in map.values() {
                if !v.is_finite() {
                    return Err(SolveError::Singular);
                }
                largest = largest.max(v.abs());
            }
            if largest == 0.0 {
                return Err(SolveError::Singular);
            }
            scale[r] = 1.0 / largest;
        }
        if n == 0 {
            return Ok(());
        }
        self.pinv.fill(usize::MAX);
        self.l_col_ptr = vec![0];
        self.u_col_ptr = vec![0];
        self.l_row_ids.clear();
        self.l_values.clear();
        self.u_row_ids.clear();
        self.u_values.clear();
        for k in 0..n {
            // `l_col_ptr[k]` must hold the start of column k before the reach,
            // whose DFS reads `l_col_ptr[pinv[row] + 1]` (up to k) for the
            // already-pivoted rows of the reach.
            let top = self.solve_col_b(matrix, k);
            let mut ipiv = usize::MAX;
            let mut largest = 0.0f64;
            for &i in &self.xi[top..n] {
                if self.pinv[i] == usize::MAX {
                    let t = self.x[i].abs() * scale[i];
                    if t > largest {
                        largest = t;
                        ipiv = i;
                    }
                } else {
                    self.u_row_ids.push(self.pinv[i]);
                    self.u_values.push(self.x[i]);
                }
            }
            if ipiv == usize::MAX || largest == 0.0 {
                return Err(SolveError::Singular);
            }
            let pivot = self.x[ipiv];
            self.u_row_ids.push(k);
            self.u_values.push(pivot);
            self.pinv[ipiv] = k;
            self.l_row_ids.push(ipiv);
            self.l_values.push(1.0);
            for &i in &self.xi[top..n] {
                if self.pinv[i] == usize::MAX {
                    self.l_row_ids.push(i);
                    self.l_values.push(self.x[i] / pivot);
                }
                self.x[i] = 0.0;
            }
            self.l_col_ptr.push(self.l_row_ids.len());
            self.u_col_ptr.push(self.u_row_ids.len());
        }
        // Remap L's row ids into the permuted space so the solves read a unit
        // lower triangular L.
        for row in self.l_row_ids.iter_mut() {
            *row = self.pinv[*row];
        }
        Ok(())
    }

    /// Reach solve for one column of A through the already-factored L,
    /// upstream's `solveColB`. Returns the reach in `xi[top..n]` and leaves
    /// the solved column in `x`.
    fn solve_col_b(&mut self, matrix: &CscMatrix, k: usize) -> usize {
        let n = self.n;
        let a_col_ptr = &self.a_col_ptr;
        let a_row_ids = &self.a_row_ids;
        let l_col_ptr = &self.l_col_ptr;
        let l_row_ids = &self.l_row_ids;
        let l_values = &self.l_values;
        let pinv = &self.pinv;
        let x = &mut self.x;
        let xi = &mut self.xi;
        let w = &mut self.w;

        let mut top = n;
        for &row_b in &a_row_ids[a_col_ptr[k]..a_col_ptr[k + 1]] {
            if row_b < n && w[row_b] == 0 {
                top = reach_dfs(row_b, n, top, pinv, l_col_ptr, l_row_ids, xi, w);
            }
        }
        for i in top..n {
            w[xi[i]] = 0;
        }
        for i in top..n {
            x[xi[i]] = 0.0;
        }
        // Values come from the accumulator, so a value change between factors
        // needs no pattern work.
        for &row in &a_row_ids[a_col_ptr[k]..a_col_ptr[k + 1]] {
            x[row] = matrix.get(row, k);
        }
        let mut flops = 0u64;
        for &j in &xi[top..n] {
            let jj = pinv[j];
            if jj != usize::MAX {
                // The diagonal is the first entry of the column (always
                // exactly 1.0 here); divide by it, then scatter the entries
                // below into x.
                x[j] /= l_values[l_col_ptr[jj]];
                let mut e = l_col_ptr[jj] + 1;
                let end = l_col_ptr[jj + 1];
                while e < end {
                    x[l_row_ids[e]] -= l_values[e] * x[j];
                    flops += 1;
                    e += 1;
                }
            }
        }
        self.flops += flops;
        top
    }

    /// Forward substitution through L, in the permuted space.
    fn solve_l(&self, x: &mut [f64]) {
        for col in 0..self.n {
            let mut e = self.l_col_ptr[col];
            let end = self.l_col_ptr[col + 1];
            x[col] /= self.l_values[e];
            e += 1;
            while e < end {
                let row = self.l_row_ids[e];
                x[row] -= self.l_values[e] * x[col];
                e += 1;
            }
        }
    }

    /// Back substitution through U, in the permuted space.
    fn solve_u(&self, x: &mut [f64]) {
        for col in (0..self.n).rev() {
            let mut e = self.u_col_ptr[col];
            let end = self.u_col_ptr[col + 1];
            // The diagonal is the last entry of the column.
            x[col] /= self.u_values[end - 1];
            while e < end - 1 {
                let row = self.u_row_ids[e];
                x[row] -= self.u_values[e] * x[col];
                e += 1;
            }
        }
    }

    /// Multiply-adds accumulated by factor passes since the last resize.
    fn flops(&self) -> u64 {
        self.flops
    }
}

/// Iterative depth-first search over the elimination-tree edges L represents:
/// node `row` connects to the rows below the diagonal of L's column
/// `pinv[row]`. `xi[top..n]` receives the reach in post-order (children before
/// parents), which is exactly the order the forward substitution processes it
/// in. Returns the new `top`.
#[allow(clippy::too_many_arguments)]
fn reach_dfs(
    row_b: usize,
    n: usize,
    mut top: usize,
    pinv: &[usize],
    l_col_ptr: &[usize],
    l_row_ids: &[usize],
    xi: &mut [usize],
    w: &mut [usize],
) -> usize {
    let mut head = 0usize;
    xi[0] = row_b;
    loop {
        let g_col = xi[head];
        let g_col_new = pinv[g_col];
        if w[g_col] == 0 {
            w[g_col] = 1;
            // Resume position for this stack slot: the start of the node's L
            // column, set once when the node is first visited.
            w[n + head] = if g_col_new != usize::MAX {
                l_col_ptr[g_col_new]
            } else {
                0
            };
        }
        let mut done = true;
        let idx0 = w[n + head];
        let idx1 = if g_col_new != usize::MAX {
            l_col_ptr[g_col_new + 1]
        } else {
            0
        };
        for (off, &jrow) in l_row_ids[idx0..idx1].iter().enumerate() {
            if jrow < n && w[jrow] == 0 {
                // Descend into this entry; remember where to resume the scan.
                w[n + head] = idx0 + off + 1;
                head += 1;
                xi[head] = jrow;
                done = false;
                break;
            }
        }
        if done {
            top -= 1;
            xi[top] = g_col;
            if head == 0 {
                break;
            }
            head -= 1;
        }
    }
    top
}

/// The [`crate::matrix::LinearSystem`] facade for the sparse backend.
///
/// Owns the working matrix, its snapshot and the factor, and exposes the same
/// method surface as the dense system so [`crate::matrix::Solver`] can hold
/// either without call-site changes.
#[derive(Clone)]
pub struct SparseSystem {
    n: usize,
    matrix: CscMatrix,
    b: Vec<f64>,
    base_b: Vec<f64>,
    lu: SparseLU,
    factored: bool,
    pub x: Vec<f64>,
}

impl Default for SparseSystem {
    fn default() -> Self {
        Self::new()
    }
}

impl SparseSystem {
    pub fn new() -> Self {
        Self {
            n: 0,
            matrix: CscMatrix::new(0),
            b: Vec::new(),
            base_b: Vec::new(),
            lu: SparseLU::new(0),
            factored: false,
            x: Vec::new(),
        }
    }

    /// Discards all state and allocates an `n`-node system of zeroes. Errors
    /// when `n` exceeds [`MAX_MATRIX_ROWS`]: the sparse structure is O(n), so
    /// the cap is a sanity bound on untrusted netlists rather than an
    /// allocation limit, and an absurd closure size must be reported as an
    /// invalid circuit instead of attempted.
    pub fn resize(&mut self, n: usize) -> Result<(), String> {
        if n > MAX_MATRIX_ROWS {
            return Err(matrix_too_large(n, MAX_MATRIX_ROWS));
        }
        self.n = n;
        self.matrix = CscMatrix::new(n);
        self.b = vec![0.0; n];
        self.base_b = vec![0.0; n];
        self.lu = SparseLU::new(n);
        self.factored = false;
        self.x = vec![0.0; n];
        Ok(())
    }

    #[inline]
    pub fn size(&self) -> usize {
        self.n
    }

    #[inline]
    pub fn add(&mut self, row: usize, col: usize, v: f64) {
        self.matrix.add(row, col, v);
    }

    #[inline]
    pub fn add_rhs(&mut self, row: usize, v: f64) {
        debug_assert!(row < self.n);
        self.b[row] += v;
    }

    #[inline]
    pub fn get(&self, row: usize, col: usize) -> f64 {
        self.matrix.get(row, col)
    }

    /// Snapshots the current matrix as the reusable base for later timesteps.
    pub fn snapshot(&mut self) {
        self.matrix.snapshot();
        self.base_b.copy_from_slice(&self.b);
        self.factored = false;
    }

    /// Restores the snapshot so the per-timestep contributions can be re-added.
    pub fn restore(&mut self) {
        self.matrix.restore();
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
        self.lu.flops()
    }

    /// LU-factors the matrix, no-op if the cached factorisation is valid.
    pub fn factor(&mut self) -> Result<(), SolveError> {
        if self.factored {
            return Ok(());
        }
        self.lu.symbolic(&self.matrix);
        self.lu.numeric(&self.matrix)?;
        self.factored = true;
        Ok(())
    }

    /// Solves for the current right-hand side using the cached factors.
    pub fn solve(&mut self) -> Result<(), SolveError> {
        self.factor()?;
        let n = self.n;
        if n == 0 {
            return Ok(());
        }
        // x = P b: the row permutation the factorization's pivot choices
        // imply, `Pb[j] = b[pinv^-1(j)]`. The factors satisfy L U = P A, so
        // solving L U x = P b yields the natural-order solution directly, the
        // same way the dense path permutes only `b`.
        let pinv = &self.lu.pinv;
        for (k, &p) in pinv.iter().enumerate() {
            self.x[p] = self.b[k];
        }
        self.lu.solve_l(&mut self.x);
        self.lu.solve_u(&mut self.x);
        for v in self.x.iter() {
            if !v.is_finite() {
                return Err(SolveError::Singular);
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::matrix::Solver;
    use crate::matrix::SolverBackend;
    use crate::spec::SolverType;

    /// Builds the analytic far-corner test system: `chains` resistor chains of
    /// `len` 1 ohm resistors each fanning out from one driven node (row 0),
    /// with 1 A injected into the driven node. Each chain has `len - 1`
    /// non-ground junction nodes (the far corner is one resistor from
    /// ground), matching the plan's grid mirror. The chains are all in
    /// parallel and each is `len` ohms, so the driven node sits at
    /// `len/chains` V and each chain's far corner at `1/chains` V.
    fn stamp_fan<F: FnMut(usize, usize, f64)>(chains: usize, len: usize, mut add: F) {
        for c in 0..chains {
            let base = c * (len - 1);
            let n1 = base + 1;
            add(0, 0, 1.0);
            add(0, n1, -1.0);
            add(n1, 0, -1.0);
            add(n1, n1, 1.0);
            for k in 2..=len - 1 {
                let prev = base + (k - 1);
                let cur = base + k;
                add(prev, prev, 1.0);
                add(prev, cur, -1.0);
                add(cur, prev, -1.0);
                add(cur, cur, 1.0);
            }
            // The chain's last resistor runs from the far corner to ground,
            // which only loads the corner's diagonal.
            let far = base + len - 1;
            add(far, far, 1.0);
        }
    }

    fn fan_rhs<F: FnMut(usize, f64)>(mut add: F) {
        add(0, 1.0);
    }

    fn make_fan(chains: usize, len: usize) -> SparseSystem {
        let mut sys = SparseSystem::new();
        sys.resize(1 + chains * (len - 1)).unwrap();
        stamp_fan(chains, len, |r, c, v| sys.add(r, c, v));
        fan_rhs(|r, v| sys.add_rhs(r, v));
        sys
    }

    #[test]
    fn sparse_solves_a_small_system() {
        // A star: node A joins nodes B and C through 1 ohm resistors, and B
        // and C each carry a 1 ohm resistor to ground. Injecting 3 A into A
        // puts A at 3 V and both B and C at 1.5 V.
        let mut sys = SparseSystem::new();
        sys.resize(3).unwrap();
        sys.add(0, 0, 2.0);
        sys.add(0, 1, -1.0);
        sys.add(0, 2, -1.0);
        sys.add(1, 0, -1.0);
        sys.add(1, 1, 2.0);
        sys.add(2, 0, -1.0);
        sys.add(2, 2, 2.0);
        sys.add_rhs(0, 3.0);
        sys.solve().unwrap();
        assert!((sys.x[0] - 3.0).abs() < 1e-12);
        assert!((sys.x[1] - 1.5).abs() < 1e-12);
        assert!((sys.x[2] - 1.5).abs() < 1e-12);
    }

    #[test]
    fn sparse_matches_dense_on_a_structured_matrix() {
        let mut sparse = make_fan(40, 40);
        let mut dense = crate::matrix::LinearSystem::new();
        dense.resize(1 + 40 * 39).unwrap();
        stamp_fan(40, 40, |r, c, v| dense.add(r, c, v));
        fan_rhs(|r, v| dense.add_rhs(r, v));
        sparse.solve().unwrap();
        dense.solve().unwrap();
        for k in 0..sparse.x.len() {
            assert!(
                (sparse.x[k] - dense.x[k]).abs() < 1e-9,
                "row {k} diverged: sparse {} vs dense {}",
                sparse.x[k],
                dense.x[k]
            );
        }
        assert!(
            (sparse.x[0] - 1.0).abs() < 1e-9,
            "driven node was {}",
            sparse.x[0]
        );
        for c in 0..40 {
            let corner = sparse.x[(c + 1) * 39];
            assert!(
                (corner - 0.025).abs() < 1e-9,
                "chain {c} far corner was {corner}"
            );
        }
    }

    #[test]
    fn sparse_detects_a_singular_system() {
        let mut sys = SparseSystem::new();
        sys.resize(2).unwrap();
        sys.add(0, 0, 1.0);
        sys.add(0, 1, 1.0);
        sys.add(1, 0, 1.0);
        sys.add(1, 1, 1.0);
        sys.add_rhs(0, 1.0);
        assert_eq!(sys.solve(), Err(SolveError::Singular));
    }

    #[test]
    fn sparse_poisons_on_nonfinite_entries() {
        let mut sys = SparseSystem::new();
        sys.resize(2).unwrap();
        sys.add(0, 0, f64::NAN);
        sys.add(1, 1, 1.0);
        assert_eq!(sys.solve(), Err(SolveError::Singular));
    }

    #[test]
    fn sparse_reuses_factors_across_right_hand_sides() {
        let mut sys = SparseSystem::new();
        sys.resize(2).unwrap();
        sys.add(0, 0, 4.0);
        sys.add(1, 1, 5.0);
        sys.add_rhs(0, 8.0);
        sys.snapshot();
        sys.solve().unwrap();
        assert!((sys.x[0] - 2.0).abs() < 1e-12);

        let flops = sys.flops();
        sys.restore_rhs();
        sys.add_rhs(1, 15.0);
        assert!(sys.is_factored());
        sys.solve().unwrap();
        assert!((sys.x[0] - 2.0).abs() < 1e-12);
        assert!((sys.x[1] - 3.0).abs() < 1e-12);
        assert_eq!(sys.flops(), flops, "factors must be reused, not refactored");
    }

    #[test]
    fn sparse_symbolic_is_stable_across_value_changes() {
        let mut sys = SparseSystem::new();
        sys.resize(2).unwrap();
        sys.add(0, 0, 2.0);
        sys.add(0, 1, 1.0);
        sys.add(1, 0, 1.0);
        sys.add(1, 1, 3.0);
        sys.add_rhs(0, 5.0);
        sys.add_rhs(1, 10.0);
        sys.snapshot();
        let version = sys.matrix.version;
        sys.solve().unwrap();
        assert!((sys.x[0] - 1.0).abs() < 1e-12);
        assert!((sys.x[1] - 3.0).abs() < 1e-12);

        // Value changes on existing pairs only: the structure must not move.
        sys.restore();
        sys.add(0, 0, 4.0);
        sys.add(1, 1, 1.0);
        sys.invalidate();
        sys.solve().unwrap();
        assert_eq!(sys.matrix.version, version, "structure version moved");
        // [6 1; 1 4] x = [5; 10] -> x = [10/23; 55/23].
        assert!((sys.x[0] - 10.0 / 23.0).abs() < 1e-12);
        assert!((sys.x[1] - 55.0 / 23.0).abs() < 1e-12);
    }

    #[test]
    fn sparse_solve_is_deterministic() {
        let mut sys = make_fan(8, 8);
        sys.snapshot();
        sys.solve().unwrap();
        let first = sys.x.clone();
        sys.restore_rhs();
        sys.solve().unwrap();
        assert_eq!(sys.x, first, "the second solve drifted from the first");
    }

    #[test]
    fn solver_resize_picks_the_backend() {
        let mut auto = Solver::new();
        auto.resize(50, SolverType::Auto).unwrap();
        assert_eq!(auto.backend(), SolverBackend::Dense);
        auto.resize(200, SolverType::Auto).unwrap();
        assert_eq!(auto.backend(), SolverBackend::Sparse);

        let mut sparse = Solver::new();
        sparse.resize(50, SolverType::Sparse).unwrap();
        assert_eq!(sparse.backend(), SolverBackend::Sparse);
        sparse.resize(200, SolverType::Sparse).unwrap();
        assert_eq!(sparse.backend(), SolverBackend::Sparse);

        let mut dense = Solver::new();
        dense.resize(200, SolverType::Dense).unwrap();
        assert_eq!(dense.backend(), SolverBackend::Dense);
    }

    #[test]
    fn sparse_resize_rejects_an_absurd_row_count() {
        let mut sys = SparseSystem::new();
        let err = sys.resize(MAX_MATRIX_ROWS + 1).unwrap_err();
        assert!(err.contains("too large"), "{err}");
        assert_eq!(
            sys.size(),
            0,
            "a rejected resize must leave the system empty"
        );
    }
}
