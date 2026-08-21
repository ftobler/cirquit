//! The instruction display (InstructionDisplayElm.java, XML type "ins").
//!
//! A passive readout: a bus of `busWidth` inputs forms an integer from the
//! per-bit logic levels (a post above `threshold` sets its bit), then that
//! integer is mapped through a lookup table to a string that the UI draws.
//! It contributes no matrix unknown, so it is a pure readout.
//!
//! Upstream's text dump code is effectively 0 (it never overrides
//! `getDumpType`), so the port assigns `434`. Codes 431 and 435 are also free,
//! but `434` sits in the modern 400+ XML-era block alongside the other
//! XML-era elements (relay 425/426, busSplitter 433), so it keeps the
//! assignment coherent. See `feature/instruction-display.md`.

use crate::element::{Base, Element, SimCtx};
use crate::expr::{parse as parse_expr, ExprState};
use crate::spec::ElementSpec;
use crate::stamp::Stamper;

/// The bus width, clamped like upstream's edit dialog (1..32).
fn clamp_bus_width(raw: f64) -> usize {
    let n = raw as usize;
    n.clamp(1, 32)
}

/// One parsed lookup line: a value range `[lo, hi]` and the text template.
struct LookupEntry {
    lo: i64,
    hi: i64,
    template: String,
}

/// Parses a key (`lo`, `lo-hi`, or `0x`/`0b` prefixed) into an integer.
fn parse_number(s: &str) -> i64 {
    let s = s.trim();
    let prefixed = s
        .strip_prefix("0x")
        .or_else(|| s.strip_prefix("0X"))
        .or_else(|| s.strip_prefix("0b"))
        .or_else(|| s.strip_prefix("0B"));
    if let Some(rest) = prefixed {
        // The base follows the prefix, not the suffix: "0b10" is binary, so
        // key off the prefix, not the trailing digit.
        let radix = if s.starts_with("0b") || s.starts_with("0B") {
            2
        } else {
            16
        };
        i64::from_str_radix(rest.trim(), radix).unwrap_or(0)
    } else {
        s.parse::<i64>().unwrap_or(0)
    }
}

/// Splits the multi-line lookup text into [`LookupEntry`] rows. A line with no
/// `=` is skipped; a key with a dash (past any 0x/0b prefix) is a range.
fn parse_entries(lookup: &str) -> Vec<LookupEntry> {
    let mut entries = Vec::new();
    for line in lookup.split('\n') {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let eq = match line.find('=') {
            Some(i) => i,
            None => continue,
        };
        let key = line[..eq].trim();
        let template = line[eq + 1..].to_string();
        // A dash only starts the range past the optional radix prefix.
        let start = if key.starts_with("0x")
            || key.starts_with("0X")
            || key.starts_with("0b")
            || key.starts_with("0B")
        {
            2
        } else {
            0
        };
        let dash = key[start..].find('-').map(|i| i + start);
        match dash {
            Some(d) => {
                let lo = parse_number(&key[..d]);
                let hi = parse_number(&key[d + 1..]);
                entries.push(LookupEntry { lo, hi, template });
            }
            None => {
                let k = parse_number(key);
                entries.push(LookupEntry {
                    lo: k,
                    hi: k,
                    template,
                });
            }
        }
    }
    entries
}

/// Renders one template, substituting `{expr}` with the expression result
/// evaluated with `a = value` (InstructionDisplayElm.LookupEntry.getText).
fn render_template(template: &str, value: u32) -> String {
    let mut out = String::new();
    let mut pos = 0;
    while pos < template.len() {
        let open = match template[pos..].find('{') {
            Some(i) => pos + i,
            None => {
                out.push_str(&template[pos..]);
                break;
            }
        };
        out.push_str(&template[pos..open]);
        let close = match template[open..].find('}') {
            Some(i) => open + i,
            None => {
                out.push_str(&template[open..]);
                break;
            }
        };
        let expr_str = &template[open + 1..close];
        match parse_expr(expr_str) {
            Ok(expr) => {
                let mut st = ExprState::new();
                st.values[0] = value as f64; // `a` is the input value
                let r = expr.eval(&st);
                if r.is_finite() && (r - r.floor()).abs() < 1e-9 {
                    out.push_str(&(r as i64).to_string());
                } else {
                    out.push_str(&r.to_string());
                }
            }
            Err(_) => out.push_str(&format!("{{{expr_str}}}")),
        }
        pos = close + 1;
    }
    out
}

pub struct InstructionDisplay {
    base: Base,
    bus_width: usize,
    threshold: f64,
}

impl InstructionDisplay {
    pub fn new(spec: &ElementSpec) -> Self {
        let bus_width = clamp_bus_width(spec.param("busWidth", 4.0));
        Self {
            base: Base::with_posts(bus_width),
            bus_width,
            threshold: spec.param("threshold", 2.5),
        }
    }

    /// The integer formed from the bus posts: bit `i` is set when post `i`'s
    /// voltage is above the threshold (InstructionDisplayElm.readInputValue).
    fn read_value(&self) -> u32 {
        let mut value = 0u32;
        for i in 0..self.bus_width {
            if self.base.volts.get(i).copied().unwrap_or(0.0) > self.threshold {
                value |= 1 << i;
            }
        }
        value
    }

    /// Maps `value` through `lookup`, the port of upstream's `getDisplayText`.
    pub fn display_text(value: u32, lookup: &str) -> String {
        let entries = parse_entries(lookup);
        let v = value as i64;
        for e in &entries {
            if v >= e.lo && v <= e.hi {
                return render_template(&e.template, value);
            }
        }
        value.to_string()
    }
}

impl Element for InstructionDisplay {
    fn kind(&self) -> &'static str {
        "instructionDisplay"
    }
    fn base(&self) -> &Base {
        &self.base
    }
    fn base_mut(&mut self) -> &mut Base {
        &mut self.base
    }
    fn post_count(&self) -> usize {
        self.bus_width
    }
    /// Upstream stacks all N posts on one coordinate with bit tags
    /// (`getPost(n) = new Point(x, y, n)`, InstructionDisplayElm.java:53-55);
    /// the frontend now sends them coincident, so the bit tags are what keep
    /// the inputs apart.
    fn post_bus_z(&self, post: usize) -> usize {
        post
    }
    /// Each post is an independent input; the part draws no current, so its
    /// terminals do not couple (like the meter/readout family).
    fn connects(&self, _a: usize, _b: usize) -> bool {
        false
    }
    fn calculate_current(&mut self, _ctx: &SimCtx) {
        self.base.current = 0.0;
    }
    /// A multi-post readout attributes no current to any terminal.
    fn current_into_node(&self, _post: usize) -> f64 {
        0.0
    }
    /// The readout channel reports the live bus value.
    fn value(&self) -> f64 {
        self.read_value() as f64
    }
    fn display_state(&self) -> f64 {
        self.read_value() as f64
    }
    fn set_param(&mut self, name: &str, value: f64) -> bool {
        // `busWidth` is structural (changes the post count), so it falls
        // through to a full rebuild rather than a live `set_param`.
        if name == "threshold" {
            self.threshold = value;
            true
        } else {
            false
        }
    }
    // No `stamp`/`do_step`: a readout adds no matrix unknown.
    fn stamp(&mut self, _ctx: &SimCtx, _s: &mut Stamper) {}
}
