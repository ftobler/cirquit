//! Quadratic MOSFET model with a body diode.

use std::collections::HashMap;

use crate::element::{Base, Element, SimCtx};
use crate::elements::diode::Diode;
use crate::elements::junction::convergence_ladder;
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

/// Quadratic MOSFET, upstream's default model: `vt = 1.5`, `beta = 0.02`,
/// `lambda = 0`, no gate caps, body diode simulated and tied to one of the
/// channel terminals.
///
/// Posts are gate, source and drain for an N-channel; the P-channel swaps the
/// source/drain *labels*, but the engine never needs to know which physical
/// post is which: it picks the source as the lower-voltage terminal for an
/// N-channel and the higher-voltage one for a P-channel, so `vds >= 0` in the
/// device frame, exactly like upstream (MosfetElm.java:588).
pub struct Mosfet {
    base: Base,
    /// `1.0` for an N-channel, `-1.0` for a P-channel. Folding the type into a
    /// sign keeps one set of equations for both, like the BJT's `polarity`.
    polarity: f64,
    /// Threshold voltage `vt`, in volts.
    vt: f64,
    /// Transconductance parameter `beta`, in A/V^2.
    beta: f64,
    /// The body diode, anode at post 1 and cathode at post 2 for both channel
    /// types, matching upstream's `diodeB1.stamp(nodes[1], nodes[2])`
    /// (MosfetElm.java:504-515). Post 1 is the source post for an N-channel
    /// and the drain post for a P-channel, so the diode blocks while the
    /// channel conducts in the normal direction and conducts when that
    /// terminal is raised above the other, which is exactly the parasitic
    /// body diode. One diode suffices because the body is tied to one of the
    /// channel terminals, so only one junction can ever be forward biased;
    /// the other junction is shorted by the tie.
    diode: Diode,
    /// Current through the body diode, positive anode to cathode, for the
    /// per-node current report.
    diode_current: f64,
    /// Limited source/drain voltages from the previous iteration, feeding the
    /// per-iteration clamp and the convergence report.
    last_v0: f64,
    last_v1: f64,
    last_v2: f64,
    /// Reported drain-source current, folded back through the swap
    /// (MosfetElm.java:642-644).
    ids: f64,
}

