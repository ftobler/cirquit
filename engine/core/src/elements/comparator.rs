//! Comparator (ComparatorElm.java, dump 401): an op-amp whose output drives an
//! analog switch that pulls the output post to a ground child's node. The
//! output is therefore open-drain style: it reads near ground when the
//! differential is positive, and an external pull-up raises it when the
//! op-amp's output rail drops below the switch's threshold. The three-child
//! model and the external node order are upstream's own (ComparatorElm.java:
//! 8-9).

use crate::elements::composite::Composite;
use crate::spec::ElementSpec;

/// The op-amp drives node 3; the analog switch spans the output post (node 4)
/// to the ground child's node 5 and is controlled by node 3, exactly
/// ComparatorElm.java:8-9. The ground child pins node 5 to the reference.
const MODEL: &str = "OpAmpElm 1 2 3\rAnalogSwitchElm 4 5 3\rGroundElm 5";

/// The three posts in setPoints order (ComparatorElm.java:86-88): the
/// inverting input (node 2), the non-inverting input (node 1), the output
/// (node 4).
const EXTERNAL: &[usize] = &[2, 1, 4];

pub fn from_spec(spec: &ElementSpec) -> Option<Composite> {
    let dumps: Option<Vec<String>> = spec
        .model
        .as_deref()
        .and_then(|m| serde_json::from_str(m).ok());
    // Folding a child-expression failure into the Option contract is
    // deliberate: this model is a const string and its children carry no
    // expressions, so `from_model` cannot fail here; if it ever did, the
    // built-in composite tests would fail loudly.
    Composite::from_model(MODEL, EXTERNAL, dumps.as_deref(), "comparator").ok()
}
