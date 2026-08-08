//! Quadratic JFET model: the MOSFET channel machinery plus a gate junction.
//!
//! A JFET is a depletion-mode part, so the default threshold is -4 V and an
//! N-channel with its gate at source voltage already conducts its full
//! saturation current (JfetElm.java:137-139, MosfetModel.java:132). The
//! channel stamp is exactly the mosfet's quadratic model
//! (MosfetElm.java:563-629); what makes the JFET itself is the gate, which is
//! a reverse-biased P-N junction rather than an oxide, so it carries a real
//! (leakage, then full) current when the junction voltage moves off zero
//! (JfetElm.java:111-126). This module embeds the same `Diode` the mosfet
//! embeds for its body junction, stamped gate-to-source.
//!
//! There is no body diode: the default-jfet model never shows a bulk terminal,
//! so `doBodyDiode` is false (MosfetModel.java:133). Nor are there gate caps.
//! The polarity-sign folding, the source/drain swap and the per-iteration
//! voltage clamp are copied from the mosfet model so the two devices stay in
//! step.

use std::collections::HashMap;

use crate::element::{Base, Element, SimCtx};
use crate::elements::diode::Diode;
use crate::elements::junction::CONVERGENCE_V;
use crate::spec::ElementSpec;
use crate::stamp::Stamper;

/// Conductance of an off channel, keeping the drain/source pair from floating
/// (MosfetElm.java:610). The saturation branch clamps its own Gds to the same
/// floor because lambda is 0 in this model, so this is the minimum
/// drain-source conductance everywhere.
const MIN_CHANNEL_G: f64 = 1e-8;
/// Largest source/drain voltage move per Newton iteration, the same
/// anti-divergence role the BJT's junction limiting plays (MosfetElm.java:573-580).
const MAX_STEP_V: f64 = 0.5;
/// Threshold and beta of the default JFET model, taken from Hayes+Horowitz
/// p155 (JfetElm.java:137-139). Depletion mode: the threshold is negative, so
/// the channel conducts at `vgs = 0`.
const DEFAULT_THRESHOLD: f64 = -4.0;
const DEFAULT_BETA: f64 = 0.00125;

/// JFET, upstream's default model: `vt = -4`, `beta = 0.00125`, `lambda = 0`,
/// no gate caps, and a default-model gate junction in place of the mosfet's
/// body diode.
///
/// Posts are gate, source and drain for an N-channel; the P-channel swaps the
/// source/drain *labels*, but the engine never needs to know which physical
/// post is which: it picks the source as the lower-voltage terminal for an
/// N-channel and the higher-voltage one for a P-channel, so `vds >= 0` in the
/// device frame, exactly like the mosfet (MosfetElm.java:588).
pub struct Jfet {
    base: Base,
    /// `1.0` for an N-channel, `-1.0` for a P-channel. Folding the type into a
    /// sign keeps one set of equations for both, like the mosfet's `polarity`.
    polarity: f64,
    /// Threshold voltage `vt`, in volts.
    vt: f64,
    /// Transconductance parameter `beta`, in A/V^2.
    beta: f64,
    /// The gate junction, anode at the gate post for an N-channel and at post 1
    /// for a P-channel, mirroring `JfetElm.stamp`'s `diode.stamp(nodes[0],
    /// nodes[1])` / `diode.stamp(nodes[1], nodes[0])` (JfetElm.java:113-116).
    /// The embedded `Diode` carries its own `Base` that the circuit never sees.
    gate_diode: Diode,
    /// Current leaving the gate through the junction toward the source-side
    /// terminal, positive for both channel types, so `current_into_node`
    /// matches upstream's `getCurrentIntoNode` (JfetElm.java:78-84). For a
    /// P-channel the junction is reversed (anode at post 1), so a
    /// source-to-gate conduction shows here as a negative gate current, i.e.
    /// current entering the gate node.
    gate_current: f64,
    /// Limited source/drain voltages from the previous iteration, feeding the
    /// per-iteration clamp and the convergence report.
    last_v0: f64,
    last_v1: f64,
    last_v2: f64,
    /// Reported drain-source current, folded back through the swap
    /// (MosfetElm.java:642-644).
    ids: f64,
}

impl Jfet {
    pub fn new(spec: &ElementSpec) -> Self {
        // The file sign is the type: +1 is N-channel, -1 is P-channel, and any
        // non-negative token (including the absent one) reads as N
        // (MosfetElm.java:91). The gate junction is the default diode model,
        // which is all upstream's `setupForDefaultModel()` gives a JFET either
        // (JfetElm.java:31-33).
        let gate_diode = Diode::new(&ElementSpec {
            id: 0,
            kind: "diode".into(),
            posts: Vec::new(),
            params: HashMap::new(),
            label: None,
            flags: 0,
        });
        Self {
            base: Base::with_posts(3),
            polarity: if spec.param("pnp", 1.0) < 0.0 {
                -1.0
            } else {
                1.0
            },
            vt: spec.param("threshold", DEFAULT_THRESHOLD),
            beta: spec.param("beta", DEFAULT_BETA).max(1e-6),
            gate_diode,
            gate_current: 0.0,
            last_v0: 0.0,
            last_v1: 0.0,
            last_v2: 0.0,
            ids: 0.0,
        }
    }

