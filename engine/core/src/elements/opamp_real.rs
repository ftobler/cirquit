//! Realistic op-amp (OpAmpRealElm.java, dump 409): a transistor-level LM741
//! built as a composite of twenty transistors, the compensation capacitor and
//! eleven resistors. The posts are the inverting input, the non-inverting
//! input, the output, the positive supply and the negative supply, in that
//! order (OpAmpRealElm.java:18).
//!
//! The model is upstream's 741 string (OpAmpRealElm.java:9-17); the child
//! values are configured by `init741` (OpAmpRealElm.java:101-120), which the
//! port reproduces after building the composite: the compensation capacitor is
//! sized from the slew rate, the eleven resistors take the table values with
//! the two output-stage ones scaled by the current-limit multiplier, and the
//! two output transistors carry `currentMult`-scaled betas. The slew-rate
//! field and the loaded capacitor charge are the only tokens that feed the
//! model beyond the fixed table.
//!
//! Only the 741 is modelled. The LM324 (modelType 1) and its v2 revision
//! (modelType 2) need current-source and controlled-source children this port
//! has not wired into a composite; the token round-trips and the frontend
//! offers only the 741, so a file naming a 324 loads as the 741 netlist.

use crate::elements::composite::Composite;
use crate::spec::ElementSpec;

/// The 741's transistor network, verbatim upstream (OpAmpRealElm.java:9-17):
/// Q1-Q20 plus the compensation capacitor (child 20) and eleven resistors
/// (children 21-31). A transistor line is base, collector, emitter.
const MODEL: &str = "NTransistorElm 3 8 9\rNTransistorElm 2 8 10\rPTransistorElm 11 12 9\r\
PTransistorElm 11 13 10\rNTransistorElm 14 12 1\rNTransistorElm 14 13 5\rNTransistorElm 12 7 14\r\
PTransistorElm 8 8 7\rPTransistorElm 8 11 7\rNTransistorElm 17 11 16\rNTransistorElm 17 17 4\r\
PTransistorElm 18 18 7\rPTransistorElm 18 20 7\rNTransistorElm 20 7 25\rNTransistorElm 13 22 24\r\
NTransistorElm 21 20 22\rNTransistorElm 25 20 6\rNTransistorElm 24 22 23\rPTransistorElm 22 4 15\r\
NTransistorElm 23 13 4\rCapacitorElm 13 20\rResistorElm 15 6\rResistorElm 6 25\rResistorElm 4 1\r\
ResistorElm 4 14\rResistorElm 4 5\rResistorElm 4 16\rResistorElm 4 24\rResistorElm 4 23\r\
ResistorElm 17 18\rResistorElm 22 21\rResistorElm 21 20";

/// The five external node ids, in post order (OpAmpRealElm.java:18).
const EXTERNAL: &[usize] = &[2, 3, 6, 7, 4];

/// The eleven resistor values (OpAmpRealElm.java:55), in child index order.
const RESISTANCES: [f64; 11] = [
    50.0, 25.0, 1e3, 50e3, 1e3, 5e3, 50e3, 50.0, 39e3, 7500.0, 4500.0,
];

/// The compensation capacitor value at the default slew rate
/// (OpAmpRealElm.java:105).
const CAP_AT_UNITY_SLEW: f64 = 30e-12;
/// The output current limit the capacitor and resistor table are tuned for
/// (OpAmpRealElm.java:64).
const DEFAULT_CURRENT_LIMIT: f64 = 0.0231;

pub fn from_spec(spec: &ElementSpec) -> Option<Composite> {
    let mut op = Composite::from_model(MODEL, EXTERNAL, None, "opampReal");
    // The 741 configuration, `init741` (OpAmpRealElm.java:101-120). The
    // current multiplier scales the two output-stage resistors and the two
    // output transistors' betas together, so the delivered current follows
    // the `currentLimit` field.
    let slew = spec.param("slewRate", 0.6);
    let cap_value = spec.param("capValue", 0.0);
    let current_limit = spec.param("currentLimit", DEFAULT_CURRENT_LIMIT);
    let current_mult = current_limit / DEFAULT_CURRENT_LIMIT;
    op.set_child_param(20, "capacitance", CAP_AT_UNITY_SLEW / (slew / 0.6));
    op.set_child_param(20, "voltDiff", cap_value);
    for (i, &r) in RESISTANCES.iter().enumerate() {
        let scaled = if i < 2 { r / current_mult } else { r };
        op.set_child_param(21 + i, "resistance", scaled);
    }
    op.set_child_param(13, "beta", current_mult * 100.0);
    op.set_child_param(18, "beta", current_mult * 100.0);
    Some(op)
}
