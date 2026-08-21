//! Bus transceiver (BusTransceiverElm.java, XML type "bt").
//!
//! An N-bit tri-state transceiver: an active-low OE and a DIR pin decide
//! whether each bit's A pin drives its B pin or the reverse. Each bit has one
//! internal node driven by a voltage source that follows the source side's
//! logic level; the destination side couples through 1 ohm when enabled and
//! 1e10 when not, while the source side always sees 1e8
//! (BusTransceiverElm.java:117-143).
//!
//! The A/B pins are individual (one post per bit), which is upstream's
//! behaviour with `useBus()` off, the default outside bus mode
//! (ChipElm.java:72). Upstream saves this class only in the XML format, so
//! the port assigns dump code 437 alongside the other port-assigned XML-era
//! codes.
//!
//! Bank order is MSB first like the SRAM's makeBitPins runs: bank slot k
//! holds bit (dataBits - 1 - k), on both the A and the B side.

use crate::element::{Base, Element, SimCtx};
use crate::spec::ElementSpec;
use crate::stamp::{Stamper, GROUND};

/// The source-side coupling, always connected
/// (BusTransceiverElm.java:136-140).
const R_SRC: f64 = 1e8;
/// The destination coupling when output enabled.
const R_ON: f64 = 1.0;
/// The destination coupling when disabled: effectively open.
const R_OFF: f64 = 1e10;

pub struct BusTransceiver {
    base: Base,
    high_voltage: f64,
    data_bits: usize,
    /// Per-bit state from the last do_step, kept so calculate_current reads
    /// the same resistances that were stamped.
    r_a: Vec<f64>,
    r_b: Vec<f64>,
    /// Current each post exchanges with its node, for the renderer's per-lead
    /// dots and the wire-current recovery.
    pin_currents: Vec<f64>,
}

impl BusTransceiver {
    pub fn new(spec: &ElementSpec) -> Self {
        // Upstream's edit dialog allows 1..16 bits
        // (BusTransceiverElm.java:158-166); a corrupt token clamps instead of
        // allocating unbounded posts. The width arrives as `bits` (the shared
        // needsBits slot the chip family uses) or `dataBits` (the XML
        // attribute's own name); either is accepted.
        let data_bits = (spec.param("dataBits", spec.param("bits", 4.0)) as usize).clamp(1, 16);
        Self {
            base: Base::with_posts(Self::post_total(data_bits)),
            high_voltage: spec.param("highVoltage", 5.0),
            data_bits,
            r_a: vec![R_SRC; data_bits],
            r_b: vec![R_SRC; data_bits],
            pin_currents: vec![0.0; Self::post_total(data_bits)],
        }
    }

    /// OE + DIR plus the two bit banks (getPostCount,
    /// BusTransceiverElm.java:82-84).
    fn post_total(data_bits: usize) -> usize {
        2 + 2 * data_bits
    }

    fn a_base(&self) -> usize {
        2
    }

    fn b_base(&self) -> usize {
        2 + self.data_bits
    }

    fn internal_base(&self) -> usize {
        self.post_count()
    }

    fn threshold(&self) -> f64 {
        self.high_voltage * 0.5
    }
}

impl Element for BusTransceiver {
    fn kind(&self) -> &'static str {
        "busTransceiver"
    }
    fn base(&self) -> &Base {
        &self.base
    }
    fn base_mut(&mut self) -> &mut Base {
        &mut self.base
    }
    fn post_count(&self) -> usize {
        Self::post_total(self.data_bits)
    }
    /// One internal node per bit holds the level source
    /// (getInternalNodeCount, BusTransceiverElm.java:88).
    fn internal_node_count(&self) -> usize {
        self.data_bits
    }
    fn voltage_source_count(&self) -> usize {
        self.data_bits
    }
    fn voltage_source_nodes(&self, k: usize) -> (usize, usize) {
        // setVoltageSource (BusTransceiverElm.java:90-95): ground to the
        // internal node.
        (GROUND, self.base.nodes[self.internal_base() + k])
    }
    /// No posts couple directly; the switched resistors land through
    /// `matrix_connects` (getMatrixConnection,
    /// BusTransceiverElm.java:97-106).
    fn connects(&self, _a: usize, _b: usize) -> bool {
        false
    }
    fn matrix_connects(&self, a: usize, b: usize) -> bool {
        (0..self.data_bits).any(|i| {
            let internal = self.internal_base() + i;
            let pa = self.a_base() + i;
            let pb = self.b_base() + i;
            (a == internal && (b == pa || b == pb)) || (b == internal && (a == pa || a == pb))
        })
    }
    /// The couplings change with the pin levels every iteration
    /// (nonLinear, BusTransceiverElm.java:48).
    fn nonlinear(&self) -> bool {
        true
    }
    fn stamp(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
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
        let enabled = self.base.volts[0] < self.threshold();
        let dir_a_to_b = self.base.volts[1] > self.threshold();
        for k in 0..self.data_bits {
            let src = if dir_a_to_b {
                self.a_base() + k
            } else {
                self.b_base() + k
            };
            let level = if self.base.volts[src] > self.threshold() {
                self.high_voltage
            } else {
                0.0
            };
            s.voltage_source_value(self.base.vs_base + k, level);
            // The source side always sees the big resistance; the destination
            // side conducts only while OE is low.
            let (r_src, r_dst) = (R_SRC, if enabled { R_ON } else { R_OFF });
            let (r_a, r_b) = if dir_a_to_b {
                (r_src, r_dst)
            } else {
                (r_dst, r_src)
            };
            self.r_a[k] = r_a;
            self.r_b[k] = r_b;
            s.resistor(
                self.base.nodes[self.internal_base() + k],
                self.base.nodes[self.a_base() + k],
                r_a,
            );
            s.resistor(
                self.base.nodes[self.internal_base() + k],
                self.base.nodes[self.b_base() + k],
                r_b,
            );
        }
    }
    fn calculate_current(&mut self, _ctx: &SimCtx) {
        // Per-pin currents from the two couplings each bit stamps; positive
        // current_into_node means the element pushes current into that node.
        // The OE and DIR pins draw nothing (upstream sets no pin currents).
        let mut total = 0.0;
        let (a_base, b_base, internal_base) = (self.a_base(), self.b_base(), self.internal_base());
        for k in 0..self.data_bits {
            let vi = self.base.volts[internal_base + k];
            let ia = (vi - self.base.volts[a_base + k]) / self.r_a[k];
            let ib = (vi - self.base.volts[b_base + k]) / self.r_b[k];
            self.pin_currents[a_base + k] = ia;
            self.pin_currents[b_base + k] = ib;
            total += ib;
        }
        self.pin_currents[0] = 0.0;
        self.pin_currents[1] = 0.0;
        // The element current reads as what moved across, the destination
        // side's total.
        self.base.current = total;
    }
    fn current_into_node(&self, post: usize) -> f64 {
        self.pin_currents.get(post).copied().unwrap_or(0.0)
    }
    fn set_param(&mut self, name: &str, value: f64) -> bool {
        match name {
            "highVoltage" => self.high_voltage = value,
            _ => return false,
        }
        true
    }
    fn reset(&mut self) {
        self.base.reset();
        self.r_a.iter_mut().for_each(|r| *r = R_SRC);
        self.r_b.iter_mut().for_each(|r| *r = R_SRC);
        self.pin_currents.iter_mut().for_each(|c| *c = 0.0);
    }
}
