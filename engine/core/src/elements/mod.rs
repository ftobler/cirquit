//! Device models and the factory that turns a [`ElementSpec`] into one.
//!
//! Adding an element means writing the model here and registering the same
//! `kind` string in the TypeScript element registry, which owns geometry,
//! drawing and the file-format mapping.
//!
//! One module per element type. `junction.rs` is the exception: it holds the
//! Newton machinery shared by the diode and transistor families.
//!
//! Flag naming: per-element `FLAG_*` constants are private to their
//! module and may repeat a name at a different bit value per element
//! (`FLAG_PULLDOWN` alone is 2 in the analog switch family and mux,
//! 4 in logic_output, 16 in relay). Read them per module; hoisting one
//! into a shared constant needs a per-element rename, like the
//! TypeScript side's `CHIP_*`/`RELAY_*` prefixes.

pub mod adc;
pub mod am;
pub mod ammeter;
pub mod analog_mux;
pub mod analog_switch;
pub mod analog_switch2;
pub mod antenna;
pub mod audio_input;
pub mod audio_output;
pub mod battery;
pub mod r#box;
pub mod bus_logic_input;
pub mod bus_splitter;
pub mod bus_transceiver;
pub mod capacitor;
pub mod cc2;
pub mod cccs;
pub mod ccvs;
pub mod chip;
pub mod comparator;
pub mod composite;
pub mod controlled_source;
pub mod counter;
pub mod counter2;
pub mod cross_switch;
pub mod crystal;
pub mod current_source;
pub mod custom_logic;
pub mod d_flip_flop;
pub mod dac;
pub mod darlington;
pub mod data_input;
pub mod data_recorder;
pub mod dc_motor;
pub mod de_multiplexer;
pub mod decimal_display;
pub mod decoration;
pub mod delay_buffer;
pub mod diac;
pub mod diode;
pub mod dpdt_switch;
pub mod ext_voltage;
pub mod fm;
pub mod full_adder;
pub mod fuse;
pub mod ground;
pub mod half_adder;
pub mod inductor;
pub mod instruction_display;
pub mod inverter;
pub mod jfet;
pub mod jk_flip_flop;
pub mod junction;
pub mod labeled_node;
pub mod lamp;
pub mod latch;
pub mod ldr;
pub mod led;
pub mod led_array;
pub mod line;
pub mod logic;
pub mod logic_input;
pub mod logic_output;
pub mod mbb_switch;
pub mod memristor;
pub mod meter;
pub mod monostable;
pub mod mosfet;
pub mod motor_protection_switch;
pub mod multi_throw_switch;
pub mod multiplexer;
pub mod noise;
pub mod ohmmeter;
pub mod opamp;
pub mod opamp_real;
pub mod optocoupler;
pub mod ota;
pub mod phase_comp;
pub mod piso_shift;
pub mod potentiometer;
pub mod probe;
pub mod relay;
pub mod resistor;
pub mod ring_counter;
pub mod schmitt;
pub mod scope;
pub mod scr;
pub mod seq_gen;
pub mod seven_seg;
pub mod seven_seg_decoder;
pub mod sipo_shift;
pub mod spark_gap;
pub mod sram;
pub mod stop_trigger;
pub mod sweep;
pub mod switch;
pub mod t_flip_flop;
pub mod test_point;
pub mod thermistor;
pub mod three_phase_motor;
pub mod time_delay_relay;
pub mod timer;
pub mod transformer;
pub mod transistor;
pub mod transmission_line;
pub mod tri_state;
pub mod triac;
pub mod triode;
pub mod tunnel_diode;
pub mod unijunction;
pub mod var_rail;
pub mod vccs;
pub mod vco;
pub mod vcvs;
pub mod voltage_source;
pub mod wattmeter;
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
    "threePhaseMotor",
    "timer",
    "potentiometer",
    "ldr",
    "memristor",
    "motorProtectionSwitch",
    "dcMotor",
    "timeDelayRelay",
    "mbbSwitch",
    "dpdtSwitch",
    "voltage",
    "rail",
    "noise",
    "antenna",
    "am",
    "fm",
    "varRail",
    "extVoltage",
    "vco",
    "dac",
    "current",
    "battery",
    "darlington",
    "diode",
    "zener",
    "varactor",
    "led",
    "ledArray",
    "tunnelDiode",
    "diac",
    "transistor",
    "jfet",
    "mosfet",
    "triode",
    "switch",
    "sweep",
    "analogSwitch",
    "audioOutput",
    "audioInput",
    "dataInput",
    "switch2",
    "crossSwitch",
    "analogSwitch2",
    "analogMux",
    "transformer",
    "tappedTransformer",
    "customTransformer",
    "transmissionLine",
    "relay",
    "relayCoil",
    "relayContact",
    "opamp",
    "ota",
    "composite",
    "comparator",
    "opampReal",
    "optocoupler",
    "crystal",
    "phaseComp",
    "instructionDisplay",
    "inverter",
    "delayBuffer",
    "logicInput",
    "andGate",
    "nandGate",
    "orGate",
    "norGate",
    "xorGate",
    "xnorGate",
    "dFlipFlop",
    "decimalDisplay",
    "deMultiplexer",
    "jkFlipFlop",
    "tFlipFlop",
    "latch",
    "ringCounter",
    "counter",
    "counter2",
    "halfAdder",
    "fullAdder",
    "pisoShift",
    "sipoShift",
    "seqGen",
    "monostable",
    "adc",
    "multiplexer",
    "customLogic",
    "triState",
    "schmitt",
    "invertingSchmitt",
    "sparkGap",
    "scr",
    "triac",
    "sevenSeg",
    "sevenSegDecoder",
    "sram",
    "rom",
    "busSplitter",
    "busLogicInput",
    "busTransceiver",
    "labeledNode",
    "output",
    "logicOutput",
    "probe",
    "ammeter",
    "ohmmeter",
    "testPoint",
    "wattmeter",
    "dataRecorder",
    "stopTrigger",
    "decoration",
    "box",
    "line",
    "scope",
    "cc2",
    "vcvs",
    "vccs",
    "ccvs",
    "cccs",
    "unijunction",
];

