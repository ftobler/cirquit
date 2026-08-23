//! Ebers-Moll bipolar transistor.

use crate::element::{Base, Element, SimCtx};
use crate::elements::junction::{
    critical_voltage, limit_junction, ramp_gmin, CONVERGENCE_V, GMIN_RAMP_DENOM_TRANSISTOR,
    GMIN_RAMP_START, JUNCTION_GMIN, MAX_EXP_ARG, VT,
};
use crate::spec::ElementSpec;
use crate::stamp::{Stamper, GROUND};

/// Ebers-Moll bipolar transistor.
///
/// Posts are base, collector, emitter, in that order.
pub struct BipolarTransistor {
    base: Base,
    /// `1.0` for NPN, `-1.0` for PNP. Folding the type into a sign keeps one
    /// set of equations for both.
    polarity: f64,
    beta_f: f64,
    beta_r: f64,
    sat_current: f64,
    vcrit: f64,
    last_vbe: f64,
    last_vbc: f64,
    /// Initial collector node voltage, `-lastVbe` from the file. Stored
    /// pre-signed because the seed is an absolute node voltage, not a
    /// polarity-scaled junction voltage.
    seed_c: f64,
    /// Initial emitter node voltage, `-lastVbc` from the file.
    seed_e: f64,
    ic: f64,
    ib: f64,
    /// Consecutive Newton iterations this transistor has not settled within a
    /// single timestep. When it passes the ramp start, this transistor's own
    /// junction conductance ramps up, so one stuck transistor does not drag
    /// the whole circuit into gmin territory (TransistorElm.java:345-349).
    local_subiters: u32,
    /// Consecutive timesteps this transistor ended needing the ramp. After 5
    /// in a row the ramp is given up for this transistor, so a permanently
    /// stuck device stops pretending to converge (TransistorElm.java:707-712).
    bad_iters: u32,
}

impl BipolarTransistor {
    pub fn new(spec: &ElementSpec) -> Self {
        // The file sign is the type: +1 is NPN, -1 is PNP. Any non-negative
        // token (including the legacy 0) reads as NPN, matching upstream's
        // default-model saturation current of 1e-13.
        let sat = spec.param("saturationCurrent", 1e-13).max(1e-22);
        let polarity = if spec.param("pnp", 1.0) < 0.0 {
            -1.0
        } else {
            1.0
        };
        // Upstream restores the lastVbe/lastVbc tokens as the initial junction
        // state, swapped: the token named lastVbe drives the collector node
        // and lastVbc the emitter (TransistorElm.java:63-67). With the seeded
        // node voltages the first do_step computes vbe = p*lastVbc_token and
        // vbc = p*lastVbe_token, so the state below matches what those
        // voltages imply.
        let lastvbe = spec.param("lastVbe", 0.0);
        let lastvbc = spec.param("lastVbc", 0.0);
        Self {
            base: Base::with_posts(3),
            polarity,
            beta_f: spec.param("beta", 100.0).max(1e-3),
            beta_r: spec.param("betaReverse", 1.0).max(1e-3),
            sat_current: sat,
            vcrit: critical_voltage(VT, sat),
            last_vbe: polarity * lastvbc,
            last_vbc: polarity * lastvbe,
            seed_c: -lastvbe,
            seed_e: -lastvbc,
            ic: 0.0,
            ib: 0.0,
            local_subiters: 0,
            bad_iters: 0,
        }
    }
}

impl Element for BipolarTransistor {
    fn kind(&self) -> &'static str {
        "transistor"
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

