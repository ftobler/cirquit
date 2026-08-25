//! Realistic op-amp (OpAmpRealElm.java, dump 409): a transistor-level op-amp
//! built as a composite of children. The model selector (`modelType`, the
//! fourth token) picks one of three netlists: the LM741 (twenty transistors,
//! the compensation capacitor and eleven resistors), the LM324, and the v2
//! revision of the LM324 from the ON Semiconductor SPICE model. The posts are
//! the inverting input, the non-inverting input, the output, the positive
//! supply and the negative supply, in that order (OpAmpRealElm.java:18).
//!
//! The models are upstream's strings and their child dumps, carried verbatim
//! (OpAmpRealElm.java:9-49). The 741's child values are configured by
//! `init741` (OpAmpRealElm.java:101-120), which the port reproduces after
//! building the composite: the compensation capacitor is sized from the slew
//! rate, the eleven resistors take the table values with the two output-stage
//! ones scaled by the current-limit multiplier, and the two output transistors
//! carry `currentMult`-scaled betas. The 324 gets its own slew-rate constant
//! and output-stage table (`init324`, :122-137); the 324v2 takes its child
//! values straight from its dump (`init324v2`, :139-142), including the VCVS
//! and VCCS expression children. The slew-rate field and the loaded capacitor
//! charge are the only tokens that feed the models beyond the fixed tables.

use crate::elements::composite::Composite;
use crate::spec::ElementSpec;

/// The 741's transistor network, verbatim upstream (OpAmpRealElm.java:9-17):
/// Q1-Q20 plus the compensation capacitor (child 20) and eleven resistors
/// (children 21-31). A transistor line is base, collector, emitter.
const MODEL_741: &str = "NTransistorElm 3 8 9\rNTransistorElm 2 8 10\rPTransistorElm 11 12 9\r\
PTransistorElm 11 13 10\rNTransistorElm 14 12 1\rNTransistorElm 14 13 5\rNTransistorElm 12 7 14\r\
PTransistorElm 8 8 7\rPTransistorElm 8 11 7\rNTransistorElm 17 11 16\rNTransistorElm 17 17 4\r\
PTransistorElm 18 18 7\rPTransistorElm 18 20 7\rNTransistorElm 20 7 25\rNTransistorElm 13 22 24\r\
NTransistorElm 21 20 22\rNTransistorElm 25 20 6\rNTransistorElm 24 22 23\rPTransistorElm 22 4 15\r\
NTransistorElm 23 13 4\rCapacitorElm 13 20\rResistorElm 15 6\rResistorElm 6 25\rResistorElm 4 1\r\
ResistorElm 4 14\rResistorElm 4 5\rResistorElm 4 16\rResistorElm 4 24\rResistorElm 4 23\r\
ResistorElm 17 18\rResistorElm 22 21\rResistorElm 21 20";

/// The five external node ids, in post order (OpAmpRealElm.java:18).
const EXTERNAL_741: &[usize] = &[2, 3, 6, 7, 4];

/// The eleven resistor values (OpAmpRealElm.java:55), in child index order.
const RESISTANCES_741: [f64; 11] = [
    50.0, 25.0, 1e3, 50e3, 1e3, 5e3, 50e3, 50.0, 39e3, 7500.0, 4500.0,
];

/// The LM324's netlist, verbatim upstream (OpAmpRealElm.java:21-23): the
/// smaller discrete stack of transistors, current sources, the compensation
/// capacitor (child 4) and the output-stage resistor (child 11).
const MODEL_324: &str = "TransistorElm 1 2 3\rCurrentElm 4 3\rTransistorElm 2 2 5\r\
TransistorElm 2 6 5\rCapacitorElm 6 7\rCurrentElm 4 8\rCurrentElm 4 7\rTransistorElm 8 4 9\r\
TransistorElm 7 4 10\rTransistorElm 10 4 11\rTransistorElm 11 7 12\rResistorElm 11 12\r\
TransistorElm 7 5 12\rCurrentElm 12 5\rTransistorElm 6 5 8\rResistorElm 9 5\r\
TransistorElm 9 7 5\rTransistorElm 13 6 3";

