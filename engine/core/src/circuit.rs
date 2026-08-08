//! Netlist analysis and the time-stepping loop.

use std::collections::HashMap;

use crate::closure::{build_closures, Closure};
use crate::element::{Element, SimCtx};
use crate::elements::build_element;
use crate::matrix::{LinearSystem, SolveError};
use crate::scope::ScopeTrace;
use crate::spec::{CircuitSpec, ElementSpec, ScopeValue, SimOptions};
use crate::stamp::{Stamper, GROUND};

/// Conductance tied from every floating node to ground so the matrix stays
/// non-singular. Ten nanosiemens matches upstream's 1e8 ohm pin
/// (SimulationManager.java:796-802): far below anything a user would notice,
/// but enough to define an otherwise floating node directly instead of
/// through whatever tiny coupling its component happens to have.
const GMIN: f64 = 1e-8;

#[derive(Default)]
pub(crate) struct UnionFind {
    parent: Vec<usize>,
}

impl UnionFind {
    pub(crate) fn new(n: usize) -> Self {
        Self {
            parent: (0..n).collect(),
        }
    }

    pub(crate) fn find(&mut self, mut i: usize) -> usize {
        while self.parent[i] != i {
            self.parent[i] = self.parent[self.parent[i]];
            i = self.parent[i];
        }
        i
    }

    pub(crate) fn union(&mut self, a: usize, b: usize) {
        let (ra, rb) = (self.find(a), self.find(b));
        if ra != rb {
            self.parent[ra] = rb;
        }
    }
}

/// Formats a resistance with an engineering prefix and the ohm symbol,
/// e.g. 1e9 -> "1 GΩ". Mirrors `formatValue` on the web side, using the OHM
/// SIGN codepoint (\u{2126}) rather than Greek capital omega.
fn format_ohms(r: f64) -> String {
    const PREFIXES: [(f64, &str); 4] = [(1e12, ""), (1e9, "G"), (1e6, "M"), (1e3, "k")];
    for (scale, prefix) in PREFIXES {
        if r >= scale {
            return format!("{} {}{}", r / scale, prefix, '\u{2126}');
        }
    }
    format!("{} \u{2126}", r)
}

/// Outcome of advancing the simulation.
#[derive(Debug, Clone, Default)]
pub struct StepReport {
    pub steps: u32,
    /// Total Newton iterations across the frame, useful for a perf readout.
    pub iterations: u32,
    /// Timestep the last committed step used, and what the next step will
    /// attempt.
    pub time_step: f64,
    /// Timestep attempts rejected by the halve-and-retry path this frame.
    pub rejected_steps: u32,
    pub time: f64,
    pub converged: bool,
    pub error: Option<String>,
    /// Element ids that were still moving when the Newton budget ran out.
    /// Empty on a converged frame and on a singular matrix, which is a
    /// topology problem, not an element failure.
    pub failing: Vec<u32>,
}

/// Why a single timestep attempt failed, with the subiterations it burned
/// before giving up so the caller can report them.
#[derive(Debug, Clone)]
enum StepError {
    /// The matrix has no pivot: typically a shorted source or a floating
    /// subcircuit. A topology problem, so halving the step cannot fix it
    /// and the attempt must not enter the halving loop.
    Singular(u32),
    /// The Newton budget ran out, with the element indices of the elements
    /// that were still moving on the final iteration.
    NotConverged(u32, Vec<usize>),
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
    /// Connected components of the matrix graph, each with its own system.
    /// Two networks that only touch ground are separate closures, so they
    /// solve independently and each linear closure factors once at build.
    closures: Vec<Closure>,
    node_closure: Vec<usize>,
    node_row: Vec<usize>,
    vs_closure: Vec<usize>,
    vs_row: Vec<usize>,
    element_closure: Vec<usize>,
    node_count: usize,
    vs_count: usize,
    node_voltages: Vec<f64>,
    options: SimOptions,
    ctx: SimCtx,
    /// Timestep the next step will attempt; starts at `options.time_step` and
    /// moves between it and `min_time_step` under adaptation.
    current_time_step: f64,
    /// Consecutive easy steps, drives doubling once it reaches 3.
    good_iterations: u32,
    /// Solved closure vectors of the last committed step, one per closure, so
    /// a rejected attempt can restore it.
    last_x: Vec<Vec<f64>>,
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
            closures: Vec::new(),
            node_closure: Vec::new(),
            node_row: Vec::new(),
            vs_closure: Vec::new(),
            vs_row: Vec::new(),
            element_closure: Vec::new(),
            node_count: 1,
            vs_count: 0,
            node_voltages: vec![0.0],
            options: SimOptions::default(),
            ctx: SimCtx::default(),
            current_time_step: SimOptions::default().time_step,
            good_iterations: 0,
            last_x: Vec::new(),
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

