//! Logic output: a one-post passive indicator that reports its node voltage
//! as a digital level (LogicOutputElm.java).

use crate::element::{Base, Element, SimCtx};
use crate::spec::ElementSpec;
use crate::stamp::{Stamper, GROUND};

/// File-format flag: a 1 M ohm pull-down to ground, so a floating input reads
/// low instead of staying undefined (LogicOutputElm.java:28). The ternary and
/// numeric flags (bits 1 and 2) affect only the drawing, so the engine ignores
/// them and they round-trip through the spec untouched.
const FLAG_PULLDOWN: i64 = 4;

/// A digital level indicator. It reads its node voltage, so it draws no
/// current unless the pull-down flag is set.
pub struct LogicOutput {
    base: Base,
    /// The level threshold decides only what the frontend draws (L/H, 0/1),
    /// never the stamp, so the engine stores it for round-trip and for the
    /// live `set_param` fast path and never reads it back.
    #[allow(dead_code)]
    threshold: f64,
    needs_pulldown: bool,
}

impl LogicOutput {
    pub fn new(spec: &ElementSpec) -> Self {
        Self {
            base: Base::with_posts(1),
            threshold: spec.param("threshold", 2.5),
            needs_pulldown: spec.flag(FLAG_PULLDOWN),
        }
    }
}

impl Element for LogicOutput {
    fn kind(&self) -> &'static str {
        "logicOutput"
    }
    fn base(&self) -> &Base {
        &self.base
    }
    fn base_mut(&mut self) -> &mut Base {
        &mut self.base
    }
    fn post_count(&self) -> usize {
        1
    }
    /// An indicator does not couple its terminal: there is no current path of
    /// its own (LogicOutputElm.java:60-62).
    fn connects(&self, _a: usize, _b: usize) -> bool {
        false
    }
    fn stamp(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        // The optional pull-down gives a floating input a defined low state
        // (LogicOutputElm.java:93-95).
        if self.needs_pulldown {
            s.resistor(self.base.nodes[0], GROUND, 1e6);
        }
    }
    fn calculate_current(&mut self, _ctx: &SimCtx) {
        self.base.current = 0.0;
    }
    fn set_param(&mut self, name: &str, value: f64) -> bool {
        if name == "threshold" {
            self.threshold = value;
            true
        } else {
            false
        }
    }
    /// Scopes plot the node voltage, matching upstream's `getVoltageDiff()`
    /// (LogicOutputElm.java:97). Most corpus scopes attach to a logic output,
    /// so this must be `volts[0]`, not the default two-terminal difference.
    fn voltage_diff(&self) -> f64 {
        self.base.volts.first().copied().unwrap_or(0.0)
    }
}
