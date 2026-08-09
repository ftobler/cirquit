//! Composite element: a circuit built from other elements (CompositeElm.java).
//!
//! A composite owns a `Vec<Box<dyn Element>>` of children built from a model
//! string, plus the node remapping that ties the children's posts to the
//! composite's own posts and internal nodes. It reimplements the whole
//! `Element` surface by delegation, because the circuit only ever sees the
//! composite: `assign_nodes` fills the composite's flattened `base.nodes`, and
//! each child's node array is split out of it lazily.
//!
//! The model string is `\r`-separated `Type n1 n2 ...` lines, exactly
//! upstream's `loadComposite` input. The composite's own `base.nodes` entries
//! are the composite-local node ids that `assign_nodes` hands out: posts
//! first (the external nodes, in the model's `externalNodes` order), then the
//! internal nodes (the model's non-external node ids in first-seen order, then
//! one per child internal node). Node 0 in the model means ground. A child's
//! local post `j` therefore maps to the actual node id `base.nodes[cn[j]]`,
//! where `cn` is the child's composite-local mapping fixed at construction.
//!
//! Each child dump token (the tokens a saved `402`-style line carries after
//! the flags) is `_`-joined: the first field is the child's own file flags,
//! the rest map to the child kind's param names by position. The model type
//! also supplies defaults the token does not carry (the transistor's `pnp`),
//! so a freshly created composite with no dump tokens still builds a working
//! child.

use std::collections::HashMap;

use crate::element::{Base, Element, SimCtx};
use crate::elements::build_element;
use crate::spec::ElementSpec;
use crate::stamp::{Stamper, GROUND};

/// Sentinel in a composite-local node mapping: the child's post is ground,
/// which has no entry in the composite's node list.
const GROUND_NODE: usize = usize::MAX;

/// The child kind a model line's type token maps to, plus the default params
/// the type implies (the transistor's polarity is part of its class, so a
/// fresh `PTransistorElm` must start as a PNP even with no dump token).
/// Unknown types are skipped, matching upstream's "failed to create" path.
fn child_kind(model_type: &str) -> Option<(&'static str, Vec<(&'static str, f64)>)> {
    match model_type {
        "RailElm" => Some(("rail", Vec::new())),
        "VoltageElm" => Some(("voltage", Vec::new())),
        "ResistorElm" => Some(("resistor", Vec::new())),
        "TransistorElm" => Some(("transistor", Vec::new())),
        "NTransistorElm" => Some(("transistor", vec![("pnp", 1.0)])),
        "PTransistorElm" => Some(("transistor", vec![("pnp", -1.0)])),
        _ => None,
    }
}

/// The param names a child kind's dump fields map to, in position order. The
/// OTA's children are rails and transistors; the resistor table exists for the
/// composite tests and the later `.` line.
fn dump_fields(kind: &str) -> Option<&'static [&'static str]> {
    match kind {
        "rail" | "voltage" => Some(&[
            "waveform",
            "frequency",
            "maxVoltage",
            "bias",
            "phaseShift",
            "dutyCycle",
        ]),
        "transistor" => Some(&["pnp", "lastVbe", "lastVbc", "beta"]),
        "resistor" => Some(&["resistance"]),
        _ => None,
    }
}

/// Applies one `_`-joined child dump token: the first field is the child's
/// file flags, the rest overwrite the defaults by the kind's field order.
fn apply_dump(token: &str, kind: &str, params: &mut HashMap<String, f64>, flags: &mut i64) {
    let mut fields = token.split('_');
    if let Some(f) = fields.next() {
        *flags = f.parse().unwrap_or(0);
    }
    let Some(names) = dump_fields(kind) else {
        return;
    };
    for (name, field) in names.iter().zip(fields) {
        if let Ok(v) = field.parse::<f64>() {
            params.insert((*name).to_string(), v);
        }
    }
}

fn parse_model_line(line: &str) -> Option<(&str, Vec<usize>)> {
    let mut it = line.split_whitespace();
    let ty = it.next()?;
    let nodes = it.filter_map(|t| t.parse().ok()).collect();
    Some((ty, nodes))
}

