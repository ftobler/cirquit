//! Shared Newton machinery for junction devices.

/// Thermal voltage at roughly room temperature, in volts.
pub(crate) const VT: f64 = 0.025_865;
/// Parallel conductance added across every junction. Keeps a reverse-biased
/// junction from presenting an effectively infinite impedance, which is what
/// stalls Newton on circuits like a bridge rectifier at start-up.
pub(crate) const JUNCTION_GMIN: f64 = 1e-12;
/// Largest exponent evaluated, guarding against `exp` overflowing to infinity
/// on a wild Newton excursion.
pub(crate) const MAX_EXP_ARG: f64 = 40.0;

/// Voltage change per iteration beyond which the solution is not settled.
pub(crate) const CONVERGENCE_V: f64 = 0.01;

/// Subiteration at which the geometric junction-conductance ramp starts,
/// upstream's `sim.subIterations > 100` (Diode.java:150).
pub(crate) const GMIN_RAMP_START: u32 = 100;
/// Ramp denominator for the diode, upstream's 3000 (Diode.java:150).
pub(crate) const GMIN_RAMP_DENOM: f64 = 3000.0;
/// The transistor's ramp climbs ten times faster (TransistorElm.java:355).
pub(crate) const GMIN_RAMP_DENOM_TRANSISTOR: f64 = 300.0;
/// Upper clamp on the ramped conductance, so a stuck junction cannot be
/// shorted out entirely (Diode.java:151-152).
pub(crate) const GMIN_MAX: f64 = 0.1;

/// The geometric junction-conductance ramp. At `subiter` just past the start
/// it is about 2e-9, above the 1e-12 floor; it grows by a decade for every
/// `denom/9` subiterations and caps at `GMIN_MAX`. The extra conductance
/// damps the two-state limit cycle a hard switching junction can lock into.
pub(crate) fn ramp_gmin(subiter: u32, denom: f64) -> f64 {
    let ramp = (-9.0 * 10.0f64.ln() * (1.0 - subiter as f64 / denom)).exp();
    JUNCTION_GMIN.max(ramp.min(GMIN_MAX))
}

/// Standard junction limiting. Without it, Newton's linear extrapolation of an
/// exponential overshoots by many decades and the iteration never recovers.
pub(crate) fn limit_junction(vnew: f64, vold: f64, vt: f64, vcrit: f64) -> f64 {
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

pub(crate) fn critical_voltage(vt: f64, leakage: f64) -> f64 {
    vt * (vt / (std::f64::consts::SQRT_2 * leakage)).ln()
}
