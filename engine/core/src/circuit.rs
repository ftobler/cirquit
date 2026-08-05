//! Netlist analysis and the time-stepping loop.

use std::collections::HashMap;

use crate::element::{Element, SimCtx};
use crate::elements::build_element;
use crate::matrix::{LinearSystem, SolveError};
use crate::scope::ScopeTrace;
use crate::spec::{CircuitSpec, ElementSpec, ScopeValue, SimOptions};
use crate::stamp::{Stamper, GROUND};

/// Conductance tied from every floating subcircuit to ground so the matrix
/// stays non-singular. One nanosiemens is far below anything a user would
/// notice but enough to pin an otherwise undefined node.
const GMIN: f64 = 1e-9;

#[derive(Default)]
struct UnionFind {
    parent: Vec<usize>,
}

impl UnionFind {
    fn new(n: usize) -> Self {
        Self {
            parent: (0..n).collect(),
        }
    }

    fn find(&mut self, mut i: usize) -> usize {
        while self.parent[i] != i {
            self.parent[i] = self.parent[self.parent[i]];
            i = self.parent[i];
        }
        i
    }

    fn union(&mut self, a: usize, b: usize) {
        let (ra, rb) = (self.find(a), self.find(b));
        if ra != rb {
            self.parent[ra] = rb;
        }
    }
}

/// Outcome of advancing the simulation.
#[derive(Debug, Clone, Default)]
pub struct StepReport {
    pub steps: u32,
    /// Total Newton iterations across the frame, useful for a perf readout.
    pub iterations: u32,
    pub time: f64,
    pub converged: bool,
    pub error: Option<String>,
}

pub struct Circuit {
    elements: Vec<Box<dyn Element>>,
    /// Original element specs, kept so a topology edit can re-run analysis
    /// (post coordinates survive on the built elements, but specs are the
    /// canonical copy).
    specs: Vec<ElementSpec>,
    /// UI-assigned id per element, parallel to `elements`.
    ids: Vec<u32>,
    id_index: HashMap<u32, usize>,
    sys: LinearSystem,
    node_count: usize,
    vs_count: usize,
    node_voltages: Vec<f64>,
    options: SimOptions,
    ctx: SimCtx,
    nonlinear: bool,
    scopes: Vec<ScopeTrace>,
    warnings: Vec<String>,
    error: Option<String>,
}

impl Default for Circuit {
    fn default() -> Self {
        Self::new()
    }
}

impl Circuit {
    pub fn new() -> Self {
        Self {
            elements: Vec::new(),
            specs: Vec::new(),
            ids: Vec::new(),
            id_index: HashMap::new(),
            sys: LinearSystem::new(),
            node_count: 1,
            vs_count: 0,
            node_voltages: vec![0.0],
            options: SimOptions::default(),
            ctx: SimCtx::default(),
            nonlinear: false,
            scopes: Vec::new(),
            warnings: Vec::new(),
            error: None,
        }
    }

    pub fn options(&self) -> &SimOptions {
        &self.options
    }

    pub fn time(&self) -> f64 {
        self.ctx.time
    }

    pub fn warnings(&self) -> &[String] {
        &self.warnings
    }

    pub fn error(&self) -> Option<&str> {
        self.error.as_deref()
    }

    pub fn node_count(&self) -> usize {
        self.node_count
    }

    pub fn vs_count(&self) -> usize {
        self.vs_count
    }

    pub fn element_count(&self) -> usize {
        self.elements.len()
    }

    pub fn node_voltages(&self) -> &[f64] {
        &self.node_voltages
    }

    pub fn scopes(&self) -> &[ScopeTrace] {
        &self.scopes
    }