    fn do_step(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        let (nb, nc, ne) = (self.base.nodes[0], self.base.nodes[1], self.base.nodes[2]);
        let p = self.polarity;
        let mut vbe = p * (self.base.volts[0] - self.base.volts[2]);
        let mut vbc = p * (self.base.volts[0] - self.base.volts[1]);

        if (vbe - self.last_vbe).abs() > CONVERGENCE_V
            || (vbc - self.last_vbc).abs() > CONVERGENCE_V
        {
            s.not_converged();
            self.local_subiters += 1;
        } else {
            self.local_subiters = 0;
        }
        // Once this transistor has been stuck past the ramp start, ramp its
        // junction conductance so it can escape its own limit cycle, up to
        // `GMIN_MAX`, and give the ramp up entirely after 5 bad timesteps in a
        // row (`step_finished`). The denominator is ten times smaller than the
        // diode's, so the transistor ramp climbs faster
        // (TransistorElm.java:352-356).
        let gmin = if self.local_subiters > GMIN_RAMP_START && self.bad_iters < 5 {
            ramp_gmin(self.local_subiters, GMIN_RAMP_DENOM_TRANSISTOR)
        } else {
            JUNCTION_GMIN
        };
        vbe = limit_junction(vbe, self.last_vbe, VT, self.vcrit);
        vbc = limit_junction(vbc, self.last_vbc, VT, self.vcrit);
        self.last_vbe = vbe;
        self.last_vbc = vbc;

        let exp_be = (vbe / VT).min(MAX_EXP_ARG).exp();
        let exp_bc = (vbc / VT).min(MAX_EXP_ARG).exp();
        let fwd = self.sat_current * (exp_be - 1.0);
        let rev = self.sat_current * (exp_bc - 1.0);
        let g_fwd = self.sat_current * exp_be / VT + gmin;
        let g_rev = self.sat_current * exp_bc / VT + gmin;

        let inv_bf = 1.0 / self.beta_f;
        let inv_br = 1.0 / self.beta_r;

        // Terminal currents in device polarity, positive flowing in.
        let ic = fwd - rev * (1.0 + inv_br);
        let ib = fwd * inv_bf + rev * inv_br;
        let ie = -(ic + ib);
        self.ic = p * ic;
        self.ib = p * ib;

        // Jacobian entries.
        let dic_dvbe = g_fwd;
        let dic_dvbc = -g_rev * (1.0 + inv_br);
        let dib_dvbe = g_fwd * inv_bf;
        let dib_dvbc = g_rev * inv_br;
        let die_dvbe = -(dic_dvbe + dib_dvbe);
        let die_dvbc = -(dic_dvbc + dib_dvbc);

        // For terminal X:
        //   p·i_x = d_be·(V(B) − V(E)) + d_bc·(V(B) − V(C)) + const
        // The polarity cancels out of the conductance terms because
        // `vbe = p·(V(B) − V(E))` and the current is scaled by `p` as well;
        // only the constant term keeps the sign.
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

    fn calculate_current(&mut self, _ctx: &SimCtx) {
        // Report collector current as the element's headline figure.
        self.base.current = self.ic;
    }

    /// The pin plots, upstream's `getScopeValue` (TransistorElm.java:582-593).
    /// Voltages read the live terminal volts raw, exactly as upstream returns
    /// them unscaled by polarity; currents are the reported (polarity-scaled)
    /// terminal figures, with ie = -(ic + ib) as in TransistorElm.java:455-457.
    fn scope_value(&self, value: crate::spec::ScopeValue) -> f64 {
        match value {
            crate::spec::ScopeValue::Ib => self.ib,
            crate::spec::ScopeValue::Ic => self.ic,
            crate::spec::ScopeValue::Ie => -self.ic - self.ib,
            crate::spec::ScopeValue::Vbe => self.base.volts[0] - self.base.volts[2],
            crate::spec::ScopeValue::Vbc => self.base.volts[0] - self.base.volts[1],
            crate::spec::ScopeValue::Vce => self.base.volts[1] - self.base.volts[2],
            _ => 0.0,
        }
    }

    /// Upstream's VAL_ id order (TransistorElm.java:582-593): the currents
    /// and junction voltages a scope can plot, which is also the table
    /// `element_scope_values` walks for the info rows.
    fn scope_value_table(&self) -> &'static [crate::spec::ScopeValue] {
        &[
            crate::spec::ScopeValue::Ib,
            crate::spec::ScopeValue::Ic,
            crate::spec::ScopeValue::Ie,
            crate::spec::ScopeValue::Vbe,
            crate::spec::ScopeValue::Vbc,
            crate::spec::ScopeValue::Vce,
        ]
    }

    fn state_tokens(&self) -> Vec<(String, f64)> {
        // The file tokens are node differences, not the internal fields: the
        // constructor swaps and polarity-scales them (`last_vbe = p*lastVbc`,
        // `last_vbc = p*lastVbe`), so the token named lastVbe must be
        // V(base) - V(collector) and lastVbc V(base) - V(emitter) for a
        // rebuild to reproduce the live junction state.
        vec![
            ("lastVbe".into(), self.base.volts[0] - self.base.volts[1]),
            ("lastVbc".into(), self.base.volts[0] - self.base.volts[2]),
        ]
    }

    /// Give-up bookkeeping for the gmin ramp, mirroring
    /// TransistorElm.java:707-712,739: a timestep that needed ramping counts
    /// as a bad one, and five in a row retire the ramp for this transistor.
    /// The per-step count resets so the next timestep starts clean.
    fn step_finished(&mut self, _ctx: &SimCtx) {
        if self.local_subiters > GMIN_RAMP_START {
            self.bad_iters += 1;
        } else {
            self.bad_iters = 0;
        }
        self.local_subiters = 0;
    }

    fn current_into_node(&self, post: usize) -> f64 {
        // Posts are base, collector, emitter; ib, ic and ie are positive into
        // the device, so the node drains each branch current.
        match post {
            0 => -self.ib,
            1 => -self.ic,
            2 => self.ic + self.ib, // -ie
            _ => 0.0,
        }
    }

    fn set_param(&mut self, name: &str, value: f64) -> bool {
        match name {
            "beta" if value > 0.0 => self.beta_f = value,
            "betaReverse" if value > 0.0 => self.beta_r = value,
            _ => return false,
        }
        true
    }

    fn seed_initial_voltages(&mut self, v: &mut [f64]) {
        // Upstream TransistorElm.java:65-67: base 0, collector -lastVbe,
        // emitter -lastVbc. Never overwrite the reference node.
        let nc = self.base.nodes[1];
        let ne = self.base.nodes[2];
        if nc != GROUND {
            v[nc] = self.seed_c;
        }
        if ne != GROUND {
            v[ne] = self.seed_e;
        }
    }

    /// Re-anchors the two junction voltages from the restored node voltages,
    /// with the same polarity scaling `do_step` applies, so a rejected step
    /// cannot leave the Ebers-Moll model chasing a stale anchor.
    fn restore_iteration(&mut self) {
        let p = self.polarity;
        self.last_vbe = p * (self.base.volts[0] - self.base.volts[2]);
        self.last_vbc = p * (self.base.volts[0] - self.base.volts[1]);
    }

    fn reset(&mut self) {
        self.base.reset();
        self.last_vbe = 0.0;
        self.last_vbc = 0.0;
        self.ic = 0.0;
        self.ib = 0.0;
        self.local_subiters = 0;
        self.bad_iters = 0;
    }
}