pub struct Composite {
    base: Base,
    kind: &'static str,
    children: Vec<Box<dyn Element>>,
    /// Per child, its composite-local node index per child-local node index
    /// (posts then internal nodes). `GROUND_NODE` marks a ground-mapped post.
    child_nodes: Vec<Vec<usize>>,
    /// Per composite node, the (child index, child-local node) attachments.
    /// Only non-ground links are listed; the OTA's posts each carry the
    /// children that actually touch them.
    links: Vec<Vec<(usize, usize)>>,
    /// Composite-local terminal pair per voltage-source index, so
    /// `voltage_source_nodes` can resolve the actual node ids without needing
    /// the children's (lazily synced) node arrays.
    vs_terminals: Vec<(usize, usize)>,
    /// Voltage-source count per child, parallel to `children`.
    child_vs_counts: Vec<usize>,
    num_posts: usize,
    num_nodes: usize,
    /// Sum of the children's powers, accumulated in `calculate_current` so the
    /// read-only `power` hook never needs to touch the children's state.
    power_accum: f64,
}

/// The serialised model for the generic `composite` kind, as the frontend (or
/// a test) hands it over in `spec.model`. The OTA passes its own fixed model
/// directly; this JSON form is what a future `.`-line loader will emit.
#[derive(serde::Deserialize)]
struct CompositeModel {
    model: String,
    external: Vec<usize>,
    #[serde(default)]
    dumps: Vec<String>,
}

impl Composite {
    /// Builds a composite from the JSON model carried in `spec.model`, the
    /// generic kind the `.` line will use once it lands.
    pub fn from_spec(spec: &ElementSpec) -> Option<Self> {
        let m: CompositeModel = spec
            .model
            .as_deref()
            .and_then(|s| serde_json::from_str(s).ok())?;
        Some(Self::from_model(
            &m.model,
            &m.external,
            Some(&m.dumps),
            "composite",
        ))
    }

    /// Builds a composite from a model string, the external node ids that
    /// become its posts, and the optional per-child dump tokens.
    pub fn from_model(
        model: &str,
        external: &[usize],
        dumps: Option<&[String]>,
        kind: &'static str,
    ) -> Self {
        let num_posts = external.len();
        let mut children: Vec<Box<dyn Element>> = Vec::new();
        let mut node_lines: Vec<Vec<usize>> = Vec::new();

        for (i, line) in model.split('\r').enumerate() {
            let Some((ty, nodes)) = parse_model_line(line) else {
                continue;
            };
            let Some((child_kind, defaults)) = child_kind(ty) else {
                continue;
            };
            let mut params: HashMap<String, f64> = defaults
                .into_iter()
                .map(|(k, v)| (k.to_string(), v))
                .collect();
            let mut flags = 0i64;
            if let Some(dumps) = dumps {
                if let Some(token) = dumps.get(i) {
                    apply_dump(token, child_kind, &mut params, &mut flags);
                }
            }
            let spec = ElementSpec {
                id: i as u32,
                kind: child_kind.into(),
                posts: Vec::new(),
                params,
                label: None,
                model: None,
                flags,
            };
            let Some(child) = build_element(&spec) else {
                continue;
            };
            // A model line must name every post of its child; a short line is
            // a malformed model, skipped like a failed build.
            if nodes.len() < child.post_count() {
                continue;
            }
            children.push(child);
            node_lines.push(nodes);
        }

        // Map the model node ids onto composite-local indices: the external
        // ids are the posts, everything else is an internal node in first-seen
        // order, then one fresh node per child internal node.
        let mut ext_pos: HashMap<usize, usize> = HashMap::new();
        for (p, &e) in external.iter().enumerate() {
            ext_pos.insert(e, p);
        }
        let mut model_index: HashMap<usize, usize> = HashMap::new();
        let mut next_internal = num_posts;
        let mut child_nodes: Vec<Vec<usize>> = Vec::new();
        for (nodes, child) in node_lines.iter().zip(children.iter()) {
            let mut cn = Vec::with_capacity(nodes.len() + child.internal_node_count());
            for &m in nodes.iter() {
                let idx = if m == 0 {
                    GROUND_NODE
                } else if let Some(&p) = ext_pos.get(&m) {
                    p
                } else {
                    *model_index.entry(m).or_insert_with(|| {
                        let i = next_internal;
                        next_internal += 1;
                        i
                    })
                };
                cn.push(idx);
            }
            for _ in 0..child.internal_node_count() {
                cn.push(next_internal);
                next_internal += 1;
            }
            child_nodes.push(cn);
        }
        let num_nodes = next_internal;

        let mut links: Vec<Vec<(usize, usize)>> = vec![Vec::new(); num_nodes];
        for (ci, cn) in child_nodes.iter().enumerate() {
            for (local, &c) in cn.iter().enumerate() {
                if c != GROUND_NODE {
                    links[c].push((ci, local));
                }
            }
        }

        // Work out each voltage source's terminal pair in composite-local
        // terms. The children's node arrays are still unassigned, so give each
        // child sentinel node values 1..=n and let `voltage_source_nodes`
        // return the child-local indices (ground stays 0); the sentinels are
        // overwritten by `sync` before any child stamps.
        for child in children.iter_mut() {
            let n = child.post_count() + child.internal_node_count();
            child.base_mut().nodes = (1..=n).collect();
        }
        let mut vs_terminals: Vec<(usize, usize)> = Vec::new();
        let mut child_vs_counts: Vec<usize> = Vec::new();
        for (ci, child) in children.iter().enumerate() {
            let count = child.voltage_source_count();
            child_vs_counts.push(count);
            for k in 0..count {
                let (l1, l2) = child.voltage_source_nodes(k);
                let c1 = if l1 == GROUND {
                    GROUND_NODE
                } else {
                    child_nodes[ci][l1 - 1]
                };
                let c2 = if l2 == GROUND {
                    GROUND_NODE
                } else {
                    child_nodes[ci][l2 - 1]
                };
                vs_terminals.push((c1, c2));
            }
        }

        Self {
            base: Base::with_posts(num_posts),
            kind,
            children,
            child_nodes,
            links,
            vs_terminals,
            child_vs_counts,
            num_posts,
            num_nodes,
            power_accum: 0.0,
        }
    }

