//! Dense linear system with LU factorisation (Doolittle, partial pivoting).
//!
//! The simulator assembles a modified-nodal-analysis system `A x = b` every
//! timestep. For a purely linear circuit `A` is constant, so it is factored
//! once and only the right-hand side is re-solved; nonlinear circuits refactor
//! on every Newton iteration.

/// Reasons a solve can fail.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SolveError {
    /// The matrix has no usable pivot: typically a floating subcircuit, a
    /// shorted voltage source, or two ideal sources fighting over one node.
    Singular,
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

    /// Discards all state and allocates an `n x n` system of zeroes.
    pub fn resize(&mut self, n: usize) {
        self.n = n;
        self.a = vec![0.0; n * n];
        self.b = vec![0.0; n];
        self.base_a = vec![0.0; n * n];
        self.base_b = vec![0.0; n];
        self.lu = vec![0.0; n * n];
        self.perm = (0..n).collect();
        self.x = vec![0.0; n];
        self.factored = false;
        self.flops = 0;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn solves_a_two_by_two() {
        let mut s = LinearSystem::new();
        s.resize(2);
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
        s.resize(2);
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
        s.resize(2);
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
}