    /// The three branches of the quadratic model, evaluated in the
    /// polarity-scaled frame (`pvgs = p*vgs`), so the same equations serve
    /// both channel types (MosfetElm.java:607-629). Returns `(ids, gm, Gds)`.
    fn branch(&self, pvgs: f64, pvds: f64) -> (f64, f64, f64) {
        if pvgs < self.vt {
            // Off: a large resistor, so the drain/source pair stays pinned
            // instead of presenting an open circuit.
            (pvds * MIN_CHANNEL_G, 0.0, MIN_CHANNEL_G)
        } else if pvds < pvgs - self.vt {
            // Triode (linear): ids = beta*((vgs-vt)*vds - vds^2/2).
            let ids = self.beta * ((pvgs - self.vt) * pvds - 0.5 * pvds * pvds);
            (ids, self.beta * pvds, self.beta * (pvgs - pvds - self.vt))
        } else {
            // Saturation: ids = 0.5*beta*(vgs-vt)^2. With lambda = 0 the
            // channel-length-modulation term vanishes and Gds clamps to the
            // same floor as the off state.
            let vgs_vt = pvgs - self.vt;
            (
                0.5 * self.beta * vgs_vt * vgs_vt,
                self.beta * vgs_vt,
                MIN_CHANNEL_G,
            )
        }
    }

    /// Which terminal pair are source and drain, so `vds >= 0` in the device
    /// frame: the lower-voltage terminal for an N-channel, the higher one for
    /// a P-channel (MosfetElm.java:588).
    fn source_drain(&self, v1: f64, v2: f64) -> (usize, usize) {
        if self.polarity * v1 > self.polarity * v2 {
            (2, 1)
        } else {
            (1, 2)
        }
    }

    /// True when the swap moved the source off its nominal post, which flips
    /// the sign of the reported current (MosfetElm.java:642-644).
    fn folded_sign(&self, source: usize, p: f64) -> bool {
        (source == 2 && p == 1.0) || (source == 1 && p == -1.0)
    }

    /// (anode post, cathode post) of the gate junction: gate-to-source for an
    /// N-channel, source-to-gate for a P-channel (JfetElm.java:113-116).
    fn gate_diode_posts(&self) -> (usize, usize) {
        if self.polarity > 0.0 {
            (0, 1)
        } else {
            (1, 0)
        }
    }

    /// Points the embedded gate `Diode` at the junction's posts and the given
    /// terminal voltages, so its own `do_step` and `calculate_current` read
    /// the right nodes. The diode's `Base` is invisible to the circuit, so it
    /// must be re-pointed on every call, exactly like the mosfet's body diode.
    fn wire_gate_diode(&mut self, volts: [f64; 3]) {
        let (na, nc) = self.gate_diode_posts();
        let d = self.gate_diode.base_mut();
        d.nodes[0] = self.base.nodes[na];
        d.nodes[1] = self.base.nodes[nc];
        d.volts[0] = volts[na];
        d.volts[1] = volts[nc];
    }

    /// Stamps the gate junction between its anode and cathode posts, using the
    /// raw (unclamped) terminal voltages exactly as upstream's `diode.doStep
    /// (pnp*(volts[0]-volts[1]))` does (JfetElm.java:121).
    fn stamp_gate_diode(&mut self, ctx: &SimCtx, s: &mut Stamper) {
        self.wire_gate_diode([self.base.volts[0], self.base.volts[1], self.base.volts[2]]);
        self.gate_diode.do_step(ctx, s);
    }
}

