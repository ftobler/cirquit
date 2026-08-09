//! MNA stamping helpers.
//!
//! Node numbering: node `0` is the reference ("ground") and is *not* given a
//! row. Node `k > 0` owns a row in its matrix closure. Voltage-source current
//! unknowns follow each closure's node block.
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
//!
//! Every element-facing method signature matches the pre-closure Stamper, so
//! element files are untouched. What changed internally: the systems are one
//! [`Closure`] per connected component, and the node-based stamps route by each
//! node's *own* closure, exactly as upstream's `stampMatrix` reads `i.matrix`
//! per node (SimulationManager.java:1229-1268). A stamp whose two nodes fall in
//! different closures is dropped, the way upstream returns on a matrix
//! mismatch: correct elements never stamp across closures.
//!
//! The controlled-source helpers layer on an already-stamped voltage source:
//! `vcvs` extends the source's constraint row with control voltages, `cccs`
//! couples the source's current unknown into node rows. Both must be called
//! after the underlying `voltage_source`.

use crate::closure::Closure;

/// The reference node. Never allocated a matrix row.
pub const GROUND: usize = 0;

pub struct Stamper<'a> {
    closures: &'a mut [Closure],
    /// Closure index per global node id.
    node_closure: &'a [usize],
    /// Closure-local row per global node id.
    node_row: &'a [usize],
    /// Closure index per global voltage-source index.
    vs_closure: &'a [usize],
    /// Closure-local row per global voltage-source index.
    vs_row: &'a [usize],
    /// Closure index per element, routing the raw-row ops (`raw`, `raw_rhs`)
    /// which the op-amp issues against pre-resolved closure-local rows.
    element_closure: &'a [usize],
    /// Closure the raw-row ops dispatch into; set by `set_current`.
    active: usize,
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
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        closures: &'a mut [Closure],
        node_closure: &'a [usize],
        node_row: &'a [usize],
        vs_closure: &'a [usize],
        vs_row: &'a [usize],
        element_closure: &'a [usize],
    ) -> Self {
        Self {
            closures,
            node_closure,
            node_row,
            vs_closure,
            vs_row,
            element_closure,
            active: 0,
            converged: true,
            current: 0,
            failing: Vec::new(),
        }
    }

    /// Names the element whose `do_step` is about to stamp, and points the
    /// raw-row ops at its closure.
    #[inline]
    pub fn set_current(&mut self, i: usize) {
        self.current = i;
        self.active = self.element_closure[i];
    }

    /// Matrix row/column for a node, or `None` for ground. The row is local to
    /// the node's own closure, which is the active one for every element that
    /// reads it.
    #[inline]
    pub fn node_row(&self, node: usize) -> Option<usize> {
        if node == GROUND {
            None
        } else {
            Some(self.node_row[node])
        }
    }

    /// Matrix row/column for a voltage-source current unknown.
    #[inline]
    pub fn vs_row(&self, vs: usize) -> usize {
        self.vs_row[vs]
    }

    /// Raw matrix entry, in already-resolved closure-local row/column indices.
    #[inline]
    pub fn raw(&mut self, row: usize, col: usize, v: f64) {
        self.closures[self.active].sys.add(row, col, v);
    }

    /// Raw right-hand-side entry, in already-resolved closure-local row index.
    #[inline]
    pub fn raw_rhs(&mut self, row: usize, v: f64) {
        self.closures[self.active].sys.add_rhs(row, v);
    }

    /// Adds `v` at the intersection of two nodes, skipping ground and any
    /// pair that straddles closures.
    #[inline]
    pub fn node_pair(&mut self, a: usize, b: usize, v: f64) {
        if a == GROUND || b == GROUND {
            return;
        }
        let ca = self.node_closure[a];
        debug_assert_eq!(ca, self.node_closure[b], "stamp straddles closures");
        if ca == self.node_closure[b] {
            self.closures[ca]
                .sys
                .add(self.node_row[a], self.node_row[b], v);
        }
    }

    /// Injects `v` into a node's right-hand side, skipping ground.
    #[inline]
    pub fn node_rhs(&mut self, node: usize, v: f64) {
        if node != GROUND {
            let c = self.node_closure[node];
            self.closures[c].sys.add_rhs(self.node_row[node], v);
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
        let c = self.vs_closure[vs];
        let vn = self.vs_row[vs];
        let r1 = if n1 == GROUND {
            None
        } else {
            Some(self.node_row[n1])
        };
        let r2 = if n2 == GROUND {
            None
        } else {
            Some(self.node_row[n2])
        };
        let sys = &mut self.closures[c].sys;
        if let Some(r) = r1 {
            // The stamped terminals must live in the closure the unknown was
            // assigned to; a tear here means the VS-owning element's
            // `voltage_source_nodes` disagrees with its stamp.
            debug_assert_eq!(self.node_closure[n1], c, "VS terminal straddles closures");
            sys.add(r, vn, 1.0);
            sys.add(vn, r, -1.0);
        }
        if let Some(r) = r2 {
            debug_assert_eq!(self.node_closure[n2], c, "VS terminal straddles closures");
            sys.add(r, vn, -1.0);
            sys.add(vn, r, 1.0);
        }
        sys.add_rhs(vn, v);
    }

    /// Updates only the value of an already-stamped voltage source. Used on
    /// every timestep by time-varying sources, which leaves the matrix (and
    /// therefore its LU factors) untouched.
    pub fn voltage_source_value(&mut self, vs: usize, v: f64) {
        let c = self.vs_closure[vs];
        self.closures[c].sys.add_rhs(self.vs_row[vs], v);
    }

    /// A voltage-controlled current source: `i = gain * (V(cn1) - V(cn2))`
    /// delivered into `n2` and drawn from `n1`.
    pub fn vccs(&mut self, n1: usize, n2: usize, cn1: usize, cn2: usize, gain: f64) {
        self.node_pair(n1, cn1, gain);
        self.node_pair(n1, cn2, -gain);
        self.node_pair(n2, cn1, -gain);
        self.node_pair(n2, cn2, gain);
    }

    /// A voltage-controlled voltage source, layered on an already-stamped
    /// `voltage_source`: adds `coef` at the `vs` constraint row's `n1` column
    /// and `-coef` at its `n2` column (upstream's `stampVCVS`,
    /// SimulationManager.java:1151-1154). The constraint row therefore picks
    /// up `coef*(V(n1) - V(n2))` from the control terminals, so the CC2's
    /// `voltage_source(GROUND, X, vs, 0)` plus `vcvs(GROUND, Y, 1, vs)` makes
    /// X follow Y. Must be called after `voltage_source`, and the control
    /// terminals must live in the source's closure.
    pub fn vcvs(&mut self, n1: usize, n2: usize, coef: f64, vs: usize) {
        let c = self.vs_closure[vs];
        let vn = self.vs_row[vs];
        let r1 = self.node_row(n1);
        let r2 = self.node_row(n2);
        let sys = &mut self.closures[c].sys;
        if let Some(r) = r1 {
            debug_assert_eq!(self.node_closure[n1], c, "VCVS terminal straddles closures");
            sys.add(vn, r, coef);
        }
        if let Some(r) = r2 {
            debug_assert_eq!(self.node_closure[n2], c, "VCVS terminal straddles closures");
            sys.add(vn, r, -coef);
        }
    }

    /// A current-controlled current source: delivers `gain * I(vs)` into `n2`
    /// and draws it from `n1`, where `I(vs)` is the current through the
    /// already-stamped voltage source `vs` (upstream's `stampCCCS`,
    /// SimulationManager.java:1217-1220). Adds `gain` at the `n1` node row's
    /// `vs` column and `-gain` at `n2`'s.
    pub fn cccs(&mut self, n1: usize, n2: usize, vs: usize, gain: f64) {
        let vn = self.vs_row[vs];
        let vc = self.vs_closure[vs];
        if n1 != GROUND {
            let c = self.node_closure[n1];
            debug_assert_eq!(c, vc, "CCCS control source straddles closures");
            if c == vc {
                self.closures[c].sys.add(self.node_row[n1], vn, gain);
            }
        }
        if n2 != GROUND {
            let c = self.node_closure[n2];
            debug_assert_eq!(c, vc, "CCCS control source straddles closures");
            if c == vc {
                self.closures[c].sys.add(self.node_row[n2], vn, -gain);
            }
        }
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
