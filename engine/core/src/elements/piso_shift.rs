//! Parallel-in serial-out shift register (PisoShiftElm.java, dump 186). A
//! rising LD edge latches the D inputs into the register; a rising clock edge
//! then shifts the register toward the Q output one position per clock,
//! feeding the SER input into the vacated slot under FLAG_NEW_BEHAVIOR (the
//! default), or a hard low without it (the old behavior).

use crate::element::{Base, Element, SimCtx};
use crate::elements::chip::{Chip, ChipPin};
use crate::spec::ElementSpec;
use crate::stamp::Stamper;

const FLAG_NEW_BEHAVIOR: i64 = 2;

pub struct PisoShift {
    chip: Chip,
    bits: usize,
    /// The rotating register; `data_index` is where the next clock writes SER
    /// and reads the bit to output (`data`, `dataIndex`, PisoShiftElm.java:30).
    data: Vec<bool>,
    data_index: isize,
    /// The LD pin's level from the previous step, the edge detector
    /// (`loadState`, PisoShiftElm.java:33).
    load_state: bool,
    has_new_behavior: bool,
}

impl PisoShift {
    pub fn new(spec: &ElementSpec) -> Self {
        // The edit dialog rejects fewer than 1 bit (PisoShiftElm.java:149)
        // and caps no higher; the ceiling of 32 keeps a hand-edited width from
        // allocating unbounded D pins and register storage.
        let bits = (spec.param("bits", 8.0) as usize).clamp(1, 32);
        let has_new_behavior = spec.flag(FLAG_NEW_BEHAVIOR);
        let mut pins = vec![
            ChipPin::input(),         // 0 LD
            ChipPin::input().clock(), // 1 clock
            ChipPin::output(false),   // 2 Q
        ];
        if has_new_behavior {
            pins.push(ChipPin::input()); // 3 SER
        }
        for _ in 0..bits {
            pins.push(ChipPin::input()); // the D parallel inputs
        }
        let mut p = Self {
            chip: Chip::new(spec, pins),
            bits,
            data: vec![false; bits],
            data_index: 0,
            load_state: false,
            has_new_behavior,
        };
        p.restore_data(spec);
        p
    }

    /// The first D-pin index: 4 with the SER pin, 3 without
    /// (`dataPinIndex`, PisoShiftElm.java:96-99).
    fn data_pin(&self) -> usize {
        if self.has_new_behavior {
            4
        } else {
            3
        }
    }

    /// Unpacks the file's packed integer words into the register and seeds the
    /// Q output with the first bit, exactly where `setupPins` leaves a loaded
    /// part (readBits, PisoShiftElm.java:94-95).
    fn restore_data(&mut self, spec: &ElementSpec) {
        let words = self.bits.div_ceil(32);
        for w in 0..words {
            let word = spec.param(&format!("data{w}"), 0.0) as i64;
            for i in 0..32 {
                let bit = 32 * w + i;
                if bit >= self.bits {
                    break;
                }
                self.data[bit] = word & (1 << i) != 0;
            }
        }
        if self.has_new_behavior && self.bits > 0 {
            self.chip.pins[2].value = self.data[0];
        }
    }

    fn execute(&mut self) {
        // A rising LD edge latches the parallel inputs (PisoShiftElm.java:110-123).
        if self.chip.pins[0].value != self.load_state {
            self.load_state = self.chip.pins[0].value;
            if self.load_state {
                let data_pin = self.data_pin();
                for i in 0..self.bits {
                    self.data[i] = self.chip.pins[data_pin + i].value;
                }
                if self.has_new_behavior {
                    // Q shows D0 immediately and the shift restarts from it
                    // (PisoShiftElm.java:114-116).
                    self.chip.pins[2].value = self.chip.pins[data_pin].value;
                    self.data_index = 0;
                } else {
                    // The old behavior defers the first output until the clock
                    // arrives (PisoShiftElm.java:117-119).
                    self.data_index = -1;
                }
            }
        }
        // A rising clock edge rotates the register toward Q (PisoShiftElm.java:
        // 125-139).
        if self.chip.pins[1].value && !self.chip.last_clock {
            if self.data_index >= 0 {
                let ser = self.has_new_behavior && self.chip.pins[3].value;
                self.data[self.data_index as usize] = ser;
            }
            self.data_index = (self.data_index + 1).rem_euclid(self.bits as isize);
            self.chip.pins[2].value = self.data[self.data_index as usize];
        }
    }
}

impl Element for PisoShift {
    fn kind(&self) -> &'static str {
        "pisoShift"
    }
    fn base(&self) -> &Base {
        &self.chip.base
    }
    fn base_mut(&mut self) -> &mut Base {
        &mut self.chip.base
    }
    fn post_count(&self) -> usize {
        self.data_pin() + self.bits
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
            // "bits" changes the register width and the pin count, which needs
            // a full rebuild.
            _ => return false,
        }
        true
    }

    fn reset(&mut self) {
        self.chip.reset();
        self.data.fill(false);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn bits_clamps_to_the_allocation_ceiling() {
        // A hand-edited file can carry any "bits" value; 1e9 used to reach
        // the D-pin allocation and `vec![false; bits]` unclamped and panic on
        // it.
        let mut params = HashMap::new();
        params.insert("bits".to_string(), 1e9);
        let spec = ElementSpec {
            id: 1,
            kind: "pisoShift".into(),
            posts: Vec::new(),
            params,
            label: None,
            model: None,
            flags: 0,
        };
        let shift = PisoShift::new(&spec);
        assert_eq!(
            shift.bits, 32,
            "bits should clamp to 32, not pass 1e9 through"
        );
    }
}
