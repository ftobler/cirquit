//! Device models and the factory that turns a [`ElementSpec`] into one.
//!
//! Adding an element means writing the model here and registering the same
//! `kind` string in the TypeScript element registry, which owns geometry,
//! drawing and the file-format mapping.
//!
//! One module per element type. `junction.rs` is the exception: it holds the
//! Newton machinery shared by the diode and transistor families.

pub mod capacitor;
pub mod current_source;
pub mod decoration;
pub mod diode;
pub mod fuse;
pub mod ground;
pub mod inductor;
pub mod junction;
pub mod labeled_node;
pub mod lamp;
pub mod ldr;
pub mod meter;
pub mod multi_throw_switch;
pub mod opamp;
pub mod potentiometer;
pub mod resistor;
pub mod switch;
pub mod thermistor;
pub mod transistor;
pub mod voltage_source;
pub mod wire;

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
    "fuse",
    "lamp",
    "thermistor",
    "potentiometer",
    "ldr",
    "voltage",
    "rail",
    "current",
    "diode",
    "zener",
    "varactor",
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
        "wire" => Box::new(wire::Wire::new(spec)),
        "ground" => Box::new(ground::Ground::new(spec)),
        "resistor" => Box::new(resistor::Resistor::new(spec)),
        "capacitor" => Box::new(capacitor::Capacitor::new(spec)),
        "polarizedCapacitor" => Box::new(capacitor::Capacitor::new_polarized(spec)),
        "inductor" => Box::new(inductor::Inductor::new(spec)),
        "fuse" => Box::new(fuse::Fuse::new(spec)),
        "lamp" => Box::new(lamp::Lamp::new(spec)),
        "thermistor" => Box::new(thermistor::Thermistor::new(spec)),
        "potentiometer" => Box::new(potentiometer::Potentiometer::new(spec)),
        "ldr" => Box::new(ldr::Ldr::new(spec)),
        "voltage" => Box::new(voltage_source::VoltageSource::new(spec)),
        "rail" => Box::new(voltage_source::VoltageSource::new_rail(spec)),
        "current" => Box::new(current_source::CurrentSource::new(spec)),
        "diode" => Box::new(diode::Diode::new(spec)),
        "zener" => Box::new(diode::Diode::new_zener(spec)),
        "varactor" => Box::new(diode::Diode::new_varactor(spec)),
        "transistor" => Box::new(transistor::BipolarTransistor::new(spec)),
        "switch" => Box::new(switch::Switch::new(spec)),
        "switch2" => Box::new(multi_throw_switch::MultiThrowSwitch::new(spec)),
        "opamp" => Box::new(opamp::OpAmp::new(spec)),
        "labeledNode" => Box::new(labeled_node::LabeledNode::new(spec)),
        "output" => Box::new(meter::Meter::new_output(spec)),
        "probe" => Box::new(meter::Meter::new_probe(spec)),
        "decoration" => Box::new(decoration::Decoration::new(spec)),
        _ => return None,
    };
    Some(e)
}
