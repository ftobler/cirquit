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
use circuit_core::ElementSpec;
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

/// Subiteration at which the geometric ramp takes over, upstream's
/// `sim.subIterations > 100` (Diode.java:150).
const RAMP_START: u32 = 100;

/// The full-wave bridge startup whose diodes carry the "default-led" model's
/// saturation current (93.2 pA, DiodeModel.java:90), so the family's
/// `leakage * 0.01` base conductance sits at 9.3e-13 S, essentially the fixed
/// 1e-12 floor this branch replaced. That resurrects the hard-switching limit
/// cycle the plain-default-model bridge no longer forms
/// (`diode_bridge_startup_converges_within_a_tight_iteration_budget` in
/// transformer_matrix.rs): once the capacitor is charged, one switching step
/// locks up and burns its whole Newton budget without settling. This is the
/// one scenario the stuck-step ramp exists for, and every other test budget
/// tops out at or below [`RAMP_START`], leaving the ramp untested end to end.
#[test]
fn stuck_bridge_step_needs_the_ramp_and_converges_past_the_start() {
    // Upstream's own Newton cap is 100 subiterations, exactly the ramp start,
    // so the cycle is fatal there: the run must stop non-converged at the
    // switching step, which pins the circuit as genuinely stuck rather than
    // merely slow.
    let mut capped = build(stiff_bridge(), opts_budget(1e-6, false, RAMP_START));
    let fail = capped.run(2000);
    assert!(
        !fail.converged,
        "the switching cycle should exhaust a 100-iteration budget"
    );
    assert!(
        fail.error.is_some(),
        "the stalled run must record its convergence error"
    );

    // With room past the start, the same trajectory crosses subiteration 100,
    // the selector swaps in the geometric ramp (Diode.java:149-152) and the
    // formerly fatal step settles within a few further iterations. The
    // observation is the engagement proof: some step spent strictly more than
    // RAMP_START Newton rounds in flight, which only the ramp branch serves.
    let mut c = build(stiff_bridge(), opts_budget(1e-6, false, 1000));
    let mut over_start = None;
    for step in 0..2000u32 {
        let r = c.run(1);
        assert!(
            r.converged,
            "step {step} failed with the ramp available: {}",
            r.error.unwrap_or_default()
        );
        if r.iterations > RAMP_START && over_start.is_none() {
            over_start = Some((step, r.iterations));
        }
    }
    let (step, iterations) =
        over_start.expect("no step crossed the ramp start; the ramp was never exercised");

    // The ramp shapes the iteration path only: by the Norton cancellation the
    // committed solution is gmin-invariant, so the rescued run must land on
    // the physics anyway. Steady state pins the capacitor near the sine peak
    // less two conducting junction drops, each carrying the ~10 mA load
    // current at Is = 93.2 pA: vscale*ln(I/Is) = 2*VT*ln(1.1e8) is about
    // 0.96 V, so 12 - 2*0.96 = 10.08 V at the conduction peaks, less the few
    // dozen millivolts of hold sag accumulated before the sample.
    let v_cap = c.element_voltages()[5];
    assert!(
        (9.5..10.5).contains(&v_cap),
        "after the ramp rescue the capacitor read {v_cap} V at step {step} \
         ({iterations} iterations), expected the charged window around \
         peak minus two junction drops"
    );
}

/// The bridge behind transformer_matrix.rs's tight-budget startup test, with
/// every diode's saturation current set to the "default-led" model's 93.2 pA.
fn stiff_bridge() -> Vec<ElementSpec> {
    vec![
        elm(
            1,
            "voltage",
            &[[0, 160], [0, 320]],
            &[
                ("maxVoltage", 12.0),
                ("waveform", 1.0),
                ("frequency", 1000.0),
            ],
        ),
        stiff_diode(2, [[0, 160], [160, 160]]),
        stiff_diode(3, [[0, 320], [160, 160]]),
        stiff_diode(4, [[160, 320], [0, 160]]),
        stiff_diode(5, [[160, 320], [0, 320]]),
        elm(
            6,
            "capacitor",
            &[[160, 160], [160, 320]],
            &[("capacitance", 100e-6)],
        ),
        elm(
            7,
            "resistor",
            &[[160, 160], [320, 160]],
            &[("resistance", 1000.0)],
        ),
        elm(8, "wire", &[[320, 160], [320, 320]], &[]),
        elm(9, "wire", &[[320, 320], [160, 320]], &[]),
        elm(10, "ground", &[[0, 320]], &[]),
    ]
}

fn stiff_diode(id: u32, posts: [[i32; 2]; 2]) -> ElementSpec {
    elm(id, "diode", &posts, &[("saturationCurrent", 93.2e-12)])
}
