//! Quartz crystal (CrystalElm.java, dump 412): the motional LCR branch in
//! parallel with the holder capacitance, the standard two-pole model. The four
//! children are upstream's own (CrystalElm.java:31): the parallel capacitance
//! across the posts, then the series branch with the capacitance, the
//! inductance and the resistance between the same two posts.
//!
//! The motional parameters are the element's own fields, edited by name and
//! applied onto the matching child by `from_spec` and the composite's live
//! `set_param` routing. A saved 412 line carries the four child dumps, so the
//! values also reach the engine through the `_`-joined tokens, but the params
//! always win: the frontend keeps them in step with the tokens (crystal.ts),
//! and a fresh element has no tokens at all.

use crate::elements::composite::Composite;
use crate::spec::ElementSpec;

/// The model string, node ids 1..4 with the external pair 1, 2 as the posts
/// (CrystalElm.java:31-32).
const MODEL: &str = "CapacitorElm 1 2\rCapacitorElm 1 3\rInductorElm 3 4\rResistorElm 4 2";
const EXTERNAL: &[usize] = &[1, 2];

/// The default motional parameters (CrystalElm.java:37-40).
pub const DEF_PARALLEL_CAP: f64 = 28.7e-12;
pub const DEF_SERIES_CAP: f64 = 0.1e-12;
pub const DEF_INDUCTANCE: f64 = 2.5e-3;
pub const DEF_RESISTANCE: f64 = 6.4;

pub fn from_spec(spec: &ElementSpec) -> Option<Composite> {
    let dumps: Option<Vec<String>> = spec
        .model
        .as_deref()
        .and_then(|m| serde_json::from_str(m).ok());
    // Folding a child-expression failure into the Option contract is
    // deliberate: the const model's children are passive parts, which carry
    // no expressions, so `from_model` cannot fail here; if it ever did, the
    // built-in composite tests would fail loudly.
    let mut crystal = Composite::from_model(MODEL, EXTERNAL, dumps.as_deref(), "crystal").ok()?;
    crystal.set_child_param(
        0,
        "capacitance",
        spec.param("parallelCapacitance", DEF_PARALLEL_CAP),
    );
    crystal.set_child_param(
        1,
        "capacitance",
        spec.param("seriesCapacitance", DEF_SERIES_CAP),
    );
    crystal.set_child_param(2, "inductance", spec.param("inductance", DEF_INDUCTANCE));
    crystal.set_child_param(3, "resistance", spec.param("resistance", DEF_RESISTANCE));
    Some(crystal)
}
