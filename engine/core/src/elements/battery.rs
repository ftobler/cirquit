//! Battery model with a state-of-charge voltage table.
//!
//! `(-) post0 -- Vsrc -- node2 -- R0 -- node3 -- (R1 || C1) -- (+) post1`
//! (BatteryElm.java:29-32). The source value comes from a piecewise-linear
//! SOC table; SOC is tracked by coulomb counting the terminal current.
//! Over-discharge is modelled: the source extrapolates below 0% and the SOC
//! itself is never clamped below zero (BatteryElm.java:122-123).

use crate::element::{Base, Element, SimCtx};
use crate::spec::ElementSpec;
use crate::stamp::Stamper;

/// Steady-state open a capacitor is modelled as during the DC operating-point
/// solve, the same value the capacitor element uses
/// (capacitor.rs, CapacitorElm.java:147-151).
const DC_OPEN: f64 = 1e8;

/// The flat voltage a tableless battery produces, whatever the SOC
/// (BatteryElm.java:205-206).
const FLAT_VOLTAGE: f64 = 3.7;

pub struct Battery {
    base: Base,
    r0: f64,
    r1: f64,
    c1: f64,
    capacity_ah: f64,
    initial_soc: f64,
    /// The batteryType token rides the file format and the frontend edits it;
    /// the engine only carries it, nothing reads it back
    /// (BatteryElm.java:64, :126).
    #[allow(dead_code)]
    battery_type: i32,
    /// Sorted ascending (socPercent, voltage) pairs, parsed once at
    /// construction from the raw table string in `spec.model`
    /// (BatteryElm.java:75).
    soc_table: Vec<(f64, f64)>,
    soc: f64,
    comp_resistance: f64,
    cap_volt_diff: f64,
    cap_current: f64,
    cur_source_value: f64,
}

impl Battery {
    pub fn new(spec: &ElementSpec) -> Self {
        let initial_soc = clamp_soc(spec.param("initialSoc", 1.0));
        // `soc` is not lower-clamped (over-discharge is modelled), only capped
        // at 100%, matching upstream's undump (BatteryElm.java:124-125).
        let soc = spec.param("soc", initial_soc).min(1.0);
        let soc_table = parse_soc_table(&spec.model.clone().unwrap_or_default());
        Self {
            base: Base::with_posts(2),
            r0: spec.param("r0", 0.01),
            r1: spec.param("r1", 0.02),
            c1: spec.param("c1", 2000.0),
            capacity_ah: spec.param("capacityAh", 2.0),
            initial_soc,
            battery_type: spec.param("batteryType", 1.0) as i32,
            soc_table,
            soc,
            comp_resistance: 0.0,
            // The saved capVoltDiff restores the polarization cap's stored
            // charge, the capacitor voltDiff precedent (BatteryElm.java:72).
            cap_volt_diff: spec.param("capVoltDiff", 0.0),
            cap_current: 0.0,
            cur_source_value: 0.0,
        }
    }

    /// The source value for a SOC fraction, upstream's `getVoltageForSoc`
    /// (BatteryElm.java:192-202): below 0% it extrapolates linearly at three
    /// times the 0..10% slope.
    fn voltage_for_soc(&self, soc: f64) -> f64 {
        let soc_pct = soc * 100.0;
        if soc_pct < 0.0 {
            let v0 = Self::interp_soc_table(&self.soc_table, 0.0);
            let v10 = Self::interp_soc_table(&self.soc_table, 10.0);
            let slope = (v10 - v0) / 10.0;
            return v0 + slope * 3.0 * soc_pct;
        }
        Self::interp_soc_table(&self.soc_table, soc_pct)
    }

    /// Piecewise-linear interpolation of the table by percent, with the empty
    /// and single-entry cases and the out-of-range clamps, upstream's
    /// `interpSocTable` (BatteryElm.java:204-225).
    fn interp_soc_table(table: &[(f64, f64)], soc_pct: f64) -> f64 {
        if table.is_empty() {
            return FLAT_VOLTAGE;
        }
        if table.len() == 1 {
            return table[0].1;
        }
        if soc_pct <= table[0].0 {
            return table[0].1;
        }
        let n = table.len();
        if soc_pct >= table[n - 1].0 {
            return table[n - 1].1;
        }
        for i in 0..n - 1 {
            let (a, b) = (table[i], table[i + 1]);
            if soc_pct >= a.0 && soc_pct <= b.0 {
                if b.0 == a.0 {
                    return a.1;
                }
                let frac = (soc_pct - a.0) / (b.0 - a.0);
                return a.1 + frac * (b.1 - a.1);
            }
        }
        table[n - 1].1
    }
}

/// Splits the table into sorted `(pct, volt)` pairs, skipping blank and
/// malformed lines, upstream's `parseSocTable` (BatteryElm.java:156-190). The
/// insertion sort keeps duplicate percents in file order, like upstream.
fn parse_soc_table(text: &str) -> Vec<(f64, f64)> {
    let mut pairs: Vec<(f64, f64)> = Vec::new();
    for line in text.split('\n') {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(eq) = line.find('=') {
            if let (Ok(pct), Ok(v)) = (
                line[..eq].trim().parse::<f64>(),
                line[eq + 1..].trim().parse::<f64>(),
            ) {
                pairs.push((pct, v));
            }
        }
    }
    for i in 1..pairs.len() {
        let cur = pairs[i];
        let mut j = i;
        while j > 0 && pairs[j - 1].0 > cur.0 {
            pairs[j] = pairs[j - 1];
            j -= 1;
        }
        pairs[j] = cur;
    }
    pairs
}

