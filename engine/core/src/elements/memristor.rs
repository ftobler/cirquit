//! A memristor: a charge-controlled resistor.

use crate::element::{two_terminal_current, Base, Element, SimCtx};
use crate::spec::ElementSpec;
use crate::stamp::Stamper;

/// A memristor, the fourth of Chua's basic circuit elements: a two-terminal
/// resistor whose value is set by the charge that has flowed through it.
/// The doped region's width `dope_width` integrates the device current every
/// timestep (MemristorElm.java:119-127), and the resistance is the linear
/// blend of `r_on` and `r_off` across the `dope_width`/`total_width` ratio.
/// Like the lamp, the resistance for a step is fixed before Newton begins
/// (there is nothing to linearise within a timestep) and only changes from
/// one timestep to the next, which needs a full refactor rather than an
/// RHS-only update: `nonlinear()` returns `true` for exactly the reason the
/// lamp's doc comment explains, and, like the lamp and fuse, there is no
/// `stamp()` override, because upstream's `stamp()` only calls
/// `sim.stampNonLinear(...)`, which feeds the matrix-simplification pass this
/// port does not implement (see OVERVIEW.md's deliberate gaps).
pub struct Memristor {
    base: Base,
    /// On-state (fully doped) resistance, ohms (MemristorElm.java:31).
    r_on: f64,
    /// Off-state (undoped) resistance, ohms (MemristorElm.java:32, `160*r_on`).
    r_off: f64,
    /// Width of the doped region, meters (MemristorElm.java:33).
    dope_width: f64,
    /// Total oxide width, meters (MemristorElm.java:34, default `10e-9`).
    total_width: f64,
    /// Dopant mobility, m^2/(s*V) (MemristorElm.java:35, default `1e-10`).
    mobility: f64,
    /// Resistance computed from `dope_width` at the start of this timestep
    /// (MemristorElm.java's `resistance` field), used both to stamp and to
    /// report current.
    resistance: f64,
}

impl Memristor {
    /// MemristorElm.java:31-35's no-args constructor defaults.
    const DEFAULT_R_ON: f64 = 100.0;
    const DEFAULT_R_OFF: f64 = 16000.0;
    const DEFAULT_DOPE_WIDTH: f64 = 0.0;
    const DEFAULT_TOTAL_WIDTH: f64 = 10e-9;
    const DEFAULT_MOBILITY: f64 = 1e-10;

    pub fn new(spec: &ElementSpec) -> Self {
        let mut m = Self {
            base: Base::with_posts(2),
            r_on: spec.param("r_on", Self::DEFAULT_R_ON),
            r_off: spec.param("r_off", Self::DEFAULT_R_OFF),
            dope_width: spec.param("dopeWidth", Self::DEFAULT_DOPE_WIDTH),
            total_width: spec.param("totalWidth", Self::DEFAULT_TOTAL_WIDTH),
            mobility: spec.param("mobility", Self::DEFAULT_MOBILITY),
            resistance: 0.0,
        };
        m.recompute();
        m
    }

    /// The resistance blend for the current state, MemristorElm.java:126:
    /// `r_on * (dope_width/total_width) + r_off * (1 - dope_width/total_width)`.
    fn recompute(&mut self) {
        let wd = self.dope_width / self.total_width;
        self.resistance = self.r_on * wd + self.r_off * (1.0 - wd);
    }
}

impl Element for Memristor {
    fn kind(&self) -> &'static str {
        "memristor"
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
        true
    }

    /// Mirrors `startIteration()` (MemristorElm.java:119-127) exactly: the
    /// resistance for this step is the blend of the `dope_width` as it stood
    /// at the end of the previous step (`wd` is captured *before* the
    /// advance), then `dope_width` integrates
    /// `dt * mobility * r_on * current / total_width` using the previous
    /// converged current (`base.current`), clamped to [0, `total_width`].
    /// The order matters, the same way the lamp's does: swapping it would
    /// make the stamped resistance react to the charge a step early.
    /// The clamp is upstream's *only* boundary confinement: `MemristorElm`
    /// has no window function (no Biolek/Joglekar term). A windowed dopant
    /// drift would diverge from upstream and must not be added here.
    fn start_iteration(&mut self, ctx: &SimCtx) {
        let wd = self.dope_width / self.total_width;
        self.dope_width +=
            ctx.dt * self.mobility * self.r_on * self.base.current / self.total_width;
        if self.dope_width < 0.0 {
            self.dope_width = 0.0;
        }
        if self.dope_width > self.total_width {
            self.dope_width = self.total_width;
        }
        self.resistance = self.r_on * wd + self.r_off * (1.0 - wd);
    }

    fn do_step(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        s.resistor(self.base.nodes[0], self.base.nodes[1], self.resistance);
    }

    fn calculate_current(&mut self, _ctx: &SimCtx) {
        self.base.current = two_terminal_current(&self.base, self.resistance);
    }

    fn state_tokens(&self) -> Vec<(String, f64)> {
        vec![("dopeWidth".into(), self.dope_width)]
    }

    /// The live dopant ratio `dope_width/total_width`, surfaced over the same
    /// per-element channel the lamp, fuse and motor use so the frontend can
    /// render the device's instantaneous state without round-tripping params.
    fn display_state(&self) -> f64 {
        self.dope_width / self.total_width
    }

    fn set_param(&mut self, name: &str, value: f64) -> bool {
        match name {
            "r_on" if value > 0.0 => self.r_on = value,
            "r_off" if value > 0.0 => self.r_off = value,
            "dopeWidth" => self.dope_width = value,
            "totalWidth" if value > 0.0 => self.total_width = value,
            "mobility" => self.mobility = value,
            _ => return false,
        }
        self.recompute();
        true
    }

    /// Matches `reset()` (MemristorElm.java:116-118): back to an undoped
    /// device. `base.reset()` already zeroes current and volts, so the next
    /// `start_iteration` integrates from zero movement; the fully-off blend
    /// is `r_off`.
    fn reset(&mut self) {
        self.base.reset();
        self.dope_width = 0.0;
        self.resistance = self.r_off;
    }
}
