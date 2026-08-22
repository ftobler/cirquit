//! Static RAM (SRAMElm.java, dump 413) and ROM (ROMElm.java, dump 436), one
//! shared memory model with a `has_we` switch. The address and data bits ride
//! on the west and east sides, WE and OE are active-low, and each data pin is
//! a bidirectional terminal: an internal voltage source holds the stored bit
//! and a per-step resistor couples it to the pin (1 ohm while output enabled,
//! else a 1e8 pulldown), so the pin can also be driven from outside during a
//! write (SRAMElm.java:283-331).
//!
//! The file line carries the `addressBits` and `dataBits` tokens after the
//! optional high voltage, then the stored contents as runs of consecutive
//! addresses: `addr val val ... -1 addr val ... -1 ... -2` (SRAMElm.java:
//! 55-70). Upstream's text `dump()` drops both the sizes and the contents,
//! so this port's writer restores them (the same quirk fix as the
//! thermistor's position token); the reader here matches the constructor.

use std::collections::HashMap;

use crate::element::{Base, Element, SimCtx};
use crate::spec::ElementSpec;
use crate::stamp::{Stamper, GROUND};

/// File flag saying the map reloads from its initial contents on reset
/// (SRAMElm.java:36).
const FLAG_RELOAD_ON_RESET: i64 = 2;

/// The write-time pulldown on each data pin, `stampResistor(data, ground, 1e8)`
/// (SRAMElm.java:315).
const WRITE_PULLDOWN_R: f64 = 1e8;
/// The output coupling resistance from the internal source to the data pin
/// (SRAMElm.java:313).
const OUTPUT_R: f64 = 1.0;

/// Reads the flat `addr{i}`/`val{i}` pair stream the frontend dumps into
/// params out of the file's run groups. Last write wins per address, matching
/// upstream's `map.put` over runs that overlap.
fn load_contents(spec: &ElementSpec) -> HashMap<usize, u32> {
    let mut map = HashMap::new();
    let mut i = 0usize;
    while let Some(&a) = spec.params.get(&format!("addr{i}")) {
        let v = spec.params.get(&format!("val{i}")).copied().unwrap_or(0.0);
        map.insert(a as usize, v as u32);
        i += 1;
    }
    map
}

/// SRAM (with a WE pin) and ROM (without one). The ROM is SRAM with the write
/// path removed: no WE pin, no `step_finished` write-back (ROMElm.java:90).
pub struct Sram {
    base: Base,
    high_voltage: f64,
    address_bits: usize,
    data_bits: usize,
    /// True under upstream's BIT_ORDER_BUS (ChipElm.java:37): the address
    /// bank and the data bank each share one coordinate, told apart by
    /// per-post bit tags.
    bus: bool,
    has_we: bool,
    map: HashMap<usize, u32>,
    /// The contents to restore under FLAG_RELOAD_ON_RESET, captured at build
    /// (SRAMElm.java:72-73).
    initial_map: Option<HashMap<usize, u32>>,
    /// The address decoded on the last step, kept for the write-back
    /// (`address`, SRAMElm.java:281).
    address: usize,
}

impl Sram {
    pub fn new(spec: &ElementSpec, has_we: bool) -> Self {
        // The edit dialog limits both widths to 2..16 (SRAMElm.java:228-241);
        // the clamp keeps a corrupt token from allocating unbounded posts.
        let address_bits = (spec.param("addressBits", 4.0) as usize).clamp(2, 16);
        let data_bits = (spec.param("dataBits", 4.0) as usize).clamp(2, 16);
        let map = load_contents(spec);
        let initial_map = if spec.flag(FLAG_RELOAD_ON_RESET) {
            Some(map.clone())
        } else {
            None
        };
        Self {
            base: Base::with_posts(Self::post_total(has_we, address_bits, data_bits)),
            high_voltage: spec.param("highVoltage", 5.0),
            address_bits,
            data_bits,
            bus: spec.flag(crate::elements::chip::FLAG_BIT_ORDER_BUS),
            has_we,
            map,
            initial_map,
            address: 0,
        }
    }