fn clamp_soc(s: f64) -> f64 {
    s.clamp(0.0, 1.0)
}

impl Element for Battery {
    fn kind(&self) -> &'static str {
        "battery"
    }
    fn base(&self) -> &Base {
        &self.base
    }
    fn base_mut(&mut self) -> &mut Base {
        &mut self.base
    }
    fn post_count(&self) -> usize {
        2
    }

    fn internal_node_count(&self) -> usize {
        2
    }
    fn voltage_source_count(&self) -> usize {
        1
    }
    fn voltage_source_nodes(&self, _k: usize) -> (usize, usize) {
        // The source spans the minus terminal to the internal node after it
        // (BatteryElm.java:227-230), so the unknown joins that node's closure.
        (self.base.nodes[0], self.base.nodes[2])
    }

    fn stamp(&mut self, ctx: &SimCtx, s: &mut Stamper) {
        let (n0, n1) = (self.base.nodes[0], self.base.nodes[1]);
        let (n2, n3) = (self.base.nodes[2], self.base.nodes[3]);
        // Topology now with a zero source value; do_step supplies the value
        // each timestep so the matrix stays constant (BatteryElm.java:233-235).
        s.voltage_source(n0, n2, self.base.vs_base, 0.0);
        s.resistor(n2, n3, self.r0);
        s.resistor(n3, n1, self.r1);
        // The trapezoidal capacitor companion, or a 1e8 open under DC
        // (BatteryElm.java:237-245).
        self.comp_resistance = if ctx.dc_analysis {
            DC_OPEN
        } else {
            ctx.dt / (2.0 * self.c1)
        };
        s.resistor(n3, n1, self.comp_resistance);
    }

    fn start_iteration(&mut self, ctx: &SimCtx) {
        // The Norton history current of the companion (BatteryElm.java:250-255).
        self.cur_source_value = if ctx.dc_analysis {
            0.0
        } else {
            -self.cap_volt_diff / self.comp_resistance - self.cap_current
        };
    }

    fn do_step(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        let (n1, n3) = (self.base.nodes[1], self.base.nodes[3]);
        s.voltage_source_value(self.base.vs_base, self.voltage_for_soc(self.soc));
        s.current_source(n3, n1, self.cur_source_value);
    }

    fn calculate_current(&mut self, _ctx: &SimCtx) {
        // The battery's current is its internal source's solved current, which
        // is positive when discharging (the current enters the minus terminal
        // and leaves the plus), exactly the sign coulomb counting needs.
        self.base.current = self.base.vs_currents[0];
    }

    fn state_tokens(&self) -> Vec<(String, f64)> {
        vec![
            ("soc".into(), self.soc),
            ("capVoltDiff".into(), self.cap_volt_diff),
        ]
    }

    fn step_finished(&mut self, ctx: &SimCtx) {
        self.cap_volt_diff = self.base.volts[3] - self.base.volts[1];
        if self.comp_resistance > 0.0 {
            self.cap_current = self.cap_volt_diff / self.comp_resistance + self.cur_source_value;
        }
        // Coulomb counting: the current is positive when discharging, so the
        // SOC falls; there is no lower clamp, and 100% is the only cap. Both
        // skipped under DC (BatteryElm.java:262-276).
        if self.capacity_ah > 0.0 && !ctx.dc_analysis {
            self.soc -= self.base.current * ctx.dt / (3600.0 * self.capacity_ah);
            if self.soc > 1.0 {
                self.soc = 1.0;
            }
        }
    }

    fn voltage_diff(&self) -> f64 {
        // Positive EMF: volts[plus] - volts[minus], like upstream's
        // getVoltageDiff (BatteryElm.java:320).
        self.base.volts[1] - self.base.volts[0]
    }

    fn power(&self) -> f64 {
        // The element delivers power, so it reads negative, upstream's
        // deliberate negation (BatteryElm.java:319).
        -self.voltage_diff() * self.base().current
    }

    fn display_state(&self) -> f64 {
        // The live SOC fraction, for the frontend's caption draw.
        self.soc
    }

    fn set_param(&mut self, name: &str, value: f64) -> bool {
        match name {
            "r0" if value > 0.0 => self.r0 = value,
            "r1" if value > 0.0 => self.r1 = value,
            "c1" if value > 0.0 => self.c1 = value,
            "capacityAh" if value >= 0.0 => self.capacity_ah = value,
            "initialSoc" => self.initial_soc = clamp_soc(value),
            "batteryType" => self.battery_type = value as i32,
            "soc" => self.soc = value.min(1.0),
            "capVoltDiff" => self.cap_volt_diff = value,
            _ => return false,
        }
        true
    }

    fn reset(&mut self) {
        self.base.reset();
        self.soc = clamp_soc(self.initial_soc);
        self.cap_volt_diff = 0.0;
        self.cap_current = 0.0;
        self.cur_source_value = 0.0;
    }
}
