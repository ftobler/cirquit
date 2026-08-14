//! Serial-in parallel-out shift register (SipoShiftElm.java, dump 189). A
//! rising clock edge shifts the register one position toward Q_{bits-1} and
//! loads the D pin into Q0.

use crate::element::{Base, Element, SimCtx};
use crate::elements::chip::{Chip, ChipPin};
use crate::spec::ElementSpec;
use crate::stamp::Stamper;

pub struct SipoShift {
    chip: Chip,
    bits: usize,
}

impl SipoShift {
    pub fn new(spec: &ElementSpec) -> Self {
        // The edit dialog rejects fewer than 1 bit (SipoShiftElm.java:110)
        // and caps no higher; the ceiling of 32 keeps a hand-edited width from
        // allocating unbounded Q pins.
        let bits = (spec.param("bits", 8.0) as usize).clamp(1, 32);
        let mut pins = vec![
            ChipPin::input(),         // 0 D
            ChipPin::input().clock(), // 1 clock
        ];
        for _ in 0..bits {
            pins.push(ChipPin::output(false)); // 2..2+bits Q0..Q_{bits-1}
        }
        let mut s = Self {
            chip: Chip::new(spec, pins),
            bits,
        };
        s.restore_outputs(spec);
        s
    }

    /// Unpacks the file's packed integer words onto the Q outputs, the levels
    /// the file constructor restores (readBits, SipoShiftElm.java:38-43).
    fn restore_outputs(&mut self, spec: &ElementSpec) {
        let words = self.bits.div_ceil(32);
        for w in 0..words {
            let word = spec.param(&format!("data{w}"), 0.0) as i64;
            for i in 0..32 {
                let bit = 32 * w + i;
                if bit >= self.bits {
                    break;
                }
                self.chip.pins[2 + bit].value = word & (1 << i) != 0;
            }
        }
    }

    fn execute(&mut self) {
        // A rising clock edge shifts toward Q_{bits-1} and loads D into Q0
        // (SipoShiftElm.java:91-101).
        if self.chip.pins[1].value && !self.chip.last_clock {
            for i in (0..self.bits - 1).rev() {
                self.chip.pins[2 + i + 1].value = self.chip.pins[2 + i].value;
            }
            self.chip.pins[2].value = self.chip.pins[0].value;
        }
    }
}

impl Element for SipoShift {
    fn kind(&self) -> &'static str {
        "sipoShift"
    }
    fn base(&self) -> &Base {
        &self.chip.base
    }
    fn base_mut(&mut self) -> &mut Base {
        &mut self.chip.base
    }
    fn post_count(&self) -> usize {
        2 + self.bits
    }
    fn voltage_source_count(&self) -> usize {
        self.chip.voltage_source_count()
    }
    fn voltage_source_nodes(&self, k: usize) -> (usize, usize) {
        self.chip.voltage_source_nodes(k)
    }
    fn connects(&self, _a: usize, _b: usize) -> bool {
        false
    }

    fn stamp(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        self.chip.stamp(s);
    }

    fn start_iteration(&mut self, _ctx: &SimCtx) {
        if self.chip.read_inputs() {
            self.execute();
        }
        self.chip.commit_clock();
    }

    fn do_step(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        self.chip.do_step(s);
    }

    fn calculate_current(&mut self, _ctx: &SimCtx) {
        self.chip.base.current = 0.0;
    }

    fn current_into_node(&self, post: usize) -> f64 {
        self.chip.current_into_node(post)
    }

    fn set_param(&mut self, name: &str, value: f64) -> bool {
        match name {
            "highVoltage" => self.chip.high_voltage = value,
            // "bits" changes the output count, which needs a full rebuild.
            _ => return false,
        }
        true
    }

    fn reset(&mut self) {
        self.chip.reset();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn bits_clamps_to_the_allocation_ceiling() {
        // A hand-edited file can carry any "bits" value; 1e9 used to reach
        // the Q-pin allocation unclamped and panic on it.
        let mut params = HashMap::new();
        params.insert("bits".to_string(), 1e9);
        let spec = ElementSpec {
            id: 1,
            kind: "sipoShift".into(),
            posts: Vec::new(),
            params,
            label: None,
            model: None,
            flags: 0,
        };
        let shift = SipoShift::new(&spec);
        assert_eq!(
            shift.bits, 32,
            "bits should clamp to 32, not pass 1e9 through"
        );
    }
}
