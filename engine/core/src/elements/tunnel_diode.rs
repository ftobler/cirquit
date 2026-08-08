//! Tunnel diode: a two-terminal nonlinear device with a negative-resistance
//! region (TunnelDiodeElm.java). Its current is a fixed curve of the terminal
//! voltage with no adjustable parameters.

use crate::element::{Base, Element, SimCtx};
use crate::elements::junction::CONVERGENCE_V;
use crate::spec::ElementSpec;
use crate::stamp::Stamper;

/// Curve constants from upstream's `TunnelDiodeElm` (TunnelDiodeElm.java:
/// 93-98). `pvp` is the tunnelling-peak voltage, `pip` its current, `pvv` the
/// valley voltage, `pvt` a thermal scale, `pvpp` the forward-knee voltage and
/// `piv` the valley current. They are hardcoded, not file tokens: the format
/// carries nothing after the shared x/y/flags fields.
const PVP: f64 = 0.1;
const PIP: f64 = 4.7e-3;
const PVV: f64 = 0.37;
const PVT: f64 = 0.026;
const PVPP: f64 = 0.525;
const PIV: f64 = 370e-6;

/// Largest voltage change allowed per Newton iteration, upstream's `limitStep`
/// 1 V clamp (TunnelDiodeElm.java:80-88). The steep forward exponential would
/// otherwise overshoot by decades and throw the iteration into a limit cycle.
const LIMIT_V: f64 = 1.0;

/// A tunnel diode, whose current is a pure function of the terminal voltage
/// (TunnelDiodeElm.java:99-127). There is no persistent junction state beyond
/// the last solved voltage, which the Newton limiting and the convergence
/// check anchor on.
pub struct TunnelDiode {
    base: Base,
    /// Last limited voltage the companion model was linearised around.
    last_v: f64,
}

impl TunnelDiode {
    pub fn new(_spec: &ElementSpec) -> Self {
        Self {
            base: Base::with_posts(2),
            last_v: 0.0,
        }
    }
}

/// The current law, upstream's `calculateCurrent` (TunnelDiodeElm.java:
/// 122-127): a tunnelling peak `pip` at `PVP`, a valley exponential `piv` at
/// `PVV`, and a steep forward exponential at `PVT`. The `- i0` subtracts the
/// valley branch's value at zero so the curve passes through the origin.
fn curve_current(v: f64) -> f64 {
    let i0 = PIV * (-PVV).exp();
    PIP * (-PVPP / PVT).exp() * ((v / PVT).exp() - 1.0)
        + PIP * (v / PVP) * (1.0 - v / PVP).exp()
        + PIV * (v - PVV).exp()
        - i0
}

/// Slope of the curve, the analytical derivative of `curve_current`
/// (TunnelDiodeElm.java:113-116). The tunnelling term makes it negative
/// between the peak at `PVP` and the valley near `PVV`, which is the
/// negative-resistance region that makes this device useful.
fn curve_conductance(v: f64) -> f64 {
    PIP * (-PVPP / PVT).exp() * (v / PVT).exp() / PVT + PIP * (1.0 - v / PVP).exp() / PVP
        - (1.0 - v / PVP).exp() * PIP * v / (PVP * PVP)
        + (v - PVV).exp() * PIV
}

/// Upstream's `limitStep` (TunnelDiodeElm.java:80-88): never move the
/// linearisation point more than 1 V per iteration, which is what keeps the
/// steep exponentials from throwing the iteration into a limit cycle.
fn limit_step(vnew: f64, vold: f64) -> f64 {
    if vnew > vold + LIMIT_V {
        vold + LIMIT_V
    } else if vnew < vold - LIMIT_V {
        vold - LIMIT_V
    } else {
        vnew
    }
}

impl Element for TunnelDiode {
    fn kind(&self) -> &'static str {
        "tunnelDiode"
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

    fn do_step(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        let v = self.base.volts[0] - self.base.volts[1];
        if (v - self.last_v).abs() > CONVERGENCE_V {
            s.not_converged();
        }
        let v = limit_step(v, self.last_v);
        self.last_v = v;
        // The Norton companion, the same shape the diode family stamps: a
        // conductance across the posts plus a current source whose intercept
        // puts the linearised line through the curve point
        // (TunnelDiodeElm.java:117-119).
        let g = curve_conductance(v);
        let ieq = curve_current(v) - g * v;
        s.conductance(self.base.nodes[0], self.base.nodes[1], g);
        s.current_source(self.base.nodes[0], self.base.nodes[1], ieq);
    }

    fn calculate_current(&mut self, _ctx: &SimCtx) {
        self.base.current = curve_current(self.base.volts[0] - self.base.volts[1]);
    }

    /// Re-anchors the linearisation from the restored node voltages, so a
    /// retry at a smaller step does not keep the previous attempt's limited
    /// voltage, the same reasoning as the diode's `restore_iteration`.
    fn restore_iteration(&mut self) {
        self.last_v = self.base.volts[0] - self.base.volts[1];
    }

    fn reset(&mut self) {
        self.base.reset();
        self.last_v = 0.0;
    }
}
