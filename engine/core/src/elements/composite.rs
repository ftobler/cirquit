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

use std::collections::{HashMap, HashSet};

use crate::element::{Base, Element, SimCtx};
use crate::elements::build_element;
use crate::spec::ElementSpec;
use crate::stamp::{Stamper, GROUND};

/// Sentinel in a composite-local node mapping: the child's post is ground,
/// which has no entry in the composite's node list.
const GROUND_NODE: usize = usize::MAX;

/// Channel-type flag bit on a jfet/mosfet child, the frontend's `MOSFET_PNP`
/// (web/src/model/registry/flags.ts). The channel type is not a dump token:
/// it lives in the child's file flags, and the engine jfet/mosfet read it as
/// the `pnp` param, so `apply_dump` stores the flags and `from_model` folds
/// the bit into the param.
const MOSFET_PNP: i64 = 1;

/// The child kind a model line's type token maps to, plus the default params
/// the type implies (the transistor's and jfet/mosfet's polarity is part of
/// its class, so a fresh `PTransistorElm` or `PJfetElm` must start as a PNP
/// even with no dump token). Unknown types are skipped, matching upstream's
/// "failed to create" path.
fn child_kind(model_type: &str) -> Option<(&'static str, Vec<(&'static str, f64)>)> {
    match model_type {
        "RailElm" => Some(("rail", Vec::new())),
        "VoltageElm" => Some(("voltage", Vec::new())),
        "ResistorElm" => Some(("resistor", Vec::new())),
        "TransistorElm" => Some(("transistor", Vec::new())),
        "NTransistorElm" => Some(("transistor", vec![("pnp", 1.0)])),
        "PTransistorElm" => Some(("transistor", vec![("pnp", -1.0)])),
        "CapacitorElm" => Some(("capacitor", Vec::new())),
        "InductorElm" => Some(("inductor", Vec::new())),
        "CurrentElm" => Some(("current", Vec::new())),
        "SwitchElm" => Some(("switch", Vec::new())),
        "DiodeElm" => Some(("diode", Vec::new())),
        "ZenerElm" => Some(("zener", Vec::new())),
        "LEDElm" => Some(("led", Vec::new())),
        "JfetElm" | "NJfetElm" => Some(("jfet", vec![("pnp", 1.0)])),
        "PJfetElm" => Some(("jfet", vec![("pnp", -1.0)])),
        "MosfetElm" | "NMosfetElm" => Some(("mosfet", vec![("pnp", 1.0)])),
        "PMosfetElm" => Some(("mosfet", vec![("pnp", -1.0)])),
        // The built-in composite elements' children. The comparator is an
        // op-amp whose output drives an analog switch pulling the output post
        // to a ground child's node; the optocoupler's light path is a CCCS
        // whose expression the parent sets after build. A ground child pins
        // its post's model node to the reference (see the node-mapping pass).
        // Logic children. A gate's post count is its input count plus the
        // output, and the input count is the first dump field, so a gate whose
        // model line carries no dump falls back to the node count (see
        // `gate_input_count`).
        "AndGateElm" => Some(("andGate", Vec::new())),
        "NandGateElm" => Some(("nandGate", Vec::new())),
        "OrGateElm" => Some(("orGate", Vec::new())),
        "NorGateElm" => Some(("norGate", Vec::new())),
        "XorGateElm" => Some(("xorGate", Vec::new())),
        "XnorGateElm" => Some(("xnorGate", Vec::new())),
        "InverterElm" => Some(("inverter", Vec::new())),
        "OpAmpElm" => Some(("opamp", Vec::new())),
        "AnalogSwitchElm" => Some(("analogSwitch", Vec::new())),
        "GroundElm" => Some(("ground", Vec::new())),
        "CCCSElm" => Some(("cccs", Vec::new())),
        // The expression-driven controlled sources. The LM324v2 model strings
        // hold a VCVS and a VCCS child whose value is a dump-token expression
        // (lm324v2ModelString, OpAmpRealElm.java:38-41); the expression rides
        // the child's label, the same string carrier the top-level sources
        // use (VCCSElm.java:37-38).
        "VCVSElm" => Some(("vcvs", Vec::new())),
        "VCCSElm" => Some(("vccs", Vec::new())),
        _ => None,
    }
}