impl Mosfet {
    pub fn new(spec: &ElementSpec) -> Self {
        // The file sign is the type: +1 is N-channel, -1 is P-channel, and any
        // non-negative token (including the absent one) reads as N
        // (MosfetElm.java:91). The body diode is upstream's default model too.
        let diode = Diode::new(&ElementSpec {
            id: 0,
            kind: "diode".into(),
            posts: Vec::new(),
            params: HashMap::new(),
            label: None,
            model: None,
            flags: 0,
        });
        Self {
            base: Base::with_posts(3),
            polarity: if spec.param("pnp", 1.0) < 0.0 {
                -1.0
            } else {
                1.0
            },
            vt: spec.param("threshold", 1.5),
            beta: spec.param("beta", 0.02).max(1e-6),
            diode,
            diode_current: 0.0,
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

    /// Points the embedded body `Diode` at its posts and the current terminal
    /// voltages, so its own `do_step`, `calculate_current` and
    /// `restore_iteration` read the right nodes. The diode's `Base` is
    /// invisible to the circuit, so it must be re-pointed on every call,
    /// exactly like the JFET's gate diode. No joint mosfet/jfet helper fits:
    /// the JFET picks its orientation through polarity logic
    /// (jfet.rs `gate_diode_posts`), while this body diode is fixed at posts
    /// (1, 2) for both channel types.
    fn wire_body_diode(&mut self) {
        // Anode at post 1, cathode at post 2, identical for both channel
        // types (MosfetElm.java:504-515).
        let d = self.diode.base_mut();
        d.nodes[0] = self.base.nodes[1];
        d.nodes[1] = self.base.nodes[2];
        d.volts[0] = self.base.volts[1];
        d.volts[1] = self.base.volts[2];
    }

    /// Stamps the body diode between its anode and cathode posts, using the
    /// mosfet's own node assignments and the current node voltages.
    fn stamp_body_diode(&mut self, ctx: &SimCtx, s: &mut Stamper) {
        self.wire_body_diode();
        self.diode.do_step(ctx, s);
    }
}

impl Element for Mosfet {
    fn kind(&self) -> &'static str {
        "mosfet"
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

        // The convergence row compares the clamped values against lastv
        // through the shared ladder (MosfetElm.java:595).
        if convergence_ladder(self.beta, ctx.subiter, self.last_v1, sv1)
            || convergence_ladder(self.beta, ctx.subiter, self.last_v2, sv2)
            || convergence_ladder(self.beta, ctx.subiter, self.last_v0, vg)
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

        // The 3x3 drain/source/gate pattern and its right-hand side
        // (MosfetElm.java:649-659). Each channel row holds
        // `Gds*(Vd-Vs) + gm*(Vg-Vs)`, and `rs` supplies the constant part so
        // the physical channel current `p*ids0` leaves the drain.
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

        self.stamp_body_diode(ctx, s);
    }

    fn calculate_current(&mut self, ctx: &SimCtx) {
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

        // The body diode's own current at the solved voltages, for the
        // per-node report.
        self.wire_body_diode();
        self.diode.calculate_current(ctx);
        self.diode_current = self.diode.base().current;
    }

    fn current_into_node(&self, post: usize) -> f64 {
        // `ids` flows from drain to source; the body diode always conducts
        // post 1 to post 2 (MosfetElm.java:800-820), so node 1 receives
        // `-diode_current` and node 2 `+diode_current`. The gate carries
        // nothing without gate caps.
        let d1 = -self.diode_current;
        match post {
            0 => 0.0,
            1 => self.ids + d1,
            2 => -self.ids - d1,
            _ => 0.0,
        }
    }

    fn voltage_diff(&self) -> f64 {
        // Upstream's MOSFET plots volts[2] - volts[1] (MosfetElm.java:710).
        self.base.volts[2] - self.base.volts[1]
    }

    fn connects(&self, a: usize, b: usize) -> bool {
        // The gate is isolated from the channel without gate caps
        // (MosfetElm.java:711-715), so a gate-only circuit reads as floating
        // instead of pinning the gate onto the source/drain.
        a != 0 && b != 0
    }

    /// The gate column stamps into the channel rows, so the gate must share
    /// the channel's closure (MosfetElm.java:716).
    fn matrix_connects(&self, _a: usize, _b: usize) -> bool {
        true
    }

    fn set_param(&mut self, name: &str, value: f64) -> bool {
        match name {
            "beta" if value > 0.0 => self.beta = value,
            "threshold" if value > 0.0 => self.vt = value,
            // The channel type decides which node is the source, so the UI
            // falls back to a full rebuild rather than patching in place.
            "pnp" => return false,
            _ => return false,
        }
        true
    }

    fn reset(&mut self) {
        self.base.reset();
        self.diode_current = 0.0;
        self.last_v0 = 0.0;
        self.last_v1 = 0.0;
        self.last_v2 = 0.0;
        self.ids = 0.0;
        self.diode.reset();
    }

    /// Re-anchors the clamped source/drain move and the body diode from the
    /// restored node voltages, so a rejected step cannot leave the per-step
    /// state stuck mid-iteration on the retry. Mirrors the JFET's identical
    /// treatment of its gate diode (jfet.rs `restore_iteration`): without it
    /// the retry's first stamp compares against the failed attempt's final
    /// junction iterate, one spurious `not_converged` past the 10 mV bar plus
    /// one mislimiting step.
    fn restore_iteration(&mut self) {
        self.last_v0 = self.base.volts[0];
        self.last_v1 = self.base.volts[1];
        self.last_v2 = self.base.volts[2];
        self.wire_body_diode();
        self.diode.restore_iteration();
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::closure::Closure;
    use crate::matrix::Solver;
    use crate::spec::SolverType;

    fn spec() -> ElementSpec {
        ElementSpec {
            id: 1,
            kind: "mosfet".into(),
            posts: Vec::new(),
            params: HashMap::from([("pnp".to_string(), 1.0)]),
            label: None,
            model: None,
            flags: 0,
        }
    }

    /// A minimal one-closure rig, the shape stamp.rs's own tests use: nodes 1
    /// and 2 carry the channel terminals, node 0 is ground.
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
            Self {
                closures: vec![Closure {
                    node_rows: vec![1, 2],
                    vs_rows: Vec::new(),
                    sys,
                    nonlinear: true,
                    simplified: None,
                }],
                node_closure: vec![0, 0, 0],
                node_row: vec![0, 0, 1],
                vs_closure: Vec::new(),
                vs_row: Vec::new(),
                element_closure: vec![0],
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
    fn restore_iteration_reanchors_the_body_diode() {
        // After a rejected step, restore_committed rewinds base.volts but the
        // embedded body diode keeps whatever junction voltage the FAILED
        // attempt's last iteration wrote into its anchor (Diode.java:142-145).
        // The JFET re-derives its identical gate diode on restore; the MOSFET
        // must do the same for its body diode, or the retry burns a spurious
        // not_converged plus a mislimiting step before catching up.
        let mut q = Mosfet::new(&spec());
        q.base.nodes = vec![0, 1, 2];
        let ctx = SimCtx::default();

        // A failed attempt leaves distant terminal volts and an anchor to
        // match: do_step at 5 V across posts (1, 2) writes its limited
        // iterate into the diode's anchor.
        q.base.volts = vec![0.0, 5.0, 0.0];
        let mut rig = Rig::new();
        {
            let mut s = rig.stamper();
            s.set_current(0);
            q.do_step(&ctx, &mut s);
        }
        assert!(
            q.diode.junction_anchor().abs() > 1e-3,
            "do_step must have moved the anchor, got {}",
            q.diode.junction_anchor()
        );

        // restore_committed rewinds the solution vector and write_back fills
        // base.volts with the committed values, all zero here.
        q.base.volts = vec![0.0, 0.0, 0.0];
        q.restore_iteration();
        assert_eq!(
            q.diode.junction_anchor(),
            q.base.volts[1] - q.base.volts[2],
            "the diode anchor must be re-derived from the restored volts"
        );

        // Behaviourally: at unchanged volts the next do_step reports settled.
        // With a stale anchor it would trip the 10 mV convergence bar and
        // cost the retry an extra iteration plus a mislimited stamp.
        let mut s = rig.stamper();
        s.set_current(0);
        q.do_step(&ctx, &mut s);
        assert!(
            s.converged,
            "a re-anchored body diode must not flag not_converged at unchanged volts"
        );
    }
}
