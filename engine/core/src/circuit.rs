//! Netlist analysis and the time-stepping loop.

use std::collections::{HashMap, HashSet};

use crate::closure::{build_closures, Closure};
use crate::element::{Element, SimCtx};
use crate::elements::build_element;
use crate::matrix::{
    matrix_too_large, LinearSystem, SolveError, SolverBackend, MAX_DENSE_ROWS, MAX_MATRIX_ROWS,
};
use crate::scope::ScopeTrace;
use crate::simplified::build_simplified;
use crate::spec::{CircuitSpec, ElementSpec, ScopeValue, SimOptions};
use crate::stamp::{Stamper, GROUND};

/// Conductance tied from every floating node to ground so the matrix stays
/// non-singular. Ten nanosiemens matches upstream's 1e8 ohm pin
/// (SimulationManager.java:796-802): far below anything a user would notice,
/// but enough to define an otherwise floating node directly instead of
/// through whatever tiny coupling its component happens to have.
const GMIN: f64 = 1e-8;

/// Below this stamped load conductance a current-source output terminal is
/// effectively open: the only loads that small are an open analog switch's
/// `r_off` (1e10 ohm = 1e-10 S) and genuinely floating structures. The
/// threshold equals the GMIN pin exactly, and the check is a strict `<`, so a
/// node whose diagonal is exactly GMIN (a gmin-pinned floating output) is
/// deliberately excluded: a pinned node must carry a load smaller than the
/// gmin floor. qam-256's runaway output sits at 2e-10 S, two orders of
/// magnitude below the boundary; the corpus's smallest genuine current-source
/// load is ~1e-2 S.
const OPEN_LOAD_G: f64 = 1e-8;

/// Conductance stamped from an effectively-open current-source output to
/// ground. One ohm keeps the solved node voltage at roughly the source's own
/// current (qam-256's 2.2 mA -> ~2 mV), deep inside an op-amp follower's rail
/// window, while dominating every stray load by orders of magnitude. A smaller
/// pin would let a larger source current push the node past the follower's
/// ±15 V rails again.
const OPEN_PIN_G: f64 = 1.0;

/// The previous-iteration absolute node voltage an effectively-open
/// current-source output must have reached before the pin engages. An open
/// node legitimately sits at a plausible voltage (a transistor's off-junction
/// base draws no current but sits near a volt, a just-opened sample-hold node
/// holds its last value); only a node that has run away to megavolts needs the
/// pin. No corpus circuit drives a current-source output past ~15 V; the
/// qam-256 sample-hold runaway sits at ~7.3e6 V.
const PIN_RUNAWAY_V: f64 = 1e4;

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

