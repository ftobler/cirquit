//! Transmission line parity with upstream's TransLineElm: the ring length
//! truncates the delay ratio, and a delay too long for the ring cap stops
//! the run with upstream's message instead of silently shortening the line.

use circuit_core::{Circuit, CircuitSpec, ElementSpec, ScopeValue};

mod common;
use common::*;

/// A 10 V step behind a matched 75 ohm source resistor drives the left port,
/// both inner posts grounded, the far end open: the waveform_sources layout
/// with the delay parameterised.
fn open_line_elements(delay: f64) -> Vec<ElementSpec> {
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
    ]
}

fn open_line_circuit(delay: f64) -> Circuit {
    build_with(
        open_line_elements(delay),
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

#[test]
fn preserve_run_sizes_the_ring_from_the_nominal_step_not_a_carried_one() {
    // A preserving rebuild keeps the adaptive working step alive across an
    // edit (the carry-over in circuit.rs set_circuit) but resets nominal_dt
    // to options.time_step, and the line sizes its ring from the nominal at
    // first stamp (transmission_line.rs stamp). Keying the ring to the
    // carried step would size floor(17.5/2.5) = 7 slots here and land the
    // edge on step eight; keyed to the nominal it is floor(17.5/5) = 3
    // slots, matching a fresh build's delivery timing.
    let adaptive = adaptive_opts(5e-6, 1e-6, 4);
    let spec = CircuitSpec {
        preserve_run: false,
        elements: compliance_circuit(0.0),
        options: Some(adaptive),
        scopes: Vec::new(),
    };
    let mut c = Circuit::new();
    c.set_circuit(&spec)
        .expect("compliance circuit should build");
    // Drive one compliance crossing so current_time_step latches 2.5e-6:
    // the 5e-6 attempt misses the budget of 4 and the halved one commits,
    // exactly one rejection (the tuning analysis_hygiene's floor test leans
    // on; shift that and this moves too).
    let mut crossing = None;
    for _ in 0..200 {
        let r = c.run(1);
        assert!(
            r.converged,
            "the halving chain must end in a commit: {:?}",
            r.error
        );
        if r.rejected_steps >= 1 {
            crossing = Some(r);
            break;
        }
    }
    let r = crossing.expect("no step ever rejected the full timestep");
    assert_eq!(r.rejected_steps, 1, "one halving should have sufficed");
    assert!(
        close(r.time_step, 2.5e-6, 1e-15),
        "the committed step was {}, not the expected 2.5e-6",
        r.time_step
    );

    // Rebuild the same Circuit into the open line with preserve_run: true
    // and the same options: ctx.dt carries the 2.5e-6 working step in while
    // nominal_dt resets to 5e-6.
    c.set_circuit(&CircuitSpec {
        preserve_run: true,
        elements: open_line_elements(17.5e-6),
        options: Some(adaptive_opts(5e-6, 1e-6, 4)),
        scopes: vec![tr_scope(1, ScopeValue::NodeVoltage, 3)],
    })
    .expect("line rebuild should analyse");

    // A 3-slot ring delivers on the fourth committed step no matter what
    // the working step does; a 7-slot ring would still read 0 V here.
    for _ in 0..3 {
        c.run(1);
        assert!(
            close(last_sample(&c, 0), 0.0, 1e-9),
            "far end must stay at 0 while the nominal-sized ring fills"
        );
    }
    c.run(1);
    assert!(
        close(last_sample(&c, 0), 10.0, 1e-3),
        "a nominal-sized ring delivers the edge on the fourth step, like a fresh build"
    );
}

/// The compliance island of common::compliance_circuit, shifted far enough
/// away that no coordinate touches the line's island and with ids bumped past
/// the line's: an electrically separate Newton-forcing stage in the same
/// circuit, so the shared working step halves while the line's own closure
/// stays linear.
fn forcing_island() -> Vec<ElementSpec> {
    compliance_circuit(0.0)
        .into_iter()
        .map(|mut e| {
            e.id += 10;
            for p in e.posts.iter_mut() {
                p[0] += 2000;
                p[1] += 2000;
            }
            e
        })
        .collect()
}

#[test]
fn delivered_delay_stays_at_delay_across_halved_steps() {
    // The ring advance is gated on upstream's bucket counter exactly like the
    // meters (TransLineElm.java:216-221), because the ring is sized as
    // delay / nominal_dt: advancing per committed step under a halved working
    // step would walk the ring once per substep and contract the line's
    // delivered delay by the subdivision factor. An 8-slot line driven
    // through two halvings' worth of adaptation must therefore deliver its
    // edge at delay plus at most one nominal step; the ungated code would
    // land it one halved step (2.5 us) early for every rejection taken.
    let dt = 5e-6;
    let delay = 8.0 * dt;
    let mut els = open_line_elements(delay);
    els.extend(forcing_island());
    let spec = CircuitSpec {
        preserve_run: false,
        elements: els,
        options: Some(adaptive_opts(dt, 50e-12, 4)),
        scopes: vec![tr_scope(1, ScopeValue::NodeVoltage, 3)],
    };
    let c = &mut Circuit::new();
    c.set_circuit(&spec)
        .expect("the split circuit should build");

    let mut rejected = 0u32;
    let mut arrival = None;
    for _ in 0..60 {
        let r = c.run(1);
        assert!(r.converged, "halving must rescue every step: {:?}", r.error);
        rejected += r.rejected_steps;
        if last_sample(c, 0) > 5.0 {
            arrival = Some(r.time);
            break;
        }
    }
    let t_arrival = arrival.expect("the edge never arrived");
    assert!(
        rejected >= 2,
        "adaptation never engaged before delivery, so this test proves nothing"
    );
    // Gated: the edge shows up on the first commit whose cumulative time
    // passes the delay, so within one nominal step above it and never below.
    assert!(
        t_arrival > delay - 1e-12,
        "edge arrived at {} s, the delivered delay contracted below {} s",
        t_arrival,
        delay
    );
    assert!(
        t_arrival <= delay + dt + 1e-12,
        "edge arrived at {} s, more than a nominal step late",
        t_arrival
    );
}