    /// Replaces the circuit and runs analysis. Returns an error only when the
    /// netlist cannot be built at all; solver problems surface per-step.
    pub fn set_circuit(&mut self, spec: &CircuitSpec) -> Result<(), String> {
        self.options = spec.options.clone().unwrap_or_default();
        self.warnings.clear();
        self.error = None;
        // Rebuilding is the topology path: adding, deleting or moving an
        // element renumbers nodes, so the state vector's meaning changes.
        // Restarting from zero is deliberate, not an oversight; carrying old
        // voltages across would be worse.
        self.ctx = SimCtx {
            time: 0.0,
            dt: self.options.time_step,
            dc_analysis: false,
            subiter: 0,
        };

        self.elements = Vec::with_capacity(spec.elements.len());
        self.ids = Vec::with_capacity(spec.elements.len());
        self.id_index.clear();
        for es in &spec.elements {
            let elm = build_element(es)
                .ok_or_else(|| format!("unknown element type '{}' (id {})", es.kind, es.id))?;
            if elm.post_count() != es.posts.len() {
                return Err(format!(
                    "element '{}' (id {}) expects {} posts, got {}",
                    es.kind,
                    es.id,
                    elm.post_count(),
                    es.posts.len()
                ));
            }
            self.id_index.insert(es.id, self.elements.len());
            self.ids.push(es.id);
            self.elements.push(elm);
        }
        self.specs = spec.elements.clone();

        self.assign_nodes(&spec.elements);
        // Devices whose format stores operating-point tokens seed the global
        // node voltages from them, and each element copies its terminals so
        // the first do_step evaluates at the file's operating point. A warm
        // start only: the first solve overwrites it.
        for elm in self.elements.iter_mut() {
            elm.seed_initial_voltages(&mut self.node_voltages);
        }
        for elm in self.elements.iter_mut() {
            let base = elm.base_mut();
            for i in 0..base.nodes.len() {
                base.volts[i] = self.node_voltages[base.nodes[i]];
            }
        }
        self.allocate_and_stamp();
        self.build_scopes(spec);

        if self.options.dc_operating_point {
            self.solve_operating_point();
        }
        Ok(())
    }

    /// Works out which terminals share a node.
    fn assign_nodes(&mut self, specs: &[ElementSpec]) {
        // Flatten every terminal into one index space.
        let mut offsets = Vec::with_capacity(self.elements.len());
        let mut total = 0usize;
        for es in specs {
            offsets.push(total);
            total += es.posts.len();
        }

        let mut uf = UnionFind::new(total.max(1));
        let mut by_coord: HashMap<[i32; 2], usize> = HashMap::new();
        for (ei, es) in specs.iter().enumerate() {
            for (pi, post) in es.posts.iter().enumerate() {
                let gi = offsets[ei] + pi;
                match by_coord.entry(*post) {
                    std::collections::hash_map::Entry::Occupied(o) => uf.union(gi, *o.get()),
                    std::collections::hash_map::Entry::Vacant(v) => {
                        v.insert(gi);
                    }
                }
            }
        }

        // Named nodes connect by label rather than by position.
        let mut by_label: HashMap<String, usize> = HashMap::new();
        for (ei, elm) in self.elements.iter().enumerate() {
            if let Some(label) = elm.node_label() {
                let gi = offsets[ei];
                match by_label.entry(label.to_string()) {
                    std::collections::hash_map::Entry::Occupied(o) => uf.union(gi, *o.get()),
                    std::collections::hash_map::Entry::Vacant(v) => {
                        v.insert(gi);
                    }
                }
            }
        }

        // Wires and closed switches are ideal shorts: merge their two endpoints
        // so the matrix never sees them, exactly as upstream's wire closure
        // does. Unioning the coordinate-merged roots collapses chains, rings
        // and parallel wires into one node each.
        for (ei, elm) in self.elements.iter().enumerate() {
            if elm.removable_wire() && elm.post_count() >= 2 {
                let r0 = uf.find(offsets[ei]);
                let r1 = uf.find(offsets[ei] + 1);
                uf.union(r0, r1);
            }
        }

        // Every ground symbol pins its component to the reference node. Doing
        // it by remapping (rather than with a 0 V source per symbol) means any
        // number of ground symbols can share a node without producing
        // duplicate constraint rows.
        let mut ground_roots: Vec<usize> = Vec::new();
        for (ei, elm) in self.elements.iter().enumerate() {
            if elm.is_ground() {
                let r = uf.find(offsets[ei]);
                if !ground_roots.contains(&r) {
                    ground_roots.push(r);
                }
            }
        }
        if ground_roots.is_empty() && total > 0 {
            // An ungrounded circuit has no unique solution. Pick a reference
            // and say so, rather than handing the user a singular matrix.
            ground_roots.push(uf.find(0));
            self.warnings
                .push("No ground symbol: the first node was used as the voltage reference.".into());
        }

        let mut id_of_root: HashMap<usize, usize> = HashMap::new();
        for r in &ground_roots {
            id_of_root.insert(*r, GROUND);
        }
        let mut next_id = 1usize;
        for gi in 0..total {
            let r = uf.find(gi);
            id_of_root.entry(r).or_insert_with(|| {
                let id = next_id;
                next_id += 1;
                id
            });
        }

        // Hand each element its terminal nodes, then its internal ones.
        for (ei, elm) in self.elements.iter_mut().enumerate() {
            let posts = elm.post_count();
            let internal = elm.internal_node_count();
            let base = elm.base_mut();
            base.nodes = vec![GROUND; posts + internal];
            base.volts = vec![0.0; posts + internal];
            base.posts = specs[ei].posts.clone();
            for pi in 0..posts {
                base.nodes[pi] = id_of_root[&uf.find(offsets[ei] + pi)];
            }
            for k in 0..internal {
                base.nodes[posts + k] = next_id + k;
            }
            next_id += internal;
        }

        self.node_count = next_id;
        self.node_voltages = vec![0.0; self.node_count];
    }