/// What the one-shot Find DC Operating Point command did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DcOutcome {
    /// The operating point converged and its reactive state is committed,
    /// so the transient resumes from the found point.
    Found,
    /// The nonlinear iteration did not converge, the documented
    /// silent-degradation case: every element was reset and the state is
    /// the uncharged start, identical to a plain reset.
    Degraded,
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
    /// An element halted the run with a message, upstream's `sim.stop`
    /// (the transmission line whose delay will not fit its ring). A
    /// condition of the circuit, not the step length, so halving and
    /// retrying must not touch it.
    Stopped(String),
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
    /// Timestep the scope captures were sampled at, mirroring upstream's
    /// `Scope.scopeTimeStep` (Scope.java:73). A frame whose effective
    /// timestep differs from this clears every capture before sampling, so a
    /// buffer can never mix columns aggregated under two different dt values.
    scope_time_step: f64,
    /// Consecutive easy steps, drives doubling once it reaches 3.
    good_iterations: u32,
    /// Solved closure vectors of the last committed step, one per closure, so
    /// a rejected attempt can restore it.
    last_x: Vec<Vec<f64>>,
    /// Voltage sources whose two terminals both merged onto the reference
    /// plane, discovered during the stamp pass. The set lives here rather
    /// than on the Stamper because the step loop builds a fresh Stamper per
    /// Newton iteration: a set captured only at stamp time would be lost, and
    /// the collapsed unknowns' value updates would leak back in as phantom
    /// currents. Cleared and rebuilt by every `restamp`.
    collapsed_vs: HashSet<usize>,
    nonlinear: bool,
    /// Nodes whose effectively-open current-source output is pinned to ground
    /// this run, so the pin survives the iterations where the node's voltage
    /// is back at a sane level. Re-derived every iteration from the load check
    /// and dropped the first time the load becomes real (see
    /// `pin_open_current_outputs`). A `HashSet` (std, not rustc-hash: the
    /// engine has no `rustc-hash` dependency) keeps the per-iteration
    /// membership test O(1); with a `Vec` the pass was quadratic in the number
    /// of open outputs. The set is only ever read via `contains`, so its
    /// iteration order is irrelevant and the rebuild can stay a plain `Vec`
    /// fed through `collect` at the end.
    open_pinned: HashSet<usize>,
    scopes: Vec<ScopeTrace>,
    warnings: Vec<String>,
    error: Option<String>,
    /// Whether the latest operating-point solve converged, kept so the
    /// one-shot command can tell a degraded solve from a found one through
    /// the plain [`Circuit::reset`] it wraps: `reset` has no channel for the
    /// outcome beyond the hard-error side channel. True until the first solve.
    last_dc_converged: bool,
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
            scope_time_step: SimOptions::default().time_step,
            good_iterations: 0,
            last_x: Vec::new(),
            collapsed_vs: HashSet::new(),
            nonlinear: false,
            open_pinned: HashSet::new(),
            scopes: Vec::new(),
            warnings: Vec::new(),
            error: None,
            last_dc_converged: true,
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
        self.closure_flops().iter().sum()
    }

    /// The solver backend each closure solves through, one entry per closure
    /// in closure order. A test hook for the Auto-selection parity tests; the
    /// frontend never needs it.
    pub fn closure_backends(&self) -> Vec<SolverBackend> {
        self.closures.iter().map(|c| c.sys.backend()).collect()
    }

    /// The row count of each closure's system, one entry per closure in
    /// closure order. A test hook for the closure-decomposition benchmark;
    /// the frontend never needs it.
    pub fn closure_rows(&self) -> Vec<usize> {
        self.closures.iter().map(|c| c.sys.size()).collect()
    }

    /// The factor flops of each closure's system since its last resize, one
    /// entry per closure in closure order. For a simplified closure this adds
    /// the constant-row elimination's own factors (the fixed part once, the
    /// reduced system per iteration), so the per-closure numbers still sum to
    /// [`Circuit::factor_flops`]. A test hook for the benchmark's per-closure
    /// cost rows; the frontend never needs it.
    pub fn closure_flops(&self) -> Vec<u64> {
        self.closures
            .iter()
            .map(|c| c.sys.flops() + c.simplified.as_ref().map(|s| s.flops()).unwrap_or(0))
            .collect()
    }

    /// Which closures run the constant-row elimination, one entry per closure
    /// in closure order. A test hook for the simplification tests; the
    /// frontend never needs it.
    pub fn closure_simplified(&self) -> Vec<bool> {
        self.closures
            .iter()
            .map(|c| c.simplified.is_some())
            .collect()
    }

    /// The per-iteration reduced-system row count of each simplified closure,
    /// zero for a closure on the full path. The tests asserting that constant
    /// rows were actually eliminated read this; the frontend never needs it.
    pub fn closure_reduced_rows(&self) -> Vec<usize> {
        self.closures
            .iter()
            .map(|c| c.simplified.as_ref().map(|s| s.reduced_rows()).unwrap_or(0))
            .collect()
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

    /// Per-element body-wave samples for the renderer, resampled to `segments`
    /// strips. Only the transmission line reports anything; an unknown id and
    /// every other element return empty, so the frontend can call this for a
    /// single kind without a per-element tag on the other side.
    pub fn body_samples(&self, id: u32, segments: usize) -> Vec<f32> {
        let Some(&ei) = self.id_index.get(&id) else {
            return Vec::new();
        };
        self.elements[ei].body_samples(segments)
    }

    /// A data recorder's recorded samples, oldest first, for the frontend's
    /// export button. An unknown id and every other element return empty, so
    /// the frontend can call this for a single kind without a per-element tag
    /// on the other side. An on-demand channel like [`Circuit::body_samples`];
    /// no per-frame call.
    pub fn data_recorder_data(&self, id: u32) -> Vec<f64> {
        let Some(&ei) = self.id_index.get(&id) else {
            return Vec::new();
        };
        self.elements[ei].data_recorder_data()
    }

    /// One element's live scope-value table, walked in the order its kind
    /// declares through [`Element::scope_value_table`], so a multi-row info
    /// readout costs one crossing instead of one per row. Empty for unknown
    /// ids and every kind whose table is empty. An on-demand channel like
    /// [`Circuit::body_samples`]; only the hovered element pays.
    pub fn element_scope_values(&self, id: u32) -> Vec<f64> {
        let Some(&ei) = self.id_index.get(&id) else {
            return Vec::new();
        };
        self.elements[ei]
            .scope_value_table()
            .iter()
            .map(|v| self.elements[ei].scope_value(*v))
            .collect()
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
        let options = spec.options.clone().unwrap_or_default();
        // A negative or non-finite step reaches the reactive companions
        // (capacitor.rs, inductor.rs) as `geq = 2*C/dt < 0` or NaN, a genuine
        // negative resistance that stamps without complaint and produces
        // garbage output. Caught here, before anything downstream consumes
        // either value, so a bad `$` header or JSON SimOptions is rejected
        // the same way a degenerate topology is rejected below rather than
        // silently running. Validated on this local `options` and only
        // committed to `self.options` once both checks pass: a live instance
        // keeps its last good options across a rejected call, so a later
        // `reset()` (which reads `self.options.time_step` directly, bypassing
        // `set_time_step`) can't stamp against a bad value that was never
        // actually accepted.
        if !options.time_step.is_finite() || options.time_step <= 0.0 {
            return Err(format!(
                "timeStep must be a positive, finite number of seconds, got {}",
                options.time_step
            ));
        }
        if !options.min_time_step.is_finite() || options.min_time_step <= 0.0 {
            return Err(format!(
                "minTimeStep must be a positive, finite number of seconds, got {}",
                options.min_time_step
            ));
        }
        self.options = options;
        self.warnings.clear();
        self.error = None;
        self.open_pinned.clear();
        // Rebuilding is the topology path: adding, deleting or moving an
        // element renumbers nodes, so the state vector's meaning changes and
        // the elements below are built fresh from the spec. The clock is not
        // node-indexed though, and an edit mid-run must not rewind it: that is
        // upstream's split between `analyzeCircuit`, which never touches `t`,
        // and `resetAction`, which is the only thing that does
        // (UIManager.java:1349-1360). `preserve_run` carries that distinction
        // across the boundary; a fresh document sends false and starts at zero.
        if spec.preserve_run {
            // The adaptive step rides along, so a circuit that had shrunk its
            // way down to a converging step does not have to re-shrink from
            // the nominal after every edit. Clamped to the (possibly new)
            // nominal, since an options edit is also a rebuild and the working
            // step may never exceed `time_step`. A non-finite or non-positive
            // carry-over cannot happen through halving and doubling, but it is
            // floored here anyway rather than reaching the reactive companions.
            let carried = self.current_time_step.min(self.options.time_step);
            self.current_time_step = if carried.is_finite() && carried > 0.0 {
                carried
            } else {
                self.options.time_step
            };
        } else {
            self.current_time_step = self.options.time_step;
            self.good_iterations = 0;
        }
        self.ctx = SimCtx {
            time: if spec.preserve_run {
                self.ctx.time
            } else {
                0.0
            },
            dt: self.current_time_step,
            dc_analysis: false,
            subiter: 0,
        };

        // Built into locals and committed to `self` only once every element
        // has been accepted: a mid-loop reject below must not leave a
        // half-built list behind, so a rejected build keeps its previous
        // elements, closures and node voltages and stays runnable instead
        // of stepping a mixture of both circuits. This is per-stage
        // atomicity, the same discipline as the options guards above:
        // whatever an earlier stage committed (options, the warning and
        // error clears, the adaptive-step carry-over and the context,
        // including the clock rewind under `preserve_run = false`) stays
        // in force when a later stage rejects.
        let mut elements: Vec<Box<dyn Element>> = Vec::with_capacity(spec.elements.len());
        let mut ids = Vec::with_capacity(spec.elements.len());
        let mut id_index: HashMap<u32, usize> = HashMap::with_capacity(spec.elements.len());
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
            // A duplicate id makes set_param/set_state/indexOf ambiguous, so
            // reject it rather than keep only the last element under that id.
            if let Some(&prev) = id_index.get(&es.id) {
                return Err(format!(
                    "duplicate element id {} (element {} '{}' and element {} '{}')",
                    es.id,
                    prev,
                    elements[prev].kind(),
                    elements.len(),
                    es.kind,
                ));
            }
            id_index.insert(es.id, elements.len());
            ids.push(es.id);
            elements.push(elm);
        }
        self.elements = elements;
        self.ids = ids;
        self.id_index = id_index;
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
            if let Err(e) = self.assign_nodes(&spec.elements) {
                self.clear_closure_state();
                return Err(e);
            }
            if !self.validate_capacitors() {
                break;
            }
            attempts += 1;
            if attempts >= 10 {
                // Defensive only: monotone damping cannot reach this, but a
                // fresh node pass keeps the final state consistent regardless.
                if let Err(e) = self.assign_nodes(&spec.elements) {
                    self.clear_closure_state();
                    return Err(e);
                }
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
        self.allocate_and_stamp()?;
        self.build_scopes(spec);

        // The operating-point solve is a start-of-run act: it holds every
        // reactive element at steady state and rewinds the clock, so running
        // it again on an edit would snap a half-charged capacitor back to its
        // bias mid-transient. Upstream sets `dcAnalysisFlag` from
        // `resetAction` and circuit load only, never from `needAnalyze`
        // (UIManager.java:1352), which is what `preserve_run` carries here.
        // The `time == 0.0` arm keeps the pre-run case: a circuit being built
        // up before it has ever stepped has no run to preserve, and its edits
        // must keep showing the bias point rather than a dead 0 V everywhere
        // until Run is pressed.
        if self.options.dc_operating_point && (!spec.preserve_run || self.ctx.time == 0.0) {
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

    /// Works out which terminals share a node. Errors when the terminal
    /// count or the resulting node count exceeds [`MAX_MATRIX_ROWS`]: a
    /// hand-edited netlist with an absurd number of distinct posts must be
    /// rejected as an invalid circuit here, before anything sized by the
    /// count is allocated.
    fn assign_nodes(&mut self, specs: &[ElementSpec]) -> Result<(), String> {
        // Flatten every terminal into one index space.
        let mut offsets = Vec::with_capacity(self.elements.len());
        let mut total = 0usize;
        for es in specs {
            offsets.push(total);
            total = total
                .checked_add(es.posts.len())
                .ok_or_else(|| matrix_too_large(total, MAX_MATRIX_ROWS))?;
            if total > MAX_MATRIX_ROWS {
                return Err(matrix_too_large(total, MAX_MATRIX_ROWS));
            }
        }

        let mut uf = UnionFind::new(total.max(1));
        // Two terminals merge when they share the coordinate AND the bus bit,
        // upstream's Point equality including z (Point.java:61-67): the N pins
        // of a wide element sit at one coordinate and stay N separate nodes
        // because each carries its own bit. Plain posts are bit 0, so a
        // circuit with no wide elements keys exactly as before.
        let mut by_coord: HashMap<([i32; 2], usize), usize> = HashMap::new();
        for (ei, es) in specs.iter().enumerate() {
            let elm = &self.elements[ei];
            for (pi, post) in es.posts.iter().enumerate() {
                let gi = offsets[ei] + pi;
                let key = (*post, elm.post_bus_z(pi));
                match by_coord.entry(key) {
                    std::collections::hash_map::Entry::Occupied(o) => uf.union(gi, *o.get()),
                    std::collections::hash_map::Entry::Vacant(v) => {
                        v.insert(gi);
                    }
                }
            }
        }

        // Named nodes connect by label rather than by position, per post: a
        // wide labeled node's post b carries the key (text, Some(b)) and joins
        // only bit b of every same-named label, while a narrow one keys
        // (text, None), exactly the port's pre-bus behaviour. Upstream writes
        // these two forms as distinct closure keys (LabeledNodeElm.java:99,
        // :137-140), which keeps a narrow label named A and a wide label named
        // A on separate nets.
        let mut by_label: HashMap<(&str, Option<usize>), usize> = HashMap::new();
        for (ei, es) in specs.iter().enumerate() {
            let elm = &self.elements[ei];
            for pi in 0..es.posts.len() {
                if let Some((label, bit)) = elm.node_label_key(pi) {
                    let gi = offsets[ei] + pi;
                    match by_label.entry((label, bit)) {
                        std::collections::hash_map::Entry::Occupied(o) => uf.union(gi, *o.get()),
                        std::collections::hash_map::Entry::Vacant(v) => {
                            v.insert(gi);
                        }
                    }
                }
            }
        }

        // Wires and closed switches are ideal shorts: merge their endpoints
        // so the matrix never sees them, exactly as upstream's wire closure
        // does. Unioning the coordinate-merged roots collapses chains, rings
        // and parallel wires into one node each. A bus wire hands in one pair
        // per bit, so each bit's endpoints merge while the bits stay apart.
        for (ei, elm) in self.elements.iter().enumerate() {
            if elm.removable_wire() && elm.post_count() >= 2 {
                for k in 0..elm.removable_wire_pair_count() {
                    let (a, b) = elm.removable_wire_pair(k);
                    let r0 = uf.find(offsets[ei] + a);
                    let r1 = uf.find(offsets[ei] + b);
                    uf.union(r0, r1);
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
        // No ground symbol: upstream grounds the first voltage source's first
        // terminal, but only when no rail is present (SimulationManager.java:
        // 517-528, setGroundNode). A rail is a one-post source referencing the
        // reference node already, so its terminal must stay a normal node; the
        // fallback below would short it and its voltage source would read
        // ground-to-ground, which is a degenerate row.
        let has_rail = self
            .elements
            .iter()
            .any(|e| e.post_count() == 1 && e.is_voltage_source());
        if ground_roots.is_empty() && total > 0 && !has_rail {
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

        if next_id > MAX_MATRIX_ROWS {
            // Checked before `node_count` or the state vector is touched, so
            // a rejected build leaves neither a huge node count nor a stale
            // vector a later `run` could index against.
            return Err(matrix_too_large(next_id, MAX_MATRIX_ROWS));
        }
        self.node_count = next_id;
        self.node_voltages = vec![0.0; self.node_count];
        Ok(())
    }

    /// Resolves relay labels once, at build time, so a coil's per-step state
    /// machine can drive its contacts by element index instead of scanning
    /// the element list like upstream's `toggleSwitchPositions`
    /// (RelayCoilElm.java:353-378). A coil with no matching contact simply
    /// drives nobody; a contact with no coil keeps its file position.
    fn link_relay_contacts(&mut self) {
        // An empty label is no label: `escapeToken('')` round-trips as the
        // `\0` token, so a saved unlabelled coil or contact loads with an
        // empty string, not None, and without the filter would pair with every
        // other unlabelled relay in the file.
        let mut contacts_by_label: HashMap<String, Vec<usize>> = HashMap::new();
        for (i, elm) in self.elements.iter().enumerate() {
            if let Some(label) = elm.link_label().filter(|l| !l.is_empty()) {
                contacts_by_label
                    .entry(label.to_string())
                    .or_default()
                    .push(i);
            }
        }
        for elm in self.elements.iter_mut() {
            if let Some(label) = elm.link_label().filter(|l| !l.is_empty()) {
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
            if let Some((n0, n1)) = elm.current_output_nodes() {
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
    /// step change (SimulationManager.java:1318,1405). Private, and its only
    /// callers pass `step / 2.0` or `(current_time_step * 2.0).min(options.time_step)`,
    /// both derived from `current_time_step` and `options.time_step`, which
    /// `set_circuit` already validated positive and finite; a positive finite
    /// input can't become negative or non-finite through halving or a min
    /// against another positive finite value, so `dt` needs no guard of its
    /// own here.
    fn set_time_step(&mut self, dt: f64) {
        self.current_time_step = dt;
        self.ctx.dt = dt;
        // A step-size change never touches topology, so `restamp` cannot
        // newly fail here; the side channel matches every other runtime
        // caller that cannot return `Result` through a `pub` bool/void API.
        if let Err(e) = self.restamp() {
            self.error = Some(e);
        }
    }

    /// Leaves the circuit in the state a rejected build settles into: no
    /// closures and no node-voltage vector, so a subsequent `run()` takes the
    /// harmless empty-closures no-op path instead of indexing a stale, larger
    /// closure list against the node voltages. Mirrors the clearing the
    /// `restamp` error path performs.
    fn clear_closure_state(&mut self) {
        self.closures = Vec::new();
        self.node_closure = Vec::new();
        self.node_row = Vec::new();
        self.vs_closure = Vec::new();
        self.vs_row = Vec::new();
        self.element_closure = Vec::new();
        self.collapsed_vs.clear();
        self.node_voltages = Vec::new();
        self.last_x = Vec::new();
    }

    /// Zeroes the matrix, re-runs the constant stamp pass and snapshots the
    /// result for reuse across timesteps. Errors when `build_closures` finds
    /// a voltage source with nowhere to route its row, a degenerate topology
    /// (see [`build_closures`]) rather than a panic.
    fn restamp(&mut self) -> Result<(), String> {
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
        let map = match build_closures(
            &self.elements,
            self.node_count,
            self.vs_count,
            self.nonlinear,
            self.options.solver_type,
        ) {
            Ok(map) => map,
            Err(e) => {
                // `assign_nodes` has already resized `node_voltages` and
                // `node_count` to the new topology by the time this runs, so
                // leaving the previous, larger closures in place would let
                // the next run()/step() index `node_voltages` with a stale,
                // out-of-range node id in `write_back`. Clearing everything
                // reproduces the same closure-less state the harmless empty
                // case below settles into, so `step_once`'s
                // `closures.is_empty()` guard catches the next call instead.
                self.closures = Vec::new();
                self.node_closure = Vec::new();
                self.node_row = Vec::new();
                self.vs_closure = Vec::new();
                self.vs_row = Vec::new();
                self.element_closure = Vec::new();
                self.last_x = Vec::new();
                return Err(e);
            }
        };
        self.closures = map.closures;
        self.node_closure = map.node_closure;
        self.node_row = map.node_row;
        self.vs_closure = map.vs_closure;
        self.vs_row = map.vs_row;
        self.element_closure = map.element_closure;
        if self.closures.is_empty() {
            self.last_x = Vec::new();
            return Ok(());
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
            // The set survives onto the circuit so the step loop's fresh
            // Stampers keep treating these sources as collapsed.
            self.collapsed_vs = s.take_collapsed_sources();
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
        Ok(())
    }

    /// Allocation plus stamping, with the one-off floating-node diagnostic.
    fn allocate_and_stamp(&mut self) -> Result<(), String> {
        self.allocate();
        let pins = self.floating_nodes();
        if !pins.is_empty() {
            self.warnings.push(format!(
                "{} floating node(s) have no path to ground; they were pinned with a {} resistance.",
                pins.len(),
                format_ohms(1.0 / GMIN)
            ));
        }
        self.restamp()
    }

    /// Re-runs the topology analysis after an interactive edit that can merge
    /// or unmerge terminals, such as closing a switch. Unlike `set_circuit`,
    /// it leaves the sim clock alone: a throw must not rewind the trace.
    fn reanalyze(&mut self) {
        // The warnings belong to the latest analysis pass: this re-runs
        // assign_nodes and the stamp, so the no-ground and floating-node
        // notices below must replace whatever an earlier pass left rather
        // than append to it. Without this, every switch throw grew the
        // vector by one.
        self.warnings.clear();
        // `assign_nodes` borrows the specs while `&mut self` is in play, so
        // hand it a clone rather than borrowing `self.specs` through `self`.
        // Closing a switch can short a capacitor or complete a capacitor loop,
        // so the same validate-and-retry as `set_circuit` runs here, matching
        // upstream's per-analysis validateCircuit.
        let mut attempts = 0;
        loop {
            // The node-count guard cannot fire here (a throw only merges or
            // unmerges terminals in a circuit `set_circuit` already accepted),
            // but the call now returns `Result`, and its failure must land on
            // the side channel like every other interactive-build failure.
            if let Err(e) = self.assign_nodes(&self.specs.clone()) {
                self.error = Some(e);
                return;
            }
            if !self.validate_capacitors() {
                break;
            }
            attempts += 1;
            if attempts >= 10 {
                if let Err(e) = self.assign_nodes(&self.specs.clone()) {
                    self.error = Some(e);
                    return;
                }
                break;
            }
        }
        // An interactive throw cannot be rejected the way `set_circuit`
        // rejects a build: `set_state` already returns a plain bool. Record
        // the failure on the side channel the frontend already polls after
        // every state-changing call.
        if let Err(e) = self.allocate_and_stamp() {
            self.error = Some(e);
        }
    }

    /// Rebuilds the scope traces for a new element list.
    ///
    /// On a preserving rebuild a trace whose spec came back byte-identical
    /// keeps its captured columns and only re-resolves its element index: the
    /// capture ring is indexed by column, not by node, so an edit elsewhere in
    /// the circuit cannot invalidate it, and wiping it would blank every scope
    /// on the screen every time the user nudged a wire. Upstream keeps its
    /// plots the same way, clearing them from `resetGraphs` alone
    /// (UIManager.java:1359). Any spec change (a different signal, speed or
    /// window) still starts a fresh ring, because those change what a column
    /// means.
    fn build_scopes(&mut self, spec: &CircuitSpec) {
        let mut reusable: Vec<Option<ScopeTrace>> = if spec.preserve_run {
            std::mem::take(&mut self.scopes)
                .into_iter()
                .map(Some)
                .collect()
        } else {
            Vec::new()
        };
        self.scopes = spec
            .scopes
            .iter()
            .map(|s| {
                let index = self.id_index.get(&s.element_id).copied();
                let reused = reusable
                    .iter_mut()
                    .find(|old| old.as_ref().is_some_and(|t| t.spec == *s))
                    .and_then(Option::take);
                match reused {
                    Some(mut trace) => {
                        trace.element_index = index;
                        trace
                    }
                    None => ScopeTrace::new(s.clone(), index),
                }
            })
            .collect();
    }

    /// Solves the circuit with reactive elements held at steady state, giving
    /// transient analysis a sensible starting point. `Ok(true)` means the
    /// operating point converged and was committed; `Ok(false)` is the
    /// documented silent-degradation case, a nonlinear circuit with no
    /// operating point, where the elements were reset to the uncharged start.
    /// Errors only when a linear circuit's DC matrix is singular: the circuit
    /// is genuinely unsolvable and continuing would leave a poisoned
    /// transient behind.
    fn solve_operating_point(&mut self) -> Result<bool, String> {
        // Reactive elements stamp differently under DC (a capacitor as an
        // open circuit, an inductor as a short), so the matrix has to be built
        // for DC, used, and then rebuilt for transient stepping.
        self.ctx.dc_analysis = true;
        self.restamp()?;
        // No adaptation here: there is no time to shrink, and reactive stamps
        // ignore `dt` under `dc_analysis`. One attempt at the nominal step
        // with the normal budget, exactly as before.
        let solved = self
            .try_step(self.options.time_step, self.options.max_subiterations)
            .is_ok();
        // Recorded for [`Circuit::find_dc_operating_point`], which observes
        // this solve only through the reset that ran it.
        self.last_dc_converged = solved;
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
        self.restamp()?;
        Ok(solved)
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
        // Constant-row elimination: the first Newton iteration of a restamp
        // epoch records which closure rows `do_step` rewrites, and the
        // simplified.rs pass splits those closures into a cached fixed part
        // and a small per-iteration changing system. The recording runs on
        // subiter 0 of every step, never on later subiterations; the split
        // runs right after it, once per epoch, because build_simplified
        // skips closures that already carry a system.
        let detect = self.options.simplify && self.nonlinear;
        let mut touches: Vec<(usize, usize, usize)> = Vec::new();

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
                s.set_collapsed_sources(self.collapsed_vs.clone());
                if subiter == 0 && detect {
                    s.set_recording(&mut touches);
                }
                for (ei, elm) in self.elements.iter_mut().enumerate() {
                    s.set_current(ei);
                    elm.do_step(&ctx, &mut s);
                }
                // An element asked to halt the run: upstream checks
                // `app.stopMessage` straight after the doStep pass
                // (SimulationManager.java:1342-1345) and abandons the frame
                // before solving, so nothing of this attempt commits.
                if let Some(msg) = s.take_stop() {
                    self.ctx.time = committed_time;
                    return Err(StepError::Stopped(msg));
                }
                last_failing = std::mem::take(&mut s.failing);
                s.converged
            };
            // The pin stamps happen outside the recorder, so a newly-pinned
            // open current-source row looks "fixed" to the elimination and
            // trips the drift check, falling back to the full path. Exact,
            // but the closure stays unsimplified for the epoch.
            self.pin_open_current_outputs();

            if subiter == 0 && detect {
                build_simplified(&mut self.closures, &touches);
            }

            for c in self.closures.iter_mut() {
                let solved = if let Some(ss) = c.simplified.as_mut() {
                    // The reduced solve falls back to the full solve on its
                    // own when a guard trips, so `solve_into` can only return
                    // Singular when the full path is singular too. A
                    // simplified closure is always dense by construction.
                    let sys = c
                        .sys
                        .dense_mut()
                        .expect("a simplified closure is always dense");
                    ss.solve_into(sys)
                } else {
                    c.sys.solve()
                };
                if let Err(SolveError::Singular) = solved {
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
            debug_assert_eq!(c.sys.x().len(), last.len());
            c.sys.x_mut().copy_from_slice(last);
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
            // While the step can still be halved, a failed attempt has a
            // smaller fallback waiting, so it only burns the normal Newton
            // budget. The `>=` matters: upstream halves first and stops only
            // when the halved value drops below the minimum
            // (SimulationManager.java:1391-1400), so every halved step at or
            // above the floor is attempted, and a circuit that converges
            // only below twice the floor recovers instead of stopping one
            // halving early. Unless `time_step` halves onto the floor
            // exactly, the smallest attempted step sits between the floor
            // and twice it, not on the floor; that smallest step is the one
            // that can no longer shrink, so it is where the relaxed
            // 5000-iteration budget applies, matching upstream's last-chance
            // budget (SimulationManager.java:1328). Above it the port
            // deliberately keeps its own documented max_subiterations
            // rather than upstream's 100: the gmin ramps engage around
            // subiter 100 and need room to climb (see SimOptions).
            let can_shrink = self.options.adaptive && step / 2.0 >= self.options.min_time_step;
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
                        debug_assert_eq!(c.sys.x().len(), last.len());
                        last.copy_from_slice(c.sys.x());
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
                Err(StepError::Stopped(msg)) => {
                    // A deliberate element stop carries its own message,
                    // upstream's stopMessage shown verbatim. No halving and
                    // no retry: the condition does not depend on the step.
                    report.converged = false;
                    report.error = Some(msg);
                    self.error = report.error.clone();
                    return report;
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
        // Coordinates are (position, bus bit) pairs, so a bus wire's bits
        // resolve as independent edges between independent nodes even though
        // every pin shares one raw coordinate.
        let mut coords: Vec<([i32; 2], usize)> = Vec::new();
        let mut coord_id: HashMap<([i32; 2], usize), usize> = HashMap::new();
        let mut edges: Vec<[usize; 2]> = Vec::new();
        // (element index, which of its removable-wire pairs this edge is).
        let mut edge_owner: Vec<(usize, usize)> = Vec::new();

        for (ei, elm) in self.elements.iter().enumerate() {
            if elm.removable_wire() && elm.post_count() >= 2 {
                let count = elm.removable_wire_pair_count();
                for pair in 0..count {
                    let (a, b) = elm.removable_wire_pair(pair);
                    let c0 = coord_of(
                        &mut coord_id,
                        &mut coords,
                        (elm.base().posts[a], elm.post_bus_z(a)),
                    );
                    let c1 = coord_of(
                        &mut coord_id,
                        &mut coords,
                        (elm.base().posts[b], elm.post_bus_z(b)),
                    );
                    edges.push([c0, c1]);
                    edge_owner.push((ei, pair));
                }
            }
        }
        if !edges.is_empty() {
            // Net current each coordinate receives from the non-removable
            // world. Grounds are excluded: they are sinks, never injectors, so
            // counting them (their `current_into_node` is `-current`) would
            // double-count their own previous-step current back into the KCL.
            let mut injection = vec![0.0; coords.len()];
            for elm in self.elements.iter() {
                if (elm.removable_wire() && elm.post_count() >= 2) || elm.is_ground() {
                    continue;
                }
                for pi in 0..elm.post_count() {
                    let key = (elm.base().posts[pi], elm.post_bus_z(pi));
                    let Some(&c) = coord_id.get(&key) else {
                        continue;
                    };
                    injection[c] += elm.current_into_node(pi);
                }
            }

            let mut resolved = vec![false; edges.len()];
            let mut currents = vec![0.0; edges.len()];

            // A coordinate whose only non-wire occupant is a ground symbol.
            // Such a node sits inside the reference plane, which spans several
            // raw coordinates, so the current it exchanges with a wire is not
            // determined locally: the ground can sink or source any balance.
            // A wire resolved from such an end would read a zero injection and
            // report no current even when its other end is driven. The chain
            // must therefore resolve such a wire from the far end instead,
            // which is why `can_resolve` refuses these coordinates.
            let mut has_ground = vec![false; coords.len()];
            let mut has_non_ground = vec![false; coords.len()];
            for elm in self.elements.iter() {
                for pi in 0..elm.post_count() {
                    let key = (elm.base().posts[pi], elm.post_bus_z(pi));
                    let Some(&c) = coord_id.get(&key) else {
                        continue;
                    };
                    if elm.is_ground() {
                        has_ground[c] = true;
                    } else if !(elm.removable_wire() && elm.post_count() >= 2) {
                        has_non_ground[c] = true;
                    }
                }
            }
            let ground_only: Vec<bool> = (0..coords.len())
                .map(|c| has_ground[c] && !has_non_ground[c])
                .collect();

            // Resolve chains and trees in the natural order: a wire whose
            // other endpoint is fully determined derives its current from KCL
            // there.
            loop {
                let mut progress = false;
                for i in 0..edges.len() {
                    if resolved[i] {
                        continue;
                    }
                    let (c0, c1) = (edges[i][0], edges[i][1]);
                    if can_resolve(&edges, &resolved, &ground_only, i, c0) {
                        currents[i] = kcl_sum(&edges, &resolved, &injection, c0, &currents);
                        resolved[i] = true;
                        progress = true;
                    } else if c1 != c0 && can_resolve(&edges, &resolved, &ground_only, i, c1) {
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

            for (i, &(ei, pair)) in edge_owner.iter().enumerate() {
                let elm = &mut self.elements[ei];
                elm.set_recovered_pair_current(pair, currents[i]);
                // The single-pair shorts (plain wires, closed switches) keep
                // the historical channel: their one current is what animates
                // the dots. A multi-pair element sums its own bits inside the
                // hook.
                if elm.removable_wire_pair_count() == 1 {
                    elm.base_mut().current = currents[i];
                }
            }
        }
        self.recover_ground_currents();
    }

    /// Gives each ground symbol the current the rest of the circuit delivers
    /// into its post coordinate. Grounds stay out of the wire graph (they are
    /// never edges or injectors), so their current only exists once every wire
    /// touching the coordinate is resolved, which is why this runs after the
    /// wire pass. The sum counts resolved wires by their recovered current and
    /// skips grounds. Grounds sharing a coordinate split the coordinate's net
    /// evenly, a deterministic choice that sums back to the true total.
    fn recover_ground_currents(&mut self) {
        // A ground pins bit 0 of its coordinate (its post carries no bus
        // bit), so both the key and the sum are bit-scoped: a ground sitting
        // on a bus coordinate collects only what the circuit delivers to bit
        // 0, never the other bits' currents.
        let mut by_coord: HashMap<([i32; 2], usize), Vec<usize>> = HashMap::new();
        for (ei, elm) in self.elements.iter().enumerate() {
            if elm.is_ground() {
                by_coord
                    .entry((elm.base().posts[0], elm.post_bus_z(0)))
                    .or_default()
                    .push(ei);
            }
        }
        for (key, grounds) in by_coord {
            let mut net = 0.0;
            for elm in self.elements.iter() {
                if elm.is_ground() {
                    continue;
                }
                for pi in 0..elm.post_count() {
                    if (elm.base().posts[pi], elm.post_bus_z(pi)) == key {
                        net += elm.current_into_node(pi);
                    }
                }
            }
            // Positive reads as current flowing from the node down the stem
            // into earth, matching upstream's `getCurrentIntoNode(n) = -current`.
            let share = net / grounds.len() as f64;
            for ei in grounds {
                self.elements[ei].base_mut().current = share;
            }
        }
    }

    /// Grounds any current-source output terminal that has run away through
    /// an effectively open load, by adding a conductance to the reference
    /// node before the solve. An ideal current source whose output node is
    /// held up only by an open analog switch's `r_off` = 1e10 ohm solves to
    /// I/G ~ 2.2e7 V, and that megavolt couples straight into an op-amp
    /// follower on the node (its constraint row tracks the runaway input), so
    /// clamping the node after the solve still leaves the follower's output
    /// stuck above its rail and the step never settles. Grounding the node
    /// inside the matrix lets every iteration re-solve from a sane value.
    ///
    /// The pin is sticky: once a node has run away it stays pinned while its
    /// load stays open, even on the iterations where the solved voltage is
    /// back at a sane level (otherwise the pin would toggle on and off and the
    /// node would run away again every other iteration). `open_pinned` holds
    /// the current set, re-derived each iteration, and the load check drops a
    /// node the first time its load becomes real again. The
    /// [`OPEN_LOAD_G`] threshold equals the GMIN pin, so a gmin-pinned node is
    /// excluded by the strict `<`, and the [`PIN_RUNAWAY_V`] gate clears any
    /// node at a plausible voltage, so the pin never touches a transistor's
    /// off-junction base (conductance JUNCTION_GMIN, a volt or so) or a held
    /// sample-hold node. The
    /// topology-based `check_broken_sources` above cannot see this case (an
    /// open switch still `dc_connects`), and this load-based check is
    /// per-iteration because the switch state, and therefore the load, changes
    /// every step. For a nonlinear closure `restore` clears the pin before
    /// each iteration re-adds it. For a linear closure the pin is stamped into
    /// the cached matrix and `invalidate` forces the next solve to refactor
    /// with it; the pin then stays in force until the next restamp, which is
    /// also the only way a linear circuit's load can change. Composites do not
    /// implement `current_output_nodes`, so a current source buried in one (an
    /// OTA child, say) is never pinned, the same blind spot
    /// `check_broken_sources` has.
    fn pin_open_current_outputs(&mut self) {
        let mut keep = Vec::new();
        for elm in &self.elements {
            let Some((n0, n1)) = elm.current_output_nodes() else {
                continue;
            };
            for &node in &[n0, n1] {
                if node == GROUND {
                    continue;
                }
                if self.node_voltages[node].abs() <= PIN_RUNAWAY_V
                    && !self.open_pinned.contains(&node)
                {
                    continue;
                }
                let c = self.node_closure[node];
                let row = self.node_row[node];
                // The row's diagonal is the sum of conductances stamped to the
                // node, so it is the node's load to the rest of the circuit.
                // A node's row always sits below the closure's vs rows.
                if self.closures[c].sys.get(row, row) < OPEN_LOAD_G {
                    self.closures[c].sys.add(row, row, OPEN_PIN_G);
                    // A linear closure keeps its LU factors across the whole
                    // run (`restore_rhs` never invalidates), so without this
                    // the pin would sit in the matrix while the solve kept
                    // using the stale unpinned factors. No-op for a nonlinear
                    // closure, which already invalidates every subiteration.
                    self.closures[c].sys.invalidate();
                    keep.push(node);
                }
            }
        }
        // Keep a Vec of what stays pinned and turn it into the set at the
        // end, so the re-derivation is deterministic and the old behaviour is
        // unchanged; `open_pinned` is read only through `contains`.
        self.open_pinned = keep.into_iter().collect();
    }

    /// Copies each closure's solved vector into node voltages and per-element
    /// state.
    fn write_back(&mut self) {
        self.node_voltages[0] = 0.0;
        for c in self.closures.iter() {
            let x = c.sys.x();
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
                base.vs_currents[k] = self.closures[c].sys.x()[self.vs_row[gvs]];
            }
        }
    }

    /// Advances `steps` timesteps, sampling every scope on each one.
    pub fn run(&mut self, steps: u32) -> StepReport {
        // Upstream resets every scope graph when the effective timestep has
        // changed (Scope.java:597-601), checked each frame before drawing:
        // columns aggregate a fixed count of steps, so after an adaptive
        // halve or double the surviving columns would stretch against the
        // time grid and a frequency readout over them would lie. The check
        // sits at the frame boundary here too; the stale columns written
        // earlier in the changing frame die one frame later, exactly
        // upstream's draw-time window.
        if self.scope_time_step != self.current_time_step {
            self.scope_time_step = self.current_time_step;
            for s in self.scopes.iter_mut() {
                s.clear();
            }
        }
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
                ScopeValue::Charge => elm.charge(),
                // The per-element values (a transistor's Ib, a lamp's R):
                // the element model answers per sample, the same one-value
                // boundary the charge hook rides.
                other => elm.scope_value(other),
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

    /// Re-arms every stop trigger without rewinding time, so a simulation
    /// paused by one can resume. The frame loop calls this when the user
    /// presses Run; stepping alone must never clear the latches, or the pause
    /// would never register.
    pub fn clear_stops(&mut self) {
        for elm in self.elements.iter_mut() {
            elm.clear_stop();
        }
    }

    /// Returns the circuit to time zero.
    pub fn reset(&mut self) {
        // The warnings belong to the latest analysis pass: the stamp below
        // re-raises the floating-node notice, so it must replace whatever
        // an earlier pass left rather than append to it. Without this,
        // every reset grew the vector by one.
        self.warnings.clear();
        self.ctx.time = 0.0;
        self.ctx.dt = self.options.time_step;
        self.ctx.subiter = 0;
        self.error = None;
        self.current_time_step = self.options.time_step;
        // The captures below were just emptied at the nominal step; recording
        // it here keeps the next frame from clearing them a second time.
        self.scope_time_step = self.current_time_step;
        self.good_iterations = 0;
        self.open_pinned.clear();
        for elm in self.elements.iter_mut() {
            elm.reset();
        }
        for s in self.scopes.iter_mut() {
            s.clear();
        }
        self.node_voltages.iter_mut().for_each(|v| *v = 0.0);
        // Topology is unchanged from the last accepted `set_circuit`, so this
        // cannot newly fail; guarded anyway since `reset` has no `Result` to
        // return it through, and a failure here must skip the DC solve below
        // rather than run it against a broken closure map.
        if let Err(e) = self.allocate_and_stamp() {
            self.error = Some(e);
            return;
        }
        if self.options.dc_operating_point {
            if let Err(e) = self.solve_operating_point() {
                self.error = Some(e);
            }
        }
    }

    /// Runs upstream's File > Find DC Operating Point one-shot command: a
    /// flag plus the ordinary reset action (CommandManager.java:361-364).
    /// The port borrows every guard and normalisation of [`Circuit::reset`]
    /// by flipping `options.dc_operating_point` around the plain reset
    /// instead of duplicating it: the clock and adaptive-dt fields rewind,
    /// scopes clear, a converged solve commits its reactive state and a
    /// failed one leaves the uncharged start. Run state is otherwise left
    /// alone, matching this port's Reset rather than upstream's force-start
    /// at t == 0. A hard engine failure recorded by the reset (a singular
    /// linear matrix, a broken stamp) comes back as `Err` with that message;
    /// the option is restored on every path.
    pub fn find_dc_operating_point(&mut self) -> Result<DcOutcome, String> {
        let saved = self.options.dc_operating_point;
        self.options.dc_operating_point = true;
        self.reset();
        self.options.dc_operating_point = saved;
        // reset clears `error` before it runs, so whatever sits here was
        // recorded by this command's own reset.
        if let Some(e) = self.error.clone() {
            return Err(e);
        }
        Ok(if self.last_dc_converged {
            DcOutcome::Found
        } else {
            DcOutcome::Degraded
        })
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
        // A parameter edit never changes topology, so `restamp` cannot newly
        // fail here; handled anyway since `set_param`'s `bool` signature
        // cannot carry a `Result`.
        if let Err(e) = self.restamp() {
            self.error = Some(e);
            return false;
        }
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

    /// Current each terminal exchanges with its node, flattened in element
    /// order then post order, laid out identically to [`Circuit::element_nodes`]
    /// so the renderer indexes it with the same post-offset map. Each entry is
    /// [`Element::current_into_node`], the current leaving the device into the
    /// node at that post. A two-terminal element reports `-current` at post 0
    /// and `+current` at post 1; a ground reports `-current` (upstream's
    /// `GroundElm.getCurrentIntoNode`).
    pub fn element_post_currents(&self) -> Vec<f64> {
        let mut out = Vec::new();
        for e in &self.elements {
            for i in 0..e.post_count() {
                out.push(e.current_into_node(i));
            }
        }
        out
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

    /// Per-element live render state, in element order, one `f64` per element
    /// like [`Circuit::element_values`]. Each element defines what its scalar
    /// means through [`Element::display_state`]: a fuse's melt fraction, a
    /// lamp's filament temperature, 0 for everything else.
    pub fn element_states(&self) -> Vec<f64> {
        self.elements.iter().map(|e| e.display_state()).collect()
    }

    /// Live file-format tokens per element, in element order, one vector per
    /// element holding its `(name, value)` pairs. Only the operating-point
    /// kinds report anything; everything else stays empty. Called only at
    /// save/rebuild time, never per step, and consumed by the wasm façade's
    /// `elementStateTokens`.
    pub fn state_tokens(&self) -> Vec<Vec<(String, f64)>> {
        self.elements.iter().map(|e| e.state_tokens()).collect()
    }

    /// UI-assigned ids in element order, parallel to
    /// [`Circuit::element_states`], so the wasm façade can pair each token
    /// vector with the id the frontend knows.
    pub fn element_ids(&self) -> &[u32] {
        &self.ids
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

/// Index for a (coordinate, bus bit) key, allocating one on first sight.
fn coord_of(
    coord_id: &mut HashMap<([i32; 2], usize), usize>,
    coords: &mut Vec<([i32; 2], usize)>,
    key: ([i32; 2], usize),
) -> usize {
    if let Some(&i) = coord_id.get(&key) {
        i
    } else {
        let i = coords.len();
        coord_id.insert(key, i);
        coords.push(key);
        i
    }
}

/// True when every other unresolved wire touching `c` is resolved, so wire `i`
/// is free to determine its current from KCL at `c`. Self-loops (both posts at
/// one coordinate) never block: they neither draw nor deliver net current, so
/// their own current is whatever the neighbours leave. A ground-only
/// coordinate never resolves (see `recover_wire_currents`): its injection is
/// zero by construction, so reading a wire's current from it would misreport a
/// wire that actually feeds the reference plane through the ground.
fn can_resolve(
    edges: &[[usize; 2]],
    resolved: &[bool],
    ground_only: &[bool],
    i: usize,
    c: usize,
) -> bool {
    if ground_only[c] {
        return false;
    }
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

        // The Gram solve is dense O(n^2), so the entry count is computed with
        // checked arithmetic and capped the same way the dense backend caps
        // its systems. A wire component that large is a hand-edited netlist,
        // not a real circuit; it falls back to the zero-current report a
        // failed solve already produces instead of overflowing or exhausting
        // memory.
        let Some(g_entries) = nr
            .checked_mul(nr)
            .filter(|&n| n <= MAX_DENSE_ROWS * MAX_DENSE_ROWS)
        else {
            for &i in idxs {
                currents[i] = 0.0;
                resolved[i] = true;
            }
            continue;
        };

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
        let mut g = vec![0.0; g_entries];
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
        // `nr` is bounded by the Gram guard above, so the resize cannot fail;
        // the expect encodes that invariant instead of swallowing a real
        // guard hit.
        sys.resize(nr).expect("nr is bounded by MAX_DENSE_ROWS");
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
    use crate::spec::{ScopeSpec, TriggerSpec};

    /// A 5 V source behind 1 k into ground, with one voltage scope on the
    /// resistor: four steps aggregate into each column of a 16-column ring.
    fn scoped_circuit() -> Circuit {
        let mut c = Circuit::new();
        let spec = CircuitSpec {
            preserve_run: false,
            elements: vec![
                ElementSpec {
                    id: 1,
                    kind: "voltage".into(),
                    posts: vec![[0, 100], [0, 0]],
                    params: HashMap::from([("maxVoltage".to_string(), 5.0)]),
                    label: None,
                    model: None,
                    flags: 0,
                },
                ElementSpec {
                    id: 2,
                    kind: "resistor".into(),
                    posts: vec![[0, 0], [100, 0]],
                    params: HashMap::from([("resistance".to_string(), 1000.0)]),
                    label: None,
                    model: None,
                    flags: 0,
                },
                ElementSpec {
                    id: 3,
                    kind: "ground".into(),
                    posts: vec![[100, 0]],
                    params: HashMap::new(),
                    label: None,
                    model: None,
                    flags: 0,
                },
            ],
            options: Some(SimOptions {
                time_step: 5e-6,
                ..SimOptions::default()
            }),
            scopes: vec![ScopeSpec {
                element_id: 2,
                value: ScopeValue::Voltage,
                post: 0,
                steps_per_column: 4,
                columns: 16,
                ac_coupled: false,
                trigger: TriggerSpec::default(),
                display_width: 0,
            }],
        };
        c.set_circuit(&spec).expect("circuit should analyse");
        c
    }

    #[test]
    fn a_timestep_change_clears_the_scope_captures_at_the_next_frame() {
        // Scope.java:597-601: when sim.maxTimeStep changes, every graph is
        // reset before the next draw, so a capture buffer never mixes
        // columns aggregated under two different timesteps. Without this an
        // adaptive halve leaves the surviving columns stretched against the
        // time grid and the frequency readout lies. The port checks at the
        // same point, the frame boundary inside run().
        let mut c = scoped_circuit();
        c.run(40);
        assert_eq!(c.scopes()[0].columns_written, 10);
        assert_eq!(c.scopes()[0].snapshot().len(), 20);

        // What the adaptive halve would reach mid-frame.
        c.set_time_step(1.25e-6);
        // The next frame clears first, then samples eight steps at the new
        // dt: two fresh columns, nothing carried over.
        c.run(8);
        assert_eq!(c.scopes()[0].columns_written, 2);
        assert_eq!(c.scopes()[0].snapshot().len(), 4);
    }

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
