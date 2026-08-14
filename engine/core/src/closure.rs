//! Connected components of the matrix graph, each solved as its own dense
//! system.
//!
//! A circuit that only touches ground through a few components decomposes
//! into independent closures: LU cost drops from `O(N^3)` for one global
//! matrix to `O(sum n_i^3)` over closures, and each linear closure is factored
//! once at build instead of once per step. This is the port of upstream's
//! `calculateClosures` (SimulationManager.java:710-791).
//!
//! The seam that makes closures correct is [`Element::matrix_connects`], the
//! port of `getMatrixConnection`: two posts share a closure exactly when their
//! stamps can couple rows, which is usually [`Element::connects`] but is
//! overridden to true on the op-amp, mosfet, transformers and current source,
//! whose gates or controls affect other rows.

use std::collections::HashMap;

use crate::circuit::UnionFind;
use crate::element::Element;
use crate::matrix::Solver;
use crate::spec::SolverType;
use crate::stamp::GROUND;

/// One connected component of the matrix graph.
pub struct Closure {
    /// Closure row `k` -> global node id (1-based). Node rows come first, in
    /// node-id order, matching upstream's per-matrix row numbering
    /// (SimulationManager.java:763-774).
    pub node_rows: Vec<usize>,
    /// Closure rows after the node block -> global voltage-source index, in
    /// global VS order.
    pub vs_rows: Vec<usize>,
    /// The closure's linear system, dense or sparse per its size and the
    /// circuit's [`SolverType`]. Both backends share one method surface.
    pub sys: Solver,
    /// True when the circuit has any nonlinear element. Matches upstream, which
    /// sets every matrix nonlinear when any element is (SimulationManager.java:
    /// 976-983), so a nonlinear circuit splits into closures but each closure
    /// still refactors every Newton iteration.
    pub nonlinear: bool,
}

/// Everything the solver needs to address a circuit through its closures: the
/// closures themselves and the per-node / per-VS / per-element maps into them.
pub struct ClosureMap {
    pub closures: Vec<Closure>,
    /// Closure index per global node id. Node 0 (ground) maps to closure 0,
    /// which is never consulted because the Stamper skips ground explicitly.
    pub node_closure: Vec<usize>,
    /// Closure-local row per global node id (0-based, node block first).
    pub node_row: Vec<usize>,
    /// Closure index per global voltage-source index.
    pub vs_closure: Vec<usize>,
    /// Closure-local row per global voltage-source index.
    pub vs_row: Vec<usize>,
    /// Closure index per element, used by `Stamper::set_current` to route the
    /// raw row operations (the op-amp's input columns) into the right system.
    pub element_closure: Vec<usize>,
}