    /// Finds subcircuits with no path to ground and pins them with `GMIN`.
    fn floating_nodes(&self) -> Vec<usize> {
        let mut uf = UnionFind::new(self.node_count);
        for elm in &self.elements {
            let nodes = &elm.base().nodes;
            for a in 0..nodes.len() {
                for b in (a + 1)..nodes.len() {
                    if elm.connects(a, b) {
                        uf.union(nodes[a], nodes[b]);
                    }
                }
            }
        }
        let ground_root = uf.find(GROUND);
        let mut seen: Vec<usize> = Vec::new();
        let mut pins = Vec::new();
        for n in 1..self.node_count {
            let r = uf.find(n);
            if r != ground_root && !seen.contains(&r) {
                seen.push(r);
                pins.push(n);
            }
        }
        pins
    }

    /// Assigns voltage-source unknowns and sizes the matrix. Re-runs on every
    /// analysis pass; per-element unknown counts are static now that wires and
    /// closed switches merge out of the matrix and only the SPDT keeps one.
    fn allocate(&mut self) {
        self.vs_count = 0;
        self.nonlinear = false;
        for elm in self.elements.iter_mut() {
            let n = elm.voltage_source_count();
            elm.base_mut().vs_base = self.vs_count;
            elm.base_mut().vs_currents = vec![0.0; n];
            self.vs_count += n;
            if elm.nonlinear() {
                self.nonlinear = true;
            }
        }
        self.sys.resize((self.node_count - 1) + self.vs_count);
    }

    /// Zeroes the matrix, re-runs the constant stamp pass and snapshots the
    /// result for reuse across timesteps.
    fn restamp(&mut self) {
        let size = (self.node_count - 1) + self.vs_count;
        // `resize` also zeroes, which is what we want before re-stamping.
        self.sys.resize(size);
        if size == 0 {
            self.sys.snapshot();
            return;
        }
        let ctx = self.ctx;
        let pins = self.floating_nodes();
        {
            let mut s = Stamper::new(&mut self.sys, self.node_count);
            for n in pins {
                s.conductance(n, GROUND, GMIN);
            }
            for elm in self.elements.iter_mut() {
                elm.stamp(&ctx, &mut s);
            }
        }
        self.sys.snapshot();
    }

    /// Allocation plus stamping, with the one-off floating-node diagnostic.
    fn allocate_and_stamp(&mut self) {
        self.allocate();
        let pins = self.floating_nodes();
        if !pins.is_empty() {
            self.warnings.push(format!(
                "{} part(s) of the circuit have no path to ground; they were pinned with a {:e} S conductance.",
                pins.len(),
                GMIN
            ));
        }
        self.restamp();
    }

