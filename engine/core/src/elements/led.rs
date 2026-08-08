//! Light-emitting diode: the port's Shockley diode with the LED's brighter
//! forward drop and frontend-only colour state.

use crate::element::{Base, Element, SimCtx};
use crate::elements::diode::Diode;
use crate::spec::ElementSpec;
use crate::stamp::Stamper;

/// The LED's rated forward drop, the `fwdrop` a flagless `162` line falls
/// back to (LEDElm.java:41). Seeded into the spec exactly like the plain
/// diode's own `DEFAULT_FWDROP`: `Diode::build` anchors the saturation
/// current on the drop, so the whole default I-V curve follows.
const LED_FWDROP: f64 = 2.102_425_9;

/// A diode carrying the LED's colour and brightness state. The colour only
/// drives the frontend's glow; the simulator sees the same junction the
/// `Diode` model always stamps, and this wrapper is the zener/varactor
/// pattern of one element kind reusing the diode model wholesale.
pub struct Led {
    diode: Diode,
    /// Red component of the emitted colour, 0..1 (LEDElm.java:27).
    #[allow(dead_code)]
    color_r: f64,
    /// Green component of the emitted colour, 0..1.
    #[allow(dead_code)]
    color_g: f64,
    /// Blue component of the emitted colour, 0..1.
    #[allow(dead_code)]
    color_b: f64,
    /// Current at which the LED reaches full brightness, 0.01 A by default
    /// (LEDElm.java:28).
    #[allow(dead_code)]
    max_brightness_current: f64,
}

impl Led {
    pub fn new(spec: &ElementSpec) -> Self {
        // The LED's own drop, not the diode's 0.806 V: a bare `162` line with
        // neither FLAG_MODEL nor FLAG_FWDROP reads no forward-drop token, and
        // upstream falls back to 2.1024259 there (LEDElm.java:40-46), so the
        // inner Diode must be handed one to anchor its curve on. Clone rather
        // than mutate: the spec outlives the model.
        let mut spec = spec.clone();
        if !spec.params.contains_key("forwardVoltage") {
            spec.params.insert("forwardVoltage".into(), LED_FWDROP);
        }
        Self {
            diode: Diode::new(&spec),
            color_r: spec.param("colorR", 1.0),
            color_g: spec.param("colorG", 0.0),
            color_b: spec.param("colorB", 0.0),
            max_brightness_current: spec.param("maxBrightnessCurrent", 0.01),
        }
    }
}

impl Element for Led {
    fn kind(&self) -> &'static str {
        "led"
    }
    fn base(&self) -> &Base {
        self.diode.base()
    }
    fn base_mut(&mut self) -> &mut Base {
        self.diode.base_mut()
    }
    fn post_count(&self) -> usize {
        2
    }
    fn nonlinear(&self) -> bool {
        true
    }
    /// The series-resistance junction node, when the model has one.
    fn internal_node_count(&self) -> usize {
        self.diode.internal_node_count()
    }
    fn stamp(&mut self, ctx: &SimCtx, s: &mut Stamper) {
        self.diode.stamp(ctx, s);
    }
    fn start_iteration(&mut self, ctx: &SimCtx) {
        self.diode.start_iteration(ctx);
    }
    fn do_step(&mut self, ctx: &SimCtx, s: &mut Stamper) {
        self.diode.do_step(ctx, s);
    }
    fn step_finished(&mut self, ctx: &SimCtx) {
        self.diode.step_finished(ctx);
    }
    fn restore_iteration(&mut self) {
        self.diode.restore_iteration();
    }
    fn calculate_current(&mut self, ctx: &SimCtx) {
        self.diode.calculate_current(ctx);
    }
    fn set_param(&mut self, name: &str, value: f64) -> bool {
        match name {
            "colorR" => self.color_r = value,
            "colorG" => self.color_g = value,
            "colorB" => self.color_b = value,
            "maxBrightnessCurrent" => self.max_brightness_current = value,
            _ => return self.diode.set_param(name, value),
        }
        true
    }
    fn reset(&mut self) {
        self.diode.reset();
    }
}
