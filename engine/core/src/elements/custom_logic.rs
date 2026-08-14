//! Custom logic (CustomLogicElm.java, dump 208): a chip whose pin table and
//! behaviour come from a named model defined by a `!` netlist line. The
//! frontend resolves that line and hands the parsed model to the engine as a
//! JSON blob in `spec.model`; a spec with no model falls back to 4 inputs / 2
//! outputs and no rules, so every output stays low.
//!
//! The rules are a left/right table. Each step `execute()` walks the table in
//! order and matches `rules_left[i]` against the pin levels: `0`/`1` literal,
//! `?` don't care, `+`/`-` up/down transition against `lastValues`, `a`..`z`
//! saves the pin's level into `pattern_values`, and `A`..`Z` compares against
//! it. The left string may be longer than the input count, so it can also test
//! output levels (CustomLogicElm.java:138-205). On a match, `rules_right[i]`
//! sets each output: `a`..`z` copies the saved pattern level, `_` puts the
//! pin high-impedance, anything else is the literal `0`/`1`.
//!
//! Each output is a voltage source to ground. A tri-state model (any right
//! side holds a `_`) needs an internal node per output with a 1e8/1e-3 ohm
//! resistor to the real terminal, so the source drives the internal node and
//! the switched resistor decides how much of that reaches the pin
//! (CustomLogicElm.java:102-136). Non-tri-state models stamp straight onto the
//! terminal. The bundled corpus model (ledarray's smiley) is not tri-state,
//! but the path is part of the model format so it is implemented.

use serde::Deserialize;

use crate::element::{Base, Element, SimCtx};
use crate::elements::chip::{Chip, ChipPin};
use crate::spec::ElementSpec;
use crate::stamp::{Stamper, GROUND};

/// Pin counts for a spec that carries no model, matching the registry's
/// fallback when the model name is unresolvable or the element was placed
/// fresh. Upstream's default model is 2/2 (CustomLogicModel.java:64-70), but
/// the plan fixes the port's fallback at 4 inputs / 2 outputs.
const DEFAULT_INPUTS: usize = 4;
const DEFAULT_OUTPUTS: usize = 2;

/// The resistor a tri-state output puts between its internal node and the
/// terminal when the output is high-impedance, and when it is driven
/// (CustomLogicElm.java:133).
const HI_Z_RESISTANCE: f64 = 1e8;
const DRIVEN_RESISTANCE: f64 = 1e-3;

/// The serialised model as the frontend builds it from the `!` line. Only the
/// pin counts and the parsed rule vectors cross the boundary; the pin names
/// travel with them (the model object is serialised wholesale) but are only
/// used for the counts here.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelData {
    #[serde(default)]
    inputs: Vec<String>,
    #[serde(default)]
    outputs: Vec<String>,
    #[serde(default)]
    tri_state: bool,
    #[serde(default)]
    rules_left: Vec<String>,
    #[serde(default)]
    rules_right: Vec<String>,
}

impl ModelData {
    fn input_count(&self) -> usize {
        if self.inputs.is_empty() {
            DEFAULT_INPUTS
        } else {
            self.inputs.len()
        }
    }

    fn output_count(&self) -> usize {
        if self.outputs.is_empty() {
            DEFAULT_OUTPUTS
        } else {
            self.outputs.len()
        }
    }

    /// Shape-checks the rule table the way the TS parser does (parse.ts:49-51),
    /// because the model arrives as raw JSON and must not be trusted to index
    /// `execute`'s vectors. The left side may test output pins too, so it may
    /// be longer than the input count but never longer than the whole pin
    /// table; the right side must name exactly the output count; and no left
    /// rule may outlive its right partner. `execute` indexes `pins[j]`,
    /// `last_values[j]`, `rules_right[i]`, `high_impedance[k]` and
    /// `write_output(input_count + k)` with exactly these bounds, so a passing
    /// check keeps every one of those in range.
    fn rules_in_bounds(&self, input_count: usize, output_count: usize) -> bool {
        if self.rules_right.len() < self.rules_left.len() {
            return false;
        }
        let pin_count = input_count + output_count;
        for rl in &self.rules_left {
            let len = rl.chars().count();
            if len < input_count || len > pin_count {
                return false;
            }
        }
        for rr in &self.rules_right {
            if rr.chars().count() != output_count {
                return false;
            }
        }
        true
    }
}