/// The input count a gate child's model line implies: one post per input plus
/// the output. `None` for a child that is not a gate, and for a node list too
/// short to name even one input, which `from_model`'s post-count check refuses
/// anyway. The count is clamped to the model's own 1..=8 range so a malformed
/// line cannot allocate an absurd gate.
fn gate_input_count(child_kind: &str, nodes: usize) -> Option<f64> {
    match child_kind {
        "andGate" | "nandGate" | "orGate" | "norGate" | "xorGate" | "xnorGate" => {
            (nodes >= 2).then(|| (nodes - 1).min(8) as f64)
        }
        _ => None,
    }
}

/// The param names a child kind's dump fields map to, in position order, the
/// frontend registry's `dump` order. The OTA's children are rails and
/// transistors; the rest of the tables exist for the `.` line and the
/// composite tests.
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
        "capacitor" => Some(&[
            "capacitance",
            "voltDiff",
            "initialVoltage",
            "seriesResistance",
        ]),
        "inductor" => Some(&[
            "inductance",
            "current",
            "initialCurrent",
            "saturationCurrent",
        ]),
        "diode" => Some(&["forwardVoltage"]),
        "zener" => Some(&["forwardVoltage", "breakdownVoltage"]),
        "led" => Some(&[
            "forwardVoltage",
            "colorR",
            "colorG",
            "colorB",
            "maxBrightnessCurrent",
        ]),
        "current" => Some(&["current", "maxVoltage"]),
        "switch" => Some(&["position"]),
        "jfet" | "mosfet" => Some(&["threshold", "beta"]),
        // The op-amp child's fields follow OpAmpElm.java:51-56 (maxOut,
        // minOut, gbw, the saved input voltages, gain); the analog switch's
        // its r_on/r_off/threshold (AnalogSwitchElm.java:58-60). A ground
        // child has nothing numeric to apply (the port's ground ignores all
        // params), and the CCCS's expression is a string the parent sets
        // directly, not a dump field.
        // GateElm.java:55-61 reads inputCount, the last output voltage and the
        // high level, which is the frontend registry's dump order too.
        "andGate" | "nandGate" | "orGate" | "norGate" | "xorGate" | "xnorGate" => {
            Some(&["inputCount", "lastOutputVoltage", "highVoltage"])
        }
        "inverter" => Some(&["slewRate", "highVoltage"]),
        "opamp" => Some(&["maxOut", "minOut", "gbw", "volts0", "volts1", "gain"]),
        "analogSwitch" => Some(&["r_on", "r_off", "threshold"]),
        "cccs" => Some(&["inputCount"]),
        // The controlled sources dump their input count and their expression
        // (VCCSElm.java:37-38); only the count is numeric, the expression is a
        // string field `dump_expression` reads off the token directly.
        "vcvs" | "vccs" => Some(&["inputCount"]),
        _ => None,
    }
}

/// Applies one `_`-joined child dump token: the first field is the child's
/// file flags, the rest overwrite the defaults by the kind's field order.
///
/// Only `f64` fields are parsed, so the string tokens a child dump can carry
/// are dropped silently: a diode/zener/led's `modelName` (FLAG_MODEL form) and
/// a switch's `true`/`false` momentary or label token are skipped and the
/// child falls back to its value-form defaults. The position alignment holds
/// because the fields are paired by order and a non-numeric token is just
/// skipped, so the numeric fields that follow still land. The LED's colour and
/// brightness, the switch's position and every other value-form field
/// round-trip; only the named-model and momentary/label tokens do not.
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

/// The expression a vcvs/vccs child's dump token carries, the fields after its
/// flags and input count (VCCSElm.java:37-38). The token is `_`-joined, so the
/// leftover fields rejoin with `_` to recover the original string, which the
/// engine's own expressions never contain. `None` for every other child kind,
/// and for a token that stops after the input count.
fn dump_expression(token: &str, kind: &str) -> Option<String> {
    if kind != "vcvs" && kind != "vccs" {
        return None;
    }
    let mut fields = token.split('_');
    fields.next();
    fields.next();
    let rest: Vec<&str> = fields.collect();
    if rest.is_empty() {
        None
    } else {
        Some(rest.join("_"))
    }
}

