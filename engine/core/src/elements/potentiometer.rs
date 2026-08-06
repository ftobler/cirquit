//! A three-terminal potentiometer.

use crate::element::{Base, Element, SimCtx};
use crate::spec::ElementSpec;
use crate::stamp::Stamper;

/// A three-terminal potentiometer: posts 0 and 1 are the track ends, post 2 is
/// the wiper.
pub struct Potentiometer {
    base: Base,
    max_resistance: f64,
    position: f64,
    r0: f64,
    r1: f64,
    /// Current through the second track half, positive flowing post 1 to the
    /// wiper. Tracked so the wire-current recovery can balance the wiper node.
    r1_current: f64,
}

impl Potentiometer {
    pub fn new(spec: &ElementSpec) -> Self {
        let mut p = Self {
            base: Base::with_posts(3),
            max_resistance: spec.param("maxResistance", 1000.0),
            position: spec.param("position", 0.5),
            r0: 0.0,
            r1: 0.0,
            r1_current: 0.0,
        };
        p.recompute();
        p
    }

    fn recompute(&mut self) {
        // A wiper at an extreme would otherwise short a track section to
        // nothing, so keep a floor on each half.
        let p = self.position.clamp(0.0, 1.0);
        self.r0 = (self.max_resistance * p).max(1e-6);
        self.r1 = (self.max_resistance * (1.0 - p)).max(1e-6);
    }
}

impl Element for Potentiometer {
    fn kind(&self) -> &'static str {
        "potentiometer"
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
    fn stamp(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        s.resistor(self.base.nodes[0], self.base.nodes[2], self.r0);
        s.resistor(self.base.nodes[2], self.base.nodes[1], self.r1);
    }
    fn calculate_current(&mut self, _ctx: &SimCtx) {
        self.base.current = (self.base.volts[0] - self.base.volts[2]) / self.r0;
        self.r1_current = (self.base.volts[1] - self.base.volts[2]) / self.r1;
    }
    fn current_into_node(&self, post: usize) -> f64 {
        match post {
            0 => -self.base.current,
            1 => -self.r1_current,
            2 => self.base.current + self.r1_current,
            _ => 0.0,
        }
    }
    fn set_param(&mut self, name: &str, value: f64) -> bool {
        match name {
            "position" => self.position = value,
            "maxResistance" if value > 0.0 => self.max_resistance = value,
            _ => return false,
        }
        self.recompute();
        true
    }
}
