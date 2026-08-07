//! Inductor companion model.

use crate::element::{Base, Element, SimCtx};
use crate::spec::ElementSpec;
use crate::stamp::Stamper;

/// Resistance an inductor is modelled with while solving the DC operating
/// point, standing in for a short. The single-solve port cannot integrate
/// upstream's frame of steps, so the exact short finds the steady-state
/// current in one pass and `step_finished` carries it into the transient.
const DC_SHORT: f64 = 1e-6;

/// Companion model for an inductor: `i = (dt/2L)·v + [i_prev + (dt/2L)·v_prev]`.
///
/// A saturation current switches the model to nonlinear: `L_eff = L/(1 +
/// (I/Isat)^2)` (Inductor.java:54-60) makes the companion conductance a
/// function of the running current, so nothing constant is stamped in `stamp`
/// and `do_step` re-stamps the conductance every Newton iteration, exactly as
/// `Inductor.java`'s `stampNonLinear`/`doStep` pair does. `saturationCurrent`
/// of 0 (or negative) means linear, with the fixed companion stamped once.
pub struct Inductor {
    base: Base,
    inductance: f64,
    /// Current at which `L_eff` has halved. 0 disables saturation, so the
    /// element is the plain linear companion. Upstream's "0 = disabled
    /// (linear)" (Inductor.java:31).
    saturation_current: f64,
    initial_current: f64,
    backward_euler: bool,
    geq: f64,
    ieq: f64,
    v_prev: f64,
    i_prev: f64,
}

impl Inductor {
    const FLAG_BACK_EULER: i64 = 2;

    pub fn new(spec: &ElementSpec) -> Self {
        let ic = spec.param("initialCurrent", 0.0);
        Self {
            base: Base::with_posts(2),
            inductance: spec.param("inductance", 1e-3),
            saturation_current: spec.param("saturationCurrent", 0.0),
            initial_current: ic,
            backward_euler: spec.flag(Self::FLAG_BACK_EULER),
            geq: 0.0,
            ieq: 0.0,
            v_prev: 0.0,
            // The saved `current` token is the running state the file was
            // saved with (InductorElm.java:42); restoring it is what lets a
            // loaded circuit continue from its stored current rather than
            // from zero. Without the token the initial current stands in, as
            // upstream's `reset()` does (InductorElm.java:95-99).
            i_prev: spec.param("current", ic),
        }
    }

    /// The current-dependent inductance used by the saturating model
    /// (`calcEffectiveInductance`, Inductor.java:56-60): smooth rolloff to
    /// `L/2` at `|I| = Isat` and `L/10` at `|I| = 3*Isat`.
    fn effective_inductance(&self, i: f64) -> f64 {
        if self.saturation_current <= 0.0 {
            return self.inductance;
        }
        let ratio = i / self.saturation_current;
        self.inductance / (1.0 + ratio * ratio)
    }
}

impl Element for Inductor {
    fn kind(&self) -> &'static str {
        "inductor"
    }
    fn base(&self) -> &Base {
        &self.base
    }
    fn base_mut(&mut self) -> &mut Base {
        &mut self.base
    }
    fn post_count(&self) -> usize {
        2
    }

    fn nonlinear(&self) -> bool {
        // The saturating companion is a function of the current, so the
        // matrix is restored and the conductance re-stamped every Newton
        // iteration (Inductor.java:85).
        self.saturation_current > 0.0
    }

    fn stamp(&mut self, ctx: &SimCtx, s: &mut Stamper) {
        let (n0, n1) = (self.base.nodes[0], self.base.nodes[1]);
        if ctx.dc_analysis {
            self.geq = 1.0 / DC_SHORT;
            s.conductance(n0, n1, self.geq);
            return;
        }
        if self.saturation_current <= 0.0 {
            // Linear: the companion conductance is fixed for the whole run,
            // so it is part of the stamped snapshot (Inductor.java:74-81).
            self.geq = if self.backward_euler {
                ctx.dt / self.inductance
            } else {
                ctx.dt / (2.0 * self.inductance)
            };
            s.conductance(n0, n1, self.geq);
        }
        // Saturating: nothing constant to stamp. The matrix is restored to
        // the snapshot every Newton iteration, so do_step re-stamps the
        // current-dependent conductance there instead (Inductor.java:110-114).
    }

    fn start_iteration(&mut self, ctx: &SimCtx) {
        // The saturating companion depends on the last converged current,
        // which only changes between timesteps, so recompute the conductance
        // once per timestep like `startIteration` (Inductor.java:87-95).
        if ctx.dc_analysis || self.saturation_current <= 0.0 {
            return;
        }
        let l_eff = self.effective_inductance(self.i_prev);
        self.geq = if self.backward_euler {
            ctx.dt / l_eff
        } else {
            ctx.dt / (2.0 * l_eff)
        };
    }

    fn do_step(&mut self, ctx: &SimCtx, s: &mut Stamper) {
        if ctx.dc_analysis {
            return;
        }
        let (n0, n1) = (self.base.nodes[0], self.base.nodes[1]);
        if self.saturation_current > 0.0 {
            s.conductance(n0, n1, self.geq);
        }
        self.ieq = if self.backward_euler {
            self.i_prev
        } else {
            self.i_prev + self.geq * self.v_prev
        };
        // `i = geq·v + ieq`, so the source draws `ieq` from post 0.
        s.current_source(n0, n1, self.ieq);
    }

    fn calculate_current(&mut self, ctx: &SimCtx) {
        let v = self.base.voltage_diff();
        self.base.current = if ctx.dc_analysis {
            v / DC_SHORT
        } else {
            self.geq * v + self.ieq
        };
    }

    fn step_finished(&mut self, _ctx: &SimCtx) {
        // The operating-point step commits too, so an inductor carries the
        // DC steady-state current (`i_prev`, from `calculate_current` above)
        // into the first transient step instead of starting from zero.
        self.v_prev = self.base.voltage_diff();
        self.i_prev = self.base.current;
    }

    /// `saturationCurrent` is deliberately missing: it flips `nonlinear()`,
    /// which is decided once in `allocate`, and the live path only re-stamps.
    /// Falling through to `false` sends the edit down the full-rebuild path,
    /// which re-allocates and re-reads the flag, exactly as `InductorElm`
    /// calls `ind.setup` from a fresh element (InductorElm.java:163).
    fn set_param(&mut self, name: &str, value: f64) -> bool {
        match name {
            "inductance" if value > 0.0 => self.inductance = value,
            "initialCurrent" => self.initial_current = value,
            _ => return false,
        }
        true
    }

    fn reset(&mut self) {
        self.base.reset();
        self.v_prev = 0.0;
        self.i_prev = self.initial_current;
        self.ieq = 0.0;
    }
}
