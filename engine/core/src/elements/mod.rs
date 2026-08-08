//! Device models and the factory that turns a [`ElementSpec`] into one.
//!
//! Adding an element means writing the model here and registering the same
//! `kind` string in the TypeScript element registry, which owns geometry,
//! drawing and the file-format mapping.
//!
//! One module per element type. `junction.rs` is the exception: it holds the
//! Newton machinery shared by the diode and transistor families.

pub mod analog_switch;
pub mod analog_switch2;
pub mod audio_output;
pub mod capacitor;
pub mod chip;
pub mod counter;
pub mod current_source;
pub mod d_flip_flop;
pub mod decoration;
pub mod diode;
pub mod ext_voltage;
pub mod fuse;
pub mod ground;
pub mod inductor;
pub mod inverter;
pub mod jk_flip_flop;
pub mod junction;
pub mod labeled_node;
pub mod lamp;
pub mod latch;
pub mod ldr;
pub mod led;
pub mod logic;
pub mod logic_input;
pub mod logic_output;
pub mod memristor;
pub mod meter;
pub mod mosfet;
pub mod multi_throw_switch;
pub mod opamp;
pub mod potentiometer;
pub mod probe;
pub mod relay;
pub mod resistor;
pub mod ring_counter;
pub mod schmitt;
pub mod sweep;
pub mod switch;
pub mod t_flip_flop;
pub mod thermistor;
pub mod timer;
pub mod transformer;
pub mod transistor;
pub mod transmission_line;
pub mod tri_state;
pub mod var_rail;
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
    "timer",
    "potentiometer",
    "ldr",
    "memristor",
    "voltage",
    "rail",
    "varRail",
    "extVoltage",
    "current",
    "diode",
    "zener",
    "varactor",
    "led",
    "transistor",
    "mosfet",
    "switch",
    "sweep",
    "analogSwitch",
    "audioOutput",
    "switch2",
    "analogSwitch2",
    "transformer",
    "tappedTransformer",
    "customTransformer",
    "transmissionLine",
    "relay",
    "relayCoil",
    "relayContact",
    "opamp",
    "inverter",
    "logicInput",
    "andGate",
    "nandGate",
    "orGate",
    "norGate",
    "xorGate",
    "xnorGate",
    "dFlipFlop",
    "jkFlipFlop",
    "tFlipFlop",
    "latch",
    "ringCounter",
    "counter",
    "triState",
    "schmitt",
    "invertingSchmitt",
    "labeledNode",
    "output",
    "logicOutput",
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
        "timer" => Box::new(timer::Timer::new(spec)),
        "memristor" => Box::new(memristor::Memristor::new(spec)),
        "potentiometer" => Box::new(potentiometer::Potentiometer::new(spec)),
        "ldr" => Box::new(ldr::Ldr::new(spec)),
        "voltage" => Box::new(voltage_source::VoltageSource::new(spec)),
        "rail" => Box::new(voltage_source::VoltageSource::new_rail(spec)),
        "varRail" => Box::new(var_rail::VarRail::new(spec)),
        "extVoltage" => Box::new(ext_voltage::ExtVoltage::new(spec)),
        "current" => Box::new(current_source::CurrentSource::new(spec)),
        "diode" => Box::new(diode::Diode::new(spec)),
        "zener" => Box::new(diode::Diode::new_zener(spec)),
        "varactor" => Box::new(diode::Diode::new_varactor(spec)),
        "led" => Box::new(led::Led::new(spec)),
        "transistor" => Box::new(transistor::BipolarTransistor::new(spec)),
        "mosfet" => Box::new(mosfet::Mosfet::new(spec)),
        "switch" => Box::new(switch::Switch::new(spec)),
        "sweep" => Box::new(sweep::Sweep::new(spec)),
        "analogSwitch" => Box::new(analog_switch::AnalogSwitch::new(spec)),
        "audioOutput" => Box::new(audio_output::AudioOutput::new(spec)),
        "switch2" => Box::new(multi_throw_switch::MultiThrowSwitch::new(spec)),
        "analogSwitch2" => Box::new(analog_switch2::AnalogSwitch2::new(spec)),
        "transformer" => Box::new(transformer::Transformer::new_basic(spec)),
        "tappedTransformer" => Box::new(transformer::Transformer::new_tapped(spec)),
        "customTransformer" => Box::new(transformer::Transformer::new_custom(spec)),
        "transmissionLine" => Box::new(transmission_line::TransmissionLine::new(spec)),
        "relay" => Box::new(relay::Relay::new(spec)),
        "relayCoil" => Box::new(relay::RelayCoil::new(spec)),
        "relayContact" => Box::new(relay::RelayContact::new(spec)),
        "opamp" => Box::new(opamp::OpAmp::new(spec)),
        "inverter" => Box::new(inverter::Inverter::new(spec)),
        "logicInput" => Box::new(logic_input::LogicInput::new(spec)),
        "andGate" => Box::new(logic::Gate::new(spec, logic::GateKind::And)),
        "nandGate" => Box::new(logic::Gate::new(spec, logic::GateKind::Nand)),
        "orGate" => Box::new(logic::Gate::new(spec, logic::GateKind::Or)),
        "norGate" => Box::new(logic::Gate::new(spec, logic::GateKind::Nor)),
        "xorGate" => Box::new(logic::Gate::new(spec, logic::GateKind::Xor)),
        "xnorGate" => Box::new(logic::Gate::new(spec, logic::GateKind::Xnor)),
        "dFlipFlop" => Box::new(d_flip_flop::DFlipFlop::new(spec)),
        "jkFlipFlop" => Box::new(jk_flip_flop::JKFlipFlop::new(spec)),
        "tFlipFlop" => Box::new(t_flip_flop::TFlipFlop::new(spec)),
        "latch" => Box::new(latch::Latch::new(spec)),
        "ringCounter" => Box::new(ring_counter::RingCounter::new(spec)),
        "counter" => Box::new(counter::Counter::new(spec)),
        "triState" => Box::new(tri_state::TriState::new(spec)),
        "schmitt" => Box::new(schmitt::Schmitt::new(spec, false)),
        "invertingSchmitt" => Box::new(schmitt::Schmitt::new(spec, true)),
        "labeledNode" => Box::new(labeled_node::LabeledNode::new(spec)),
        "output" => Box::new(meter::Meter::new_output(spec)),
        "logicOutput" => Box::new(logic_output::LogicOutput::new(spec)),
        "probe" => Box::new(probe::Probe::new(spec)),
        "decoration" => Box::new(decoration::Decoration::new(spec)),
        _ => return None,
    };
    Some(e)
}
