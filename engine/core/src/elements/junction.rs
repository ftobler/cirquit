//! Shared Newton machinery for junction devices.

/// Thermal voltage at roughly room temperature, in volts.
pub(crate) const VT: f64 = 0.025_865;
/// Fixed parallel conductance of the transistor family's junctions, which
/// upstream hardcodes at 1e-12 (TransistorElm.java:348, its `leakage*0.01`
/// line commented out), and the lower clamp of the stuck-step ramp below.
/// The diode family instead scales its base conductance with the model's
/// saturation current, [`base_gmin`].
pub(crate) const JUNCTION_GMIN: f64 = 1e-12;

/// A Shockley junction's base parallel conductance before the stuck-step ramp
/// engages, upstream's `leakage * 0.01` (Diode.java:147): proportional to the
/// model's saturation current, so a leaky model damps a reverse-biased
/// junction proportionally harder and a peak detector's hold droops at the
/// rate upstream shows.
pub(crate) fn base_gmin(leakage: f64) -> f64 {
    leakage * 0.01
}

/// The conductance a Shockley junction stamps on Newton iteration `subiter`:
/// the saturation-current-scaled [`base_gmin`] below the ramp start, replaced
/// by the geometric [`ramp_gmin`] once a step is stuck
/// (Diode.java:147-156). Every device upstream serves with real `Diode`
/// instances routes through here, the plain diode plus SCR, TRIAC and DIAC,
/// the unijunction's emitter diode (UnijunctionElm.java:38) and the LED
/// array's grid (LEDArrayElm.java:90-94), so the family cannot drift. The
/// transistor family keeps the fixed `JUNCTION_GMIN`
/// instead, matching TransistorElm's hardcoded constant.
pub(crate) fn junction_gmin(leakage: f64, subiter: u32) -> f64 {
    if subiter > GMIN_RAMP_START {
        ramp_gmin(subiter, GMIN_RAMP_DENOM)
    } else {
        base_gmin(leakage)
    }
}
/// Largest exponent evaluated, guarding against `exp` overflowing to infinity
/// on a wild Newton excursion.
pub(crate) const MAX_EXP_ARG: f64 = 40.0;

/// Voltage change per iteration beyond which the solution is not settled.
pub(crate) const CONVERGENCE_V: f64 = 0.01;

/// Upstream's MOSFET/JFET tolerance ladder for one terminal's move between
/// Newton iterations (MosfetElm.java:517-533). True means the terminal has
/// not settled yet. Four stages: a plain 10 mV absolute bar; a x100
/// difference multiplier when the part's beta exceeds 1, because a
/// high-beta channel turns millivolt wobble into ampere-scale current
/// error; a relative pass past subiteration 10, when a move under 0.1% of
/// the terminal's own value is accepted so a settled large signal is not
/// chased forever; and a linear loosening past subiteration 100 for
/// closures that genuinely struggle. The multiplier applies before every
/// branch, so it rides the relative and loosened tests too: a high-beta
/// part settles to a hundredth of the absolute bar a default part asks
/// for. JFETs share the ladder because upstream's JfetElm extends
/// MosfetElm and reaches it through super.doStep() (JfetElm.java:24,
/// :119-122), each device contributing its own model beta.
pub(crate) fn convergence_ladder(beta: f64, subiter: usize, last: f64, now: f64) -> bool {
    let mut diff = (last - now).abs();
    if beta > 1.0 {
        diff *= 100.0;
    }
    if diff < CONVERGENCE_V {
        return false;
    }
    if subiter > 10 && diff < now.abs() * 0.001 {
        return false;
    }
    if subiter > 100 && diff < CONVERGENCE_V + (subiter as f64 - 100.0) * 1e-4 {
        return false;
    }
    true
}

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

#[cfg(test)]
mod tests {
    use super::*;

    /// The port's default diode model: emission coefficient 2, saturation
    /// current derived from the rated 0.805904783 V forward drop
    /// (DiodeModel.java:149). Is = 1.7143528192808883e-7.
    const DEFAULT_FWDROP: f64 = 0.805_904_783;

    fn default_leakage() -> f64 {
        let vscale = 2.0 * VT;
        1.0 / ((DEFAULT_FWDROP / vscale).exp() - 1.0)
    }