/// The 324's five external node ids, in post order (OpAmpRealElm.java:25).
const EXTERNAL_324: &[usize] = &[1, 13, 12, 4, 5];

/// The 324's per-child dump values, verbatim upstream (OpAmpRealElm.java:26-28),
/// `/`-separated like upstream feeds `loadComposite`.
const DUMP_324: &str = "0 -1 -0 0 10000/0 0.000006/0 1 0 0 100/0 1 0 0 100/0 1e-11 0/\
0 0.000004/0 0.0001/0 1 0 0 100/0 1 0 0 100/0 1 0 0 100/0 1 0 0 100/0 25/0 -1 0 0 100/\
0 0.00005/0 -1 0 0 100/0 10000/0 1 0 0 100/0 -1 0 0 10000";

/// The 324's per-model child indexes, kept beside the netlist so they cannot
/// silently desync from it (init324, OpAmpRealElm.java:127-137). The
/// compensation capacitor, `getCapacitor()`'s 324 branch (:149-153).
const LM324_CAP_CHILD: usize = 4;
/// The output-stage resistor scaled by the current-limit multiplier (:132).
const LM324_OUT_RESISTOR_CHILD: usize = 11;
/// The output-stage transistors whose betas scale with the current limit
/// (:133-136).
const LM324_OUT_TRANSISTORS: [usize; 4] = [9, 10, 12, 16];

/// The LM324v2 netlist, verbatim upstream (OpAmpRealElm.java:31-41): the ON
/// Semiconductor full SPICE model of resistors, capacitors, transistors,
/// current sources, voltage sources and the VCVS and VCCS children, several
/// of them expression-driven (`-0.00001*(a-b)` etc.).
const MODEL_324V2: &str = "ResistorElm 4 6\rCurrentElm 4 7\rResistorElm 4 29\r\
ResistorElm 8 30\rResistorElm 9 31\rTransistorElm 30 29 31 \rResistorElm 4 32\rResistorElm 2 33\r\
ResistorElm 10 34\rTransistorElm 33 32 34 \rResistorElm 9 35\rResistorElm 9 36\rResistorElm 11 37\r\
TransistorElm 36 35 37 \rResistorElm 10 38\rResistorElm 10 39\rResistorElm 11 40\r\
TransistorElm 39 38 40 \rResistorElm 12 41\rTransistorElm 13 41 4 \rResistorElm 13 42\r\
TransistorElm 13 42 4 \rResistorElm 4 43\rTransistorElm 12 43 14 \rResistorElm 3 44\r\
TransistorElm 14 44 6 \rResistorElm 15 45\rTransistorElm 6 45 4 \rResistorElm 3 46\r\
TransistorElm 15 46 16 \rResistorElm 3 47\rTransistorElm 16 47 17 \rResistorElm 17 16\r\
ResistorElm 5 17\rResistorElm 4 48\rTransistorElm 15 48 5 \rResistorElm 15 49\r\
TransistorElm 17 49 5 \rCurrentElm 18 3\rCurrentElm 19 3\rCurrentElm 20 3\rResistorElm 11 50\r\
TransistorElm 18 50 3 \rResistorElm 14 51\rTransistorElm 19 51 3 \rResistorElm 5 52\r\
TransistorElm 7 52 4 \rResistorElm 15 53\rTransistorElm 20 53 3 \rCapacitorElm 21 22\r\
ResistorElm 12 21\rResistorElm 12 15\rVCVSElm 3 0 23 8\rVoltageElm 23 1\rCurrentElm 3 4\r\
ResistorElm 4 3\rResistorElm 12 54\rTransistorElm 9 54 11 \rResistorElm 13 55\r\
TransistorElm 10 55 11 \rCapacitorElm 12 13\rCapacitorElm 6 15\rCapacitorElm 3 24\r\
ResistorElm 11 24\rCapacitorElm 1 2\rCapacitorElm 2 0\rCapacitorElm 1 0\rVCVSElm 15 0 22 0\r\
CapacitorElm 5 0\rResistorElm 25 56\rTransistorElm 25 56 0 \rVCCSElm 27 0 4 3\r\
CurrentElm 0 25\rVoltageElm 25 26\rResistorElm 0 26\rVCVSElm 28 26 27 0\rResistorElm 0 27\r\
VoltageElm 28 0\rResistorElm 0 28";

