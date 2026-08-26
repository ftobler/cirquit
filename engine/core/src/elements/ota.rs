//! OTA (OTAElm.java, dump 402): an LM13700-style operational transconductance
//! amplifier, built as a composite of two supply rails and sixteen
//! transistors.
//!
//! The model string is upstream's own (OTAElm.java:8-9), node ids 1..15 with
//! 0 as ground. The five external nodes `{ 7, 5, 15, 1, 13 }` become the
//! composite's posts in order: the non-inverting input, the inverting input,
//! the positive-rail collector load, the Iabc bias pin and the output. The
//! rail children pin the two internal rails to `negVolt` (child 0) and
//! `posVolt` (child 1), read from the spec's params and defaulting to the
//! LM13700's +/-9 V.
//!
//! A saved 402 line carries one `_`-joined dump token per child after the
//! flags. The tokens reach the engine as a JSON array in `spec.model`, the
//! string carrier the custom-logic element already uses; each token's fields
//! map onto the rail or transistor params the composite applies.

use crate::elements::composite::Composite;
use crate::spec::ElementSpec;

/// The 18-child model: two rails plus the transistor network. The rail's node
/// is its single post; a transistor's line is base, collector, emitter.
const MODEL: &str = "RailElm 4\rRailElm 10\rNTransistorElm 1 2 3\rNTransistorElm 3 1 4\r\
NTransistorElm 3 3 4\rNTransistorElm 5 6 2\rNTransistorElm 7 8 2\rPTransistorElm 9 6 10\r\
PTransistorElm 9 9 10\rPTransistorElm 6 12 9\rPTransistorElm 11 8 10\rPTransistorElm 11 11 10\r\
PTransistorElm 8 13 11\rNTransistorElm 14 14 4\rNTransistorElm 14 12 4\rNTransistorElm 12 13 14\r\
NTransistorElm 15 15 5\rNTransistorElm 15 15 7";

/// The five external node ids, in post order (OTAElm.java:9).
const EXTERNAL: &[usize] = &[7, 5, 15, 1, 13];

pub fn from_spec(spec: &ElementSpec) -> Option<Composite> {
    let dumps: Option<Vec<String>> = spec
        .model
        .as_deref()
        .and_then(|m| serde_json::from_str(m).ok());
    // Folding a child-expression failure into the Option contract is
    // deliberate: the const model's children are rails and transistors, which
    // carry no expressions, so `from_model` cannot fail here; if it ever did,
    // the built-in composite tests would fail loudly.
    let mut ota = Composite::from_model(MODEL, EXTERNAL, dumps.as_deref(), "ota").ok()?;
    let pos = spec.param("posVolt", 9.0);
    let neg = spec.param("negVolt", -9.0);
    ota.set_child_param(0, "maxVoltage", neg);
    ota.set_child_param(1, "maxVoltage", pos);
    Some(ota)
}