/// The trailing model name a transistor child's dump token carries, the field
/// after beta (TransistorElm.java:58-68, the token constructor reads the model
/// name at :69). The LM324v2's dump names its transistors
/// (`xlm324v2-qpi` etc.); without this field the child builds as a default
/// Ebers-Moll transistor and the SPICE model's satCur/betaR are silently lost.
/// `None` for every other child kind, and for a token with no name field.
fn dump_model_name(token: &str, kind: &str) -> Option<String> {
    if kind != "transistor" {
        return None;
    }
    token.split('_').nth(5).map(|n| n.to_string())
}

/// The internal transistor models a composite child can name, with the two
/// Ebers-Moll params the port consumes (satCur, betaR). Mirrors the engine
/// half of `web/src/model/deviceModels.ts` (TransistorModel.java:121-126): the
/// composite has no path through the frontend's load-time resolution, so the
/// children of the built-in composites resolve here. A name outside the table
/// is skipped and the child keeps its defaults, the same
/// `getModelWithNameOrCopy` fallback a file miss gets at the top level.
const TRANSISTOR_MODELS: &[(&str, f64, f64)] = &[
    ("xlm324v2-qpi", 1.01e-16, 1.0),
    ("xlm324v2-qpa", 1.01e-16, 1.0),
    ("xlm324v2-qnq", 1e-16, 1.0),
    ("xlm324v2-qpq", 1e-16, 1.0),
];

