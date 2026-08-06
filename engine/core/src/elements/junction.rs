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