    /// Post count: WE + OE (or just OE for a ROM) plus the two pin banks
    /// (getPostCount, SRAMElm.java:124-126, ROMElm.java:60-62).
    fn post_total(has_we: bool, address_bits: usize, data_bits: usize) -> usize {
        let controls = if has_we { 2 } else { 1 };
        controls + address_bits + data_bits
    }

    fn oe_post(&self) -> usize {
        if self.has_we {
            1
        } else {
            0
        }
    }

    /// First address pin's post index (`addressNodes`, SRAMElm.java:117,
    /// ROMElm.java:51).
    fn address_base(&self) -> usize {
        if self.has_we {
            2
        } else {
            1
        }
    }

    /// First data pin's post index (`dataNodes`, SRAMElm.java:118).
    fn data_base(&self) -> usize {
        self.address_base() + self.address_bits
    }

    /// First internal node's local index, right after the posts
    /// (`internalNodes`, SRAMElm.java:119).
    fn internal_base(&self) -> usize {
        self.post_count()
    }

    fn threshold(&self) -> f64 {
        self.high_voltage * 0.5
    }

    /// Decodes the address pins MSB first (SRAMElm.java:299-302).
    fn read_address(&self) -> usize {
        let mut address = 0usize;
        for i in 0..self.address_bits {
            if self.base.volts[self.address_base() + i] > self.threshold() {
                address |= 1 << (self.address_bits - 1 - i);
            }
        }
        address
    }
}

