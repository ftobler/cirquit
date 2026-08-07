//! Op-amp modelled as a saturating VCVS.

use crate::element::{Base, Element, SimCtx};
use crate::spec::ElementSpec;
use crate::stamp::{Stamper, GROUND};

/// Load-time flag meanings, shared with the TypeScript registry so a loaded
/// file reaches the engine already normalised (OpAmpElm.java:28-31).
const FLAG_LOWGAIN: i64 = 4;
const FLAG_GAIN: i64 = 8;

/// Op-amp modelled as a saturating voltage-controlled voltage source.
///
/// Posts are inverting input, non-inverting input, output. The inputs draw no
/// current; the output is an ideal source referenced to ground, since the
/// supply rails are not modelled.
pub struct OpAmp {
    base: Base,
    gain: f64,
    max_out: f64,
    min_out: f64,
    /// The previous Newton iterate's input differential. The convergence test
    /// and the saturation-nudge branch both read it, so it is assigned at the
    /// very end of `do_step`, as upstream does (OpAmpElm.java:159, :194).
    last_vd: f64,
    /// Saved input voltages from the file, seeding `last_vd` on build and
    /// reset (OpAmpElm.java:54-55). The solve overwrites the node voltages, so
    /// the seed only decides which branch the first iteration starts on.
    volts0: f64,
    volts1: f64,
    /// xorshift64* state for the saturation nudge, the port's deterministic
    /// stand-in for upstream's `app.getrand(4) == 1` (OpAmpElm.java:176-181).
    rng: u64,
}

impl OpAmp {
    /// Slope used inside saturation. Not zero, because a perfectly flat
    /// region gives Newton no gradient to work with and the solve stalls.
    const SATURATED_SLOPE: f64 = 1e-4;

    pub fn new(spec: &ElementSpec) -> Self {
        let volts0 = spec.param("volts0", 0.0);
        let volts1 = spec.param("volts1", 0.0);
        // The flags decide the gain on load (OpAmpElm.java:63-70): a file
        // saved by a modern upstream carries FLAG_GAIN and keeps its stored
        // value, while a legacy file gets a fixed one. 100000 broke one
        // bundled circuit and 1000 another, which is why upstream has both.
        let parsed_gain = spec.param("gain", 100_000.0);
        let gain = if spec.flag(FLAG_GAIN) {
            parsed_gain
        } else if spec.flag(FLAG_LOWGAIN) {
            1000.0
        } else {
            100_000.0
        };
        Self {
            base: Base::with_posts(3),
            gain,
            max_out: spec.param("maxOut", 15.0),
            min_out: spec.param("minOut", -15.0),
            last_vd: volts1 - volts0,
            volts0,
            volts1,
            // A fixed seed keeps the nudge reproducible across runs and
            // rebuilds, like the noise source's.
            rng: 0x9E37_79B9_7F4A_7C15,
        }
    }

    /// One xorshift64* step, the same generator the noise source uses
    /// (`voltage_source.rs`). Its low two bits give the 25% roll upstream
    /// takes with `getrand(4) == 1`.
    fn next_rand(&mut self) -> u64 {
        self.rng ^= self.rng >> 12;
        self.rng ^= self.rng << 25;
        self.rng ^= self.rng >> 27;
        self.rng.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
}

impl Element for OpAmp {
    fn kind(&self) -> &'static str {
        "opamp"
    }
    fn base(&self) -> &Base {
        &self.base
    }
    fn base_mut(&mut self) -> &mut Base {
        &mut self.base
    }
    fn post_count(&self) -> usize {
        3
    }
    fn voltage_source_count(&self) -> usize {
        1
    }
    fn nonlinear(&self) -> bool {
        true
    }
    /// The inputs are isolated; only the output terminal is driven.
    fn connects(&self, _a: usize, _b: usize) -> bool {
        false
    }

    fn stamp(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        // Topology only: the output is a source to ground whose value and
        // input coupling `do_step` fills in each iteration.
        s.voltage_source(GROUND, self.base.nodes[2], self.base.vs_base, 0.0);
    }