    /// Re-runs the topology analysis after an interactive edit that can merge
    /// or unmerge terminals, such as closing a switch. Unlike `set_circuit`,
    /// it leaves the sim clock alone: a throw must not rewind the trace.
    fn reanalyze(&mut self) {
        // `assign_nodes` borrows the specs while `&mut self` is in play, so
        // hand it a clone rather than borrowing `self.specs` through `self`.
        self.assign_nodes(&self.specs.clone());
        self.allocate_and_stamp();
    }

    fn build_scopes(&mut self, spec: &CircuitSpec) {
        self.scopes = spec
            .scopes
            .iter()
            .map(|s| ScopeTrace::new(s.clone(), self.id_index.get(&s.element_id).copied()))
            .collect();
    }

    /// Solves the circuit with reactive elements held at steady state, giving
    /// transient analysis a sensible starting point.
    fn solve_operating_point(&mut self) {
        // Reactive elements stamp differently under DC (a capacitor as an
        // open circuit, an inductor as a short), so the matrix has to be built
        // for DC, used, and then rebuilt for transient stepping.
        self.ctx.dc_analysis = true;
        self.restamp();
        let _ = self.step_once();
        self.ctx.dc_analysis = false;
        self.ctx.time = 0.0;
        self.restamp();
    }

    /// Advances one timestep, running Newton to convergence.
    fn step_once(&mut self) -> StepReport {
        let mut report = StepReport {
            steps: 1,
            time: self.ctx.time,
            converged: true,
            ..Default::default()
        };
        if self.sys.size() == 0 {
            return report;
        }

        self.ctx.dt = self.options.time_step;
        if !self.ctx.dc_analysis {
            self.ctx.time += self.ctx.dt;
        }
        report.time = self.ctx.time;

        let ctx_snapshot = self.ctx;
        for elm in self.elements.iter_mut() {
            elm.start_iteration(&ctx_snapshot);
        }

        let max_sub = if self.nonlinear {
            self.options.max_subiterations.max(2)
        } else {
            1
        };
        let mut converged_at = None;

        for subiter in 0..max_sub {
            self.ctx.subiter = subiter as usize;
            let ctx = self.ctx;
            report.iterations += 1;

            if self.nonlinear {
                self.sys.restore();
                self.sys.invalidate();
            } else {
                self.sys.restore_rhs();
            }

            let converged = {
                let mut s = Stamper::new(&mut self.sys, self.node_count);
                for elm in self.elements.iter_mut() {
                    elm.do_step(&ctx, &mut s);
                }
                s.converged
            };

            if let Err(SolveError::Singular) = self.sys.solve() {
                report.converged = false;
                report.error = Some(
                    "The circuit has no solution: check for shorted sources or missing connections."
                        .into(),
                );
                self.error = report.error.clone();
                return report;
            }
            self.write_back();

            if converged && (subiter > 0 || !self.nonlinear) {
                converged_at = Some(subiter);
                break;
            }
        }

        if converged_at.is_none() {
            report.converged = false;
            report.error =
                Some("Newton iteration did not converge; try a smaller timestep.".into());
        }

        let ctx = self.ctx;
        for elm in self.elements.iter_mut() {
            elm.calculate_current(&ctx);
        }
        self.recover_wire_currents();
        for elm in self.elements.iter_mut() {
            elm.step_finished(&ctx);
        }
        report
    }

