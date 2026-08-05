//! Nonlinear junction devices, linearised each Newton iteration.

use crate::element::{Base, Element, SimCtx};
use crate::spec::ElementSpec;
use crate::stamp::{Stamper, GROUND};

/// Thermal voltage at roughly room temperature, in volts.
const VT: f64 = 0.025_865;
/// Parallel conductance added across every junction. Keeps a reverse-biased
/// junction from presenting an effectively infinite impedance, which is what
/// stalls Newton on circuits like a bridge rectifier at start-up.
const JUNCTION_GMIN: f64 = 1e-12;
/// Largest exponent evaluated, guarding against `exp` overflowing to infinity
/// on a wild Newton excursion.
const MAX_EXP_ARG: f64 = 40.0;

/// Voltage change per iteration beyond which the solution is not settled.
const CONVERGENCE_V: f64 = 0.01;

/// Standard junction limiting. Without it, Newton's linear extrapolation of an
/// exponential overshoots by many decades and the iteration never recovers.
fn limit_junction(vnew: f64, vold: f64, vt: f64, vcrit: f64) -> f64 {
    if vnew > vcrit && (vnew - vold).abs() > 2.0 * vt {
        if vold > 0.0 {
            let arg = 1.0 + (vnew - vold) / vt;
            if arg > 0.0 {
                vold + vt * arg.ln()
            } else {
                vcrit
            }
        } else {
            // Coming from reverse bias, step to a point on the exponential
            // rather than straight across it.
            vt * (vnew / vt).ln()
        }
    } else {
        vnew
    }
}

fn critical_voltage(vt: f64, leakage: f64) -> f64 {
    vt * (vt / (std::f64::consts::SQRT_2 * leakage)).ln()
}

/// Shockley diode, optionally with a Zener breakdown branch.
pub struct Diode {
    base: Base,
    /// Saturation current.
    leakage: f64,
    /// Emission-scaled thermal voltage, `emcoef * VT`.
    vscale: f64,
    vcrit: f64,
    /// Reverse breakdown voltage; zero disables the branch.
    z_voltage: f64,
    z_offset: f64,
    /// Rated forward drop, used to derive `leakage` when no saturation current
    /// is given (DiodeModel.java:149).
    fwdrop: f64,
    /// Emission coefficient (n), 2 for the default model.
    emcoef: f64,
    /// True when `saturationCurrent` was supplied, so forward-drop edits do
    /// not overwrite an explicit saturation current.
    explicit_sat: bool,
    /// Fixed series resistance between the cathode terminal and the junction.
    /// Zero means the junction sits directly on post 1.
    series_resistance: f64,
    /// Node index of the cathode side of the junction: 2 when the series
    /// resistor is present, else 1 (DiodeElm.java:72-82).
    diode_end: usize,
    last_v: f64,
    geq: f64,
    ieq: f64,
}

impl Diode {
    pub fn new(spec: &ElementSpec) -> Self {
        Self::build(spec, spec.param("breakdownVoltage", 0.0))
    }

    pub fn new_zener(spec: &ElementSpec) -> Self {
        Self::build(spec, spec.param("breakdownVoltage", 5.6))
    }

    fn build(spec: &ElementSpec, z_voltage: f64) -> Self {
        const DEFAULT_FWDROP: f64 = 0.805_904_783; // DiodeElm.java:51 defaultdrop

        let fwdrop = spec.param("forwardVoltage", DEFAULT_FWDROP).max(0.05);
        let emcoef = spec.param("emissionCoefficient", 2.0).max(0.1);
        let vscale = emcoef * VT; // DiodeModel.java:333
        let vdcoef = 1.0 / vscale;
        // An explicit saturation current wins; otherwise the curve is anchored
        // so the rated forward drop is on it, which is exactly how upstream
        // derives the default model (DiodeModel.java:149). With the defaults
        // this is bit-exact to the "default" model's Is.
        let explicit = spec.param("saturationCurrent", 0.0);
        let leakage = if explicit > 0.0 {
            explicit
        } else {
            1.0 / ((fwdrop * vdcoef).exp() - 1.0)
        };
        let series_resistance = spec.param("seriesResistance", 0.0).max(0.0);
        // Place the breakdown knee so ~5 mA flows at the rated Zener voltage.
        let z_offset = if z_voltage > 0.0 {
            z_voltage - vscale * (0.005 / leakage + 1.0).ln()
        } else {
            0.0
        };
        Self {
            base: Base::with_posts(2),
            leakage,
            vscale,
            vcrit: critical_voltage(vscale, leakage),
            z_voltage,
            z_offset,
            fwdrop,
            emcoef,
            explicit_sat: explicit > 0.0,
            series_resistance,
            diode_end: if series_resistance > 0.0 { 2 } else { 1 },
            last_v: 0.0,
            geq: 0.0,
            ieq: 0.0,
        }
    }

