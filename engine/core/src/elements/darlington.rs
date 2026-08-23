//! Darlington pair (DarlingtonElm.java): two Ebers-Moll bipolar transistors
//! sharing one collector post, with the first transistor's emitter feeding the
//! second's base at an internal node. Upstream builds it as a `CompositeElm`
//! of two `NTransistorElm`s and simulates the composite element by element;
//! this port stamps the two junctions directly, which is the same set of
//! equations without the subcircuit machinery.

use crate::element::{Base, Element, SimCtx};
use crate::elements::junction::{
    critical_voltage, limit_junction, ramp_gmin, CONVERGENCE_V, GMIN_RAMP_DENOM_TRANSISTOR,
    GMIN_RAMP_START, JUNCTION_GMIN, MAX_EXP_ARG, VT,
};
use crate::spec::ElementSpec;
use crate::stamp::Stamper;

/// Darlington pair.
///
/// Posts are base, collector, emitter, in that order; the extra node between
/// Q1's emitter and Q2's base is upstream's internal node 4
/// (DarlingtonElm.java:18-19). Q1 = base(post 0), collector(post 1),
/// emitter(internal); Q2 = base(internal), collector(post 1), emitter(post 2).
pub struct Darlington {
    base: Base,
    /// `1.0` for NPN, `-1.0` for PNP. One sign folds the type into both
    /// transistors (DarlingtonElm.java:16, :24-25).
    polarity: f64,
    beta_f: f64,
    beta_r: f64,
    sat_current: f64,
    vcrit: f64,
    /// Convergence anchors for Q1 (base-to-internal and base-to-collector).
    last_vbe1: f64,
    last_vbc1: f64,
    /// Convergence anchors for Q2 (internal-to-emitter and internal-to-collector).
    last_vbe2: f64,
    last_vbc2: f64,
    /// Total collector current, Q1's and Q2's added, positive into the device.
    ic: f64,
    /// Q1's base current, positive into the device.
    ib: f64,
    /// Q2's emitter current, positive into the device.
    ie2: f64,
    /// Per-junction currents of the internal pair, device polarity, positive
    /// into each transistor's base and collector. `power` reports them over
    /// the raw node volts, so they must be the exact pair `do_step` stamped
    /// with, not a quantity re-derived from the aggregates.
    ib1: f64,
    ic1: f64,
    ib2: f64,
    ic2: f64,
    /// Consecutive Newton iterations the pair has not settled within a single
    /// timestep. Both junctions share one counter and one ramp: they live on
    /// the same internal node, so when one limit-cycles the pair is stuck as a
    /// whole (see `BipolarTransistor`).
    local_subiters: u32,
    /// Consecutive timesteps the pair ended needing the ramp, after five of
    /// which the ramp is given up entirely (`step_finished`).
    bad_iters: u32,
}

impl Darlington {
    pub fn new(spec: &ElementSpec) -> Self {
        // The file sign is the type: +1 is NPN, -1 is PNP, and a non-negative
        // token (including the legacy 0) reads as NPN. Both internal
        // transistors use the default model (beta 100, sat 1e-13), the same
        // values the opaque per-transistor state tokens on a `400` line carry.
        let sat = spec.param("saturationCurrent", 1e-13).max(1e-22);
        let polarity = if spec.param("pnp", 1.0) < 0.0 {
            -1.0
        } else {
            1.0
        };
        Self {
            base: Base::with_posts(3),
            polarity,
            beta_f: spec.param("beta", 100.0).max(1e-3),
            beta_r: spec.param("betaReverse", 1.0).max(1e-3),
            sat_current: sat,
            vcrit: critical_voltage(VT, sat),
            last_vbe1: 0.0,
            last_vbc1: 0.0,
            last_vbe2: 0.0,
            last_vbc2: 0.0,
            ic: 0.0,
            ib: 0.0,
            ie2: 0.0,
            ib1: 0.0,
            ic1: 0.0,
            ib2: 0.0,
            ic2: 0.0,
            local_subiters: 0,
            bad_iters: 0,
        }
    }