    /// Recovers the current through each wire and closed switch after a solve.
    /// The matrix never sees these elements, so their currents come from KCL
    /// at their endpoint coordinates: a chain or tree resolves in order from
    /// its driven end, and any loop that remains (two parallel wires, a fed
    /// ring) is solved as a minimum-norm problem, the deterministic split for
    /// ideal shorts. Upstream reports "wire loop detected" on such loops;
    /// minimum-norm is the port's deliberate improvement.
    fn recover_wire_currents(&mut self) {
        let mut coords: Vec<[i32; 2]> = Vec::new();
        let mut coord_id: HashMap<[i32; 2], usize> = HashMap::new();
        let mut edges: Vec<[usize; 2]> = Vec::new();
        let mut edge_elm: Vec<usize> = Vec::new();

        for (ei, elm) in self.elements.iter().enumerate() {
            if elm.removable_wire() && elm.post_count() >= 2 {
                let c0 = coord_of(&mut coord_id, &mut coords, elm.base().posts[0]);
                let c1 = coord_of(&mut coord_id, &mut coords, elm.base().posts[1]);
                edges.push([c0, c1]);
                edge_elm.push(ei);
            }
        }
        if edges.is_empty() {
            return;
        }

        // Net current each coordinate receives from the non-removable world.
        let mut injection = vec![0.0; coords.len()];
        for elm in self.elements.iter() {
            if elm.removable_wire() && elm.post_count() >= 2 {
                continue;
            }
            for pi in 0..elm.post_count() {
                let Some(&c) = coord_id.get(&elm.base().posts[pi]) else {
                    continue;
                };
                injection[c] += elm.current_into_node(pi);
            }
        }

        let mut resolved = vec![false; edges.len()];
        let mut currents = vec![0.0; edges.len()];

        // Resolve chains and trees in the natural order: a wire whose other
        // endpoint is fully determined derives its current from KCL there.
        loop {
            let mut progress = false;
            for i in 0..edges.len() {
                if resolved[i] {
                    continue;
                }
                let (c0, c1) = (edges[i][0], edges[i][1]);
                if can_resolve(&edges, &resolved, i, c0) {
                    currents[i] = kcl_sum(&edges, &resolved, &injection, c0, &currents);
                    resolved[i] = true;
                    progress = true;
                } else if c1 != c0 && can_resolve(&edges, &resolved, i, c1) {
                    currents[i] = -kcl_sum(&edges, &resolved, &injection, c1, &currents);
                    resolved[i] = true;
                    progress = true;
                }
            }
            if !progress {
                break;
            }
        }

        if resolved.iter().any(|&r| !r) {
            resolve_stuck_wires(&edges, &mut resolved, &mut currents, &injection);
        }

        for (i, &ei) in edge_elm.iter().enumerate() {
            self.elements[ei].base_mut().current = currents[i];
        }
    }

    /// Copies the solution vector into node voltages and per-element state.
    fn write_back(&mut self) {
        let x = &self.sys.x;
        self.node_voltages[0] = 0.0;
        self.node_voltages[1..self.node_count].copy_from_slice(&x[..self.node_count - 1]);
        let vs_offset = self.node_count - 1;
        for elm in self.elements.iter_mut() {
            let base = elm.base_mut();
            for i in 0..base.nodes.len() {
                base.volts[i] = self.node_voltages[base.nodes[i]];
            }
            for k in 0..base.vs_currents.len() {
                base.vs_currents[k] = x[vs_offset + base.vs_base + k];
            }
        }
    }

    /// Advances `steps` timesteps, sampling every scope on each one.
    pub fn run(&mut self, steps: u32) -> StepReport {
        let mut total = StepReport {
            time: self.ctx.time,
            converged: true,
            ..Default::default()
        };
        for _ in 0..steps {
            let r = self.step_once();
            total.steps += 1;
            total.iterations += r.iterations;
            total.time = r.time;
            if !r.converged {
                total.converged = false;
                total.error = r.error;
                break;
            }
            self.sample_scopes();
        }
        total
    }

    fn sample_scopes(&mut self) {
        for scope in self.scopes.iter_mut() {
            let Some(ei) = scope.element_index else {
                continue;
            };
            let elm = &self.elements[ei];
            let base = elm.base();
            let v = match scope.value_kind() {
                ScopeValue::Voltage => {
                    if base.volts.len() >= 2 {
                        base.volts[0] - base.volts[1]
                    } else {
                        base.volts.first().copied().unwrap_or(0.0)
                    }
                }
                ScopeValue::Current => base.current,
                ScopeValue::Power => {
                    let vd = if base.volts.len() >= 2 {
                        base.volts[0] - base.volts[1]
                    } else {
                        0.0
                    };
                    vd * base.current
                }
                ScopeValue::NodeVoltage => base.volts.get(scope.spec.post).copied().unwrap_or(0.0),
            };
            scope.push(v);
        }
    }