pub struct CustomLogic {
    chip: Chip,
    input_count: usize,
    output_count: usize,
    tri_state: bool,
    rules_left: Vec<String>,
    rules_right: Vec<String>,
    /// `lastValues`, one entry per post, the transition memory (CustomLogicElm.java:85).
    last_values: Vec<bool>,
    /// `patternValues`, the pin levels saved by `a`..`z` left-side chars
    /// (CustomLogicElm.java:86).
    pattern_values: [bool; 26],
    /// `highImpedance`, one entry per output (CustomLogicElm.java:87).
    high_impedance: Vec<bool>,
}

impl CustomLogic {
    /// `None` means the model's rule table is too malformed to walk safely;
    /// `build_element` then reports the element through the same invalid-
    /// circuit path an unknown kind takes.
    pub fn new(spec: &ElementSpec) -> Option<Self> {
        let model = spec
            .model
            .as_deref()
            .and_then(|m| serde_json::from_str::<ModelData>(m).ok())
            .unwrap_or_default();
        // A parseable model is authoritative about its own pin counts; only a
        // missing or empty one falls back to the defaults.
        let input_count = model.input_count();
        let output_count = model.output_count();
        if !model.rules_in_bounds(input_count, output_count) {
            return None;
        }
        // Pin table (CustomLogicElm.java:75-88): the inputs on the west, then
        // the outputs on the east. The `state` flag stays off: the saved
        // output voltages are keyed by output ordinal here, not pin position,
        // so the restore below reads them itself.
        let mut pins = Vec::with_capacity(input_count + output_count);
        for _ in 0..input_count {
            pins.push(ChipPin::input());
        }
        for _ in 0..output_count {
            pins.push(ChipPin::output(false));
        }
        let mut chip = Chip {
            base: Base::with_posts(pins.len()),
            high_voltage: spec.param("highVoltage", 5.0),
            last_clock: false,
            just_loaded: false,
            pins,
        };
        // Restore the file's saved output levels, one `voltage{k}` token per
        // output in output order (CustomLogicElm.java:29-35). The presence of
        // any such token arms the first-step deferral, so the restored levels
        // are not clobbered by the still-zero node voltages.
        let mut loaded = false;
        for (k, pin) in chip.pins.iter_mut().enumerate().skip(input_count) {
            if let Some(&v) = spec.params.get(&format!("voltage{}", k - input_count)) {
                loaded = true;
                pin.value = v > chip.high_voltage * 0.5;
            }
        }
        chip.just_loaded = loaded;
        Some(Self {
            chip,
            input_count,
            output_count,
            tri_state: model.tri_state,
            rules_left: model.rules_left,
            rules_right: model.rules_right,
            last_values: vec![false; input_count + output_count],
            pattern_values: [false; 26],
            high_impedance: vec![false; output_count],
        })
    }

    fn internal_node(&self, output: usize) -> usize {
        self.chip.base.nodes[self.input_count + self.output_count + output]
    }

    fn output_node(&self, output: usize) -> usize {
        self.chip.base.nodes[self.input_count + output]
    }

    /// Walks the rule table in order and applies the first matching rule,
    /// then snapshots every pin level for the next step's transition checks
    /// (CustomLogicElm.java:138-205).
    fn execute(&mut self) {
        for (i, rl) in self.rules_left.iter().enumerate() {
            let mut rule_matches = true;
            for (j, x) in rl.chars().enumerate() {
                let value = self.chip.pins[j].value;
                let ok = match x {
                    '0' | '1' => value == (x == '1'),
                    // don't care
                    '?' => true,
                    // up transition
                    '+' => value && !self.last_values[j],
                    // down transition
                    '-' => !value && self.last_values[j],
                    // save the pin's value into the pattern table. The table is
                    // fixed at 26 entries and the arm below bounds the index to
                    // a..z, so this can never walk out.
                    'a'..='z' => {
                        self.pattern_values[(x as u8 - b'a') as usize] = value;
                        true
                    }
                    // compare against the saved pattern value
                    'A'..='Z' => self.pattern_values[(x as u8 - b'A') as usize] == value,
                    _ => false,
                };
                if !ok {
                    rule_matches = false;
                    break;
                }
            }
            if !rule_matches {
                continue;
            }
            let rr = &self.rules_right[i];
            for (k, x) in rr.chars().enumerate() {
                let pin = self.input_count + k;
                self.high_impedance[k] = false;
                if x.is_ascii_lowercase() {
                    let v = self.pattern_values[(x as u8 - b'a') as usize];
                    self.chip.write_output(pin, v);
                } else if x == '_' {
                    self.high_impedance[k] = true;
                } else {
                    self.chip.write_output(pin, x == '1');
                }
            }
            break;
        }
        for (j, pin) in self.chip.pins.iter().enumerate() {
            self.last_values[j] = pin.value;
        }
    }
}