    /// Forward-active currents of one Ebers-Moll transistor at `vbe`/`vbc`,
    /// the same `ic`/`ib` split `BipolarTransistor` uses (transistor.rs):
    /// `ic = fwd - rev*(1+1/βr)`, `ib = fwd/βf + rev/βr`.
    fn junction_currents(&self, vbe: f64, vbc: f64) -> (f64, f64) {
        let exp_be = (vbe / VT).min(MAX_EXP_ARG).exp();
        let exp_bc = (vbc / VT).min(MAX_EXP_ARG).exp();
        let fwd = self.sat_current * (exp_be - 1.0);
        let rev = self.sat_current * (exp_bc - 1.0);
        let ic = fwd - rev * (1.0 + 1.0 / self.beta_r);
        let ib = fwd / self.beta_f + rev / self.beta_r;
        (ic, ib)
    }

    /// Stamps one Ebers-Moll transistor between the given base, collector and
    /// emitter nodes, the exact `BipolarTransistor` terminal pattern: for
    /// terminal X, `p·i_x = d_be·(V(B) − V(E)) + d_bc·(V(B) − V(C)) + const`,
    /// with the polarity cancelling out of the conductance terms so only the
    /// constant keeps the sign.
    #[allow(clippy::too_many_arguments)]
    fn stamp_transistor(
        &self,
        s: &mut Stamper,
        p: f64,
        gmin: f64,
        nb: usize,
        nc: usize,
        ne: usize,
        vbe: f64,
        vbc: f64,
        ic: f64,
        ib: f64,
    ) {
        let exp_be = (vbe / VT).min(MAX_EXP_ARG).exp();
        let exp_bc = (vbc / VT).min(MAX_EXP_ARG).exp();
        let g_fwd = self.sat_current * exp_be / VT + gmin;
        let g_rev = self.sat_current * exp_bc / VT + gmin;

        let inv_bf = 1.0 / self.beta_f;
        let inv_br = 1.0 / self.beta_r;
        let dic_dvbe = g_fwd;
        let dic_dvbc = -g_rev * (1.0 + inv_br);
        let dib_dvbe = g_fwd * inv_bf;
        let dib_dvbc = g_rev * inv_br;
        let die_dvbe = -(dic_dvbe + dib_dvbe);
        let die_dvbc = -(dic_dvbc + dib_dvbc);
        let ie = -(ic + ib);

        let mut terminal = |node: usize, d_be: f64, d_bc: f64, i0: f64| {
            s.node_pair(node, nb, d_be + d_bc);
            s.node_pair(node, ne, -d_be);
            s.node_pair(node, nc, -d_bc);
            let constant = p * (i0 - d_be * vbe - d_bc * vbc);
            s.node_rhs(node, -constant);
        };
        terminal(nc, dic_dvbe, dic_dvbc, ic);
        terminal(nb, dib_dvbe, dib_dvbc, ib);
        terminal(ne, die_dvbe, die_dvbc, ie);
    }
}

impl Element for Darlington {
    fn kind(&self) -> &'static str {
        "darlington"
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
    /// The node where Q1's emitter meets Q2's base, invisible to the
    /// TypeScript side, exactly as the composite's `getInternalNodeCount`
    /// (CompositeElm.java:333-335).
    fn internal_node_count(&self) -> usize {
        1
    }
    fn nonlinear(&self) -> bool {
        true
    }