impl Element for Jfet {
    fn kind(&self) -> &'static str {
        "jfet"
    }
    fn base(&self) -> &Base {
        &self.base
    }
    fn base_mut(&mut self) -> &mut Base {
        &mut self.base
    }
    fn post_count(&self) -> usize {
        3
    }
    fn nonlinear(&self) -> bool {
        true
    }

    fn do_step(&mut self, ctx: &SimCtx, s: &mut Stamper) {
        let p = self.polarity;
        let (vg, v1, v2) = (self.base.volts[0], self.base.volts[1], self.base.volts[2]);

        // Clamp the source/drain move to 0.5 V per iteration so Newton cannot
        // leap across the whole characteristic (MosfetElm.java:573-580). The
        // gate is not clamped; upstream limits only nodes 1 and 2.
        let sv1 = v1
            .max(self.last_v1 - MAX_STEP_V)
            .min(self.last_v1 + MAX_STEP_V);
        let sv2 = v2
            .max(self.last_v2 - MAX_STEP_V)
            .min(self.last_v2 + MAX_STEP_V);

        if (sv1 - self.last_v1).abs() > CONVERGENCE_V
            || (sv2 - self.last_v2).abs() > CONVERGENCE_V
            || (vg - self.last_v0).abs() > CONVERGENCE_V
        {
            s.not_converged();
        }
        self.last_v0 = vg;
        self.last_v1 = sv1;
        self.last_v2 = sv2;

        let (source, drain) = self.source_drain(sv1, sv2);
        let vs = if source == 1 { sv1 } else { sv2 };
        let vd = if drain == 1 { sv1 } else { sv2 };
        let vgs = vg - vs;
        let vds = vd - vs;

        let (ids0, gm, gds) = self.branch(p * vgs, p * vds);
        self.ids = if self.folded_sign(source, p) {
            -ids0
        } else {
            ids0
        };

        // The 3x3 drain/source/gate pattern and its right-hand side, the same
        // channel stamp as the mosfet (MosfetElm.java:649-659). Each channel
        // row holds `Gds*(Vd-Vs) + gm*(Vg-Vs)`, and `rs` supplies the constant
        // part so the physical channel current `p*ids0` leaves the drain.
        let rs = -p * ids0 + gds * vds + gm * vgs;
        let (ng, ns, nd) = (
            self.base.nodes[0],
            self.base.nodes[source],
            self.base.nodes[drain],
        );
        s.node_pair(nd, nd, gds);
        s.node_pair(nd, ns, -gds - gm);
        s.node_pair(nd, ng, gm);
        s.node_pair(ns, nd, -gds);
        s.node_pair(ns, ns, gds + gm);
        s.node_pair(ns, ng, -gm);
        s.node_rhs(nd, rs);
        s.node_rhs(ns, -rs);

        // The gate junction, after the channel, matching upstream's
        // `super.doStep()` then `diode.doStep()` (JfetElm.java:119-122).
        self.stamp_gate_diode(ctx, s);
    }

    fn calculate_current(&mut self, _ctx: &SimCtx) {
        // Recompute the reported current from the solved, unclamped voltages,
        // matching upstream's `calculate(true)` in stepFinished.
        let p = self.polarity;
        let (vg, v1, v2) = (self.base.volts[0], self.base.volts[1], self.base.volts[2]);
        let (source, drain) = self.source_drain(v1, v2);
        let vs = if source == 1 { v1 } else { v2 };
        let vd = if drain == 1 { v1 } else { v2 };
        let (ids0, _, _) = self.branch(p * (vg - vs), p * (vd - vs));
        self.ids = if self.folded_sign(source, p) {
            -ids0
        } else {
            ids0
        };
        self.base.current = self.ids;

        // The gate junction's own current at the solved voltages, folded so
        // `gate_current` reads leaving the gate into the source-side terminal
        // for both channel types (JfetElm.java:124-126).
        self.wire_gate_diode([vg, v1, v2]);
        self.gate_diode.calculate_current(_ctx);
        self.gate_current = p * self.gate_diode.base().current;
    }

    fn current_into_node(&self, post: usize) -> f64 {
        // `ids` flows drain to source; the gate junction leaks between the
        // gate and the source-side terminal (JfetElm.java:78-84). Upstream
        // reports current into the gate as `-gateCurrent`, into post 1 as
        // `gateCurrent + ids` and into post 2 as `-ids`.
        match post {
            0 => -self.gate_current,
            1 => self.ids + self.gate_current,
            2 => -self.ids,
            _ => 0.0,
        }
    }

    fn voltage_diff(&self) -> f64 {
        // Inherited from the mosfet: plots volts[2] - volts[1]
        // (MosfetElm.java:710).
        self.base.volts[2] - self.base.volts[1]
    }

    fn connects(&self, _a: usize, _b: usize) -> bool {
        // Unlike the mosfet's isolated gate, the JFET gate always connects to
        // the channel through its junction (JfetElm.java:145-147), which is a
        // real DC path.
        true
    }

    /// The gate column stamps into the channel rows, so the gate must share
    /// the channel's closure (MosfetElm.java:716).
    fn matrix_connects(&self, _a: usize, _b: usize) -> bool {
        true
    }

    fn set_param(&mut self, name: &str, value: f64) -> bool {
        match name {
            "beta" if value > 0.0 => self.beta = value,
            // The JFET threshold is the depletion-mode pinch-off voltage, a
            // negative number, so unlike the mosfet's enhancement-only guard
            // any value is accepted.
            "threshold" => self.vt = value,
            // The channel type decides which node is the source, so the UI
            // falls back to a full rebuild rather than patching in place.
            "pnp" => return false,
            _ => return false,
        }
        true
    }

    fn reset(&mut self) {
        self.base.reset();
        self.gate_current = 0.0;
        self.last_v0 = 0.0;
        self.last_v1 = 0.0;
        self.last_v2 = 0.0;
        self.ids = 0.0;
        // Upstream's JfetElm.reset() calls super.reset() then diode.reset()
        // (JfetElm.java:42-45).
        self.gate_diode.reset();
    }

    /// Re-anchors the clamped source/drain move and the gate junction from the
    /// restored node voltages, so a rejected step cannot leave the per-step
    /// state stuck mid-iteration on the retry.
    fn restore_iteration(&mut self) {
        self.last_v0 = self.base.volts[0];
        self.last_v1 = self.base.volts[1];
        self.last_v2 = self.base.volts[2];
        self.wire_gate_diode([self.base.volts[0], self.base.volts[1], self.base.volts[2]]);
        self.gate_diode.restore_iteration();
    }
}
