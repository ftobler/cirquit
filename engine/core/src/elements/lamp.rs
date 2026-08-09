//! An incandescent lamp.

use crate::element::{two_terminal_current, Base, Element, SimCtx};
use crate::spec::ElementSpec;
use crate::stamp::Stamper;

/// An incandescent lamp: a resistor whose value is a function of filament
/// temperature, which itself evolves each timestep from the power dissipated
/// the step before, with independent warm-up and cool-down thermal masses
/// (LampElm.java). Like the fuse, this is a state-dependent resistor rather
/// than a junction device: there is nothing to linearise *within* a
/// timestep (the resistance for the step is fixed before Newton begins), but
/// the value can change from one timestep to the next, which needs a full
/// refactor rather than an RHS-only update. `nonlinear()` returns `true` for
/// that reason, exactly as Fuse's doc comment explains, and — like Fuse —
/// there is no `stamp()` override: upstream's `stamp()` only calls
/// `sim.stampNonLinear(...)`, which feeds the matrix-simplification pass
/// this port does not implement (see OVERVIEW.md's deliberate gaps), so
/// there is nothing to port there.
pub struct Lamp {
    base: Base,
    /// Filament temperature, kelvin (LampElm.java:29-30, `roomTemp`/`temp`).
    temp: f64,
    /// Rated power at `nom_v`, in watts (LampElm.java:34's default of 100).
    nom_pow: f64,
    /// Rated operating voltage, in volts (LampElm.java:35's default of 120).
    nom_v: f64,
    /// Thermal warm-up and cool-down time constants, in seconds, each
    /// normalised against upstream's baseline of 0.4 s (LampElm.java:36-37,
    /// :177-178).
    warm_time: f64,
    cool_time: f64,
    /// Resistance computed from `temp` at the start of this timestep
    /// (LampElm.java's `resistance` field), used both to stamp and to report
    /// current.
    resistance: f64,
}

impl Lamp {
    /// LampElm.java:29.
    const ROOM_TEMP: f64 = 300.0;
    /// LampElm.java:34-37's no-args constructor defaults.
    const DEFAULT_NOM_POW: f64 = 100.0;
    const DEFAULT_NOM_V: f64 = 120.0;
    const DEFAULT_WARM_TIME: f64 = 0.4;
    const DEFAULT_COOL_TIME: f64 = 0.4;
    /// The resistance-temperature curve below is only valid up to here
    /// (LampElm.java:171-172).
    const MAX_CURVE_TEMP: f64 = 5390.0;

    pub fn new(spec: &ElementSpec) -> Self {
        // The token constructor falls back to room temperature when the
        // saved token is NaN (LampElm.java:44-45); the TypeScript loader
        // already drops non-finite tokens before they reach `params`, so
        // `spec.param`'s own default covers the same case here.
        let mut lamp = Self {
            base: Base::with_posts(2),
            temp: spec.param("temp", Self::ROOM_TEMP),
            nom_pow: spec.param("nomPower", Self::DEFAULT_NOM_POW),
            nom_v: spec.param("nomVoltage", Self::DEFAULT_NOM_V),
            warm_time: spec.param("warmTime", Self::DEFAULT_WARM_TIME),
            cool_time: spec.param("coolTime", Self::DEFAULT_COOL_TIME),
            resistance: 0.0,
        };
        lamp.resistance = lamp.resistance_from_temp();
        lamp
    }

    /// Resistance-vs-temperature curve, cited upstream to
    /// http://www.intusoft.com/nlpdf/nl11.pdf (LampElm.java:169-175):
    /// `nom_r` is the resistance a plain resistor of the same rated power and
    /// voltage would have, and the polynomial in `tp` scales it from roughly
    /// 1/20th of `nom_r` at room temperature up toward `nom_r` itself near
    /// the filament's rated operating temperature.
    fn resistance_from_temp(&self) -> f64 {
        let nom_r = self.nom_v * self.nom_v / self.nom_pow;
        let tp = self.temp.min(Self::MAX_CURVE_TEMP);
        nom_r * (1.26104 - 4.90662 * (17.1839 / tp - 0.00318794).sqrt() - 7.8569 / (tp - 187.56))
    }
}

impl Element for Lamp {
    fn kind(&self) -> &'static str {
        "lamp"
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

    /// Mirrors `startIteration()` (LampElm.java:168-184) exactly: first
    /// compute this step's resistance from `temp` as it stood at the end of
    /// the previous step, *then* advance `temp` using the power dissipated
    /// over that previous step (`base.voltage_diff() * base.current`, both
    /// still holding the last converged solve — `getPower()` is
    /// `CircuitElm.java:1269`). The order matters: swapping it would make
    /// the stamped resistance react to power a step early.
    fn start_iteration(&mut self, ctx: &SimCtx) {
        self.resistance = self.resistance_from_temp();

        // Thermal mass scales with rated power; warm-up and cool-down carry
        // independent time constants (LampElm.java:176-178).
        let cap = 1.57e-4 * self.nom_pow;
        let capw = cap * self.warm_time / 0.4;
        let capc = cap * self.cool_time / 0.4;

        let power = self.base.voltage_diff() * self.base.current;
        self.temp += power * ctx.dt / capw;
        let cr = 2600.0 / self.nom_pow;
        self.temp -= ctx.dt * (self.temp - Self::ROOM_TEMP) / (capc * cr);
    }

    fn do_step(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        s.resistor(self.base.nodes[0], self.base.nodes[1], self.resistance);
    }

    fn calculate_current(&mut self, _ctx: &SimCtx) {
        self.base.current = two_terminal_current(&self.base, self.resistance);
    }

    fn set_param(&mut self, name: &str, value: f64) -> bool {
        // Matches setEditValue's `ei.value > 0` guard on all four fields
        // (LampElm.java:207-215).
        match name {
            "nomPower" if value > 0.0 => self.nom_pow = value,
            "nomVoltage" if value > 0.0 => self.nom_v = value,
            "warmTime" if value > 0.0 => self.warm_time = value,
            "coolTime" if value > 0.0 => self.cool_time = value,
            _ => return false,
        }
        true
    }

    /// Matches `reset()` (LampElm.java:79-84): back to room temperature,
    /// then recompute resistance. `base.reset()` already zeroes current and
    /// volts, so the power term above is moot here; no need to duplicate
    /// `start_iteration`'s temp-update math for a state that isn't moving.
    fn reset(&mut self) {
        self.base.reset();
        self.temp = Self::ROOM_TEMP;
        self.resistance = self.resistance_from_temp();
    }

    /// Filament temperature in kelvin, the number the draw maps through the
    /// four-band temperature ramp (LampElm.java:101-121) so the bulb glows.
    fn display_state(&self) -> f64 {
        self.temp
    }
}