impl Element for Sram {
    fn kind(&self) -> &'static str {
        if self.has_we {
            "sram"
        } else {
            "rom"
        }
    }
    fn base(&self) -> &Base {
        &self.base
    }
    fn base_mut(&mut self) -> &mut Base {
        &mut self.base
    }
    fn post_count(&self) -> usize {
        Self::post_total(self.has_we, self.address_bits, self.data_bits)
    }
    /// Bus mode: each bank collapses onto one coordinate, and makeBitPins
    /// runs the banks reversed, so bank pin p carries bit `n-1-p` of its
    /// bank, which is exactly what read_address (:132) and do_step (:210)
    /// decode (SRAMElm.java:120-121).
    fn post_bus_z(&self, post: usize) -> usize {
        if !self.bus {
            return 0;
        }
        let a0 = self.address_base();
        let d0 = self.data_base();
        if post >= a0 && post < d0 {
            self.address_bits - 1 - (post - a0)
        } else if post >= d0 && post < d0 + self.data_bits {
            self.data_bits - 1 - (post - d0)
        } else {
            0
        }
    }
    /// One node per data bit holds the source that drives the stored value
    /// (`getInternalNodeCount`, SRAMElm.java:268).
    fn internal_node_count(&self) -> usize {
        self.data_bits
    }
    /// One voltage source per data bit, from ground to the internal node
    /// (SRAMElm.java:267).
    fn voltage_source_count(&self) -> usize {
        self.data_bits
    }
    fn voltage_source_nodes(&self, k: usize) -> (usize, usize) {
        // setVoltageSource (SRAMElm.java:269-272): the source spans ground to
        // the internal node, never the data pin itself.
        (GROUND, self.base.nodes[self.internal_base() + k])
    }
    /// No posts couple in the matrix: the data pins reach the internal nodes
    /// only through the per-step resistor, which the `matrix_connects`
    /// override puts in one closure (ChipElm.java:467).
    fn connects(&self, _a: usize, _b: usize) -> bool {
        false
    }
    /// Each internal node couples to its data pin through the per-step output
    /// resistor (getMatrixConnection, SRAMElm.java:273-279).
    fn matrix_connects(&self, a: usize, b: usize) -> bool {
        (0..self.data_bits).any(|i| {
            let internal = self.internal_base() + i;
            let data = self.data_base() + i;
            (a == internal && b == data) || (a == data && b == internal)
        })
    }
    /// The resistor changes with the pin levels every step, so the element is
    /// nonlinear (nonLinear, SRAMElm.java:103).
    fn nonlinear(&self) -> bool {
        true
    }
    fn stamp(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        // Topology once with a zero value; `do_step` supplies the stored bits
        // and the coupling resistors (SRAMElm.java:283-291).
        for k in 0..self.data_bits {
            s.voltage_source(
                GROUND,
                self.base.nodes[self.internal_base() + k],
                self.base.vs_base + k,
                0.0,
            );
        }
    }
    fn do_step(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        let write_enabled = self.has_we && self.base.volts[0] < self.threshold();
        let output_enabled = !write_enabled && self.base.volts[self.oe_post()] < self.threshold();
        let address = self.read_address();
        let data = self.map.get(&address).copied().unwrap_or(0);
        for i in 0..self.data_bits {
            let bit = (data >> (self.data_bits - 1 - i)) & 1 == 1;
            s.voltage_source_value(
                self.base.vs_base + i,
                if bit { self.high_voltage } else { 0.0 },
            );
            // Output enabled: couple the internal source to the data pin so it
            // can drive the external net. Otherwise pull the pin down so an
            // external write driver can hold it (SRAMElm.java:306-316).
            if output_enabled {
                s.resistor(
                    self.base.nodes[self.internal_base() + i],
                    self.base.nodes[self.data_base() + i],
                    OUTPUT_R,
                );
            } else {
                s.resistor(
                    self.base.nodes[self.data_base() + i],
                    GROUND,
                    WRITE_PULLDOWN_R,
                );
            }
        }
        self.address = address;
    }
    fn step_finished(&mut self, _ctx: &SimCtx) {
        // A ROM has no write path (ROMElm.java:90). While WE is low the SRAM
        // samples the data pins and stores them (SRAMElm.java:319-331).
        if !self.has_we || self.base.volts[0] >= self.threshold() {
            return;
        }
        let mut data = 0u32;
        for i in 0..self.data_bits {
            if self.base.volts[self.data_base() + i] > self.threshold() {
                data |= 1 << (self.data_bits - 1 - i);
            }
        }
        self.map.insert(self.address, data);
    }
    fn calculate_current(&mut self, _ctx: &SimCtx) {
        self.base.current = 0.0;
    }
    fn current_into_node(&self, post: usize) -> f64 {
        let data_base = self.data_base();
        if post >= data_base && post < data_base + self.data_bits {
            let i = post - data_base;
            let write_enabled = self.has_we && self.base.volts[0] < self.threshold();
            let output_enabled =
                !write_enabled && self.base.volts[self.oe_post()] < self.threshold();
            if output_enabled {
                // The stored bit's source drives the data pin through the
                // 1 ohm coupling; the delivered current is what leaves the
                // element into the pin's node.
                (self.base.volts[self.internal_base() + i] - self.base.volts[post]) / OUTPUT_R
            } else {
                // The write-time pulldown draws a negligible leak out of the
                // externally driven pin.
                -self.base.volts[post] / WRITE_PULLDOWN_R
            }
        } else {
            0.0
        }
    }
    fn set_param(&mut self, name: &str, value: f64) -> bool {
        match name {
            "highVoltage" => self.high_voltage = value,
            // The widths change the post and node counts, which only a full
            // rebuild can reallocate.
            _ => return false,
        }
        true
    }
    fn reset(&mut self) {
        self.base.reset();
        self.address = 0;
        if let Some(initial) = &self.initial_map {
            // Restore the load-time contents under FLAG_RELOAD_ON_RESET
            // (SRAMElm.java:97-101).
            self.map = initial.clone();
        }
    }
}
