//! A fuse: an ideal resistor until it blows.

use crate::element::{two_terminal_current, Base, Element, SimCtx};
use crate::spec::ElementSpec;
use crate::stamp::Stamper;

/// A fuse: an ideal resistor until it blows, then a large but finite resistor
/// for the rest of the run. FuseElm.java tracks a leaky I²t integrator rather
/// than a simple instantaneous current limit: `heat` accumulates `i²·dt` each
/// timestep and bleeds off at a fixed rate, on the assumption the fuse can
/// dissipate its whole rating in three seconds (FuseElm.java:150-163). Once
/// `heat` exceeds `i2t` the fuse is permanently blown; [`Element::reset`]
/// (the Run/Reset button) clears it and `reanalyze()` leaves it alone,
/// matching upstream's `reset()` (FuseElm.java:71-75) versus its
/// `startIteration()`. Like capacitor `voltDiff`/inductor `current`, a full
/// circuit rebuild from TS state also resets it, since that state never
/// round-trips back out of the engine.
pub struct Fuse {
    base: Base,
    resistance: f64,
    i2t: f64,
    heat: f64,
    blown: bool,
}

impl Fuse {
    /// FuseElm.java's no-args constructor, sourced from a Littelfuse 218-series
    /// datasheet (FuseElm.java:34-39).
    const DEFAULT_RESISTANCE: f64 = 0.0613;
    const DEFAULT_I2T: f64 = 6.73;
    /// Resistance substituted for a blown fuse: large enough to read as open,
    /// finite so the matrix never goes singular (FuseElm.java:33).
    const BLOWN_RESISTANCE: f64 = 1e9;
    /// Upstream assumes the fuse can dissipate its entire I²t rating in three
    /// seconds (FuseElm.java:156).
    const COOLING_SECONDS: f64 = 3.0;

    pub fn new(spec: &ElementSpec) -> Self {
        Self {
            base: Base::with_posts(2),
            resistance: spec.param("resistance", Self::DEFAULT_RESISTANCE),
            i2t: spec.param("i2t", Self::DEFAULT_I2T),
            heat: spec.param("heat", 0.0),
            blown: spec.param("blown", 0.0) != 0.0,
        }
    }

    fn effective_resistance(&self) -> f64 {
        if self.blown {
            Self::BLOWN_RESISTANCE
        } else {
            self.resistance
        }
    }
}

impl Element for Fuse {
    fn kind(&self) -> &'static str {
        "fuse"
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

    /// Blowing swaps the resistor stamped into the matrix from one timestep
    /// to the next, which needs a full refactor rather than an RHS-only
    /// update — the same reason a diode junction is nonlinear — even though
    /// nothing changes across a single timestep's own Newton iterations
    /// (FuseElm.java:149).
    fn nonlinear(&self) -> bool {
        true
    }

    /// Heat accumulates from the *previous* timestep's current once per
    /// timestep, before Newton begins. This mirrors upstream exactly:
    /// `startIteration()` runs once per timestep outside the subiteration
    /// loop (SimulationManager.java:1324-1328), so the `blown` decision it
    /// makes is fixed for every Newton iteration of this timestep, and
    /// `do_step` below never needs to re-check it.
    fn start_iteration(&mut self, ctx: &SimCtx) {
        let i = self.base.current;
        self.heat += i * i * ctx.dt;
        self.heat -= ctx.dt * self.i2t / Self::COOLING_SECONDS;
        if self.heat < 0.0 {
            self.heat = 0.0;
        }
        if self.heat > self.i2t {
            self.blown = true;
        }
    }

    fn do_step(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        s.resistor(
            self.base.nodes[0],
            self.base.nodes[1],
            self.effective_resistance(),
        );
    }

    fn calculate_current(&mut self, _ctx: &SimCtx) {
        self.base.current = two_terminal_current(&self.base, self.effective_resistance());
    }

    fn set_param(&mut self, name: &str, value: f64) -> bool {
        match name {
            "resistance" if value > 0.0 => self.resistance = value,
            "i2t" if value > 0.0 => self.i2t = value,
            _ => return false,
        }
        true
    }

    /// The store confirms a pop (or an engine reset's un-pop) back into the
    /// model so its `blown` copy and the serialized token never diverge on a
    /// rebuild, exactly as a switch position lands through this same hook.
    /// Blowing is still driven by heat; this only lets the frontend's
    /// persisted value ride in.
    fn set_state(&mut self, state: i32) -> bool {
        self.blown = state != 0;
        true
    }

    /// Melt fraction `heat / i2t`: below 1 the filament is intact and warming,
    /// at or above 1 it is blown. Once blown the number is clamped to stay at
    /// least 1 even as the heat bleeds off (cooling keeps running after the
    /// open), or a popped fuse would redraw its body a few seconds later.
    fn display_state(&self) -> f64 {
        let fraction = self.heat / self.i2t;
        if self.blown {
            fraction.max(1.0)
        } else {
            fraction
        }
    }

    fn state_tokens(&self) -> Vec<(String, f64)> {
        vec![
            ("heat".into(), self.heat),
            ("blown".into(), if self.blown { 1.0 } else { 0.0 }),
        ]
    }

    fn reset(&mut self) {
        self.base.reset();
        self.heat = 0.0;
        self.blown = false;
    }
}
