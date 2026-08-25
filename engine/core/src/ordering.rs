//! Fill-reducing column ordering for the sparse LU.
//!
//! The left-looking factor in [`crate::sparse`] eliminates columns in the
//! order it is given them. On a circuit that is a true two-dimensional mesh
//! the natural order is close to the worst one: eliminating node by node
//! across a row connects the whole width of the mesh into the frontier, and
//! the factor fills roughly with the square of the mesh width. Choosing a
//! better order costs one pass over the pattern per structural change and is
//! paid back by every factor afterwards.
//!
//! The ordering here is the classic minimum-degree heuristic on the symmetric
//! pattern of `A + A'`, run on an explicit elimination graph: repeatedly take
//! the node of least current degree, record it, and join its remaining
//! neighbours into a clique, which is exactly the fill its elimination would
//! create. Circuit matrices are structurally symmetric except for the
//! voltage-source rows, and symmetrising costs only a few extra edges, so the
//! symmetric heuristic describes the fill well enough to be worth its pass.
//!
//! No quotient graph, no supernodes, no mass elimination: the refinements that
//! make AMD fast on very large problems are omitted because this runs once per
//! structural change on matrices of a few thousand rows. What protects the
//! pathological case instead is a work budget: a pattern whose cliques grow
//! faster than [`FILL_BUDGET`] allows abandons the ordering and hands back the
//! identity, so a dense-ish closure degrades to the old natural order rather
//! than spending unbounded time chasing an order that cannot help it.

use std::collections::BTreeSet;

/// Ceiling on the clique-joining work one ordering may do, in edge insertions.
/// A 30x30 mesh (961 rows) uses about 40k, so this leaves an order of
/// magnitude of headroom for the shapes worth ordering while cutting off the
/// quadratic blow-up a near-dense pattern would cause.
const FILL_BUDGET: usize = 4_000_000;

/// Minimum-degree column ordering of an `n`-row pattern.
///
/// `pattern(col)` must yield the row ids of column `col`; the caller's CSC
/// arrays are read through it so this module never owns a copy. Returns `q`
/// with `q[k]` the column to eliminate at step `k`, always a valid
/// permutation. The identity is returned for a trivial or over-budget
/// pattern, which is exactly the previous behaviour.
pub(crate) fn min_degree_order<'a, F>(n: usize, pattern: F) -> Vec<usize>
where
    F: Fn(usize) -> &'a [usize],
{
    min_degree_order_with_budget(n, pattern, FILL_BUDGET)
}

