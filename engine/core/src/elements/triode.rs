//! Vacuum-tube triode (TriodeElm.java): a three-post nonlinear device whose
//! plate current follows a 3/2-power law in the grid-cathode and plate-cathode
//! voltages, `ids = pow(vgk + vpk/mu, 1.5) / kg1`. The grid-to-cathode path is
//! a resistor, 6 k once the grid conducts and 1e8 otherwise, so the grid node
//! is never singular; below cutoff the plate current collapses to a 1e-8
//! conductance leak for the same reason. The whole device is one Newton
//! companion in the plate and cathode rows, and the grid column stamps into
//! those rows even though the grid carries no plate current of its own.

use crate::element::{Base, Element, SimCtx};
use crate::elements::junction::CONVERGENCE_V;
use crate::spec::ElementSpec;
use crate::stamp::Stamper;

/// Grid-to-cathode resistance while the grid is forward enough to conduct
/// (TriodeElm.java:30, :183-185).
const GRID_CURRENT_R: f64 = 6000.0;
/// Grid-to-cathode resistance in cutoff, a stub that keeps the grid node from
/// going singular (TriodeElm.java:187).
const GRID_OFF_R: f64 = 1e8;
/// Grid-cathode voltage above which the grid resistor switches to its
/// conducting value (TriodeElm.java:183).
const GRID_CONDUCT_V: f64 = 0.01;
/// Plate conductance below cutoff: the law's `1e-8` floor, which keeps the
/// plate node defined while `ival < 0` (TriodeElm.java:188-192).
const CUTOFF_GDS: f64 = 1e-8;
/// Largest grid or cathode move per Newton iteration, the same anti-divergence
/// role the junction limiting plays elsewhere (TriodeElm.java:161-168).
const MAX_GRID_STEP_V: f64 = 0.5;
/// Default amplification factor `mu` (TriodeElm.java:33).
const DEF_MU: f64 = 93.0;
/// Default plate-current scale `kg1` (TriodeElm.java:34).
const DEF_KG1: f64 = 680.0;

/// Vacuum-tube triode.
///
/// Posts are plate, grid, cathode, in that order, the terminal order
/// upstream's `getPost` exposes (TriodeElm.java:144-146).
pub struct Triode {
    base: Base,
    /// Amplification factor `mu`: how much more effective the grid voltage is
    /// than the plate voltage at moving the plate current.
    mu: f64,
    /// The 3/2-power law's scale `kg1`: `ids = pow(ival, 1.5) / kg1`.
    kg1: f64,
    /// Convergence anchors of the three terminal voltages. The grid and
    /// cathode are clamped to a 0.5 V move per iteration, the plate is not.
    last_v0: f64,
    last_v1: f64,
    last_v2: f64,
    /// Plate current from the last solve, the tube's `ids` (TriodeElm.java:201).
    currentp: f64,
    /// Grid current from the last solve, `vgk / gridCurrentR` when conducting
    /// (TriodeElm.java:202).
    currentg: f64,
    /// Cathode current, plate plus grid, the scope's headline figure
    /// (TriodeElm.java:149, :202).
    currentc: f64,
}

impl Triode {
    pub fn new(spec: &ElementSpec) -> Self {
        Self {
            base: Base::with_posts(3),
            mu: spec.param("mu", DEF_MU),
            kg1: spec.param("kg1", DEF_KG1),
            last_v0: 0.0,
            last_v1: 0.0,
            last_v2: 0.0,
            currentp: 0.0,
            currentg: 0.0,
            currentc: 0.0,
        }
    }

    /// The plate-current law at the given terminal voltages, returning
    /// `(ids, Gds, gm)`: the current and its partial derivatives against `vpk`
    /// and `vgk`. Below cutoff the curve collapses to a leak, not zero, because
    /// a bare zero would leave the plate node singular (TriodeElm.java:188-200).
    fn branch(&self, vgk: f64, vpk: f64) -> (f64, f64, f64) {
        let ival = vgk + vpk / self.mu;
        if ival < 0.0 {
            (vpk * CUTOFF_GDS, CUTOFF_GDS, 0.0)
        } else {
            let ids = ival.powf(1.5) / self.kg1;
            let q = 1.5 * ival.sqrt() / self.kg1;
            (ids, q, q / self.mu)
        }
    }
}

impl Element for Triode {
    fn kind(&self) -> &'static str {
        "triode"
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
        let [v0, v1, v2] = [self.base.volts[0], self.base.volts[1], self.base.volts[2]];
        // The grid and cathode cannot move more than 0.5 V per iteration, so
        // Newton cannot leap the grid across its whole characteristic; the
        // plate is not clamped (TriodeElm.java:161-168).
        let vs0 = v0;
        let vs1 = v1
            .max(self.last_v1 - MAX_GRID_STEP_V)
            .min(self.last_v1 + MAX_GRID_STEP_V);
        let vs2 = v2
            .max(self.last_v2 - MAX_GRID_STEP_V)
            .min(self.last_v2 + MAX_GRID_STEP_V);
        if (vs0 - self.last_v0).abs() > CONVERGENCE_V
            || (vs1 - self.last_v1).abs() > CONVERGENCE_V
            || (vs2 - self.last_v2).abs() > CONVERGENCE_V
        {
            s.not_converged();
        }
        self.last_v0 = vs0;
        self.last_v1 = vs1;
        self.last_v2 = vs2;