/// Builds the closures over the merged node graph.
///
/// Every element's node pairs are unioned when `matrix_connects` reports them
/// and neither is ground, mirroring the upstream flood that stops at ground
/// (SimulationManager.java:740, :744). Each root is a closure; closure rows are
/// assigned node by node in id order, and the closures are ordered by their
/// smallest node id so repeated builds solve in an identical order.
pub fn build_closures(
    elements: &[Box<dyn Element>],
    node_count: usize,
    vs_count: usize,
    nonlinear: bool,
    solver_type: SolverType,
) -> Result<ClosureMap, String> {
    let mut uf = UnionFind::new(node_count.max(1));
    for elm in elements {
        let nodes = &elm.base().nodes;
        for a in 0..nodes.len() {
            for b in (a + 1)..nodes.len() {
                if nodes[a] != GROUND && nodes[b] != GROUND && elm.matrix_connects(a, b) {
                    uf.union(nodes[a], nodes[b]);
                }
            }
        }
    }

    // Distinct roots among the non-ground nodes, in first-seen order, then
    // renumbered by smallest member node so the solve order is deterministic.
    // The root->index map keeps the two passes linear in the node count.
    let mut root_index: HashMap<usize, usize> = HashMap::new();
    let mut roots: Vec<usize> = Vec::new();
    for n in 1..node_count {
        let r = uf.find(n);
        if let std::collections::hash_map::Entry::Vacant(e) = root_index.entry(r) {
            e.insert(roots.len());
            roots.push(r);
        }
    }
    let mut smallest = vec![usize::MAX; roots.len()];
    for n in 1..node_count {
        let ci = root_index[&uf.find(n)];
        smallest[ci] = smallest[ci].min(n);
    }
    let mut order: Vec<usize> = (0..roots.len()).collect();
    order.sort_by_key(|&i| smallest[i]);
    let mut closure_of_root: HashMap<usize, usize> = HashMap::new();
    for (ci, &old_i) in order.iter().enumerate() {
        closure_of_root.insert(roots[old_i], ci);
    }

    let mut node_closure = vec![0usize; node_count];
    let mut node_row = vec![0usize; node_count];
    let mut closures: Vec<Closure> = (0..roots.len())
        .map(|_| Closure {
            node_rows: Vec::new(),
            vs_rows: Vec::new(),
            sys: Solver::new(),
            nonlinear,
        })
        .collect();
    // No non-ground node anywhere means every voltage source's terminals are
    // all ground: it is shorted across itself and there is no closure row it
    // could stamp into. That is the same degenerate topology the "no
    // solution" error already covers for a matrix that factors singular; a
    // circuit that reduces to nothing but ground and voltage sources with no
    // resistive path never reaches a factor() call, so it must be rejected
    // here instead of indexing the (empty) closures list.
    if closures.is_empty() && vs_count > 0 {
        return Err(
            "The circuit has no solution: check for shorted sources or missing connections."
                .to_string(),
        );
    }
    for n in 1..node_count {
        let ci = closure_of_root[&uf.find(n)];
        node_closure[n] = ci;
        node_row[n] = closures[ci].node_rows.len();
        closures[ci].node_rows.push(n);
    }

    // Each element routes through the closure of its first non-ground node,
    // which is where its stamps land by construction. The relay is the
    // deliberate exception: it has several closures (one per pole group plus
    // the coil), and its node-pair stamps route per node, so this index is
    // only a fallback for the raw-row ops, which the relay never uses.
    let mut element_closure = vec![0usize; elements.len()];
    for (ei, elm) in elements.iter().enumerate() {
        if let Some(&n) = elm.base().nodes.iter().find(|&&n| n != GROUND) {
            element_closure[ei] = node_closure[n];
        }
    }

    // Voltage sources join the closure of the terminal they actually stamp,
    // preferring the non-ground first terminal, else the second, else the
    // element's last non-ground node (VoltageSource.assignMatrix,
    // VoltageSource.java:18-25). The default `voltage_source_nodes` matches a
    // two-terminal source's stamp, but the SPDT stamps the *selected* throw,
    // which only its override knows, and the op-amp's single closure is the
    // same whichever node the preference lands on. Its row is the closure's
    // node count plus its per-closure ordinal (SimulationManager.java:906-922).
    // A VS whose two terminals are both non-ground is guaranteed to have them
    // in one closure because the VS itself connects them.
    let mut vs_closure = vec![0usize; vs_count];
    let mut vs_row = vec![0usize; vs_count];
    for elm in elements.iter() {
        let base = elm.base();
        for k in 0..elm.voltage_source_count() {
            let (n1, n2) = elm.voltage_source_nodes(k);
            let c = if n1 != GROUND {
                node_closure[n1]
            } else if n2 != GROUND {
                node_closure[n2]
            } else {
                base.nodes
                    .iter()
                    .rev()
                    .find(|&&n| n != GROUND)
                    .map_or(0, |&n| node_closure[n])
            };
            let gvs = base.vs_base + k;
            vs_closure[gvs] = c;
            vs_row[gvs] = closures[c].node_rows.len() + closures[c].vs_rows.len();
            closures[c].vs_rows.push(gvs);
        }
    }

    for c in closures.iter_mut() {
        c.sys
            .resize(c.node_rows.len() + c.vs_rows.len(), solver_type);
    }

    Ok(ClosureMap {
        closures,
        node_closure,
        node_row,
        vs_closure,
        vs_row,
        element_closure,
    })
}