    /// Returns the circuit to time zero.
    pub fn reset(&mut self) {
        self.ctx.time = 0.0;
        self.ctx.subiter = 0;
        self.error = None;
        for elm in self.elements.iter_mut() {
            elm.reset();
        }
        for s in self.scopes.iter_mut() {
            s.clear();
        }
        self.node_voltages.iter_mut().for_each(|v| *v = 0.0);
        self.allocate_and_stamp();
        if self.options.dc_operating_point {
            self.solve_operating_point();
        }
    }

    /// Live parameter edit from the UI. Returns false if the id is unknown or
    /// the element does not recognise the parameter name; the caller then has
    /// to rebuild the whole circuit rather than silently drop the edit.
    pub fn set_param(&mut self, id: u32, name: &str, value: f64) -> bool {
        let Some(&ei) = self.id_index.get(&id) else {
            return false;
        };
        if !self.elements[ei].set_param(name, value) {
            return false;
        }
        self.restamp();
        true
    }

    /// Interactive state change, e.g. flipping a switch. Throwing a switch can
    /// merge or unmerge its terminals, so the whole topology pass re-runs.
    pub fn set_state(&mut self, id: u32, state: i32) -> bool {
        let Some(&ei) = self.id_index.get(&id) else {
            return false;
        };
        self.elements[ei].set_state(state);
        self.reanalyze();
        true
    }

    /// Per-element current, in element order.
    pub fn element_currents(&self) -> Vec<f64> {
        self.elements.iter().map(|e| e.base().current).collect()
    }

    /// Per-element terminal voltage difference, in element order.
    pub fn element_voltages(&self) -> Vec<f64> {
        self.elements
            .iter()
            .map(|e| {
                let b = e.base();
                if b.volts.len() >= 2 {
                    b.volts[0] - b.volts[1]
                } else {
                    b.volts.first().copied().unwrap_or(0.0)
                }
            })
            .collect()
    }

    /// Node index per element terminal, flattened in element order. Lets the
    /// renderer colour each terminal by its node voltage.
    pub fn element_nodes(&self) -> Vec<u32> {
        let mut out = Vec::new();
        for e in &self.elements {
            let b = e.base();
            for i in 0..e.post_count() {
                out.push(b.nodes[i] as u32);
            }
        }
        out
    }
}

/// Index for a coordinate, allocating one on first sight.
fn coord_of(
    coord_id: &mut HashMap<[i32; 2], usize>,
    coords: &mut Vec<[i32; 2]>,
    c: [i32; 2],
) -> usize {
    if let Some(&i) = coord_id.get(&c) {
        i
    } else {
        let i = coords.len();
        coord_id.insert(c, i);
        coords.push(c);
        i
    }
}

/// True when every other unresolved wire touching `c` is resolved, so wire `i`
/// is free to determine its current from KCL at `c`. Self-loops (both posts at
/// one coordinate) never block: they neither draw nor deliver net current, so
/// their own current is whatever the neighbours leave.
fn can_resolve(edges: &[[usize; 2]], resolved: &[bool], i: usize, c: usize) -> bool {
    for (j, e) in edges.iter().enumerate() {
        if j == i || resolved[j] || e[0] == e[1] {
            continue;
        }
        if e[0] == c || e[1] == c {
            return false;
        }
    }
    true
}

/// Net current KCL assigns to the wire being resolved at `c`: what the
/// non-removable elements push in, plus what already-resolved wires at `c`
/// deliver (`+current` when `c` is their post 1 side, `-current` when it is
/// their post 0 side). A resolved self-loop contributes nothing.
fn kcl_sum(
    edges: &[[usize; 2]],
    resolved: &[bool],
    injection: &[f64],
    c: usize,
    currents: &[f64],
) -> f64 {
    let mut sum = injection[c];
    for (j, e) in edges.iter().enumerate() {
        if !resolved[j] || e[0] == e[1] {
            continue;
        }
        if e[0] == c {
            sum -= currents[j];
        } else if e[1] == c {
            sum += currents[j];
        }
    }
    sum
}