    /// Sets a live parameter on one child. The OTA uses it to push its
    /// `posVolt`/`negVolt` supply edits onto the two rail children.
    pub fn set_child_param(&mut self, index: usize, name: &str, value: f64) -> bool {
        match self.children.get_mut(index) {
            Some(child) => child.set_param(name, value),
            None => false,
        }
    }

    /// Splits the composite's flattened node list across the children, and
    /// lays each child's voltage-source base rows into the composite's own
    /// vs space. Idempotent and cheap, so every mutable entry point runs it
    /// before delegating: `assign_nodes` renumbers the composite's nodes on
    /// every analysis, and the children's arrays must follow.
    fn sync(&mut self) {
        for ci in 0..self.children.len() {
            let cn = &self.child_nodes[ci];
            let base = &self.base;
            let b = self.children[ci].base_mut();
            b.nodes.resize(cn.len(), GROUND);
            b.volts.resize(cn.len(), 0.0);
            for (j, &c) in cn.iter().enumerate() {
                b.nodes[j] = if c == GROUND_NODE {
                    GROUND
                } else {
                    base.nodes[c]
                };
                b.volts[j] = if c == GROUND_NODE { 0.0 } else { base.volts[c] };
            }
        }
        let mut offset = self.base.vs_base;
        for ci in 0..self.children.len() {
            let b = self.children[ci].base_mut();
            b.vs_base = offset;
            let count = self.child_vs_counts[ci];
            if b.vs_currents.len() != count {
                b.vs_currents = vec![0.0; count];
            }
            offset += count;
        }
    }
}