    /// Saturation current implied by the rated forward drop under the current
    /// scale voltage, the inverse of the derivation in `build`.
    fn derived_leakage(&self) -> f64 {
        1.0 / ((self.fwdrop / self.vscale).exp() - 1.0)
    }

    /// Keeps the breakdown knee consistent with the forward parameters that
    /// define it. Uses the same offset formula as `build`; the zener plan
    /// replaces both with the upstream thermal form together.
    fn recompute_z_offset(&mut self) {
        self.z_offset = if self.z_voltage > 0.0 {
            self.z_voltage - self.vscale * (0.005 / self.leakage + 1.0).ln()
        } else {
            0.0
        };
    }

    /// Current and its derivative at `v`.
    fn evaluate(&self, v: f64) -> (f64, f64) {
        let arg = (v / self.vscale).min(MAX_EXP_ARG);
        let ev = arg.exp();
        let mut i = self.leakage * (ev - 1.0);
        let mut g = self.leakage * ev / self.vscale;
        if self.z_voltage > 0.0 {
            let zarg = (-(v + self.z_offset) / self.vscale).min(MAX_EXP_ARG);
            let ez = zarg.exp();
            i -= self.leakage * (ez - 1.0);
            g += self.leakage * ez / self.vscale;
        }
        (i, g + JUNCTION_GMIN)
    }
}

impl Element for Diode {
    fn kind(&self) -> &'static str {
        if self.z_voltage > 0.0 {
            "zener"
        } else {
            "diode"
        }
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
    fn nonlinear(&self) -> bool {
        true
    }

    /// The series resistor's junction side is an extra node, invisible to the
    /// TypeScript side, exactly as upstream's `getInternalNodeCount`
    /// (DiodeElm.java:82).
    fn internal_node_count(&self) -> usize {
        if self.series_resistance > 0.0 {
            1
        } else {
            0
        }
    }

    fn stamp(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        // The series resistor is constant for the whole run, so it belongs in
        // the constant pass: it sits between post 1 and the internal node,
        // while the nonlinear junction (node 0 to internal node) is stamped by
        // do_step (DiodeElm.java:166-175).
        if self.series_resistance > 0.0 {
            s.resistor(
                self.base.nodes[1],
                self.base.nodes[2],
                self.series_resistance,
            );
        }
    }

    fn do_step(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        let (n0, nend) = (self.base.nodes[0], self.base.nodes[self.diode_end]);
        let mut v = self.base.volts[0] - self.base.volts[self.diode_end];
        if (v - self.last_v).abs() > CONVERGENCE_V {
            s.not_converged();
        }

        v = limit_junction(v, self.last_v, self.vscale, self.vcrit);
        if self.z_voltage > 0.0 {
            // The breakdown branch is the forward branch mirrored about
            // `-z_offset`, so limit it in the mirrored coordinate.
            let mirrored = limit_junction(
                -(v + self.z_offset),
                -(self.last_v + self.z_offset),
                self.vscale,
                self.vcrit,
            );
            v = -mirrored - self.z_offset;
        }
        self.last_v = v;

        let (i, g) = self.evaluate(v);
        self.geq = g;
        self.ieq = i - g * v;
        s.conductance(n0, nend, g);
        s.current_source(n0, nend, self.ieq);
    }