/// The v2's five external node ids, in post order (OpAmpRealElm.java:42).
const EXTERNAL_324V2: &[usize] = &[2, 1, 5, 3, 4];

/// The v2's per-child dump values, verbatim upstream (OpAmpRealElm.java:43-49),
/// `/`-separated. The expression children carry their output function as a
/// token of their own (`0 2 -0.00001*(a-b)`).
const DUMP_324V2: &str = "0 40000/0 5e-7/0 380/0 1700/0 5/0 -1 0 0 306 xlm324v2-qpi/\
0 380/0 1700/0 5/0 -1 0 0 300 xlm324v2-qpa/0 380/0 1700/0 5/0 -1 0 0 306 xlm324v2-qpi/\
0 380/0 1700/0 5/0 -1 0 0 306 xlm324v2-qpi/0 25/0 1 0 0 100 xlm324v2-qnq/0 25/\
0 1 0 0 100 xlm324v2-qnq/0 300/0 -1 0 0 100 xlm324v2-qpq/0 25/0 1 0 0 100 xlm324v2-qnq/\
0 25/0 1 0 0 100 xlm324v2-qnq/0 25/0 1 0 0 100 xlm324v2-qnq/0 25/0 1 0 0 100 xlm324v2-qnq/\
0 40000/0 18/0 300/0 -1 0 0 100 xlm324v2-qpq/0 25/0 1 0 0 100 xlm324v2-qnq/0 1.2e-7/\
0 6e-8/0 0.000001/0 300/0 -1 0 0 100 xlm324v2-qpq/0 300/0 -1 0 0 100 xlm324v2-qpq/\
0 25/0 1 0 0 100 xlm324v2-qnq/0 300/0 -1 0 0 100 xlm324v2-qpq/2 4.8e-12 0 0/0 3/\
0 3000000000/0 2 -0.00001*(a-b)/0 0 0 -0.00156/0 0.000005/0 450000/0 300/0 -1 0 0 100 \
xlm324v2-qpq/0 300/0 -1 0 0 100 xlm324v2-qpq/2 8e-12 0 0/2 1e-12 0 0/2 1e-13 0 0/\
0 300000/2 2.3e-13 0 0/2 7.9e-13 0 0/2 7.9e-13 0 0/0 2 2*(a-b)/2 5e-14 0 0/0 25/\
0 1 0 0 100 xlm324v2-qnq/0 2 0.0003*(a-b)/0 0.001/0 0 0 -0.25/0 1000000/0 2 1*(a-b)/\
0 1000000/0 0 0 -0.55/0 1000000";

/// The compensation capacitor value at the default slew rate
/// (OpAmpRealElm.java:105).
const CAP_AT_UNITY_SLEW: f64 = 30e-12;
/// The output current limit the capacitor and resistor table are tuned for
/// (OpAmpRealElm.java:64).
const DEFAULT_CURRENT_LIMIT: f64 = 0.0231;
/// The slew-rate floor a `slewRate` token of zero (or negative, or NaN) is
/// clamped to before it sizes the compensation capacitor. One hundredth of
/// the 0.6 V/us default: the token is read as "as slow as the model can go",
/// and a floor 60x under the default caps the compensation capacitor at 60x
/// the default, a sane finite bound. A zero or NaN slew would otherwise make
/// `CAP_AT_UNITY_SLEW / (slew / 0.6)` infinite or NaN, which the capacitor's
/// `value > 0.0` guard admits and the stamper's `is_finite` check then drops,
/// silently collapsing the 741's gain-bandwidth.
const MIN_SLEW: f64 = 0.01;

