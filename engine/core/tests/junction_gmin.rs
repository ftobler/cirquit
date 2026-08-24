//! Diode-family junction conductance, upstream's `gmin = leakage * 0.01`
//! below the stuck-step ramp (Diode.java:147-156).
//!
//! One property of the upstream stamping shapes everything here: the Norton
//! companion cancels the parallel conductance exactly at Newton convergence.
//! Upstream stamps `geq` including gmin but `nc = I(v) - geq*v` excluding the
//! `gmin*v` term (Diode.java:161-162), so once the junction voltage stops
//! moving the branch carries the bare Shockley law and gmin has no share in
//! any converged, well-posed result. It shapes the iteration path only. The
//! same holds for this port, by construction. These guards pin that
//! contract end to end; the red-first proof that the diode family stamps
//! `leakage * 0.01` itself lives with the selector in
//! `src/elements/junction.rs`.

mod common;
use common::*;

const VT: f64 = 0.025_865;
/// The default model's rated forward drop, the anchor the saturation current
/// is derived from (DiodeModel.java:149, DiodeElm.java:51).
const DEFAULT_FWDROP: f64 = 0.805_904_783;

fn default_leakage() -> f64 {
    let vscale = 2.0 * VT; // the default model's emission coefficient is 2
    1.0 / ((DEFAULT_FWDROP / vscale).exp() - 1.0)
}

#[test]
fn reverse_leakage_reads_the_saturation_current_not_the_gmin() {
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 10.0)]),
            // 1 ohm sense resistor: its readout is the true loop current of
            // whatever the diode stamped, conductance included.
            elm(2, "resistor", &[[0, 0], [100, 0]], &[("resistance", 1.0)]),
            // Cathode on the supply side: 10 V of reverse bias.
            elm(3, "diode", &[[100, 100], [100, 0]], &[]),
            elm(4, "wire", &[[100, 100], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
        ],
        opts(1e-5, true),
    );
    let report = c.run(20);
    assert!(report.converged);

    let leakage = default_leakage();
    let i = c.element_currents()[1].abs();
    // Deep in reverse the exponential underflows, so the loop carries the
    // saturation current alone, upstream's own calculateCurrent reading.
    assert!(
        close(i, leakage, 0.001 * leakage),
        "reverse leak was {i}, expected the bare saturation current \
         ({leakage}): the Norton form must cancel the parallel conductance \
         at convergence"
    );
    // The discriminating bound: if an implementation ever let gmin leak into
    // the converged branch (stamping nc without the -gmin*v cancellation, or
    // folding it into the readout), this circuit would show a
    // leakage*0.01*10 = 1.7e-8 excess where physics says ~1e-17.
    let excess = i - leakage;
    assert!(
        excess < 1e-13,
        "the converged loop carried {excess} A beyond the Shockley law; \
         the junction conductance must cancel out at Newton convergence"
    );
}

#[test]
fn sample_hold_drains_at_the_saturation_current_not_the_gmin() {
    let dt = 1e-3;
    let cap = 1e-8; // 10 nF
    let c = &mut build(
        vec![
            // Square wave, 0.1 Hz: +10 V holds for the first half period
            // (charging the cap through the diode), then sits at -10 V so
            // the diode is hard-reverse-biased for the whole measurement
            // window that follows.
            elm(
                1,
                "voltage",
                &[[0, 100], [0, 0]],
                &[("maxVoltage", 10.0), ("waveform", 2.0), ("frequency", 0.1)],
            ),
            elm(2, "resistor", &[[0, 0], [100, 0]], &[("resistance", 50.0)]),
            // Anode on the supply side, so the +10 V half charges the cap.
            elm(3, "diode", &[[100, 0], [100, 100]], &[]),
            elm(
                4,
                "capacitor",
                &[[100, 100], [100, 200]],
                &[("capacitance", cap)],
            ),
            elm(5, "wire", &[[100, 200], [0, 200]], &[]),
            elm(6, "wire", &[[0, 200], [0, 100]], &[]),
            elm(7, "ground", &[[0, 100]], &[]),
        ],
        opts(dt, false),
    );

    // Charge through the diode during the +10 V half, cross the falling edge
    // at t = 5 s, then sample the hold: v_a just after the edge, v_b 400
    // steps (exactly 0.4 s) later.
    let charge = c.run(4900);
    assert!(charge.converged);
    let settle = c.run(120);
    assert!(settle.converged);
    let v_a = c.element_voltages()[3];
    let hold = c.run(400);
    assert!(hold.converged);
    let v_b = c.element_voltages()[3];

    let droop = v_a - v_b;
    assert!(droop > 5.0, "the hold lost only {droop} V in 0.4 s");
    // In reverse saturation the junction conducts its Is regardless of
    // voltage, so the hold drains linearly at Is/C: 17.14 V/s here, 6.86 V
    // over the window. The trapezoidal companion integrates that linear law
    // exactly, so the trajectory should sit on it to Newton dust. A build
    // whose stamps let the junction conductance reach the committed
    // solution (a fixed 1e-12 floor would add nothing visible, but a
    // mis-cancelled nc with leakage*0.01 would drain at ~18.9 V/s) misses
    // by hundreds of millivolts.
    let leakage = default_leakage();
    let elapsed = 400.0 * dt;
    let predicted = v_a - leakage / cap * elapsed;
    assert!(
        close(v_b, predicted, 0.01),
        "held {v_b} after 0.4 s, the saturation drain law predicts \
         {predicted} (sampled from {v_a})"
    );
}