    fn do_step(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        let vd = self.base.volts[1] - self.base.volts[0];
        let midpoint = (self.max_out + self.min_out) * 0.5;
        // Convergence, upstream's tolerances (OpAmpElm.java:168-171): the
        // differential must settle, and the solved output must stay inside the
        // rails with a little slack so a solve can approach them.
        if (vd - self.last_vd).abs() > 0.1
            || self.base.volts[2] > self.max_out + 0.1
            || self.base.volts[2] < self.min_out - 0.1
        {
            s.not_converged();
        }
        // The linear region centres on the rail midpoint, so an asymmetric
        // op-amp idles between its rails and its knees sit equidistant from
        // them (OpAmpElm.java:167, :174-181).
        let max_adj = self.max_out - midpoint;
        let min_adj = self.min_out - midpoint;
        // Same 25% roll as upstream's getrand(4) == 1: while crossing from one
        // rail to the other, one roll in four stays in the linear branch so
        // Newton can escape a stuck saturation.
        let nudge = (self.next_rand() & 3) == 1;
        let (slope, offset) = if vd >= max_adj / self.gain && (self.last_vd >= 0.0 || nudge) {
            (
                Self::SATURATED_SLOPE,
                self.max_out - Self::SATURATED_SLOPE * max_adj / self.gain,
            )
        } else if vd <= min_adj / self.gain && (self.last_vd <= 0.0 || nudge) {
            (
                Self::SATURATED_SLOPE,
                self.min_out - Self::SATURATED_SLOPE * min_adj / self.gain,
            )
        } else {
            (self.gain, midpoint)
        };

        // Constraint row: V(out) − slope·(V(+) − V(−)) = offset.
        let row = s.vs_row(self.base.vs_base);
        if let Some(c) = s.node_row(self.base.nodes[1]) {
            s.raw(row, c, -slope);
        }
        if let Some(c) = s.node_row(self.base.nodes[0]) {
            s.raw(row, c, slope);
        }
        s.raw_rhs(row, offset);

        self.last_vd = vd;
    }

    /// Re-anchors the differential from the restored node voltages, with the
    /// same polarity `do_step` computes the anchor from, so a rejected step
    /// cannot leave `last_vd` stuck on the failed attempt's last iterate and
    /// send the retry down the wrong saturation branch.
    fn restore_iteration(&mut self) {
        self.last_vd = self.base.volts[1] - self.base.volts[0];
    }

    fn calculate_current(&mut self, _ctx: &SimCtx) {
        // Upstream's positive current leaves the output pin
        // (getCurrentIntoNode(2) == -current, OpAmpElm.java:227-231). The
        // stamp is voltage_source(GROUND, node2), whose unknown is positive
        // INTO the pin, so negate to match.
        self.base.current = -self.base.vs_currents[0];
    }

    fn current_into_node(&self, post: usize) -> f64 {
        // The inputs draw nothing; the negated current is upstream's
        // getCurrentIntoNode(2), which the wire recovery needs: a sourcing
        // op-amp delivers into the output node.
        if post == 2 {
            -self.base.current
        } else {
            0.0
        }
    }

    fn voltage_diff(&self) -> f64 {
        // A scope on an op-amp plots Vout - V+ (OpAmpElm.java:206).
        self.base.volts[2] - self.base.volts[1]
    }

    fn power(&self) -> f64 {
        // Upstream computes power from the output pin alone (OpAmpElm.java:109).
        self.base.volts[2] * self.base.current
    }

    fn set_param(&mut self, name: &str, value: f64) -> bool {
        match name {
            "gain" if value > 0.0 => self.gain = value,
            "maxOut" => self.max_out = value,
            "minOut" => self.min_out = value,
            _ => return false,
        }
        true
    }

    fn reset(&mut self) {
        self.base.reset();
        // A loaded comparator restarts from its file differential: the saved
        // volts0/volts1 are the initial node voltages upstream restores on
        // load (OpAmpElm.java:54-55).
        self.last_vd = self.volts1 - self.volts0;
    }
}