fn resolve_transistor_model(name: &str) -> Option<(f64, f64)> {
    TRANSISTOR_MODELS
        .iter()
        .find(|(n, _, _)| *n == name)
        .map(|&(_, sat, br)| (sat, br))
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
    /// generic kind the `.` line uses. The model blob is user-editable file
    /// content, so a missing or malformed definition is a named build error
    /// rather than a silent `None`, and child errors propagate verbatim.
    pub fn from_spec(spec: &ElementSpec) -> Result<Self, String> {
        let m: CompositeModel = spec
            .model
            .as_deref()
            .and_then(|s| serde_json::from_str(s).ok())
            .ok_or_else(|| {
                format!(
                    "element '{}' (id {}) has a missing or malformed model definition",
                    spec.kind, spec.id
                )
            })?;
        Self::from_model(&m.model, &m.external, Some(&m.dumps), "composite")
    }

    /// Builds a composite from a model string, the external node ids that
    /// become its posts, and the optional per-child dump tokens. Fails named
    /// when a child dump carries an expression that cannot parse; unknown
    /// child kinds and short node lists still skip silently like upstream's
    /// "failed to create" path.
    pub fn from_model(
        model: &str,
        external: &[usize],
        dumps: Option<&[String]>,
        kind: &'static str,
    ) -> Result<Self, String> {
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
            let mut label: Option<String> = None;
            if let Some(dumps) = dumps {
                if let Some(token) = dumps.get(i) {
                    apply_dump(token, child_kind, &mut params, &mut flags);
                    label = dump_expression(token, child_kind);
                    // A transistor child's named model is a string field
                    // `apply_dump` cannot carry; resolve it against the
                    // internal-model table so the built-in composites keep
                    // their SPICE transistors (see `resolve_transistor_model`).
                    if let Some(name) = dump_model_name(token, child_kind) {
                        if let Some((sat, br)) = resolve_transistor_model(&name) {
                            params.insert("saturationCurrent".into(), sat);
                            params.insert("betaReverse".into(), br);
                        }
                    }
                }
            }
            // A controlled-source child's expression is not numeric, so
            // `apply_dump` cannot carry it; it rides the label instead. The
            // token is file content a hand-edited model can corrupt, so an
            // unparseable expression refuses the whole load with the child
            // named: a silently-degraded child would stamp the wrong value,
            // and aborting the instance helps nobody.
            if let Some(ref expr) = label {
                if crate::expr::parse(expr).is_err() {
                    return Err(format!(
                        "composite child {i} ({child_kind}) carries an unparseable expression: {expr:?}"
                    ));
                }
            }
            // The channel type of a jfet/mosfet child is not a dump token; it
            // is file flag bit 1 (the frontend's `MOSFET_PNP`), which the
            // engine models read as the `pnp` param. `child_kind` already
            // carries the class's own polarity, so only the set bit needs to
            // override it.
            if (child_kind == "jfet" || child_kind == "mosfet") && flags & MOSFET_PNP != 0 {
                params.insert("pnp".into(), -1.0);
            }
            // A gate's post count is `inputCount + 1`, and a model line that
            // carries no dump token (a hand-written model, or one whose
            // writer left the gates at their defaults) would build a 2-input
            // gate for a node list of any width, which the post-count check
            // below then throws away. The node list names every post, so it
            // is the input count the model meant.
            if let Some(inputs) = gate_input_count(child_kind, nodes.len()) {
                params.entry("inputCount".into()).or_insert(inputs);
            }
            // A switch child cannot rely on the top-level wire merging that
            // shorts a closed switch's terminals, so it must know it is in a
            // composite and stamp its 1e-3 ohm closed resistance instead
            // (upstream's `inComposite`, SwitchElm.java:219-228).
            if child_kind == "switch" {
                params.insert("inComposite".into(), 1.0);
            }
            let spec = ElementSpec {
                id: i as u32,
                kind: child_kind.into(),
                posts: Vec::new(),
                params,
                label,
                model: None,
                flags,
            };
            let Ok(child) = build_element(&spec) else {
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
        // order, then one fresh node per child internal node. Model node 0 is
        // ground; so is any node a `GroundElm` child pins, mirroring upstream's
        // old-style ground child, which stamps a 0 V source onto that node
        // (CompositeElm.java:99-100). The comparator's switch output hangs off
        // exactly such a node, so without this the comparator's low drive
        // would float instead of pulling to the reference.
        let mut ground_nodes: HashSet<usize> = [0].into();
        for (nodes, child) in node_lines.iter().zip(children.iter()) {
            if child.kind() == "ground" {
                if let Some(&m) = nodes.first() {
                    ground_nodes.insert(m);
                }
            }
        }
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
                let idx = if ground_nodes.contains(&m) {
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

        Ok(Self {
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
        })
    }

    /// Sets a live parameter on one child. The OTA uses it to push its
    /// `posVolt`/`negVolt` supply edits onto the two rail children.
    pub fn set_child_param(&mut self, index: usize, name: &str, value: f64) -> bool {
        match self.children.get_mut(index) {
            Some(child) => child.set_param(name, value),
            None => false,
        }
    }

    /// Sets a string-valued parameter on one child, for the children a parent
    /// must configure after build. The optocoupler uses it to hand its CCCS
    /// child the CTR expression, which is not a number and so cannot ride the
    /// numeric `set_param` path.
    pub fn set_child_string(&mut self, index: usize, name: &str, value: &str) -> bool {
        match self.children.get_mut(index) {
            Some(child) => child.set_string_param(name, value),
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
        self.base.current = match self.kind {
            // A series-branch composite reports the one branch current, not
            // the sum of every child's: the crystal's series capacitor,
            // inductor and resistor all report the same current, and summing
            // them would triple it (CrystalElm.java:151 reports
            // `getCurrentIntoNode(1)` instead of summing).
            "crystal" => -self.current_into_node(0),
            // The op-amp reports the current leaving its output post; summing
            // all thirty-two children would count every internal bias current
            // (OpAmpRealElm.java:264 reports `getCurrentIntoNode(2)`).
            "opampReal" => -self.current_into_node(2),
            _ => self.children.iter().map(|c| c.base().current).sum(),
        };
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
        // The crystal's four fields each own exactly one child, so a live edit
        // must route to it alone: the composite's name fallback would hit
        // every child that shares the name (both capacitor children answer to
        // "capacitance"). The route is fixed for the kind, like the OTA's
        // supply pair below.
        match (self.kind, name) {
            ("crystal", "parallelCapacitance") => {
                return self.set_child_param(0, "capacitance", value)
            }
            ("crystal", "seriesCapacitance") => {
                return self.set_child_param(1, "capacitance", value)
            }
            ("crystal", "inductance") => return self.set_child_param(2, "inductance", value),
            ("crystal", "resistance") => return self.set_child_param(3, "resistance", value),
            _ => {}
        }
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