    fn do_step(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        let (nb, nc, ne) = (self.base.nodes[0], self.base.nodes[1], self.base.nodes[2]);
        let nq2b = self.base.nodes[3];
        let p = self.polarity;
        // Q1 spans base to internal, Q2 spans internal to emitter, both share
        // the collector post.
        let mut vbe1 = p * (self.base.volts[0] - self.base.volts[3]);
        let mut vbc1 = p * (self.base.volts[0] - self.base.volts[1]);
        let mut vbe2 = p * (self.base.volts[3] - self.base.volts[2]);
        let mut vbc2 = p * (self.base.volts[3] - self.base.volts[1]);

        if (vbe1 - self.last_vbe1).abs() > CONVERGENCE_V
            || (vbc1 - self.last_vbc1).abs() > CONVERGENCE_V
            || (vbe2 - self.last_vbe2).abs() > CONVERGENCE_V
            || (vbc2 - self.last_vbc2).abs() > CONVERGENCE_V
        {
            s.not_converged();
            self.local_subiters += 1;
        } else {
            self.local_subiters = 0;
        }
        // Both junctions ramp together once the pair is stuck, with the
        // transistor's faster ramp denominator (TransistorElm.java:352-356).
        let gmin = if self.local_subiters > GMIN_RAMP_START && self.bad_iters < 5 {
            ramp_gmin(self.local_subiters, GMIN_RAMP_DENOM_TRANSISTOR)
        } else {
            JUNCTION_GMIN
        };
        vbe1 = limit_junction(vbe1, self.last_vbe1, VT, self.vcrit);
        vbc1 = limit_junction(vbc1, self.last_vbc1, VT, self.vcrit);
        vbe2 = limit_junction(vbe2, self.last_vbe2, VT, self.vcrit);
        vbc2 = limit_junction(vbc2, self.last_vbc2, VT, self.vcrit);
        self.last_vbe1 = vbe1;
        self.last_vbc1 = vbc1;
        self.last_vbe2 = vbe2;
        self.last_vbc2 = vbc2;

        let (ic1, ib1) = self.junction_currents(vbe1, vbc1);
        let (ic2, ib2) = self.junction_currents(vbe2, vbc2);

        self.stamp_transistor(s, p, gmin, nb, nc, nq2b, vbe1, vbc1, ic1, ib1);
        self.stamp_transistor(s, p, gmin, nq2b, nc, ne, vbe2, vbc2, ic2, ib2);

        // Device-polarity currents, positive flowing in. The reported ic is
        // the sum over both collectors, which is the darlington's headline
        // figure (DarlingtonElm.java:119).
        self.ic = p * (ic1 + ic2);
        self.ib = p * ib1;
        self.ie2 = p * -(ic2 + ib2);
        self.ib1 = p * ib1;
        self.ic1 = p * ic1;
        self.ib2 = p * ib2;
        self.ic2 = p * ic2;
    }

    fn calculate_current(&mut self, _ctx: &SimCtx) {
        self.base.current = self.ic;
    }

    /// Upstream's composite getPower: the two internal transistors'
    /// getPower summed (CompositeElm.java:350-355), each the raw junction
    /// volts times its polarity-scaled currents (TransistorElm.java:206-208).
    /// The default `voltage_diff * current` would read (Vb-Vc)*Ic here, which
    /// even has the wrong sign in the active region.
    fn power(&self) -> f64 {
        let v = &self.base.volts;
        (v[0] - v[3]) * self.ib1
            + (v[1] - v[3]) * self.ic1
            + (v[3] - v[2]) * self.ib2
            + (v[1] - v[2]) * self.ic2
    }

    /// The three posts and the internal node, in device polarity: the base
    /// drains Q1's base current, the collector drains both collector currents,
    /// and the emitter returns Q2's emitter current. KCL at the internal node
    /// is not reported; it is a node, not a post.
    fn current_into_node(&self, post: usize) -> f64 {
        match post {
            0 => -self.ib,
            1 => -self.ic,
            2 => -self.ie2,
            _ => 0.0,
        }
    }

    /// Give-up bookkeeping for the gmin ramp, mirroring the transistor's
    /// (TransistorElm.java:707-712,739): a timestep that needed ramping counts
    /// as bad, and five in a row retire the ramp.
    fn step_finished(&mut self, _ctx: &SimCtx) {
        if self.local_subiters > GMIN_RAMP_START {
            self.bad_iters += 1;
        } else {
            self.bad_iters = 0;
        }
        self.local_subiters = 0;
    }

    /// Re-anchors the four junction voltages from the restored node voltages
    /// after a rejected step, so the retry starts where the last committed
    /// step left off, with the same polarity scaling `do_step` applies.
    fn restore_iteration(&mut self) {
        let p = self.polarity;
        self.last_vbe1 = p * (self.base.volts[0] - self.base.volts[3]);
        self.last_vbc1 = p * (self.base.volts[0] - self.base.volts[1]);
        self.last_vbe2 = p * (self.base.volts[3] - self.base.volts[2]);
        self.last_vbc2 = p * (self.base.volts[3] - self.base.volts[1]);
    }

    fn reset(&mut self) {
        self.base.reset();
        self.last_vbe1 = 0.0;
        self.last_vbc1 = 0.0;
        self.last_vbe2 = 0.0;
        self.last_vbc2 = 0.0;
        self.ic = 0.0;
        self.ib = 0.0;
        self.ie2 = 0.0;
        self.ib1 = 0.0;
        self.ic1 = 0.0;
        self.ib2 = 0.0;
        self.ic2 = 0.0;
        self.local_subiters = 0;
        self.bad_iters = 0;
    }
}
