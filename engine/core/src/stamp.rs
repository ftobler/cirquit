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
use std::collections::HashSet;

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
    /// Optional collector for coefficient-stamp touches, active only on the
    /// detection pass of the constant-row elimination. Each entry is
    /// `(closure, row, col)`. RHS-only ops never record: the elimination
    /// classifies rows by whether their *coefficients* can change, and a row
    /// whose do_step only feeds the right-hand side is constant (capacitors
    /// and inductors stamp their companions in `stamp` and update only source
    /// values per iteration, which is exactly the case the elimination wants
    /// to cache).
    record: Option<&'a mut Vec<(usize, usize, usize)>>,
    /// Voltage sources whose two terminals merged into one node this epoch.
    /// Their constraint rows are identities on their own unknowns and their
    /// value updates are dropped (see `voltage_source`).
    collapsed_vs: HashSet<usize>,
    /// Message an element asked to halt the run with, upstream's
    /// `sim.stop(text, elm)` text. First request wins: one fatal condition
    /// per frame is enough, and the earliest element's reason is the one a
    /// user can act on.
    stop: Option<String>,
    /// Stamps refused this pass because their value was outside the matrix's
    /// numeric domain: a non-finite conductance or source value, a
    /// non-positive resistance. Refusing is right (stamping them would
    /// poison the solve), but the refusal used to be invisible: GMIN pinned
    /// every orphaned row and the circuit solved to a plausible wrong answer
    /// that the dense NaN scan could never catch, because it only inspects
    /// entries that were actually stamped. The solver reads the tally after
    /// the pass and fails loudly instead.
    dropped_stamps: u32,
    /// Element index of the first drop this pass, so the surfaced report can
    /// name a culprit. First wins, like `stop`.
    dropped_first_by: usize,
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
            record: None,
            collapsed_vs: HashSet::new(),
            stop: None,
            dropped_stamps: 0,
            dropped_first_by: 0,
        }
    }

    /// Starts recording coefficient-stamp touches into `buf` on the
    /// subsequent stamps, for the constant-row detection pass. The recorder
    /// is one-shot in practice: the solver enables it on the first Newton
    /// iteration of a restamp epoch and never turns it back on.
    #[inline]
    pub fn set_recording(&mut self, buf: &'a mut Vec<(usize, usize, usize)>) {
        self.record = Some(buf);
    }

    /// Hands the caller the collapsed-source set this Stamper discovered
    /// during the stamp pass. `restamp` stores it on the [`Circuit`](crate::circuit::Circuit)
    /// and hands it back to every step-loop Stamper via
    /// [`Stamper::set_collapsed_sources`], so a source detected once stays
    /// collapsed for value updates across all Newton iterations.
    pub fn take_collapsed_sources(&mut self) -> HashSet<usize> {
        std::mem::take(&mut self.collapsed_vs)
    }

    /// Installs a previously collected collapsed-source set (see
    /// [`Stamper::take_collapsed_sources`]).
    pub fn set_collapsed_sources(&mut self, collapsed: HashSet<usize>) {
        self.collapsed_vs = collapsed;
    }

    /// Records one coefficient touch `(closure, row, col)`, value-independent:
    /// a stamp with `v == 0.0` still counts, because a zero at the detection
    /// operating point (a MOSFET in cutoff) can be nonzero at a later one, and
    /// under-classifying a row would silently corrupt the solve.
    #[inline]
    fn record_touch(&mut self, c: usize, row: usize, col: usize) {
        if let Some(buf) = self.record.as_deref_mut() {
            buf.push((c, row, col));
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
        self.record_touch(self.active, row, col);
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
            let (ra, rb) = (self.node_row[a], self.node_row[b]);
            self.record_touch(ca, ra, rb);
            self.closures[ca].sys.add(ra, rb, v);
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

    /// A conductance `g` bridging two nodes. An exact zero contributes
    /// nothing mathematically and is skipped in silence; anything non-finite
    /// would poison the solve if stamped, so it is refused and tallied (see
    /// [`Stamper::take_dropped`]).
    pub fn conductance(&mut self, n1: usize, n2: usize, g: f64) {
        if !g.is_finite() {
            self.drop_stamp();
            return;
        }
        if g == 0.0 {
            return;
        }
        self.node_pair(n1, n1, g);
        self.node_pair(n2, n2, g);
        self.node_pair(n1, n2, -g);
        self.node_pair(n2, n1, -g);
    }

    /// A resistor of `r` ohms bridging two nodes. A zero or negative value
    /// stamps no conductance at all, which reads downstream as a silent open
    /// circuit; a non-finite one would divide into a poisoned matrix. Both
    /// are refused and tallied rather than ignored.
    pub fn resistor(&mut self, n1: usize, n2: usize, r: f64) {
        if !r.is_finite() || r <= 0.0 {
            self.drop_stamp();
            return;
        }
        self.conductance(n1, n2, 1.0 / r);
    }

    /// An independent current source delivering `i` amps into `n2`, drawn
    /// from `n1`.
    pub fn current_source(&mut self, n1: usize, n2: usize, i: f64) {
        if !i.is_finite() {
            self.drop_stamp();
            return;
        }
        self.node_rhs(n1, -i);
        self.node_rhs(n2, i);
    }

    /// An ideal voltage source holding `V(n2) - V(n1) = v`.
    ///
    /// A source whose two terminals both merged onto the reference plane
    /// constrains nothing: upstream's stamp lands entirely on the dropped
    /// ground row and vanishes. This port must still give the unknown a
    /// solvable row, so it becomes an identity carrying zero: the unknown
    /// reads 0 for the rest of the run and later `voltage_source_value`
    /// updates are dropped, which keeps a chip output accidentally tied to
    /// ground (the td4 registers' Q pins) from singling the whole closure.
    /// A source shorted across one non-ground node keeps the old behaviour:
    /// its constraint cancels to an unsatisfiable row and the solve fails
    /// loudly, which is the honest report for a genuinely broken circuit.
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
        if r1.is_none() && r2.is_none() {
            self.collapsed_vs.insert(vs);
            self.record_touch(c, vn, vn);
            let sys = &mut self.closures[c].sys;
            sys.add(vn, vn, 1.0);
            return;
        }
        // Recorded before the `sys` borrow, which the touch recorder would
        // otherwise conflict with.
        if let Some(r) = r1 {
            // The stamped terminals must live in the closure the unknown was
            // assigned to; a tear here means the VS-owning element's
            // `voltage_source_nodes` disagrees with its stamp.
            debug_assert_eq!(self.node_closure[n1], c, "VS terminal straddles closures");
            self.record_touch(c, r, vn);
            self.record_touch(c, vn, r);
        }
        if let Some(r) = r2 {
            debug_assert_eq!(self.node_closure[n2], c, "VS terminal straddles closures");
            self.record_touch(c, r, vn);
            self.record_touch(c, vn, r);
        }
        let sys = &mut self.closures[c].sys;
        if let Some(r) = r1 {
            sys.add(r, vn, 1.0);
            sys.add(vn, r, -1.0);
        }
        if let Some(r) = r2 {
            sys.add(r, vn, -1.0);
            sys.add(vn, r, 1.0);
        }
        sys.add_rhs(vn, v);
    }

    /// Updates only the value of an already-stamped voltage source. Used on
    /// every timestep by time-varying sources, which leaves the matrix (and
    /// therefore its LU factors) untouched.
    pub fn voltage_source_value(&mut self, vs: usize, v: f64) {
        // A collapsed source carries no constraint (see `voltage_source`), so
        // its value updates are dropped along with the original stamp.
        if self.collapsed_vs.contains(&vs) {
            return;
        }
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
        if let Some(r) = r1 {
            debug_assert_eq!(self.node_closure[n1], c, "VCVS terminal straddles closures");
            self.record_touch(c, vn, r);
        }
        if let Some(r) = r2 {
            debug_assert_eq!(self.node_closure[n2], c, "VCVS terminal straddles closures");
            self.record_touch(c, vn, r);
        }
        let sys = &mut self.closures[c].sys;
        if let Some(r) = r1 {
            sys.add(vn, r, coef);
        }
        if let Some(r) = r2 {
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
                self.record_touch(c, self.node_row[n1], vn);
            }
        }
        if n2 != GROUND {
            let c = self.node_closure[n2];
            debug_assert_eq!(c, vc, "CCCS control source straddles closures");
            if c == vc {
                self.record_touch(c, self.node_row[n2], vn);
            }
        }
        if n1 != GROUND {
            let c = self.node_closure[n1];
            if c == vc {
                self.closures[c].sys.add(self.node_row[n1], vn, gain);
            }
        }
        if n2 != GROUND {
            let c = self.node_closure[n2];
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

    /// Asks the solver to halt the simulation run with this message,
    /// upstream's `sim.stop` (SimulationManager.java:1342-1345 reads the
    /// stop back straight after the doStep pass and abandons the frame).
    /// Unlike [`Stamper::not_converged`] this never recovers by shrinking
    /// the step: it is for conditions no timestep length can fix.
    #[inline]
    pub fn request_stop(&mut self, msg: &str) {
        if self.stop.is_none() {
            self.stop = Some(msg.to_string());
        }
    }

    /// Takes the pending stop request, if any element raised one this
    /// iteration.
    #[inline]
    pub fn take_stop(&mut self) -> Option<String> {
        self.stop.take()
    }

    /// Records one refused stamp against the element currently stamping.
    /// Two integer writes, so the hot path stays allocation-free.
    #[inline]
    fn drop_stamp(&mut self) {
        if self.dropped_stamps == 0 {
            self.dropped_first_by = self.current;
        }
        self.dropped_stamps = self.dropped_stamps.saturating_add(1);
    }

    /// Takes the drop tally and the first element that dropped, for the
    /// solver to surface after the pass.
    #[inline]
    pub fn take_dropped(&mut self) -> (u32, usize) {
        (
            std::mem::take(&mut self.dropped_stamps),
            std::mem::replace(&mut self.dropped_first_by, 0),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::matrix::Solver;
    use crate::spec::SolverType;

    /// A Stamper over one two-node dense closure, the smallest rig that can
    /// exercise the value guards. Field-wise destructuring keeps every borrow
    /// disjoint so `stamper` can hand out `&mut` to all of them at once.
    struct Rig {
        closures: Vec<Closure>,
        node_closure: Vec<usize>,
        node_row: Vec<usize>,
        vs_closure: Vec<usize>,
        vs_row: Vec<usize>,
        element_closure: Vec<usize>,
    }

    impl Rig {
        fn new() -> Self {
            let mut sys = Solver::new();
            sys.resize(2, SolverType::Dense)
                .expect("two rows fit the dense cap");
            Rig {
                closures: vec![Closure {
                    node_rows: vec![1, 2],
                    vs_rows: Vec::new(),
                    sys,
                    nonlinear: false,
                    simplified: None,
                }],
                node_closure: vec![0, 0, 0],
                node_row: vec![0, 0, 1],
                vs_closure: Vec::new(),
                vs_row: Vec::new(),
                // Long enough that set_current can name any culprit index
                // these tests use.
                element_closure: vec![0; 16],
            }
        }

        fn stamper(&mut self) -> Stamper<'_> {
            let Rig {
                closures,
                node_closure,
                node_row,
                vs_closure,
                vs_row,
                element_closure,
            } = self;
            Stamper::new(
                closures,
                node_closure,
                node_row,
                vs_closure,
                vs_row,
                element_closure,
            )
        }
    }

    #[test]
    fn non_finite_conductances_are_tallied_and_named() {
        let mut rig = Rig::new();
        let mut s = rig.stamper();
        s.set_current(7);
        s.conductance(1, 2, f64::NAN);
        s.conductance(1, 2, f64::INFINITY);
        assert_eq!(
            s.take_dropped(),
            (2, 7),
            "both drops name the first culprit"
        );
        // An exact zero is a mathematical no-op, not a divergence signal.
        s.conductance(1, 2, 0.0);
        assert_eq!(s.take_dropped().0, 0);
        // The finite stamp still lands: one self term of 2 per node.
        s.conductance(1, 2, 2.0);
        drop(s);
        assert_eq!(rig.closures[0].sys.get(0, 0), 2.0);
    }

    #[test]
    fn non_positive_resistances_are_tallied() {
        let mut rig = Rig::new();
        {
            let mut s = rig.stamper();
            s.set_current(3);
            s.resistor(1, 2, 0.0);
            s.resistor(1, 2, -5.0);
            s.resistor(1, 2, f64::NAN);
            assert_eq!(s.take_dropped(), (3, 3));
            s.resistor(1, 2, 1000.0);
            assert_eq!(s.take_dropped().0, 0);
        }
        // The finite resistor stamped its 1 mS conductance; the refusals
        // before it left nothing behind.
        assert_eq!(rig.closures[0].sys.get(0, 0), 1e-3);
        assert_eq!(rig.closures[0].sys.get(1, 1), 1e-3);
    }

    #[test]
    fn non_finite_source_currents_are_tallied() {
        let mut rig = Rig::new();
        let mut s = rig.stamper();
        s.set_current(11);
        s.current_source(1, 2, f64::NAN);
        s.current_source(1, 2, f64::NEG_INFINITY);
        assert_eq!(s.take_dropped(), (2, 11));
        // A finite current stops being tallied; its two half-injections land
        // in the right-hand side, which the solve tests cover end to end.
        s.current_source(1, 2, 1e-3);
        assert_eq!(s.take_dropped().0, 0);
    }
}
