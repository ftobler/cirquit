//! An NTC thermistor.

use crate::element::{two_terminal_current, Base, Element, SimCtx};
use crate::spec::ElementSpec;
use crate::stamp::Stamper;

/// An NTC thermistor. Upstream's file is `ThermistorNTCElm.java` — the class
/// name inside the file, despite this port's own `thermistor` kind and the
/// task that asked for it both saying "ThermistorElm". Unlike Fuse/Lamp,
/// there is no self-heating: `temperature` is derived purely from a slider
/// `position` in `[0, 1]` interpolated between two edited endpoints
/// (`minTempr`, `maxTempr`), the same way `PotElm.java`'s wiper `position`
/// sets its two resistances — this port has no slider widget yet (see
/// OVERVIEW.md's "Sliders (`38` lines)" gap), so `position` is exposed as a
/// directly-editable field instead, exactly as this port's `Potentiometer`
/// already does for its own wiper.
///
/// `stamp()` (ThermistorNTCElm.java:185-189) recomputes `temperature` from
/// `position` and `resistance` from `temperature` on every call — nothing
/// here depends on current or dissipated power, and nothing evolves between
/// timesteps. That is the same shape as `PotElm.java`'s `stamp()`
/// recomputing its two resistances from `position` every call, so this is a
/// plain resistor whose value only changes on edit: no `nonlinear()`
/// override, no `do_step`/`start_iteration`, matching `Potentiometer` rather
/// than `Fuse`/`Lamp`.
pub struct Thermistor {
    base: Base,
    /// Resistance at 25 C and 50 C, the two calibration points a datasheet
    /// gives (ThermistorNTCElm.java:28, defaults at :44-45: a Vishay
    /// NTCLE100E3010).
    r25: f64,
    r50: f64,
    /// Celsius range the `position` slider spans (ThermistorNTCElm.java:26,
    /// defaults at :42-43).
    min_tempr: f64,
    max_tempr: f64,
    /// Slider position in `[0, 1]`-ish (upstream's actual slider only
    /// reaches 0.005-0.995); default is 25 C on the -40..150 range
    /// (ThermistorNTCElm.java:46).
    position: f64,
    /// Resistance computed from `position` (ThermistorNTCElm.java's
    /// `resistance` field), recomputed whenever an editable field changes.
    resistance: f64,
}

impl Thermistor {
    const T0: f64 = 273.15;
    /// ThermistorNTCElm.java:42-46's no-args constructor defaults.
    const DEFAULT_R25: f64 = 10000.0;
    const DEFAULT_R50: f64 = 3605.0;
    const DEFAULT_MIN_TEMPR: f64 = -40.0;
    const DEFAULT_MAX_TEMPR: f64 = 150.0;
    const DEFAULT_POSITION: f64 = 0.34;

    pub fn new(spec: &ElementSpec) -> Self {
        let mut t = Self {
            base: Base::with_posts(2),
            r25: spec.param("r25", Self::DEFAULT_R25),
            r50: spec.param("r50", Self::DEFAULT_R50),
            min_tempr: spec.param("minTempr", Self::DEFAULT_MIN_TEMPR),
            max_tempr: spec.param("maxTempr", Self::DEFAULT_MAX_TEMPR),
            position: spec.param("position", Self::DEFAULT_POSITION),
            resistance: 0.0,
        };
        t.recompute();
        t
    }

    /// `calcB25100()` (ThermistorNTCElm.java:256-262): the Beta constant a
    /// datasheet's two calibration points imply, so `calc_resistance` below
    /// reproduces `r25` exactly at 25 C and `r50` exactly at 50 C.
    fn b25100(&self) -> f64 {
        let k1 = Self::T0 + 25.0;
        let k2 = Self::T0 + 50.0;
        (self.r25.ln() - self.r50.ln()) / (1.0 / k1 - 1.0 / k2)
    }

    /// `calcResistance()` (ThermistorNTCElm.java:247-250): the Beta/NTC
    /// exponential law referenced to `r25` at 25 C, `tempr` in Celsius.
    /// Upstream rounds to the nearest ohm.
    fn calc_resistance(&self, tempr: f64) -> f64 {
        let t25 = Self::T0 + 25.0;
        (self.r25 * (self.b25100() * (1.0 / (tempr + Self::T0) - 1.0 / t25)).exp()).round()
    }

    /// `temprFromSliderPos()` (ThermistorNTCElm.java:251-254). Upstream
    /// rounds to the nearest degree.
    fn temp_from_position(&self) -> f64 {
        (self.position * (self.max_tempr - self.min_tempr) + self.min_tempr).round()
    }

    fn recompute(&mut self) {
        self.resistance = self.calc_resistance(self.temp_from_position());
    }
}

impl Element for Thermistor {
    fn kind(&self) -> &'static str {
        "thermistor"
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
    fn stamp(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        s.resistor(self.base.nodes[0], self.base.nodes[1], self.resistance);
    }
    fn calculate_current(&mut self, _ctx: &SimCtx) {
        self.base.current = two_terminal_current(&self.base, self.resistance);
    }
    fn set_param(&mut self, name: &str, value: f64) -> bool {
        match name {
            "r25" if value > 0.0 => self.r25 = value,
            "r50" if value > 0.0 => self.r50 = value,
            "minTempr" => self.min_tempr = value,
            "maxTempr" => self.max_tempr = value,
            "position" => self.position = value,
            _ => return false,
        }
        self.recompute();
        true
    }
}