    fn calculate_current(&mut self, _ctx: &SimCtx) {
        // The junction current across the diode proper, not the terminal
        // current: with series resistance the two differ by the resistor.
        self.base.current =
            self.geq * (self.base.volts[0] - self.base.volts[self.diode_end]) + self.ieq;
    }

    fn set_param(&mut self, name: &str, value: f64) -> bool {
        match name {
            "forwardVoltage" => {
                self.fwdrop = value.max(0.05);
                if !self.explicit_sat {
                    self.leakage = self.derived_leakage();
                }
            }
            "emissionCoefficient" => {
                self.emcoef = value.max(0.1);
                self.vscale = self.emcoef * VT;
                if !self.explicit_sat {
                    self.leakage = self.derived_leakage();
                }
            }
            "saturationCurrent" => {
                self.leakage = value.max(1e-20);
                self.explicit_sat = true;
            }
            "breakdownVoltage" => {
                self.z_voltage = value;
            }
            // Changing between zero and non-zero series resistance changes
            // `internal_node_count`, which a live patch cannot do: the caller
            // must rebuild.
            "seriesResistance" => return false,
            _ => return false,
        }
        self.vcrit = critical_voltage(self.vscale, self.leakage);
        self.recompute_z_offset();
        true
    }

    fn reset(&mut self) {
        self.base.reset();
        self.last_v = 0.0;
        self.geq = 0.0;
        self.ieq = 0.0;
    }
}

/// Ebers-Moll bipolar transistor.
///
/// Posts are base, collector, emitter, in that order.
pub struct BipolarTransistor {
    base: Base,
    /// `1.0` for NPN, `-1.0` for PNP. Folding the type into a sign keeps one
    /// set of equations for both.
    polarity: f64,
    beta_f: f64,
    beta_r: f64,
    sat_current: f64,
    vcrit: f64,
    last_vbe: f64,
    last_vbc: f64,
    /// Initial collector node voltage, `-lastVbe` from the file. Stored
    /// pre-signed because the seed is an absolute node voltage, not a
    /// polarity-scaled junction voltage.
    seed_c: f64,
    /// Initial emitter node voltage, `-lastVbc` from the file.
    seed_e: f64,
    ic: f64,
    ib: f64,
}

impl BipolarTransistor {
    pub fn new(spec: &ElementSpec) -> Self {
        // The file sign is the type: +1 is NPN, -1 is PNP. Any non-negative
        // token (including the legacy 0) reads as NPN, matching upstream's
        // default-model saturation current of 1e-13.
        let sat = spec.param("saturationCurrent", 1e-13).max(1e-22);
        let polarity = if spec.param("pnp", 1.0) < 0.0 {
            -1.0
        } else {
            1.0
        };
        // Upstream restores the lastVbe/lastVbc tokens as the initial junction
        // state, swapped: the token named lastVbe drives the collector node
        // and lastVbc the emitter (TransistorElm.java:63-67). With the seeded
        // node voltages the first do_step computes vbe = p*lastVbc_token and
        // vbc = p*lastVbe_token, so the state below matches what those
        // voltages imply.
        let lastvbe = spec.param("lastVbe", 0.0);
        let lastvbc = spec.param("lastVbc", 0.0);
        Self {
            base: Base::with_posts(3),
            polarity,
            beta_f: spec.param("beta", 100.0).max(1e-3),
            beta_r: spec.param("betaReverse", 1.0).max(1e-3),
            sat_current: sat,
            vcrit: critical_voltage(VT, sat),
            last_vbe: polarity * lastvbc,
            last_vbc: polarity * lastvbe,
            seed_c: -lastvbe,
            seed_e: -lastvbc,
            ic: 0.0,
            ib: 0.0,
        }
    }
}

impl Element for BipolarTransistor {
    fn kind(&self) -> &'static str {
        "transistor"
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
    fn nonlinear(&self) -> bool {
        true
    }