        let vgk = vs1 - vs2;
        let vpk = vs0 - vs2;

        // The grid resistor, stamped before the plate companion exactly as
        // upstream's `doStep` does (TriodeElm.java:183-187): 6 k once the grid
        // conducts, else a 1e8 stub so the grid node is never singular.
        let grid_r = if vgk > GRID_CONDUCT_V {
            GRID_CURRENT_R
        } else {
            GRID_OFF_R
        };
        self.currentg = if vgk > GRID_CONDUCT_V {
            vgk / GRID_CURRENT_R
        } else {
            0.0
        };
        s.resistor(self.base.nodes[1], self.base.nodes[2], grid_r);

        let (ids, gds, gm) = self.branch(vgk, vpk);
        self.currentp = ids;
        self.currentc = ids + self.currentg;

        // The plate row reads `Gds*(Vp-Vk) + gm*(Vg-Vk) = ids + rs`, the
        // cathode row the negation, so the companion's Norton source carries
        // the linear intercept (TriodeElm.java:203-213). The grid column is
        // coupled through `gm` even though the grid carries no plate current.
        let (np, ng, nk) = (self.base.nodes[0], self.base.nodes[1], self.base.nodes[2]);
        let rs = -ids + gds * vpk + gm * vgk;
        s.node_pair(np, np, gds);
        s.node_pair(np, nk, -gds - gm);
        s.node_pair(np, ng, gm);
        s.node_pair(nk, np, -gds);
        s.node_pair(nk, nk, gds + gm);
        s.node_pair(nk, ng, -gm);
        s.node_rhs(np, rs);
        s.node_rhs(nk, -rs);
    }

    fn calculate_current(&mut self, _ctx: &SimCtx) {
        // Recomputed from the solved, unclamped voltages, matching upstream's
        // currents on the last converged iteration (TriodeElm.java:201-202).
        let vgk = self.base.volts[1] - self.base.volts[2];
        let vpk = self.base.volts[0] - self.base.volts[2];
        let (ids, _, _) = self.branch(vgk, vpk);
        let currentg = if vgk > GRID_CONDUCT_V {
            vgk / GRID_CURRENT_R
        } else {
            0.0
        };
        self.currentp = ids;
        self.currentg = currentg;
        self.currentc = ids + currentg;
        // The scope reports the cathode current (TriodeElm.java:149).
        self.base.current = self.currentc;
    }

    /// Upstream reports each terminal's current into the device
    /// (TriodeElm.java:136-142): the plate and grid read negative because
    /// their currents flow out of the element, the cathode is the sink.
    fn current_into_node(&self, post: usize) -> f64 {
        match post {
            0 => -self.currentp,
            1 => -self.currentg,
            2 => self.currentc,
            _ => 0.0,
        }
    }

    /// The grid is isolated from the other two terminals as far as the wire
    /// connection model is concerned, so a grid-only net is never merged with
    /// the plate or cathode nets (TriodeElm.java:233).
    fn connects(&self, a: usize, b: usize) -> bool {
        a != 1 && b != 1
    }

    /// But the grid column stamps into the plate and cathode rows, so the grid
    /// must share their matrix closure (TriodeElm.java:234).
    fn matrix_connects(&self, _a: usize, _b: usize) -> bool {
        true
    }

    fn voltage_diff(&self) -> f64 {
        // The scope plots plate to cathode (TriodeElm.java:249).
        self.base.volts[0] - self.base.volts[2]
    }

    fn power(&self) -> f64 {
        // Both branches dissipate: the plate path and the grid path
        // (TriodeElm.java:148).
        let v = &self.base.volts;
        (v[0] - v[2]) * self.currentc + (v[1] - v[2]) * self.currentg
    }

    fn set_param(&mut self, name: &str, value: f64) -> bool {
        match name {
            "mu" if value > 0.0 => self.mu = value,
            "kg1" if value > 0.0 => self.kg1 = value,
            _ => return false,
        }
        true
    }

    /// Re-anchors the three convergence anchors from the restored node
    /// voltages after a rejected step, so the retry starts where the last
    /// committed step left off.
    fn restore_iteration(&mut self) {
        self.last_v0 = self.base.volts[0];
        self.last_v1 = self.base.volts[1];
        self.last_v2 = self.base.volts[2];
    }

    fn reset(&mut self) {
        self.base.reset();
        self.last_v0 = 0.0;
        self.last_v1 = 0.0;
        self.last_v2 = 0.0;
        self.currentp = 0.0;
        self.currentg = 0.0;
        self.currentc = 0.0;
    }
}