impl Element for Composite {
    fn kind(&self) -> &'static str {
        self.kind
    }
    fn base(&self) -> &Base {
        &self.base
    }
    fn base_mut(&mut self) -> &mut Base {
        &mut self.base
    }
    fn post_count(&self) -> usize {
        self.num_posts
    }
    fn internal_node_count(&self) -> usize {
        self.num_nodes - self.num_posts
    }

    fn voltage_source_count(&self) -> usize {
        self.child_vs_counts.iter().sum()
    }

    fn voltage_source_nodes(&self, k: usize) -> (usize, usize) {
        let (c1, c2) = self.vs_terminals[k];
        (
            if c1 == GROUND_NODE {
                GROUND
            } else {
                self.base.nodes[c1]
            },
            if c2 == GROUND_NODE {
                GROUND
            } else {
                self.base.nodes[c2]
            },
        )
    }

    fn nonlinear(&self) -> bool {
        self.children.iter().any(|c| c.nonlinear())
    }

    fn stamp(&mut self, ctx: &SimCtx, s: &mut Stamper) {
        self.sync();
        for child in self.children.iter_mut() {
            child.stamp(ctx, s);
        }
    }

    fn start_iteration(&mut self, ctx: &SimCtx) {
        self.sync();
        for child in self.children.iter_mut() {
            child.start_iteration(ctx);
        }
    }

    fn do_step(&mut self, ctx: &SimCtx, s: &mut Stamper) {
        // `write_back` refreshed the composite's volts between Newton
        // iterations, so syncing here hands each child the latest iterate.
        self.sync();
        for child in self.children.iter_mut() {
            child.do_step(ctx, s);
        }
    }

    fn step_finished(&mut self, ctx: &SimCtx) {
        self.sync();
        for child in self.children.iter_mut() {
            child.step_finished(ctx);
        }
    }

    fn restore_iteration(&mut self) {
        self.sync();
        for child in self.children.iter_mut() {
            child.restore_iteration();
        }
    }

    fn calculate_current(&mut self, ctx: &SimCtx) {
        self.sync();
        // The solver wrote the composite's vs currents back; split them into
        // each child's own array so the child can derive its current.
        let base = &self.base;
        for ci in 0..self.children.len() {
            let start = self.children[ci].base().vs_base - base.vs_base;
            for k in 0..self.child_vs_counts[ci] {
                self.children[ci].base_mut().vs_currents[k] = base.vs_currents[start + k];
            }
            self.children[ci].calculate_current(ctx);
        }
        self.base.current = self.children.iter().map(|c| c.base().current).sum();
        self.power_accum = self.children.iter().map(|c| c.power()).sum();
    }

    /// No composite post pair couples through the composite as a device
    /// (upstream's `getConnection` returns false). The coupling lives inside
    /// the children, which `matrix_connects` makes visible to the closure
    /// builder.
    fn connects(&self, _a: usize, _b: usize) -> bool {
        false
    }

    /// The closure builder must see the children's couplings or the OTA's
    /// posts and internal nodes would each float in their own closure and the
    /// children's stamps would tear.
    fn matrix_connects(&self, a: usize, b: usize) -> bool {
        for (ci, child) in self.children.iter().enumerate() {
            let cn = &self.child_nodes[ci];
            for p in 0..cn.len() {
                for q in (p + 1)..cn.len() {
                    if child.matrix_connects(p, q)
                        && ((cn[p] == a && cn[q] == b) || (cn[p] == b && cn[q] == a))
                    {
                        return true;
                    }
                }
            }
        }
        false
    }

    fn current_into_node(&self, post: usize) -> f64 {
        self.links
            .get(post)
            .map(|ls| {
                ls.iter()
                    .map(|&(ci, local)| self.children[ci].current_into_node(local))
                    .sum()
            })
            .unwrap_or(0.0)
    }

    fn seed_initial_voltages(&mut self, v: &mut [f64]) {
        self.sync();
        for child in self.children.iter_mut() {
            child.seed_initial_voltages(v);
        }
    }

    fn reset(&mut self) {
        self.sync();
        for child in self.children.iter_mut() {
            child.reset();
        }
        self.base.reset();
        self.power_accum = 0.0;
    }

    fn set_param(&mut self, name: &str, value: f64) -> bool {
        match name {
            // The supply edits are the two rails, negative first
            // (OTAElm.java:41-42); a composite with a different layout can
            // still fall through to the per-child delegation below.
            "posVolt" => self.set_child_param(1, "maxVoltage", value),
            "negVolt" => self.set_child_param(0, "maxVoltage", value),
            _ => {
                let mut any = false;
                for child in self.children.iter_mut() {
                    any |= child.set_param(name, value);
                }
                any
            }
        }
    }

    fn set_frequency(&mut self, ctx: &SimCtx, new_freq: f64) -> bool {
        let mut any = false;
        for child in self.children.iter_mut() {
            any |= child.set_frequency(ctx, new_freq);
        }
        any
    }

    fn set_state(&mut self, state: i32) -> bool {
        let mut any = false;
        for child in self.children.iter_mut() {
            any |= child.set_state(state);
        }
        any
    }

    fn voltage_diff(&self) -> f64 {
        let b = self.base();
        if b.volts.len() >= 2 {
            b.volts[0] - b.volts[1]
        } else {
            b.volts.first().copied().unwrap_or(0.0)
        }
    }

    fn power(&self) -> f64 {
        self.power_accum
    }
}