/// Builds the model for a spec. Errors name the element and the offending
/// parameter when a spec value would silently vanish at stamp time (a
/// resistance of zero stamps no conductance, so upstream's loud 1/0 must be
/// answered by an equally loud build rejection here), or would stamp an
/// active negative resistance instead (a negative capacitor, inductor or
/// transformer winding companion grows the solution every step), or would
/// attempt an unbounded allocation before the global size guards ever run
/// (an LED array grid outside the dialog range, a custom transformer above
/// the coil cap), or `unknown element type` for a kind this engine does not
/// implement.
pub fn build_element(spec: &ElementSpec) -> Result<Box<dyn Element>, String> {
    let e: Box<dyn Element> = match spec.kind.as_str() {
        "wire" => Box::new(wire::Wire::new(spec)),
        "ground" => Box::new(ground::Ground::new(spec)),
        "resistor" => Box::new(resistor::Resistor::new(spec)?),
        "capacitor" => Box::new(capacitor::Capacitor::new(spec)?),
        "polarizedCapacitor" => Box::new(capacitor::Capacitor::new_polarized(spec)?),
        "inductor" => Box::new(inductor::Inductor::new(spec)?),
        "fuse" => Box::new(fuse::Fuse::new(spec)?),
        "lamp" => Box::new(lamp::Lamp::new(spec)?),
        "thermistor" => Box::new(thermistor::Thermistor::new(spec)),
        "threePhaseMotor" => Box::new(three_phase_motor::ThreePhaseMotor::new(spec)),
        "timer" => Box::new(timer::Timer::new(spec)),
        "memristor" => Box::new(memristor::Memristor::new(spec)),
        "motorProtectionSwitch" => {
            Box::new(motor_protection_switch::MotorProtectionSwitch::new(spec))
        }
        "dcMotor" => Box::new(dc_motor::DcMotor::new(spec)?),
        "timeDelayRelay" => Box::new(time_delay_relay::TimeDelayRelay::new(spec)),
        "mbbSwitch" => Box::new(mbb_switch::MbbSwitch::new(spec)),
        "dpdtSwitch" => Box::new(dpdt_switch::DpdtSwitch::new(spec)),
        "potentiometer" => Box::new(potentiometer::Potentiometer::new(spec)),
        "ldr" => Box::new(ldr::Ldr::new(spec)),
        "voltage" => Box::new(voltage_source::VoltageSource::new(spec)),
        "rail" => Box::new(voltage_source::VoltageSource::new_rail(spec)),
        "noise" => Box::new(noise::Noise::new(spec)),
        "antenna" => Box::new(antenna::Antenna::new(spec)),
        "am" => Box::new(am::AM::new(spec)),
        "fm" => Box::new(fm::FM::new(spec)),
        "varRail" => Box::new(var_rail::VarRail::new(spec)),
        "extVoltage" => Box::new(ext_voltage::ExtVoltage::new(spec)),
        "vco" => Box::new(vco::Vco::new(spec)),
        "dac" => Box::new(dac::Dac::new(spec)),
        "current" => Box::new(current_source::CurrentSource::new(spec)),
        "battery" => Box::new(battery::Battery::new(spec)),
        "darlington" => Box::new(darlington::Darlington::new(spec)),
        "diode" => Box::new(diode::Diode::new(spec)),
        "zener" => Box::new(diode::Diode::new_zener(spec)),
        "varactor" => Box::new(diode::Diode::new_varactor(spec)),
        "led" => Box::new(led::Led::new(spec)),
        "ledArray" => Box::new(led_array::LedArray::new(spec)?),
        "tunnelDiode" => Box::new(tunnel_diode::TunnelDiode::new(spec)),
        "diac" => Box::new(diac::Diac::new(spec)),
        "transistor" => Box::new(transistor::BipolarTransistor::new(spec)),
        "jfet" => Box::new(jfet::Jfet::new(spec)),
        "mosfet" => Box::new(mosfet::Mosfet::new(spec)),
        "triode" => Box::new(triode::Triode::new(spec)),
        "switch" => Box::new(switch::Switch::new(spec)),
        "sweep" => Box::new(sweep::Sweep::new(spec)),
        "analogSwitch" => Box::new(analog_switch::AnalogSwitch::new(spec)),
        "audioOutput" => Box::new(audio_output::AudioOutput::new(spec)),
        "audioInput" => Box::new(audio_input::AudioInput::new(spec)),
        "dataInput" => Box::new(data_input::DataInput::new(spec)),
        "switch2" => Box::new(multi_throw_switch::MultiThrowSwitch::new(spec)),
        "crossSwitch" => Box::new(cross_switch::CrossSwitch::new(spec)),
        "analogSwitch2" => Box::new(analog_switch2::AnalogSwitch2::new(spec)),
        "analogMux" => Box::new(analog_mux::AnalogMux::new(spec)),
        "transformer" => Box::new(transformer::Transformer::new_basic(spec)?),
        "tappedTransformer" => Box::new(transformer::Transformer::new_tapped(spec)?),
        "customTransformer" => Box::new(transformer::Transformer::new_custom(spec)?),
        "transmissionLine" => Box::new(transmission_line::TransmissionLine::new(spec)),
        "relay" => Box::new(relay::Relay::new(spec)?),
        "relayCoil" => Box::new(relay::RelayCoil::new(spec)?),
        "relayContact" => Box::new(relay::RelayContact::new(spec)),
        "opamp" => Box::new(opamp::OpAmp::new(spec)),
        "ota" => {
            let c = model_composite(spec, ota::from_spec(spec))?;
            Box::new(c)
        }
        // The generic composite's model blob is file content, so its builder
        // reports failures itself and they surface verbatim; the built-in
        // kinds keep the Option contract via `model_composite`.
        "composite" => Box::new(composite::Composite::from_spec(spec)?),
        "comparator" => {
            let c = model_composite(spec, comparator::from_spec(spec))?;
            Box::new(c)
        }
        "opampReal" => {
            let c = model_composite(spec, opamp_real::from_spec(spec))?;
            Box::new(c)
        }
        "optocoupler" => {
            let c = model_composite(spec, optocoupler::from_spec(spec))?;
            Box::new(c)
        }
        "crystal" => {
            let c = model_composite(spec, crystal::from_spec(spec))?;
            Box::new(c)
        }
        "phaseComp" => Box::new(phase_comp::PhaseComp::new(spec)),
        "inverter" => Box::new(inverter::Inverter::new(spec)),
        "instructionDisplay" => Box::new(instruction_display::InstructionDisplay::new(spec)),
        "delayBuffer" => Box::new(delay_buffer::DelayBuffer::new(spec)),
        "logicInput" => Box::new(logic_input::LogicInput::new(spec)),
        "andGate" => Box::new(logic::Gate::new(spec, logic::GateKind::And)),
        "nandGate" => Box::new(logic::Gate::new(spec, logic::GateKind::Nand)),
        "orGate" => Box::new(logic::Gate::new(spec, logic::GateKind::Or)),
        "norGate" => Box::new(logic::Gate::new(spec, logic::GateKind::Nor)),
        "xorGate" => Box::new(logic::Gate::new(spec, logic::GateKind::Xor)),
        "xnorGate" => Box::new(logic::Gate::new(spec, logic::GateKind::Xnor)),
        "dFlipFlop" => Box::new(d_flip_flop::DFlipFlop::new(spec)),
        "decimalDisplay" => Box::new(decimal_display::DecimalDisplay::new(spec)),
        "deMultiplexer" => Box::new(de_multiplexer::DeMultiplexer::new(spec)),
        "jkFlipFlop" => Box::new(jk_flip_flop::JKFlipFlop::new(spec)),
        "tFlipFlop" => Box::new(t_flip_flop::TFlipFlop::new(spec)),
        "latch" => Box::new(latch::Latch::new(spec)),
        "ringCounter" => Box::new(ring_counter::RingCounter::new(spec)),
        "counter" => Box::new(counter::Counter::new(spec)),
        "counter2" => Box::new(counter2::Counter2::new(spec)),
        "halfAdder" => Box::new(half_adder::HalfAdder::new(spec)),
        "fullAdder" => Box::new(full_adder::FullAdder::new(spec)),
        "pisoShift" => Box::new(piso_shift::PisoShift::new(spec)),
        "sipoShift" => Box::new(sipo_shift::SipoShift::new(spec)),
        "seqGen" => Box::new(seq_gen::SeqGen::new(spec)?),
        "monostable" => Box::new(monostable::Monostable::new(spec)),
        "adc" => Box::new(adc::Adc::new(spec)),
        "multiplexer" => Box::new(multiplexer::Multiplexer::new(spec)),
        "customLogic" => Box::new(model_composite(spec, custom_logic::CustomLogic::new(spec))?),
        "triState" => Box::new(tri_state::TriState::new(spec)),
        "schmitt" => Box::new(schmitt::Schmitt::new(spec, false)),
        "invertingSchmitt" => Box::new(schmitt::Schmitt::new(spec, true)),
        "sparkGap" => Box::new(spark_gap::SparkGap::new(spec)),
        "scr" => Box::new(scr::Scr::new(spec)),
        "triac" => Box::new(triac::Triac::new(spec)),
        "sevenSeg" => Box::new(seven_seg::SevenSeg::new(spec)?),
        "sevenSegDecoder" => Box::new(seven_seg_decoder::SevenSegDecoder::new(spec)),
        "sram" => Box::new(sram::Sram::new(spec, true)),
        "rom" => Box::new(sram::Sram::new(spec, false)),
        "busSplitter" => Box::new(bus_splitter::BusSplitter::new(spec)),
        "busLogicInput" => Box::new(bus_logic_input::BusLogicInput::new(spec)),
        "busTransceiver" => Box::new(bus_transceiver::BusTransceiver::new(spec)),
        "labeledNode" => Box::new(labeled_node::LabeledNode::new(spec)),
        "output" => Box::new(meter::Meter::new_output(spec)),
        "logicOutput" => Box::new(logic_output::LogicOutput::new(spec)),
        "probe" => Box::new(probe::Probe::new(spec)),
        "ammeter" => Box::new(ammeter::Ammeter::new(spec)),
        "ohmmeter" => Box::new(ohmmeter::Ohmmeter::new(spec)),
        "testPoint" => Box::new(test_point::TestPoint::new(spec)),
        "wattmeter" => Box::new(wattmeter::Wattmeter::new(spec)),
        "dataRecorder" => Box::new(data_recorder::DataRecorder::new(spec)?),
        "stopTrigger" => Box::new(stop_trigger::StopTrigger::new(spec)),
        "decoration" => Box::new(decoration::Decoration::new(spec)),
        "box" => Box::new(r#box::Box::new(spec)),
        "line" => Box::new(line::Line::new(spec)),
        "scope" => Box::new(scope::Scope::new(spec)),
        "cc2" => Box::new(cc2::Cc2::new(spec)),
        "vcvs" => Box::new(vcvs::Vcvs::new(spec)),
        "vccs" => Box::new(vccs::Vccs::new(spec)),
        "ccvs" => Box::new(ccvs::Ccvs::new(spec)),
        "cccs" => Box::new(cccs::Cccs::new(spec)),
        "unijunction" => Box::new(unijunction::Unijunction::new(spec)),
        _ => {
            return Err(format!(
                "unknown element type '{}' (id {})",
                spec.kind, spec.id
            ))
        }
    };
    Ok(e)
}

/// Names a model-driven composite that failed to build from its `spec.model`
/// blob. Builders return `None` when that definition is missing or
/// malformed, or when a const-string wrapper folds a child-expression
/// failure into its Option contract; either way the error names the
/// element's kind and id so a hand-edited netlist points at the offending
/// line.
fn model_composite<E: Element + 'static>(
    spec: &ElementSpec,
    built: Option<E>,
) -> Result<E, String> {
    built.ok_or_else(|| {
        format!(
            "element '{}' (id {}) has a missing or malformed model definition",
            spec.kind, spec.id
        )
    })
}
