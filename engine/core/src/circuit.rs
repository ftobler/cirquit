//! Netlist analysis and the time-stepping loop.

use std::collections::HashMap;

use crate::element::{Element, SimCtx};
use crate::elements::build_element;
use crate::matrix::{LinearSystem, SolveError};
use crate::scope::ScopeTrace;
use crate::spec::{CircuitSpec, ScopeValue, SimOptions};
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

        self.assign_nodes(spec);
        self.allocate_and_stamp();
        self.build_scopes(spec);

        if self.options.dc_operating_point {
            self.solve_operating_point();
        }
        Ok(())
    }

    /// Works out which terminals share a node.
    fn assign_nodes(&mut self, spec: &CircuitSpec) {
        // Flatten every terminal into one index space.
        let mut offsets = Vec::with_capacity(self.elements.len());
        let mut total = 0usize;
        for es in &spec.elements {
            offsets.push(total);
            total += es.posts.len();
        }

        let mut uf = UnionFind::new(total.max(1));
        let mut by_coord: HashMap<[i32; 2], usize> = HashMap::new();
        for (ei, es) in spec.elements.iter().enumerate() {
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

    /// Assigns voltage-source unknowns and sizes the matrix. Must re-run
    /// whenever an element's unknown count can change, which switches do when
    /// they open or close.
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
            elm.step_finished(&ctx);
        }
        report
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

    /// Live parameter edit from the UI. Returns false if the id is unknown.
    pub fn set_param(&mut self, id: u32, name: &str, value: f64) -> bool {
        let Some(&ei) = self.id_index.get(&id) else {
            return false;
        };
        self.elements[ei].set_param(name, value);
        self.restamp();
        true
    }

    /// Interactive state change, e.g. flipping a switch. Reallocates because
    /// an opening switch removes its current unknown from the system.
    pub fn set_state(&mut self, id: u32, state: i32) -> bool {
        let Some(&ei) = self.id_index.get(&id) else {
            return false;
        };
        let realloc = self.elements[ei].set_state(state);
        if realloc {
            self.allocate();
        }
        self.restamp();
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
