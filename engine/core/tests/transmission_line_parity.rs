//! Transmission line parity with upstream's TransLineElm: the ring length
//! truncates the delay ratio, and a delay too long for the ring cap stops
//! the run with upstream's message instead of silently shortening the line.

use circuit_core::{Circuit, ScopeValue};

mod common;
use common::*;

/// A 10 V step behind a matched 75 ohm source resistor drives the left port,
/// both inner posts grounded, the far end open: the waveform_sources layout
/// with the delay parameterised.
fn open_line_circuit(delay: f64) -> Circuit {
    build_with(
        vec![
            elm(
                1,
                "transmissionLine",
                &[[0, 100], [400, 100], [0, 0], [400, 0]],
                &[("delay", delay), ("imped", 75.0)],
            ),
            elm(2, "ground", &[[0, 100]], &[]),
            elm(3, "ground", &[[400, 100]], &[]),
            elm(
                4,
                "voltage",
                &[[-100, 100], [-100, 0]],
                &[("maxVoltage", 10.0)],
            ),
            elm(5, "resistor", &[[-100, 0], [0, 0]], &[("resistance", 75.0)]),
            elm(6, "ground", &[[-100, 100]], &[]),
        ],
        opts(5e-6, false),
        vec![tr_scope(1, ScopeValue::NodeVoltage, 3)],
    )
}

#[test]
fn half_step_delay_delivers_on_the_truncated_ring() {
    // delay/dt = 3.5 must ride a 3-slot ring like upstream's `(int)` cast
    // (TransLineElm.java:94): the far end stays at 0 through three committed
    // steps and reads the full source value one step later. Rounding sized
    // 4 slots and pushed the edge a step out; an open far end doubles the
    // arrived wave back to the source value.
    let dt = 5e-6;
    let c = &mut open_line_circuit(3.5 * dt);
    c.run(3);
    assert!(
        close(last_sample(c, 0), 0.0, 1e-9),
        "far end must stay at 0 while the truncated ring is still filling"
    );
    c.run(1);
    assert!(
        close(last_sample(c, 0), 10.0, 1e-3),
        "a 3-slot ring delivers the edge on the fourth step"
    );
}

#[test]
fn exact_multiple_control_transitions_on_the_same_step() {
    // Control for the truncation test: a 3.0 dt line is what the 3.5 dt one
    // truncates to, so both must move the far end on exactly the same step.
    let dt = 5e-6;
    let c = &mut open_line_circuit(3.0 * dt);
    c.run(3);
    assert!(close(last_sample(c, 0), 0.0, 1e-9));
    c.run(1);
    assert!(close(last_sample(c, 0), 10.0, 1e-3));
}

#[test]
fn over_long_delay_stops_the_run_with_upstreams_message() {
    // 1 s at a 5 us step needs 200000 ring slots; upstream refuses anything
    // over 100000 (TransLineElm.java:96-101) and stops the simulation from
    // doStep with this exact message (TransLineElm.java:203-205). Clamping
    // to the cap instead would run a 1 s line as a 0.5 s line with no
    // indication.
    let c = &mut open_line_circuit(1.0);
    let r = c.run(1);
    assert!(!r.converged, "the stop must halt the frame");
    assert_eq!(
        r.error.as_deref(),
        Some("Transmission line delay too large!")
    );
    assert!(
        close(r.time, 0.0, 1e-15),
        "no timestep may commit past the stop"
    );
    // The side channel the frontend polls after every frame carries it too,
    // and a further run stays stopped rather than silently proceeding.
    assert_eq!(c.error(), Some("Transmission line delay too large!"));
    let r2 = c.run(1);
    assert_eq!(
        r2.error.as_deref(),
        Some("Transmission line delay too large!")
    );
    assert!(close(r2.time, 0.0, 1e-15));
}
