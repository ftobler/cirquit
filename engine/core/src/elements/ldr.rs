//! A light-dependent resistor.

use crate::element::{two_terminal_current, Base, Element, SimCtx};
use crate::spec::ElementSpec;
use crate::stamp::Stamper;

/// A light-dependent resistor / photoresistor, `LDRElm.java`. Same shape as
/// `Thermistor`: a slider `position` in `[0, 1]`-ish (upstream's own slider
/// only reaches 0.0001-0.9901, default 0.34, `LDRElm.java:30`) maps through a
/// fixed `minLux`/`maxLux` range (`0.1`/`10000`, hardcoded in both
/// constructors and never read from a file or exposed via `getEditInfo`, so
/// this port keeps them as constants rather than params) to a lux level, and
/// lux maps to resistance. `stamp()` (`LDRElm.java`:164-168) recomputes both
/// `lux` and `resistance` from `position` on every call — nothing depends on
/// current, voltage or a prior timestep — so like `Thermistor` this is a
/// plain resistor whose value only changes on edit: no `nonlinear()`
/// override, no `do_step`/`start_iteration`.
pub struct Ldr {
    base: Base,
    /// Slider position driving `lux` (`LDRElm.java`:18, default at :30).
    position: f64,
    /// Resistance computed from `position` (`LDRElm.java`'s `resistance`
    /// field), recomputed whenever an editable field changes.
    resistance: f64,
}

impl Ldr {
    /// `minLux`/`maxLux` (`LDRElm.java`:28-29): dark and full-sun endpoints,
    /// hardcoded in both constructors and never read from a file.
    const MIN_LUX: f64 = 0.1;
    const MAX_LUX: f64 = 10000.0;
    /// `LDRElm.java`:30's no-args constructor default.
    const DEFAULT_POSITION: f64 = 0.34;

    pub fn new(spec: &ElementSpec) -> Self {
        let mut l = Self {
            base: Base::with_posts(2),
            position: spec.param("position", Self::DEFAULT_POSITION),
            resistance: 0.0,
        };
        l.recompute();
        l
    }

    /// `LuxFromSliderPos()` (`LDRElm.java`:219-222).
    fn lux_from_position(&self) -> f64 {
        Self::MAX_LUX * self.position + Self::MIN_LUX
    }

    /// `calcResistance()` (`LDRElm.java`:206-218). Upstream rounds to the
    /// nearest ohm.
    fn calc_resistance(&self, lux: f64) -> f64 {
        ((Self::MAX_LUX - lux + 1.0) * 10.0).round()
    }

    fn recompute(&mut self) {
        self.resistance = self.calc_resistance(self.lux_from_position());
    }
}

impl Element for Ldr {
    fn kind(&self) -> &'static str {
        "ldr"
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
            "position" => self.position = value,
            _ => return false,
        }
        self.recompute();
        true
    }
}