/// Normalises a `slewRate` token for the compensation-capacitance division,
/// clamping anything that is not a positive finite value (zero, negative, NaN,
/// +/-inf) to [`MIN_SLEW`]. Upstream's `setSlewRate` never lets the field reach
/// zero through the UI, but the file format can carry any value.
fn clamped_slew(slew: f64) -> f64 {
    if !slew.is_finite() || slew <= 0.0 {
        MIN_SLEW
    } else {
        slew
    }
}

/// Splits a `/`-separated child-dump string into its per-child tokens, with the
/// fields' spaces folded to `_` so the composite's `_`-joined dump reader
/// (composite.rs) can apply them. The const strings stay verbatim upstream.
fn dump_tokens(dump: &str) -> Vec<String> {
    dump.split('/').map(|t| t.replace(' ', "_")).collect()
}

// The three builders below fold `from_model`'s child-expression failure into
// their Option contract with `.ok()`, deliberately: their dumps are const
// strings whose expressions parse today and are covered by the built-in
// composite tests, so the Err arm is unreachable in practice.

fn from_741(spec: &ElementSpec) -> Option<Composite> {
    let mut op = Composite::from_model(MODEL_741, EXTERNAL_741, None, "opampReal").ok()?;
    // The 741 configuration, `init741` (OpAmpRealElm.java:101-120). The
    // current multiplier scales the two output-stage resistors and the two
    // output transistors' betas together, so the delivered current follows
    // the `currentLimit` field.
    let slew = clamped_slew(spec.param("slewRate", 0.6));
    let cap_value = spec.param("capValue", 0.0);
    let current_limit = spec.param("currentLimit", DEFAULT_CURRENT_LIMIT);
    let current_mult = current_limit / DEFAULT_CURRENT_LIMIT;
    op.set_child_param(20, "capacitance", CAP_AT_UNITY_SLEW / (slew / 0.6));
    op.set_child_param(20, "voltDiff", cap_value);
    for (i, &r) in RESISTANCES_741.iter().enumerate() {
        let scaled = if i < 2 { r / current_mult } else { r };
        op.set_child_param(21 + i, "resistance", scaled);
    }
    op.set_child_param(13, "beta", current_mult * 100.0);
    op.set_child_param(18, "beta", current_mult * 100.0);
    Some(op)
}

fn from_324(spec: &ElementSpec) -> Option<Composite> {
    let tokens = dump_tokens(DUMP_324);
    let mut op = Composite::from_model(MODEL_324, EXTERNAL_324, Some(&tokens), "opampReal").ok()?;
    // The 324 configuration, `init324` (OpAmpRealElm.java:122-137): its own
    // slew-rate constant (10e-12 against the 741's 30e-12, tuned for the
    // 0.55 V/us default) and a different output-stage: one resistor and four
    // transistors, all named by the consts beside the netlist.
    let slew = clamped_slew(spec.param("slewRate", 0.6));
    let cap_value = spec.param("capValue", 0.0);
    let current_limit = spec.param("currentLimit", DEFAULT_CURRENT_LIMIT);
    let current_mult = current_limit / DEFAULT_CURRENT_LIMIT;
    op.set_child_param(LM324_CAP_CHILD, "capacitance", 10e-12 / (slew / 0.55));
    op.set_child_param(LM324_CAP_CHILD, "voltDiff", cap_value);
    op.set_child_param(LM324_OUT_RESISTOR_CHILD, "resistance", 25.0 / current_mult);
    for &i in &LM324_OUT_TRANSISTORS {
        op.set_child_param(i, "beta", current_mult * 100.0);
    }
    Some(op)
}

