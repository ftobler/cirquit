//! MNA stamping helpers.
//!
//! Node numbering: node `0` is the reference ("ground") and is *not* given a
//! row. Node `k > 0` owns row/column `k - 1`. Voltage-source current unknowns
//! follow the node block, so source `k` owns row `node_count - 1 + k`.
//!
//! Sign convention, applied consistently everywhere:
//!
//! * A node row states `sum of currents leaving the node through elements
//!   = sum of currents injected into the node by sources`.
//! * A voltage source declared as `voltage_source(n1, n2, k, v)` constrains
//!   `V(n2) - V(n1) = v`, and its current unknown is positive when current
//!   flows `n1 -> n2` *inside* the source, i.e. out of terminal `n2`.
//!
//! That makes the source's current match the two-terminal element convention
//! used elsewhere: positive current enters post 0 and leaves post 1.

use crate::matrix::LinearSystem;

/// The reference node. Never allocated a matrix row.
pub const GROUND: usize = 0;

pub struct Stamper<'a> {
    sys: &'a mut LinearSystem,
    /// Row index of voltage source 0.
    vs_offset: usize,
    /// Cleared by nonlinear elements that have not settled yet.
    pub converged: bool,
    /// Element index of the `do_step` currently being stamped. Records which
    /// element a `not_converged` came from, so a failed step can name the
    /// elements that were still moving.
    current: usize,
    /// Element indices that called `not_converged` this iteration, so the
    /// solver can name the non-convergent elements when the budget runs out.
    pub failing: Vec<usize>,
}

impl<'a> Stamper<'a> {
    pub fn new(sys: &'a mut LinearSystem, node_count: usize) -> Self {
        Self {
            sys,
            vs_offset: node_count.saturating_sub(1),
            converged: true,
            current: 0,
            failing: Vec::new(),
        }
    }

    /// Names the element whose `do_step` is about to stamp.
    #[inline]
    pub fn set_current(&mut self, i: usize) {
        self.current = i;
    }

    /// Matrix row/column for a node, or `None` for ground.
    #[inline]
    pub fn node_row(&self, node: usize) -> Option<usize> {
        if node == GROUND {
            None
        } else {
            Some(node - 1)
        }
    }

    /// Matrix row/column for a voltage-source current unknown.
    #[inline]
    pub fn vs_row(&self, vs: usize) -> usize {
        self.vs_offset + vs
    }

    /// Raw matrix entry, in already-resolved row/column indices.
    #[inline]
    pub fn raw(&mut self, row: usize, col: usize, v: f64) {
        self.sys.add(row, col, v);
    }

    /// Raw right-hand-side entry, in already-resolved row index.
    #[inline]
    pub fn raw_rhs(&mut self, row: usize, v: f64) {
        self.sys.add_rhs(row, v);
    }

    /// Adds `v` at the intersection of two nodes, skipping ground.
    #[inline]
    pub fn node_pair(&mut self, a: usize, b: usize, v: f64) {
        if let (Some(r), Some(c)) = (self.node_row(a), self.node_row(b)) {
            self.sys.add(r, c, v);
        }
    }

    /// Injects `v` into a node's right-hand side, skipping ground.
    #[inline]
    pub fn node_rhs(&mut self, node: usize, v: f64) {
        if let Some(r) = self.node_row(node) {
            self.sys.add_rhs(r, v);
        }
    }

    /// A conductance `g` bridging two nodes.
    pub fn conductance(&mut self, n1: usize, n2: usize, g: f64) {
        if !g.is_finite() || g == 0.0 {
            return;
        }
        self.node_pair(n1, n1, g);
        self.node_pair(n2, n2, g);
        self.node_pair(n1, n2, -g);
        self.node_pair(n2, n1, -g);
    }

    /// A resistor of `r` ohms bridging two nodes.
    pub fn resistor(&mut self, n1: usize, n2: usize, r: f64) {
        if r > 0.0 && r.is_finite() {
            self.conductance(n1, n2, 1.0 / r);
        }
    }

    /// An independent current source delivering `i` amps into `n2`, drawn
    /// from `n1`.
    pub fn current_source(&mut self, n1: usize, n2: usize, i: f64) {
        if !i.is_finite() {
            return;
        }
        self.node_rhs(n1, -i);
        self.node_rhs(n2, i);
    }

    /// An ideal voltage source holding `V(n2) - V(n1) = v`.
    pub fn voltage_source(&mut self, n1: usize, n2: usize, vs: usize, v: f64) {
        let vn = self.vs_row(vs);
        if let Some(r) = self.node_row(n1) {
            self.sys.add(r, vn, 1.0);
            self.sys.add(vn, r, -1.0);
        }
        if let Some(r) = self.node_row(n2) {
            self.sys.add(r, vn, -1.0);
            self.sys.add(vn, r, 1.0);
        }
        self.sys.add_rhs(vn, v);
    }

    /// Updates only the value of an already-stamped voltage source. Used on
    /// every timestep by time-varying sources, which leaves the matrix (and
    /// therefore its LU factors) untouched.
    pub fn voltage_source_value(&mut self, vs: usize, v: f64) {
        let vn = self.vs_row(vs);
        self.sys.add_rhs(vn, v);
    }

    /// A voltage-controlled current source: `i = gain * (V(cn1) - V(cn2))`
    /// delivered into `n2` and drawn from `n1`.
    pub fn vccs(&mut self, n1: usize, n2: usize, cn1: usize, cn2: usize, gain: f64) {
        self.node_pair(n1, cn1, gain);
        self.node_pair(n1, cn2, -gain);
        self.node_pair(n2, cn1, -gain);
        self.node_pair(n2, cn2, gain);
    }

    /// Marks the Newton iteration as not yet settled, and records which
    /// element refused to settle.
    #[inline]
    pub fn not_converged(&mut self) {
        self.converged = false;
        if self.failing.last() != Some(&self.current) {
            self.failing.push(self.current);
        }
    }
}