/// Solves the KCL system of a stuck wire subgraph (a cycle with no leaf to
/// resolve from) by minimum norm. Coordinates are the nodes, each unresolved
/// wire an edge with current positive from post 0 to post 1, so the incidence
/// matrix `B` satisfies `B I = b` with `b` the negated net injection. The
/// minimum-norm solution `I = B^T (B B^T)^+ b` is deterministic: parallel
/// shorts split equally, an undriven ring reports zero everywhere.
fn resolve_stuck_wires(
    edges: &[[usize; 2]],
    resolved: &mut [bool],
    currents: &mut [f64],
    injection: &[f64],
) {
    // Split the leftovers into connected components over their coordinates, so
    // each cycle solves on its own tiny system.
    let mut uf = UnionFind::new(injection.len());
    for (i, e) in edges.iter().enumerate() {
        if !resolved[i] && e[0] != e[1] {
            uf.union(e[0], e[1]);
        }
    }
    let mut by_root: HashMap<usize, Vec<usize>> = HashMap::new();
    for (i, e) in edges.iter().enumerate() {
        if !resolved[i] {
            by_root.entry(uf.find(e[0])).or_default().push(i);
        }
    }

    for idxs in by_root.values() {
        let mut comp_coord: HashMap<usize, usize> = HashMap::new();
        let mut comp: Vec<usize> = Vec::new();
        for &i in idxs {
            for &c in &edges[i] {
                if let std::collections::hash_map::Entry::Vacant(e) = comp_coord.entry(c) {
                    e.insert(comp.len());
                    comp.push(c);
                }
            }
        }
        let m = comp.len();
        if m <= 1 {
            // Nothing but self-loops: there is no information, report zero.
            for &i in idxs {
                currents[i] = 0.0;
                resolved[i] = true;
            }
            continue;
        }

        // Drop one coordinate's row. The reduced incidence matrix of a
        // connected component is full row rank, so its Gram matrix is
        // invertible and the minimum-norm solution is exact.
        let dropped = m - 1;
        let nr = m - 1;

        // Right-hand side: negated net injection at each coordinate, where
        // already-resolved wires contribute through `current_into_node`.
        let mut b = vec![0.0; m];
        for (r, &c) in comp.iter().enumerate() {
            let mut s = injection[c];
            for (j, e) in edges.iter().enumerate() {
                if !resolved[j] || e[0] == e[1] {
                    continue;
                }
                if e[0] == c {
                    s -= currents[j];
                } else if e[1] == c {
                    s += currents[j];
                }
            }
            b[r] = -s;
        }

        // Gram matrix G = B' B'^T over the reduced coordinates. Each edge
        // contributes its column's outer product; a self-loop's column is
        // zero, so it neither constrains the system nor carries current.
        let mut g = vec![0.0; nr * nr];
        let mut col = vec![0.0; nr];
        for &i in idxs {
            let (r0, r1) = (comp_coord[&edges[i][0]], comp_coord[&edges[i][1]]);
            for v in col.iter_mut() {
                *v = 0.0;
            }
            if r0 != dropped {
                col[r0] -= 1.0;
            }
            if r1 != dropped {
                col[r1] += 1.0;
            }
            for (r, &vr) in col.iter().enumerate() {
                if vr == 0.0 {
                    continue;
                }
                for (s, &vs) in col.iter().enumerate() {
                    if vs != 0.0 {
                        g[r * nr + s] += vr * vs;
                    }
                }
            }
        }

        let mut sys = LinearSystem::new();
        sys.resize(nr);
        for r in 0..nr {
            for s in 0..nr {
                if g[r * nr + s] != 0.0 {
                    sys.add(r, s, g[r * nr + s]);
                }
            }
            if b[r] != 0.0 {
                sys.add_rhs(r, b[r]);
            }
        }

        // The reduced system is nonsingular here; if a numerical solve
        // disagrees, fall back to zero rather than leave stale values behind.
        let ok = sys.solve().is_ok();
        for &i in idxs {
            if ok {
                let (r0, r1) = (comp_coord[&edges[i][0]], comp_coord[&edges[i][1]]);
                let mut v = 0.0;
                if r0 != dropped {
                    v -= sys.x[r0];
                }
                if r1 != dropped {
                    v += sys.x[r1];
                }
                currents[i] = v;
            } else {
                currents[i] = 0.0;
            }
            resolved[i] = true;
        }
    }
}