fn from_324v2() -> Option<Composite> {
    let tokens = dump_tokens(DUMP_324V2);
    // The v2 model takes no tuning after the dump (init324v2,
    // OpAmpRealElm.java:139-142): its compensation is fixed in the netlist and
    // `getCapacitor()` returns null (:149-153), so the slew rate and current
    // limit fields are carried but rescale nothing.
    Composite::from_model(MODEL_324V2, EXTERNAL_324V2, Some(&tokens), "opampReal").ok()
}

pub fn from_spec(spec: &ElementSpec) -> Option<Composite> {
    // Upstream parses the token with Integer.parseInt; any token that is not
    // exactly `1` or `2` (missing, non-integer, out of range) keeps the 741
    // default (OpAmpRealElm.java:82-86). A plain `as i64` truncation would
    // turn a fractional token like `1.5` into the 324, so match the exact
    // values the token can carry instead.
    let model_type = spec.param("modelType", 0.0);
    if model_type == 1.0 {
        from_324(spec)
    } else if model_type == 2.0 {
        from_324v2()
    } else {
        from_741(spec)
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    fn opamp_real_spec(slew: f64) -> ElementSpec {
        ElementSpec {
            id: 1,
            kind: "opampReal".into(),
            posts: Vec::new(),
            params: [("slewRate", slew)]
                .into_iter()
                .map(|(k, v)| (k.to_string(), v))
                .collect::<HashMap<_, _>>(),
            label: None,
            model: None,
            flags: 0,
        }
    }

    #[test]
    fn clamped_slew_guards_zero_negative_and_non_finite() {
        assert_eq!(clamped_slew(0.0), MIN_SLEW);
        assert_eq!(clamped_slew(-1.0), MIN_SLEW);
        assert_eq!(clamped_slew(f64::NAN), MIN_SLEW);
        assert_eq!(clamped_slew(f64::INFINITY), MIN_SLEW);
        assert_eq!(clamped_slew(f64::NEG_INFINITY), MIN_SLEW);
        assert_eq!(clamped_slew(0.6), 0.6);
        assert_eq!(clamped_slew(1.0), 1.0);
    }

    #[test]
    fn from_spec_clamps_zero_negative_and_nan_slew_rate() {
        // A file can carry `slewRate 0` (or negative, or NaN). Each must still
        // build a working composite. Every one of those clamps to the floor,
        // so the compensation capacitor lands on the same finite value, not
        // the inf/NaN `CAP_AT_UNITY_SLEW / (slew / 0.6)` a raw token would
        // give: that passes the capacitor's `value > 0.0` guard and is then
        // dropped by the stamper's `is_finite` check, collapsing the 741's
        // gain-bandwidth.
        for slew in [0.0, -1.0, f64::NAN] {
            assert!(
                from_spec(&opamp_real_spec(slew)).is_some(),
                "from_spec rejected slewRate {slew}"
            );
        }
        // The floor capacitance: the floor slew through the same division
        // `from_spec` uses for `set_child_param(20, "capacitance", ...)`.
        let cap = CAP_AT_UNITY_SLEW / (MIN_SLEW / 0.6);
        assert!(cap.is_finite(), "floor capacitance was {cap}");
        assert!(cap > 0.0, "floor capacitance was {cap}");
    }

    #[test]
    fn from_spec_keeps_a_positive_slew_rate_unclamped() {
        // A sane token must pass through untouched: the default slew sizes the
        // compensation capacitor at exactly `CAP_AT_UNITY_SLEW`.
        let op = from_spec(&opamp_real_spec(0.6));
        assert!(op.is_some(), "from_spec rejected slewRate 0.6");
        let cap = CAP_AT_UNITY_SLEW / (0.6 / 0.6);
        assert_eq!(cap, CAP_AT_UNITY_SLEW);
        assert_eq!(clamped_slew(0.6), 0.6);
    }
}