    fn do_step(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        let (nb, nc, ne) = (self.base.nodes[0], self.base.nodes[1], self.base.nodes[2]);
        let p = self.polarity;
        let mut vbe = p * (self.base.volts[0] - self.base.volts[2]);
        let mut vbc = p * (self.base.volts[0] - self.base.volts[1]);

        if (vbe - self.last_vbe).abs() > CONVERGENCE_V
            || (vbc - self.last_vbc).abs() > CONVERGENCE_V
        {
            s.not_converged();
        }
        vbe = limit_junction(vbe, self.last_vbe, VT, self.vcrit);
        vbc = limit_junction(vbc, self.last_vbc, VT, self.vcrit);
        self.last_vbe = vbe;
        self.last_vbc = vbc;

        let exp_be = (vbe / VT).min(MAX_EXP_ARG).exp();
        let exp_bc = (vbc / VT).min(MAX_EXP_ARG).exp();
        let fwd = self.sat_current * (exp_be - 1.0);
        let rev = self.sat_current * (exp_bc - 1.0);
        let g_fwd = self.sat_current * exp_be / VT + JUNCTION_GMIN;
        let g_rev = self.sat_current * exp_bc / VT + JUNCTION_GMIN;

        let inv_bf = 1.0 / self.beta_f;
        let inv_br = 1.0 / self.beta_r;

        // Terminal currents in device polarity, positive flowing in.
        let ic = fwd - rev * (1.0 + inv_br);
        let ib = fwd * inv_bf + rev * inv_br;
        let ie = -(ic + ib);
        self.ic = p * ic;
        self.ib = p * ib;

        // Jacobian entries.
        let dic_dvbe = g_fwd;
        let dic_dvbc = -g_rev * (1.0 + inv_br);
        let dib_dvbe = g_fwd * inv_bf;
        let dib_dvbc = g_rev * inv_br;
        let die_dvbe = -(dic_dvbe + dib_dvbe);
        let die_dvbc = -(dic_dvbc + dib_dvbc);

        // For terminal X:
        //   p·i_x = d_be·(V(B) − V(E)) + d_bc·(V(B) − V(C)) + const
        // The polarity cancels out of the conductance terms because
        // `vbe = p·(V(B) − V(E))` and the current is scaled by `p` as well;
        // only the constant term keeps the sign.
        let mut terminal = |node: usize, d_be: f64, d_bc: f64, i0: f64| {
            s.node_pair(node, nb, d_be + d_bc);
            s.node_pair(node, ne, -d_be);
            s.node_pair(node, nc, -d_bc);
            let constant = p * (i0 - d_be * vbe - d_bc * vbc);
            s.node_rhs(node, -constant);
        };
        terminal(nc, dic_dvbe, dic_dvbc, ic);
        terminal(nb, dib_dvbe, dib_dvbc, ib);
        terminal(ne, die_dvbe, die_dvbc, ie);
    }

    fn calculate_current(&mut self, _ctx: &SimCtx) {
        // Report collector current as the element's headline figure.
        self.base.current = self.ic;
    }

    fn current_into_node(&self, post: usize) -> f64 {
        // Posts are base, collector, emitter; ib, ic and ie are positive into
        // the device, so the node drains each branch current.
        match post {
            0 => -self.ib,
            1 => -self.ic,
            2 => self.ic + self.ib, // -ie
            _ => 0.0,
        }
    }

    fn set_param(&mut self, name: &str, value: f64) -> bool {
        match name {
            "beta" if value > 0.0 => self.beta_f = value,
            "betaReverse" if value > 0.0 => self.beta_r = value,
            _ => return false,
        }
        true
    }

    fn seed_initial_voltages(&mut self, v: &mut [f64]) {
        // Upstream TransistorElm.java:65-67: base 0, collector -lastVbe,
        // emitter -lastVbc. Never overwrite the reference node.
        let nc = self.base.nodes[1];
        let ne = self.base.nodes[2];
        if nc != GROUND {
            v[nc] = self.seed_c;
        }
        if ne != GROUND {
            v[ne] = self.seed_e;
        }
    }

    fn reset(&mut self) {
        self.base.reset();
        self.last_vbe = 0.0;
        self.last_vbc = 0.0;
        self.ic = 0.0;
        self.ib = 0.0;
    }
}