impl Element for CustomLogic {
    fn kind(&self) -> &'static str {
        "customLogic"
    }
    fn base(&self) -> &Base {
        &self.chip.base
    }
    fn base_mut(&mut self) -> &mut Base {
        &mut self.chip.base
    }
    fn post_count(&self) -> usize {
        self.input_count + self.output_count
    }
    /// Tri-state outputs need an internal node each for the source to drive
    /// through the switched resistor (CustomLogicElm.java:102-106).
    fn internal_node_count(&self) -> usize {
        if self.tri_state {
            self.output_count
        } else {
            0
        }
    }
    fn voltage_source_count(&self) -> usize {
        self.output_count
    }
    fn voltage_source_nodes(&self, k: usize) -> (usize, usize) {
        let n = if self.tri_state {
            self.internal_node(k)
        } else {
            self.output_node(k)
        };
        (GROUND, n)
    }
    /// The switched output resistor changes per step, so a tri-state model is
    /// nonlinear (CustomLogicElm.java:100).
    fn nonlinear(&self) -> bool {
        self.tri_state
    }
    /// The inputs only sense their nodes and the outputs are source drives, so
    /// no two posts couple (ChipElm.java:467).
    fn connects(&self, _a: usize, _b: usize) -> bool {
        false
    }
    /// The tri-state internal-to-output resistor couples those two rows, so
    /// the pair must share a closure even though `connects` is false, the same
    /// seam the tri-state buffer uses.
    fn matrix_connects(&self, a: usize, b: usize) -> bool {
        if !self.tri_state {
            return false;
        }
        for k in 0..self.output_count {
            let internal = self.input_count + self.output_count + k;
            let output = self.input_count + k;
            if (a == internal && b == output) || (a == output && b == internal) {
                return true;
            }
        }
        false
    }

    fn stamp(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        for k in 0..self.output_count {
            let (n1, n2) = self.voltage_source_nodes(k);
            s.voltage_source(n1, n2, self.chip.base.vs_base + k, 0.0);
        }
    }

    fn start_iteration(&mut self, _ctx: &SimCtx) {
        // The first step after a load is skipped: the node voltages are still
        // all zeroes, so the inputs would read low and fire a spurious rule.
        if self.chip.read_inputs() {
            self.execute();
        }
    }

    fn do_step(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        for k in 0..self.output_count {
            let v = if self.chip.output_value(k) {
                self.chip.high_voltage
            } else {
                0.0
            };
            s.voltage_source_value(self.chip.base.vs_base + k, v);
            if self.tri_state {
                let r = if self.high_impedance[k] {
                    HI_Z_RESISTANCE
                } else {
                    DRIVEN_RESISTANCE
                };
                s.resistor(self.internal_node(k), self.output_node(k), r);
            }
        }
    }

    fn calculate_current(&mut self, _ctx: &SimCtx) {
        self.chip.base.current = 0.0;
    }

    fn state_tokens(&self) -> Vec<(String, f64)> {
        // The custom-logic row names its saved output voltages by output
        // ordinal, `voltage{k}`, not by pin index: the restore reads them as
        // `format!("voltage{}", k - input_count)` in `new`.
        (0..self.output_count)
            .map(|k| {
                (
                    format!("voltage{k}"),
                    if self.chip.output_value(k) {
                        self.chip.high_voltage
                    } else {
                        0.0
                    },
                )
            })
            .collect()
    }

    fn current_into_node(&self, post: usize) -> f64 {
        self.chip.current_into_node(post)
    }

    fn set_param(&mut self, _name: &str, _value: f64) -> bool {
        // The model name and the pin table it implies can only be rebuilt;
        // nothing about this element is live-patchable.
        false
    }

    fn reset(&mut self) {
        self.chip.reset();
        self.last_values.iter_mut().for_each(|v| *v = false);
        self.pattern_values = [false; 26];
        self.high_impedance.iter_mut().for_each(|v| *v = false);
    }
}
