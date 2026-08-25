//! Optocoupler (OptocouplerElm.java, dump 407): an LED whose current is
//! sensed by a CCCS whose output feeds a phototransistor's base, the upstream
//! three-child model (OptocouplerElm.java:14). The light path is the CCCS's
//! expression, upstream's own CTR polynomial (OptocouplerElm.java:70-72)
//! scaled by the `ctr` field; the transistor beta is fixed at 700
//! (OptocouplerElm.java:75).
//!
//! Upstream loads the children with a null token stream
//! (OptocouplerElm.java:29-34), so the child dumps a saved 407 line carries
//! are ignored and every build recreates the defaults. This port does the
//! same: the composite is built without dump tokens and the parent then
//! applies `ctr` and the fixed beta.

use crate::elements::composite::Composite;
use crate::spec::ElementSpec;

/// The LED (anode 6, cathode 1), the CCCS (sense pair 1-2 in the cathode
/// return, output pair 3-4), and the phototransistor (base 3, collector 4,
/// emitter 5).
const MODEL: &str = "DiodeElm 6 1\rCCCSElm 1 2 3 4\rNTransistorElm 3 4 5";

/// The four posts in setPoints order: the LED anode (node 6), the LED
/// cathode's ground return (node 2), the collector (node 4), the emitter
/// (node 5).
const EXTERNAL: &[usize] = &[6, 2, 4, 5];

/// The CTR curve for a ~100% device, upstream's own expression
/// (OptocouplerElm.java:70-72): the LED current `i` picks one of two
/// polynomial branches at 3 mA, and the result is the phototransistor's base
/// drive in the model's units. `select` and the polynomial operators are all
/// supported by the port's expression parser.
const CTR_BASE: &str = "max(0,min(.0001, select(i-.003, \
(-80000000000*(i)^5+800000000*(i)^4-3000000*(i)^3+5177.2*(i)^2+.2453*(i)-.00005)*1.04/700, \
(9000000*(i)^5-998113*(i)^4+42174*(i)^3-861.32*(i)^2+9.0836*(i)-.0078)*.945/700)))";

pub fn from_spec(spec: &ElementSpec) -> Option<Composite> {
    // Folding a child-expression failure into the Option contract is
    // deliberate: the model builds with no dump tokens at all, so
    // `from_model` cannot fail here; if it ever did, the built-in composite
    // tests would fail loudly.
    let mut opto = Composite::from_model(MODEL, EXTERNAL, None, "optocoupler").ok()?;
    // Upstream forces the internal LED to its own `default-optocoupler-led`
    // model (OptocouplerElm.java:25, DiodeModel.java:92:
    // (1.714e-7, 0., 4.077, 0., null)). Only the emission coefficient (4.077
    // vs the port default's 2) differs from `default`, but that shifts the LED
    // forward drop at a given current and therefore the current a fixed input
    // voltage drives; the CTR polynomial itself is model-independent.
    opto.set_child_param(0, "saturationCurrent", 1.714e-7);
    opto.set_child_param(0, "emissionCoefficient", 4.077);
    let ctr = spec.param("ctr", 1.0);
    opto.set_child_string(1, "expr", &format!("{ctr}*{CTR_BASE}"));
    opto.set_child_param(2, "beta", 700.0);
    Some(opto)
}