    /// Multiply-adds accumulated by the factor passes across all closures,
    /// for the closure-decomposition speedup test. Deterministic, unlike a
    /// wall clock.
    pub fn factor_flops(&self) -> u64 {
        self.closures.iter().map(|c| c.sys.flops()).sum()
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

    /// This frame's recent raw samples for one scope trace (X-Y mode).
    pub fn recent_samples(&self, index: usize) -> Vec<f32> {
        self.scopes
            .get(index)
            .map(|s| s.recent_snapshot())
            .unwrap_or_default()
    }

    /// Trigger display anchor for one scope trace.
    pub fn trigger_info(&self, index: usize, width: usize) -> Option<crate::scope::TriggerInfo> {
        self.scopes.get(index).map(|s| s.trigger_info(width))
    }

    /// Replaces the circuit and runs analysis. Returns an error when the
    /// netlist cannot be built at all, and when a linear circuit's matrix is
    /// singular at analysis time (upstream factors linear matrices
    /// immediately and stops on failure, SimulationManager.java:1020-1030).
    /// Nonlinear circuits keep per-step detection: their base matrix can be
    /// structurally fine and singular only at a specific operating point.
    pub fn set_circuit(&mut self, spec: &CircuitSpec) -> Result<(), String> {
        self.options = spec.options.clone().unwrap_or_default();
        self.warnings.clear();
        self.error = None;
        self.current_time_step = self.options.time_step;
        self.good_iterations = 0;
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

        self.link_relay_contacts();
        // Capacitor validation can grow a capacitor's internal node count
        // (the 0.1 ohm damping), which renumbers nodes, so the whole pass
        // retries, upstream's 10-attempt pre-stamp loop
        // (SimulationManager.java:944-947). Upstream stops with "failed to
        // stamp circuit" after the tenth attempt; here the loop always breaks
        // on a clean pass in one or two iterations, because damping only
        // removes CAP_V paths, never adds them, and a residual undamped
        // ideal-cap loop is left as-is rather than reported. Each pass ends
        // on a fresh `assign_nodes`, so the damped capacitor's new internal
        // node is always allocated before anything stamps.
        let mut attempts = 0;
        loop {
            self.assign_nodes(&spec.elements);
            if !self.validate_capacitors() {
                break;
            }
            attempts += 1;
            if attempts >= 10 {
                // Defensive only: monotone damping cannot reach this, but a
                // fresh node pass keeps the final state consistent regardless.
                self.assign_nodes(&spec.elements);
                break;
            }
        }
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
            self.solve_operating_point()?;
        }
        // Linear matrices are factored eagerly so a singular circuit (two
        // sources fighting over one node, a shorted source) is rejected here
        // at build time, not on the first frame. The DC solve above, when on,
        // already re-stamped for the transient, so this factor is of the
        // matrices the transient steps will actually solve.
        if !self.nonlinear {
            for c in self.closures.iter_mut() {
                c.sys.factor().map_err(|_| {
                    "The circuit has no solution: check for shorted sources or missing connections."
                        .to_string()
                })?;
            }
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

    /// Resolves relay labels once, at build time, so a coil's per-step state
    /// machine can drive its contacts by element index instead of scanning
    /// the element list like upstream's `toggleSwitchPositions`
    /// (RelayCoilElm.java:353-378). A coil with no matching contact simply
    /// drives nobody; a contact with no coil keeps its file position.
    fn link_relay_contacts(&mut self) {
        let mut contacts_by_label: HashMap<String, Vec<usize>> = HashMap::new();
        for (i, elm) in self.elements.iter().enumerate() {
            if let Some(label) = elm.link_label() {
                contacts_by_label
                    .entry(label.to_string())
                    .or_default()
                    .push(i);
            }
        }
        for elm in self.elements.iter_mut() {
            if let Some(label) = elm.link_label() {
                if let Some(contacts) = contacts_by_label.get(label) {
                    elm.set_relay_contacts(contacts.clone());
                }
            }
        }
    }

    /// Applies the contact drives each coil queued during `start_iteration`.
    /// Runs once per timestep, between `start_iteration` and the Newton loop,
    /// so a coil's new `switchPosition` reaches its contacts before their
    /// `do_step` stamps the new conductance.
    fn push_relay_contact_positions(&mut self) {
        let mut updates: Vec<(usize, i32)> = Vec::new();
        for elm in self.elements.iter_mut() {
            updates.extend(elm.relay_contact_updates());
        }
        for (ci, position) in updates {
            if ci < self.elements.len() {
                self.elements[ci].set_relay_position(position);
            }
        }
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
        // Pin every node of each floating component, not one representative:
        // a node that only reaches its component through a huge resistance is
        // then defined directly instead of through that ill-conditioned
        // coupling, matching upstream's per-node connectUnconnectedNodes.
        let mut pins = Vec::new();
        for n in 1..self.node_count {
            if uf.find(n) != ground_root {
                pins.push(n);
            }
        }
        pins
    }

    /// Marks current sources whose terminals have no DC current path as
    /// broken, upstream's `CurrentElm.validate()` (CurrentElm.java:203-207).
    /// Upstream walks an INDUCT `FindPathInfo` between the source's two nodes;
    /// a UnionFind over `dc_connects` finds the same components, with a
    /// capacitor open and an inductor short, and a path through ground counts
    /// because ground symbols share node 0. Runs on every restamp, so throwing
    /// a switch re-evaluates the path.
    fn check_broken_sources(&mut self) {
        let mut uf = UnionFind::new(self.node_count);
        for elm in &self.elements {
            let nodes = &elm.base().nodes;
            for a in 0..nodes.len() {
                for b in (a + 1)..nodes.len() {
                    if elm.dc_connects(a, b) {
                        uf.union(nodes[a], nodes[b]);
                    }
                }
            }
        }
        for elm in self.elements.iter_mut() {
            if elm.kind() == "current" {
                let (n0, n1) = (elm.base().nodes[0], elm.base().nodes[1]);
                let broken = uf.find(n0) != uf.find(n1);
                elm.set_broken(broken);
            }
        }
    }

    /// Depth-first CAP_V search, ported from `FindPathInfo.findPath`
    /// (FindPathInfo.java:26-104). Starting from a capacitor's post 0, does
    /// the merged node graph reach its post 1 by crossing only ideal
    /// capacitors and voltage sources? Wires and closed switches are absent by
    /// construction: `assign_nodes` merges them into self-loops, so a wire can
    /// never bridge two distinct nodes and the SHORT filter (upstream's
    /// `isWireEquivalent`) collapses to the trivial post-equality check in
    /// [`Circuit::validate_capacitors`]. Ground needs no branch because every
    /// ground symbol is merged onto node 0, exactly what upstream's
    /// `CircuitNode.ground` case (FindPathInfo.java:42-46, :71-83) provides.
    /// `skip` is the element being validated, never traversed.
    fn cap_v_path(&self, start: usize, dest: usize, skip: usize) -> bool {
        let mut visited = vec![false; self.node_count];
        self.cap_v_visit(start, dest, skip, &mut visited)
    }

    fn cap_v_visit(&self, n: usize, dest: usize, skip: usize, visited: &mut [bool]) -> bool {
        if n == dest {
            return true;
        }
        if visited[n] {
            return false;
        }
        visited[n] = true;
        for (ei, elm) in self.elements.iter().enumerate() {
            if ei == skip {
                continue;
            }
            if !(elm.is_ideal_capacitor() || elm.is_voltage_source()) {
                continue;
            }
            let nodes = &elm.base().nodes;
            if elm.post_count() >= 2 {
                if nodes[0] == n && self.cap_v_visit(nodes[1], dest, skip, visited) {
                    return true;
                }
                if nodes[1] == n && self.cap_v_visit(nodes[0], dest, skip, visited) {
                    return true;
                }
            } else {
                // A rail's single post spans to the reference node, which is
                // the port's node 0 in the merged graph, so it crosses either
                // way: terminal to ground, and ground to terminal.
                if nodes[0] == n && self.cap_v_visit(GROUND, dest, skip, visited) {
                    return true;
                }
                if n == GROUND && self.cap_v_visit(nodes[0], dest, skip, visited) {
                    return true;
                }
            }
        }
        false
    }

    /// Ports `CapacitorElm.validate()` (CapacitorElm.java:274-291). For every
    /// ideal capacitor in element order: if its two posts merged into one node
    /// (the SHORT condition), `shorted()` zeroes the stored charge; otherwise
    /// the CAP_V walk decides whether it sits in a loop of ideal capacitors
    /// and voltage sources, and a hit forces the 0.1 ohm series resistance
    /// that damps the trapezoidal companion. Damping in element order keeps
    /// upstream's semantics: the later member of a parallel pair no longer
    /// sees the damped one as ideal, so exactly one of the two carries the
    /// 0.1. Returns true when at least one capacitor was damped, which needs
    /// a retry because the new internal node changes the node count.
    fn validate_capacitors(&mut self) -> bool {
        let mut changed = false;
        for ei in 0..self.elements.len() {
            if !self.elements[ei].is_ideal_capacitor() {
                continue;
            }
            let (n0, n1) = {
                let nodes = &self.elements[ei].base().nodes;
                (nodes[0], nodes[1])
            };
            if n0 == n1 {
                self.elements[ei].shorted();
            } else if self.cap_v_path(n0, n1, ei) {
                self.elements[ei].set_series_resistance(0.1);
                changed = true;
            }
        }
        changed
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
        // A reallocation renumbers nodes, so the committed solution no longer
        // means anything; `restamp` re-seeds `last_x` to all zeroes on the
        // next pass because the empty vector never matches the closure sizes.
        self.last_x = Vec::new();
    }

    /// Sets the working timestep and rebuilds the constant stamp pass, which
    /// holds the reactive companion conductances that depend on `dt`. Called
    /// on every halve and every double, matching upstream's re-stamp on a
    /// step change (SimulationManager.java:1318,1405).
    fn set_time_step(&mut self, dt: f64) {
        self.current_time_step = dt;
        self.ctx.dt = dt;
        self.restamp();
    }

    /// Zeroes the matrix, re-runs the constant stamp pass and snapshots the
    /// result for reuse across timesteps.
    fn restamp(&mut self) {
        // A live parameter edit can flip `nonlinear()` (a current source
        // gaining or losing `maxVoltage`), which `allocate` only decides once.
        // Recompute so the single-subiteration path is not taken for a source
        // that just became voltage-limited.
        self.nonlinear = self.elements.iter().any(|e| e.nonlinear());
        // A switch that opens or closes changes which current sources have a
        // DC path, so the broken flag is re-derived on every restamp rather
        // than once at analysis time.
        self.check_broken_sources();
        // Rebuild the closures: a throw that merges or unmerges terminals
        // changes membership, and every restamp re-solves which system each
        // element stamps into.
        let map = build_closures(
            &self.elements,
            self.node_count,
            self.vs_count,
            self.nonlinear,
        );
        self.closures = map.closures;
        self.node_closure = map.node_closure;
        self.node_row = map.node_row;
        self.vs_closure = map.vs_closure;
        self.vs_row = map.vs_row;
        self.element_closure = map.element_closure;
        if self.closures.is_empty() {
            self.last_x = Vec::new();
            return;
        }
        let ctx = self.ctx;
        let pins = self.floating_nodes();
        {
            let mut s = Stamper::new(
                &mut self.closures,
                &self.node_closure,
                &self.node_row,
                &self.vs_closure,
                &self.vs_row,
                &self.element_closure,
            );
            for n in pins {
                s.conductance(n, GROUND, GMIN);
            }
            for (ei, elm) in self.elements.iter_mut().enumerate() {
                s.set_current(ei);
                elm.stamp(&ctx, &mut s);
            }
        }
        for c in self.closures.iter_mut() {
            c.sys.snapshot();
        }
        // `last_x` is the committed solution a rejected step restores. A
        // reallocation (`allocate` emptied it) or any change in closure sizes
        // re-seeds it to all zeroes, the t=0 state; a restamp that preserves
        // the sizes (a `set_time_step` halve, a `set_param` edit) keeps the
        // committed values, so a halved retry can restore where the last
        // committed step left off, exactly as the flat `last_solution` did.
        let sizes_changed = self.last_x.len() != self.closures.len()
            || self
                .last_x
                .iter()
                .zip(&self.closures)
                .any(|(l, c)| l.len() != c.sys.size());
        if sizes_changed {
            self.last_x = self
                .closures
                .iter()
                .map(|c| vec![0.0; c.sys.size()])
                .collect();
        }
    }

    /// Allocation plus stamping, with the one-off floating-node diagnostic.
    fn allocate_and_stamp(&mut self) {
        self.allocate();
        let pins = self.floating_nodes();
        if !pins.is_empty() {
            self.warnings.push(format!(
                "{} floating node(s) have no path to ground; they were pinned with a {} resistance.",
                pins.len(),
                format_ohms(1.0 / GMIN)
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
        // Closing a switch can short a capacitor or complete a capacitor loop,
        // so the same validate-and-retry as `set_circuit` runs here, matching
        // upstream's per-analysis validateCircuit.
        let mut attempts = 0;
        loop {
            self.assign_nodes(&self.specs.clone());
            if !self.validate_capacitors() {
                break;
            }
            attempts += 1;
            if attempts >= 10 {
                self.assign_nodes(&self.specs.clone());
                break;
            }
        }
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
    /// transient analysis a sensible starting point. Errors only when a linear
    /// circuit's DC matrix is singular: a nonlinear circuit can legitimately
    /// have no operating point (a current source into a reverse diode), in
    /// which case the transient degrades to the documented initial conditions
    /// and the call still succeeds.
    fn solve_operating_point(&mut self) -> Result<(), String> {
        // Reactive elements stamp differently under DC (a capacitor as an
        // open circuit, an inductor as a short), so the matrix has to be built
        // for DC, used, and then rebuilt for transient stepping.
        self.ctx.dc_analysis = true;
        self.restamp();
        // No adaptation here: there is no time to shrink, and reactive stamps
        // ignore `dt` under `dc_analysis`. One attempt at the nominal step
        // with the normal budget, exactly as before.
        let solved = self
            .try_step(self.options.time_step, self.options.max_subiterations)
            .is_ok();
        self.ctx.dc_analysis = false;
        self.ctx.time = 0.0;
        if !solved {
            // A failed DC solve must not seed reactive history from the last
            // Newton iterate; restart from the documented initial conditions.
            // The transient then degrades to the uncharged start rather than
            // committing garbage. `node_voltages` is cleared with the elements
            // so the frontend, which reads `node_voltages` after a build,
            // does not see the last (possibly diverged) DC iterate.
            self.node_voltages.fill(0.0);
            for elm in self.elements.iter_mut() {
                elm.reset();
            }
            if !self.nonlinear {
                // For a linear circuit a failed DC solve means the DC matrix
                // is singular: the circuit is genuinely unsolvable, so
                // continuing would leave a poisoned transient behind.
                return Err(
                    "The circuit has no solution: check for shorted sources or missing connections."
                        .to_string(),
                );
            }
        }
        self.restamp();
        Ok(())
    }

    /// A single timestep attempt at `dt`, running up to `budget` Newton
    /// subiterations. The clock is committed only on success: `ctx.time` is
    /// advanced to `committed + dt` while the attempt runs (so time-varying
    /// sources see the end-of-step time) and restored on every failure path.
    /// Reactive history (`v_prev`/`i_prev` and the source phase) moves only
    /// in the converged branch below, in that order (`step_finished` reads
    /// `base.current`, which `calculate_current` set).
    fn try_step(&mut self, dt: f64, budget: u32) -> Result<usize, StepError> {
        let committed_time = self.ctx.time;
        self.ctx.dt = dt;
        if !self.ctx.dc_analysis {
            self.ctx.time = committed_time + dt;
        }

        let ctx_snapshot = self.ctx;
        for elm in self.elements.iter_mut() {
            elm.start_iteration(&ctx_snapshot);
        }
        self.push_relay_contact_positions();

        // Linear circuits settle in a single pass; the caller's budget is for
        // the nonlinear Newton loop. The `max(2)` guard keeps a pathologically
        // low budget from making every nonlinear step fail on purpose.
        let max_sub = if self.nonlinear { budget.max(2) } else { 1 };
        let mut converged_at = None;
        // Element indices of whoever was still moving on the last iteration.
        // Only meaningful on budget exhaustion, where it lets the caller name
        // the failing elements.
        let mut last_failing: Vec<usize> = Vec::new();

        for subiter in 0..max_sub {
            self.ctx.subiter = subiter as usize;
            let ctx = self.ctx;

            // Per closure, per iteration: the right-hand side is always
            // restored, and the matrix only for nonlinear closures. A linear
            // closure keeps its cached LU factors across the whole run.
            for c in self.closures.iter_mut() {
                if c.nonlinear {
                    c.sys.restore();
                    c.sys.invalidate();
                } else {
                    c.sys.restore_rhs();
                }
            }

            let converged = {
                let mut s = Stamper::new(
                    &mut self.closures,
                    &self.node_closure,
                    &self.node_row,
                    &self.vs_closure,
                    &self.vs_row,
                    &self.element_closure,
                );
                for (ei, elm) in self.elements.iter_mut().enumerate() {
                    s.set_current(ei);
                    elm.do_step(&ctx, &mut s);
                }
                last_failing = std::mem::take(&mut s.failing);
                s.converged
            };

            for c in self.closures.iter_mut() {
                if let Err(SolveError::Singular) = c.sys.solve() {
                    self.ctx.time = committed_time;
                    return Err(StepError::Singular(subiter + 1));
                }
            }
            self.write_back();

            if converged && (subiter > 0 || !self.nonlinear) {
                converged_at = Some(subiter);
                break;
            }
        }

        let Some(subiter) = converged_at else {
            self.ctx.time = committed_time;
            return Err(StepError::NotConverged(max_sub, last_failing));
        };

        let ctx = self.ctx;
        for elm in self.elements.iter_mut() {
            elm.calculate_current(&ctx);
        }
        self.recover_wire_currents();
        for elm in self.elements.iter_mut() {
            elm.step_finished(&ctx);
        }
        Ok(subiter as usize)
    }

    /// Puts the circuit back on the last committed step so a retry at a
    /// smaller `dt` starts from the same state the failed attempt found.
    /// `try_step` has already restored the clock; what remains is the
    /// solution vector, the derived voltages and the per-element Newton
    /// anchors, which a failed attempt mutated.
    fn restore_committed(&mut self) {
        debug_assert_eq!(self.closures.len(), self.last_x.len());
        for (c, last) in self.closures.iter_mut().zip(self.last_x.iter()) {
            debug_assert_eq!(c.sys.x.len(), last.len());
            c.sys.x.copy_from_slice(last);
        }
        self.write_back();
        for elm in self.elements.iter_mut() {
            elm.restore_iteration();
        }
    }

    /// Advances one committed timestep, shrinking the step and retrying when
    /// Newton cannot settle, and doubling back up after easy steps.
    fn step_once(&mut self) -> StepReport {
        let mut report = StepReport {
            steps: 1,
            time: self.ctx.time,
            converged: true,
            time_step: self.current_time_step,
            ..Default::default()
        };
        if self.closures.is_empty() {
            return report;
        }

        let mut step = self.current_time_step;
        loop {
            // The 100-budget applies only while the step can still be halved;
            // at the floor (or with adaptation off) the budget relaxes so the
            // solver gets every chance before failing, matching upstream's
            // subiterCount rule (SimulationManager.java:1328).
            let can_shrink = self.options.adaptive && step / 2.0 > self.options.min_time_step;
            let budget = if self.options.adaptive && !can_shrink {
                5000
            } else {
                self.options.max_subiterations
            };

            match self.try_step(step, budget) {
                Ok(subiter) => {
                    report.iterations += subiter as u32 + 1;
                    debug_assert_eq!(self.closures.len(), self.last_x.len());
                    for (c, last) in self.closures.iter_mut().zip(self.last_x.iter_mut()) {
                        debug_assert_eq!(c.sys.x.len(), last.len());
                        last.copy_from_slice(&c.sys.x);
                    }
                    if subiter < 3 {
                        self.good_iterations += 1;
                        if self.good_iterations >= 3
                            && self.current_time_step < self.options.time_step
                        {
                            let doubled =
                                (self.current_time_step * 2.0).min(self.options.time_step);
                            self.set_time_step(doubled);
                            self.good_iterations = 0;
                        }
                    } else {
                        self.good_iterations = 0;
                    }
                    report.time = self.ctx.time;
                    report.time_step = self.current_time_step;
                    break;
                }
                Err(StepError::Singular(iterations)) => {
                    report.iterations += iterations;
                    report.converged = false;
                    // A matrix problem is a topology problem, not an element
                    // failure, so `failing` stays empty.
                    report.error = Some(
                        "The circuit has no solution: check for shorted sources or missing connections."
                            .into(),
                    );
                    self.error = report.error.clone();
                    return report;
                }
                Err(StepError::NotConverged(iterations, _)) if can_shrink => {
                    report.iterations += iterations;
                    report.rejected_steps += 1;
                    self.good_iterations = 0;
                    self.restore_committed();
                    self.set_time_step(step / 2.0);
                    step = self.current_time_step;
                }
                Err(StepError::NotConverged(iterations, failing)) => {
                    report.iterations += iterations;
                    report.converged = false;
                    report.error = Some(if self.options.adaptive {
                        "Convergence failed at the minimum timestep.".into()
                    } else {
                        "Newton iteration did not converge; try a smaller timestep.".into()
                    });
                    report.failing = failing.iter().map(|&ei| self.ids[ei]).collect();
                    self.error = report.error.clone();
                    return report;
                }
            }
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

    /// Copies each closure's solved vector into node voltages and per-element
    /// state.
    fn write_back(&mut self) {
        self.node_voltages[0] = 0.0;
        for c in self.closures.iter() {
            let x = &c.sys.x;
            for (k, &node) in c.node_rows.iter().enumerate() {
                self.node_voltages[node] = x[k];
            }
        }
        for elm in self.elements.iter_mut() {
            let base = elm.base_mut();
            for i in 0..base.nodes.len() {
                base.volts[i] = self.node_voltages[base.nodes[i]];
            }
            for k in 0..base.vs_currents.len() {
                let gvs = base.vs_base + k;
                let c = self.vs_closure[gvs];
                base.vs_currents[k] = self.closures[c].sys.x[self.vs_row[gvs]];
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
            total.steps += r.steps;
            total.iterations += r.iterations;
            total.rejected_steps += r.rejected_steps;
            total.time_step = r.time_step;
            total.time = r.time;
            if !r.converged {
                total.converged = false;
                total.error = r.error;
                total.failing = r.failing;
                break;
            }
            self.sample_scopes();
        }
        total
    }

    fn sample_scopes(&mut self) {
        let sim_time = self.ctx.time;
        for scope in self.scopes.iter_mut() {
            let Some(ei) = scope.element_index else {
                continue;
            };
            let elm = &self.elements[ei];
            let base = elm.base();
            let v = match scope.value_kind() {
                ScopeValue::Voltage => elm.voltage_diff(),
                ScopeValue::Current => base.current,
                ScopeValue::Power => elm.power(),
                ScopeValue::NodeVoltage => base.volts.get(scope.spec.post).copied().unwrap_or(0.0),
            };
            scope.push(v, sim_time);
        }
    }

    /// Changes a scope's capture parameters (speed and ring size) without a
    /// rebuild, so zooming the time base never rewinds the simulation.
    /// Returns false when the index is out of range, so the caller can fall
    /// back to a full reload.
    pub fn set_scope_params(&mut self, index: usize, steps_per_column: u32, columns: u32) -> bool {
        let Some(scope) = self.scopes.get_mut(index) else {
            return false;
        };
        scope.set_params(steps_per_column, columns);
        true
    }

    /// Toggles a scope's AC coupling without a rebuild, so the coupling radio
    /// never rewinds the simulation. Returns false when the index is out of
    /// range, so the caller can fall back to a full reload.
    pub fn set_scope_ac_coupled(&mut self, index: usize, ac_coupled: bool) -> bool {
        let Some(scope) = self.scopes.get_mut(index) else {
            return false;
        };
        scope.set_ac_coupled(ac_coupled);
        true
    }

    /// Returns the circuit to time zero.
    pub fn reset(&mut self) {
        self.ctx.time = 0.0;
        self.ctx.dt = self.options.time_step;
        self.ctx.subiter = 0;
        self.error = None;
        self.current_time_step = self.options.time_step;
        self.good_iterations = 0;
        for elm in self.elements.iter_mut() {
            elm.reset();
        }
        for s in self.scopes.iter_mut() {
            s.clear();
        }
        self.node_voltages.iter_mut().for_each(|v| *v = 0.0);
        self.allocate_and_stamp();
        if self.options.dc_operating_point {
            if let Err(e) = self.solve_operating_point() {
                self.error = Some(e);
            }
        }
    }

    /// Live parameter edit from the UI. Returns false if the id is unknown or
    /// the element does not recognise the parameter name; the caller then has
    /// to rebuild the whole circuit rather than silently drop the edit.
    pub fn set_param(&mut self, id: u32, name: &str, value: f64) -> bool {
        let Some(&ei) = self.id_index.get(&id) else {
            return false;
        };
        // A frequency edit must keep the waveform phase continuous, which only
        // a source knows how to do, so it takes the dedicated hook rather than
        // the generic set_param.
        if name == "frequency" {
            if !self.elements[ei].set_frequency(&self.ctx, value) {
                return false;
            }
        } else if !self.elements[ei].set_param(name, value) {
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

    /// Per-element terminal voltage difference, in element order. Sources
    /// report positive EMF, everything else `V(post0) - V(post1)`, and the
    /// op-amp its `V(out) - V(+)`, all through the per-element
    /// [`Element::voltage_diff`] hook.
    pub fn element_voltages(&self) -> Vec<f64> {
        self.elements.iter().map(|e| e.voltage_diff()).collect()
    }

    /// Per-element dissipated power, in element order. Uses the same convention
    /// as a scope Power trace, so a source that is delivering power reads
    /// negative and the Options panel readout agrees with a power scope on the
    /// same element. Upstream's `-getVoltageDiff()*current` is the same
    /// expression.
    pub fn element_powers(&self) -> Vec<f64> {
        self.elements.iter().map(|e| e.power()).collect()
    }

    /// Per-element instrument reading, in element order. Probes report their
    /// selected meter value; everything else reports its voltage difference,
    /// so this array matches `element_voltages` except where a probe has a
    /// meter mode set.
    pub fn element_values(&self) -> Vec<f64> {
        self.elements.iter().map(|e| e.value()).collect()
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_ohms_uses_an_engineering_prefix() {
        assert_eq!(format_ohms(1e9), "1 G\u{2126}");
        assert_eq!(format_ohms(2.5e9), "2.5 G\u{2126}");
    }

    #[test]
    fn format_ohms_walks_the_neighbouring_prefixes() {
        assert_eq!(format_ohms(1e12), "1 \u{2126}");
        assert_eq!(format_ohms(1e6), "1 M\u{2126}");
        assert_eq!(format_ohms(1e3), "1 k\u{2126}");
        assert_eq!(format_ohms(100.0), "100 \u{2126}");
    }

    #[test]
    fn format_ohms_below_one_ohm_uses_the_bare_branch() {
        // GMIN never produces this (the pin is always 1/GMIN >= 1e8), but the
        // fallback must stay well-formed if the constant ever changed.
        assert_eq!(format_ohms(0.5), "0.5 \u{2126}");
    }
}