    #[test]
    fn diode_family_base_gmin_tracks_the_saturation_current() {
        // Upstream's pre-ramp conductance is leakage * 0.01 (Diode.java:147),
        // not a fixed floor: with the default model that is 1.714e-9, about
        // 1700x the fixed 1e-12 an earlier port revision stamped here.
        let leakage = default_leakage();
        assert_eq!(junction_gmin(leakage, 0), leakage * 0.01);
        // Subiteration 100 itself is still below GMIN_RAMP_START, so the
        // base applies right up to the ramp's first iteration.
        assert_eq!(junction_gmin(leakage, GMIN_RAMP_START), leakage * 0.01);
    }

    #[test]
    fn gmin_ramp_still_takes_over_past_the_start() {
        // Past the stuck-step threshold the ramp REPLACES the base, whatever
        // the model's saturation current (Diode.java:149-152).
        let leakage = default_leakage();
        assert_eq!(
            junction_gmin(leakage, GMIN_RAMP_START + 1),
            ramp_gmin(GMIN_RAMP_START + 1, GMIN_RAMP_DENOM)
        );
        // And it grows from there, capping at GMIN_MAX.
        let mid = junction_gmin(leakage, 1500);
        let late = junction_gmin(leakage, 2999);
        assert!(mid > junction_gmin(leakage, GMIN_RAMP_START + 1));
        assert!(late > mid);
        assert_eq!(junction_gmin(leakage, 100000), GMIN_MAX);
    }

    #[test]
    fn transistor_junction_floor_stays_fixed() {
        // TransistorElm.java hardcodes 1e-12 (its leakage*0.01 line commented
        // out), so the shared constant must not drift with the diode fix.
        assert_eq!(JUNCTION_GMIN, 1e-12);
    }

    /// The tolerance ladder against upstream's table of cases
    /// (MosfetElm.java:517-533): the absolute bar, the beta multiplier that
    /// rides every later branch too, the relative pass past subiteration 10,
    /// and the linear loosening past 100. The beta=0.02 rows are the mosfet
    /// default; the jfet rows pin that the same ladder keys on whatever
    /// model beta the device carries.
    #[test]
    fn convergence_ladder_tolerance_table() {
        let mosfet_default = 0.02;
        let jfet_default = 0.00125;

        // A plain 20 mV move on a 50 V signal: over the absolute bar, and the
        // relative pass needs more than ten iterations behind it.
        assert!(convergence_ladder(mosfet_default, 5, 49.98, 50.0));
        // Same move at subiteration 50 passes relatively: 20 mV is far under
        // 0.1% of 50 V.
        assert!(!convergence_ladder(mosfet_default, 50, 49.98, 50.0));

        // The same 20 mV move near ground gets no relative rescue (it is not
        // below 0.1% of a small signal), so only the loosening helps, and it
        // helps gradually: 15 mV at 150, 25 mV at 250.
        assert!(convergence_ladder(mosfet_default, 5, 0.0, 0.02));
        assert!(convergence_ladder(mosfet_default, 50, 0.0, 0.02));
        assert!(convergence_ladder(mosfet_default, 150, 0.0, 0.02));
        assert!(!convergence_ladder(mosfet_default, 250, 0.0, 0.02));

        // The absolute bar itself, strict inequality like upstream's `<`.
        assert!(!convergence_ladder(mosfet_default, 5, 0.0, 0.0095));
        assert!(convergence_ladder(mosfet_default, 5, 0.0, 0.01));

        // Beta above 1 multiplies the difference by 100 before any branch:
        // the same 9.5 mV move that a default part accepts fails here, while
        // one under 0.1 mV still passes.
        assert!(convergence_ladder(10.0, 5, 0.0, 0.0095));
        assert!(!convergence_ladder(10.0, 5, 0.0, 0.00005));
        // The multiplier reaches into the relative branch too (upstream
        // compares the scaled diff there), so a high-beta part on a large
        // node still refuses a move its default sibling would accept.
        assert!(convergence_ladder(10.0, 150, 49.998, 50.0));
        assert!(!convergence_ladder(10.0, 150, 50.0, 50.00004));

        // A settled terminal never reports motion, whatever the budget.
        assert!(!convergence_ladder(10.0, 150, 50.0, 50.0));

        // JFET rows. Upstream's stock JFET models are small-beta (the
        // default-jfet carries 0.00125), so one behaves like these low-beta
        // rows; but MosfetModel.beta is a user-editable model parameter with
        // no upper clamp, so a custom high-beta JFET reaches the multiplier
        // through the inherited ladder exactly as a mosfet does.
        assert!(!convergence_ladder(jfet_default, 5, 0.0, 0.0095));
        assert!(!convergence_ladder(jfet_default, 150, 49.998, 50.0));
        assert!(convergence_ladder(2.0, 5, 0.0, 0.0095));
    }
}
