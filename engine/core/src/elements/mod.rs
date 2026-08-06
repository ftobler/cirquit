//! Device models and the factory that turns a [`ElementSpec`] into one.
//!
//! Adding an element means writing the model here and registering the same
//! `kind` string in the TypeScript element registry, which owns geometry,
//! drawing and the file-format mapping.

pub mod active;
pub mod misc;
pub mod passive;
pub mod semiconductor;
pub mod sources;

use crate::element::Element;
use crate::spec::ElementSpec;

/// Every element type the engine can simulate.
pub const KINDS: &[&str] = &[
    "wire",
    "ground",
    "resistor",
    "capacitor",
    "polarizedCapacitor",
    "inductor",
    "potentiometer",
    "voltage",
    "rail",
    "current",
    "diode",
    "zener",
    "transistor",
    "switch",
    "switch2",
    "opamp",
    "labeledNode",
    "output",
    "probe",
    "decoration",
];

/// Builds the model for a spec, or `None` if the type is not implemented yet.
pub fn build_element(spec: &ElementSpec) -> Option<Box<dyn Element>> {
    let e: Box<dyn Element> = match spec.kind.as_str() {
        "wire" => Box::new(passive::Wire::new(spec)),
        "ground" => Box::new(passive::Ground::new(spec)),
        "resistor" => Box::new(passive::Resistor::new(spec)),
        "capacitor" => Box::new(passive::Capacitor::new(spec)),
        "polarizedCapacitor" => Box::new(passive::Capacitor::new_polarized(spec)),
        "inductor" => Box::new(passive::Inductor::new(spec)),
        "potentiometer" => Box::new(passive::Potentiometer::new(spec)),
        "voltage" => Box::new(sources::VoltageSource::new(spec)),
        "rail" => Box::new(sources::VoltageSource::new_rail(spec)),
        "current" => Box::new(sources::CurrentSource::new(spec)),
        "diode" => Box::new(semiconductor::Diode::new(spec)),
        "zener" => Box::new(semiconductor::Diode::new_zener(spec)),
        "transistor" => Box::new(semiconductor::BipolarTransistor::new(spec)),
        "switch" => Box::new(active::Switch::new(spec)),
        "switch2" => Box::new(active::MultiThrowSwitch::new(spec)),
        "opamp" => Box::new(active::OpAmp::new(spec)),
        "labeledNode" => Box::new(misc::LabeledNode::new(spec)),
        "output" => Box::new(misc::Meter::new_output(spec)),
        "probe" => Box::new(misc::Meter::new_probe(spec)),
        "decoration" => Box::new(misc::Decoration::new(spec)),
        _ => return None,
    };
    Some(e)
}