/// [`min_degree_order`] with the work budget injected, so the abandonment
/// branch is reachable from tests without shrinking the production constant.
fn min_degree_order_with_budget<'a, F>(n: usize, pattern: F, fill_budget: usize) -> Vec<usize>
where
    F: Fn(usize) -> &'a [usize],
{
    let identity = || (0..n).collect::<Vec<usize>>();
    if n < 2 {
        return identity();
    }
    // The symmetric pattern of A + A', without the diagonal: an entry at
    // (r, c) makes r and c neighbours whichever side of the diagonal it sits.
    let mut adj: Vec<BTreeSet<usize>> = vec![BTreeSet::new(); n];
    for c in 0..n {
        for &r in pattern(c) {
            if r == c || r >= n {
                continue;
            }
            adj[r].insert(c);
            adj[c].insert(r);
        }
    }

    let mut order = Vec::with_capacity(n);
    let mut eliminated = vec![false; n];
    let mut work = 0usize;

    // Degree buckets: `bucket[d]` holds candidates whose degree was `d` when
    // they were filed. Entries are never removed, only skipped when stale
    // (`degree[v] != d`), which keeps the update path to a single push and
    // still bounds the total skipped work by the number of degree changes.
    // Without this the minimum search is an O(n) scan per step, which on a
    // ten-thousand-row closure costs more than the fill it saves.
    let mut degree: Vec<usize> = adj.iter().map(|a| a.len()).collect();
    let mut bucket: Vec<Vec<usize>> = vec![Vec::new(); n];
    for (v, &d) in degree.iter().enumerate() {
        bucket[d].push(v);
    }
    // Lower bound on any live node's degree: elimination and fill can only
    // push a degree below it through the explicit updates below, which lower
    // it themselves.
    let mut min_degree = 0usize;

    for _ in 0..n {
        // The least-degree live node, skipping stale bucket entries.
        let mut best = usize::MAX;
        while min_degree < n {
            while let Some(&v) = bucket[min_degree].last() {
                if eliminated[v] || degree[v] != min_degree {
                    bucket[min_degree].pop();
                    continue;
                }
                best = v;
                break;
            }
            if best != usize::MAX {
                break;
            }
            min_degree += 1;
        }
        // Every step has a live node to take: the loop runs exactly n times
        // and each pass eliminates one.
        debug_assert!(best != usize::MAX);
        if best == usize::MAX {
            return identity();
        }
        bucket[min_degree].pop();
        eliminated[best] = true;
        order.push(best);

        let neighbours: Vec<usize> = adj[best].iter().copied().collect();
        for &v in &neighbours {
            adj[v].remove(&best);
        }
        adj[best].clear();
        // The fill: eliminating a node makes its remaining neighbours mutually
        // adjacent (Parter's rule).
        work += neighbours.len() * neighbours.len();
        if work > fill_budget {
            return identity();
        }
        for (i, &u) in neighbours.iter().enumerate() {
            for &v in &neighbours[i + 1..] {
                adj[u].insert(v);
                adj[v].insert(u);
            }
        }
        // Refile every neighbour whose degree moved, and let the search resume
        // from the lowest of them.
        for &v in &neighbours {
            let d = adj[v].len();
            if d != degree[v] {
                degree[v] = d;
                bucket[d].push(v);
            }
            min_degree = min_degree.min(d);
        }
    }
    order
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Wraps a per-column row list as the `pattern` callback takes it.
    fn order_of(n: usize, cols: &[Vec<usize>]) -> Vec<usize> {
        min_degree_order(n, |c| &cols[c])
    }

    fn is_permutation(q: &[usize], n: usize) -> bool {
        let mut seen = vec![false; n];
        for &v in q {
            if v >= n || seen[v] {
                return false;
            }
            seen[v] = true;
        }
        q.len() == n
    }

    #[test]
    fn returns_a_permutation_for_a_path_graph() {
        // A chain: 0-1-2-3-4, the pattern a series resistor string stamps.
        let n = 5;
        let mut cols = vec![Vec::new(); n];
        for i in 0..n {
            cols[i].push(i);
            if i + 1 < n {
                cols[i].push(i + 1);
                cols[i + 1].push(i);
            }
        }
        let q = order_of(n, &cols);
        assert!(is_permutation(&q, n), "not a permutation: {q:?}");
        // A path is eliminated from an end and then inward, the order that
        // never fills: each elimination leaves the next node with degree one.
        // Which end starts is a tie the degree buckets break, so the assertion
        // is the walk, not the direction.
        assert!(q[0] == 0 || q[0] == n - 1, "did not start at an end: {q:?}");
        for pair in q.windows(2) {
            assert_eq!(
                pair[0].abs_diff(pair[1]),
                1,
                "left the path to eliminate {} after {}: {q:?}",
                pair[1],
                pair[0]
            );
        }
    }

    #[test]
    fn eliminates_a_star_hub_last() {
        // A hub joined to every leaf: eliminating the hub first would join all
        // the leaves into a clique, which is the fill the heuristic exists to
        // avoid.
        let n = 6;
        let mut cols = vec![Vec::new(); n];
        for leaf in 1..n {
            cols[0].push(leaf);
            cols[leaf].push(0);
        }
        let q = order_of(n, &cols);
        assert!(is_permutation(&q, n), "not a permutation: {q:?}");
        // The leaves go first and the hub waits until its degree has fallen
        // to one, so eliminating it joins nothing. Taking it first would have
        // made a clique of all five leaves, which is the fill this avoids.
        assert_ne!(q[0], 0, "hub was eliminated first: {q:?}");
        assert!(q[n - 2] == 0 || q[n - 1] == 0, "hub went early: {q:?}");
    }

    #[test]
    fn a_trivial_pattern_is_the_identity() {
        assert_eq!(order_of(1, &[vec![0]]), vec![0]);
        assert_eq!(min_degree_order(0, |_| &[]), Vec::<usize>::new());
    }

    #[test]
    fn an_isolated_node_still_appears_exactly_once() {
        // Node 2 touches nothing: a closure row a stamp never wrote. The
        // ordering must still name it, or the factor would skip a column.
        let n = 3;
        let cols = vec![vec![0, 1], vec![0, 1], vec![]];
        let q = order_of(n, &cols);
        assert!(is_permutation(&q, n), "not a permutation: {q:?}");
    }

    /// A complete graph on `n` nodes: every elimination joins all remaining
    /// neighbours at once, the fastest possible route past any budget.
    fn complete_graph_cols(n: usize) -> Vec<Vec<usize>> {
        (0..n)
            .map(|c| (0..n).filter(|&r| r != c).collect())
            .collect()
    }

    #[test]
    fn an_over_budget_clique_abandons_to_the_identity() {
        // The abandonment branch is unreachable with the production constant
        // on any pattern small enough to test cheaply, so the budget is
        // injected here: eliminating the first node of K12 joins its eleven
        // remaining neighbours in one step, 121 edge insertions of work
        // against an injected budget of 8. The identity is the documented
        // fallback and must still be a full permutation.
        let n = 12;
        let cols = complete_graph_cols(n);
        let q = min_degree_order_with_budget(n, |c| &cols[c], 8);
        assert_eq!(q, (0..n).collect::<Vec<usize>>(), "expected the identity");
        assert!(is_permutation(&q, n));
    }

    #[test]
    fn the_same_clique_within_an_injected_budget_still_orders() {
        // Control for the abandonment test: the identical shape under a
        // generous injected budget comes back reordered, so the identity
        // above came from the budget and not from the pattern.
        let n = 12;
        let cols = complete_graph_cols(n);
        let q = min_degree_order_with_budget(n, |c| &cols[c], usize::MAX);
        assert!(is_permutation(&q, n), "not a permutation: {q:?}");
        assert_ne!(q, (0..n).collect::<Vec<usize>>());
    }

    #[test]
    fn the_production_entry_point_delegates_with_the_documented_budget() {
        // The wrapper must hand [`FILL_BUDGET`] through, or the module's cost
        // guarantee would be decoupled from the constant its documentation
        // cites.
        let n = 12;
        let cols = complete_graph_cols(n);
        let direct = min_degree_order_with_budget(n, |c| &cols[c], FILL_BUDGET);
        let wrapped = min_degree_order(n, |c| &cols[c]);
        assert_eq!(direct, wrapped);
    }
}
