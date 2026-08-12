//! JFET, triode, phase comparator, spark gap, SCR, DIAC and TRIAC.

use circuit_core::Circuit;

mod common;
use common::*;

fn n_jfet_drain(r: f64) -> Circuit {
    build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 5.0)]),
            elm(2, "resistor", &[[0, 0], [100, 0]], &[("resistance", r)]),
            elm(
                3,
                "jfet",
                &[[200, 100], [100, 100], [100, 0]],
                &[("pnp", 1.0), ("threshold", -4.0), ("beta", 0.00125)],
            ),
            elm(4, "wire", &[[200, 100], [100, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
            elm(6, "ground", &[[100, 100]], &[]),
        ],
        opts(1e-5, true),
    )
}

#[test]
fn n_jfet_saturation_current_with_gate_tied_to_source() {
    // Gate at source voltage, vt = -4, beta = 0.00125: the depletion channel
    // conducts its full saturation current ids = .5*beta*(vgs-vt)^2 = 10 mA,
    // and the gate junction, sitting at 0 V, leaks nothing. The drain voltage
    // follows Ohm's law on the 50 ohm load: Vd = 5 - ids*R = 4.5 V.
    let c = &mut n_jfet_drain(50.0);
    let report = c.run(20);
    assert!(report.converged, "did not converge: {:?}", report.error);
    assert!(
        close(c.element_voltages()[2], 4.5, 1e-3),
        "drain was {}",
        c.element_voltages()[2]
    );
    assert!(
        close(c.element_currents()[2], 0.01, 1e-5),
        "ids was {}",
        c.element_currents()[2]
    );
}

#[test]
fn triode_plate_current_matches_its_power_law() {
    // The triode sits between two ideal sources, so its terminal voltages are
    // pinned: plate at +250 V and the grid at vg, cathode grounded. The
    // reported element current is the cathode current `ids + ig` from
    // upstream's law (TriodeElm.java:169-202): `ival = vgk + vpk/mu`,
    // `ids = pow(ival, 1.5)/kg1` above cutoff and `vpk*1e-8` below, with
    // `ig = vgk/6000` once the grid conducts. The values below are
    // hand-rounded from that law at mu = 93, kg1 = 680.
    let plate_current = |vg: f64| {
        let c = &mut build(
            vec![
                elm(1, "voltage", &[[0, 0], [0, 200]], &[("maxVoltage", 250.0)]),
                elm(2, "voltage", &[[100, 0], [100, 200]], &[("maxVoltage", vg)]),
                elm(
                    3,
                    "triode",
                    &[[0, 200], [100, 200], [100, 0]],
                    &[("mu", 93.0), ("kg1", 680.0)],
                ),
                elm(4, "ground", &[[0, 0]], &[]),
                elm(5, "ground", &[[100, 0]], &[]),
            ],
            opts_budget(1e-5, true, 100),
        );
        let report = c.run(20);
        assert!(
            report.converged,
            "triode stalled at Vg = {vg}: {:?}",
            report.failing
        );
        c.element_currents()[2]
    };

    // At Vg = 0 the tube conducts `(250/93)^1.5/680` with no grid current; at
    // Vg = 1 the grid adds its `vgk/6000` share; at Vg = -3 ival is negative,
    // so the plate collapses to the `vpk*1e-8` leak. The bias values pin the
    // same plate voltage in each build, isolating the grid's effect.
    for (vg, want) in [
        (0.0, 6.481_517_19e-3),
        (1.0, 1.058_283_15e-2),
        (-3.0, 2.5e-6),
    ] {
        assert!(
            close(plate_current(vg), want, 1e-6),
            "at Vg = {vg} the triode drew {}, expected {want}",
            plate_current(vg)
        );
    }

    // End-to-end stamp check: a 400 V supply feeds the plate through a 2380
    // ohm resistor with the grid grounded. The load line crosses the triode
    // curve exactly at Vp = 372 V, where `ids = (400-372)/2380 = 1/85` and the
    // law gives `(372/93)^1.5/680 = 4^1.5/680 = 8/680 = 1/85`. A sign error in
    // the stamped companion moves the plate voltage off this window.
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 0], [0, 400]], &[("maxVoltage", 400.0)]),
            elm(
                2,
                "resistor",
                &[[0, 400], [100, 400]],
                &[("resistance", 2380.0)],
            ),
            elm(
                3,
                "triode",
                &[[100, 400], [200, 400], [200, 0]],
                &[("mu", 93.0), ("kg1", 680.0)],
            ),
            elm(4, "ground", &[[0, 0]], &[]),
            elm(5, "ground", &[[200, 0]], &[]),
            elm(6, "ground", &[[200, 400]], &[]),
        ],
        opts_budget(1e-5, true, 200),
    );
    let report = c.run(20);
    assert!(
        report.converged,
        "load-line triode stalled: {:?}",
        report.failing
    );
    let vp = c.element_voltages()[2];
    assert!(
        close(vp, 372.0, 0.5),
        "plate voltage was {vp} V, expected ~372"
    );
    let ids = c.element_currents()[2];
    assert!(
        close(ids, 1.0 / 85.0, 1e-4),
        "plate current was {ids} A, expected ~1/85"
    );
}

#[test]
fn phase_comparator_drives_high_on_i1_edge_and_clears_on_i2_edge() {
    // A rising edge on I1 with I2 low sets the first internal flip-flop and
    // drives the output high; a later rising edge on I2 sets the second and,
    // with both set, the comparator clears and the output drops.
    let c = &mut build(
        vec![
            elm(
                1,
                "logicInput",
                &[[0, 0]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm(
                2,
                "logicInput",
                &[[0, 32]],
                &[("hiV", 5.0), ("loV", 0.0), ("position", 0.0)],
            ),
            elm(
                3,
                "phaseComp",
                &[[0, 0], [0, 32], [96, 0]],
                &[("highVoltage", 5.0)],
            ),
            elm(
                4,
                "resistor",
                &[[96, 0], [96, 100]],
                &[("resistance", 1000.0)],
            ),
            elm(5, "ground", &[[96, 100]], &[]),
        ],
        opts(1e-5, false),
    );
    let out = |c: &Circuit| c.element_voltages()[3];
    c.run(3);
    assert!(close(out(c), 0.0, 1e-9), "fresh output was not low");
    c.set_state(1, 1);
    c.run(3);
    assert!(
        close(out(c), 5.0, 1e-9),
        "first edge did not drive the output high"
    );
    c.set_state(1, 0);
    c.run(3);
    assert!(
        close(out(c), 5.0, 1e-9),
        "output dropped while only ff1 was set"
    );
    c.set_state(2, 1);
    c.run(3);
    assert!(
        close(out(c), 0.0, 1e-9),
        "second edge did not clear the output"
    );
}

#[test]
fn spark_gap_fires_above_breakdown_and_latches_on() {
    // A 1500 V source through 1000 ohm and the gap: once the gap fires the
    // loop draws V/(R + r_on) = 0.75 A, and the gap holds 750 V, below the
    // 1000 V breakdown. It stays on because 0.75 A > holdcurrent.
    let dt = 1e-5;
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 1500.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(3, "sparkGap", &[[100, 0], [100, 100]], &[]),
            elm(4, "wire", &[[100, 100], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
        ],
        opts(dt, false),
    );
    c.run(3);
    let volts = c.element_voltages();
    let amps = c.element_currents();
    assert!(
        close(amps[1], 0.75, 1e-6),
        "resistor current was {}, expected 0.75 A once the gap fired",
        amps[1]
    );
    assert!(
        close(amps[2], 0.75, 1e-6),
        "gap current was {}, expected 0.75 A",
        amps[2]
    );
    assert!(
        close(volts[2], 750.0, 1e-3),
        "gap held {} V, expected 750 V below breakdown",
        volts[2]
    );
    c.run(97);
    let amps = c.element_currents();
    assert!(
        close(amps[2], 0.75, 1e-6),
        "latched gap current drifted to {} A",
        amps[2]
    );
}

#[test]
fn spark_gap_stays_off_below_breakdown() {
    // A 500 V source across the off gap is below the 1000 V breakdown, so the
    // gap keeps stamping r_off and the loop current stays at V/(R + r_off).
    let dt = 1e-5;
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 500.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(3, "sparkGap", &[[100, 0], [100, 100]], &[]),
            elm(4, "wire", &[[100, 100], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
        ],
        opts(dt, false),
    );
    c.run(5);
    let volts = c.element_voltages();
    let amps = c.element_currents();
    let expected = 500.0 / (1000.0 + 1e9);
    assert!(
        close(amps[2], expected, 1e-12),
        "off gap drew {}, expected the r_off divider current {}",
        amps[2],
        expected
    );
    assert!(
        close(volts[2], 500.0 * 1e9 / (1000.0 + 1e9), 1e-6),
        "off gap held {}, expected almost the full supply",
        volts[2]
    );
}

#[test]
fn spark_gap_clears_when_current_drops_below_holdcurrent() {
    // Fire the gap at 2000 V (loop current 1 A), then cut the source to 1 V:
    // the on-state current drops below the 1 mA holdcurrent and the gap opens.
    let dt = 1e-5;
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 2000.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(3, "sparkGap", &[[100, 0], [100, 100]], &[]),
            elm(4, "wire", &[[100, 100], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
        ],
        opts(dt, false),
    );
    c.run(3);
    let amps = c.element_currents();
    assert!(
        close(amps[2], 1.0, 1e-6),
        "expected the fired gap to draw 1 A, got {}",
        amps[2]
    );
    assert!(
        c.set_param(1, "maxVoltage", 1.0),
        "source voltage edit refused"
    );
    c.run(2);
    let amps = c.element_currents();
    let expected = 1.0 / (1000.0 + 1e9);
    assert!(
        close(amps[2], expected, 1e-12),
        "gap should have opened to the r_off current {}, got {}",
        expected,
        amps[2]
    );
}

#[test]
fn scr_blocks_until_gate_pulse_then_latches() {
    // The SCR's off state is not an open circuit: the anode path is a 10e5
    // (upstream's literal `10e5`) ohm resistor in series with the internal
    // forward-biased diode, so a 2 V supply leaks about 17.6 uA through it,
    // far below the 8.2 mA holding current, and the anode-cathode voltage
    // holds near the full supply. Driving the gate to 3 V pushes 60 mA
    // through the 50 ohm internal gate resistor, past the 10 mA trigger, and
    // the next step latches the resistor to 0.0105 ohm: the loop then draws
    // (2 - v_on)/50 with v_on ~ 0.62 V, about 27.6 mA. That anode current is
    // well above holdingI, so the latch survives the gate returning to 0 V.
    let dt = 1e-5;
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 2.0)]),
            elm(2, "resistor", &[[0, 0], [100, 0]], &[("resistance", 50.0)]),
            elm(3, "scr", &[[100, 0], [100, 200], [128, 128]], &[]),
            elm(4, "wire", &[[100, 200], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
            elm(
                6,
                "voltage",
                &[[128, 48], [128, 128]],
                &[("maxVoltage", 0.0)],
            ),
            elm(7, "ground", &[[128, 48]], &[]),
        ],
        opts_budget(dt, false, 100),
    );
    c.run(20);
    let volts = c.element_voltages();
    let amps = c.element_currents();
    assert!(
        amps[2] < 1e-4,
        "blocked SCR drew {} A, expected only the ~17.6 uA off-state leakage",
        amps[2]
    );
    assert!(
        close(volts[2], 2.0, 0.05),
        "blocked SCR held {} V, expected nearly the full 2 V supply",
        volts[2]
    );

    // Gate pulse: 3 V on the gate drives 60 mA through the internal 50 ohm
    // gate resistor, over the 10 mA trigger, so the latch fires and the
    // anode-cathode voltage drops to the diode's on-state drop.
    assert!(c.set_param(6, "maxVoltage", 3.0), "gate pulse refused");
    c.run(5);
    let volts = c.element_voltages();
    let amps = c.element_currents();
    assert!(
        close(amps[1], 0.0276, 5e-4),
        "fired SCR drew {} A through the load, expected ~27.6 mA",
        amps[1]
    );
    assert!(
        close(amps[2], 0.0276, 5e-4),
        "fired SCR anode current was {} A, expected ~27.6 mA",
        amps[2]
    );
    assert!(
        close(volts[2], 0.62, 0.05),
        "fired SCR held {} V anode-cathode, expected the ~0.62 V on drop",
        volts[2]
    );

    // Gate back to 0 V: the 27.6 mA anode current stays far above the 8.2 mA
    // holding current, so the latch must hold even with the gate current gone.
    assert!(c.set_param(6, "maxVoltage", 0.0), "gate return refused");
    c.run(5);
    let amps = c.element_currents();
    assert!(
        close(amps[1], 0.0276, 5e-4),
        "SCR unlatched after the gate went low, drew {} A",
        amps[1]
    );
    let volts = c.element_voltages();
    assert!(
        close(volts[2], 0.62, 0.05),
        "latched SCR drifted to {} V anode-cathode",
        volts[2]
    );
}

#[test]
fn diac_blocks_below_breakover_and_conducts_above() {
    // The diac's off state stamps a 1e8 ohm resistor per branch, so 20 V
    // through 1k leaves nearly the whole supply across the device and only a
    // microamp-scale leakage. 40 V exceeds the 30 V breakdown and latches the
    // 500 ohm on state; the loop then settles at the load-line fixed point
    // i = (V - vd)/1500 where vd = 2*vt*ln(i/Is + 1) is the forward drop of
    // the internal default-model diode (Is = 1.71435e-7): i = 26.25 mA and
    // the device holds 13.745 V. Dropping the supply to 10 V puts the on-state
    // current at ~6.3 mA, below the 10 mA holdcurrent, and the diac opens
    // again. A -40 V build fires the mirrored back-to-back branch and conducts
    // the same 26.25 mA in reverse, pinning the second junction's stamp signs.
    let dt = 1e-5;
    let blocking = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 20.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(3, "diac", &[[100, 0], [100, 100]], &[]),
            elm(4, "wire", &[[100, 100], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
        ],
        opts_budget(dt, false, 200),
    );
    blocking.run(5);
    let volts = blocking.element_voltages();
    let amps = blocking.element_currents();
    assert!(
        amps[2] < 1e-5,
        "blocked diac drew {} A, expected only the r_off leakage",
        amps[2]
    );
    assert!(
        close(volts[2], 20.0, 0.05),
        "blocked diac held {} V, expected nearly the full 20 V supply",
        volts[2]
    );

    let conducting = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 40.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(3, "diac", &[[100, 0], [100, 100]], &[]),
            elm(4, "wire", &[[100, 100], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
        ],
        opts_budget(dt, false, 200),
    );
    let report = conducting.run(20);
    assert!(
        report.converged,
        "diac firing stalled: {:?}",
        report.failing
    );
    let volts = conducting.element_voltages();
    let amps = conducting.element_currents();
    assert!(
        close(amps[2], 0.02625, 5e-4),
        "fired diac drew {} A, expected ~26.25 mA",
        amps[2]
    );
    assert!(
        close(volts[2], 13.745, 0.05),
        "fired diac held {} V, expected ~13.745 V",
        volts[2]
    );

    // The 26.25 mA on-state is well above the 10 mA holdcurrent, so it latches
    // until the supply drops and the current falls under the threshold.
    assert!(
        conducting.set_param(1, "maxVoltage", 10.0),
        "supply edit refused"
    );
    conducting.run(2);
    let volts = conducting.element_voltages();
    let amps = conducting.element_currents();
    assert!(
        amps[2] < 1e-5,
        "diac stayed on after the current dropped below holdcurrent, drew {} A",
        amps[2]
    );
    assert!(
        close(volts[2], 10.0, 0.05),
        "cleared diac held {} V, expected the full 10 V supply",
        volts[2]
    );

    let reversed = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", -40.0)]),
            elm(
                2,
                "resistor",
                &[[0, 0], [100, 0]],
                &[("resistance", 1000.0)],
            ),
            elm(3, "diac", &[[100, 0], [100, 100]], &[]),
            elm(4, "wire", &[[100, 100], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
        ],
        opts_budget(dt, false, 200),
    );
    let report = reversed.run(20);
    assert!(
        report.converged,
        "reverse diac firing stalled: {:?}",
        report.failing
    );
    let volts = reversed.element_voltages();
    let amps = reversed.element_currents();
    assert!(
        close(amps[2], -0.02625, 5e-4),
        "reverse-fired diac drew {} A, expected ~-26.25 mA",
        amps[2]
    );
    assert!(
        close(volts[2], -13.745, 0.05),
        "reverse-fired diac held {} V, expected ~-13.745 V",
        volts[2]
    );
}

#[test]
fn triac_blocks_both_ways_until_gate_pulse_then_latches() {
    // The triac's off state is not an open circuit: the main path is a 10e5
    // (upstream's literal `10e5`) ohm resistor in series with a back-to-back
    // diode pair, so a 2 V supply leaks about 18 uA through it (2 V across
    // the 10e5 less the small diode drop), far below the 8.2 mA holding
    // current, and the MT2-MT1 voltage holds near the full supply. The
    // antiparallel diodes block the reverse polarity the same way, which is
    // the point of a triac over an SCR. Driving the gate to 3 V pushes 30 mA
    // through the internal 100 ohm gate resistor, past the 10 mA trigger, and
    // the next step latches the resistor to 0.01 ohm: the loop then draws
    // (2 - v_on)/50 with v_on ~ 0.62 V, about 27.6 mA. That main current is
    // well above holdingI, so the latch survives the gate returning to 0 V.
    let dt = 1e-5;
    let c = &mut build(
        vec![
            elm(1, "voltage", &[[0, 100], [0, 0]], &[("maxVoltage", 2.0)]),
            elm(2, "resistor", &[[0, 0], [100, 0]], &[("resistance", 50.0)]),
            elm(3, "triac", &[[100, 0], [100, 200], [128, 128]], &[]),
            elm(4, "wire", &[[100, 200], [0, 100]], &[]),
            elm(5, "ground", &[[0, 100]], &[]),
            elm(
                6,
                "voltage",
                &[[128, 48], [128, 128]],
                &[("maxVoltage", 0.0)],
            ),
            elm(7, "ground", &[[128, 48]], &[]),
        ],
        opts_budget(dt, false, 200),
    );
    c.run(20);
    let volts = c.element_voltages();
    let amps = c.element_currents();
    assert!(
        amps[2] < 1e-4,
        "blocked triac drew {} A, expected only the ~2 uA off-state leakage",
        amps[2]
    );
    assert!(
        close(volts[2], 2.0, 0.05),
        "blocked triac held {} V, expected nearly the full 2 V supply",
        volts[2]
    );

    // Reverse the supply: the back-to-back diodes block the other polarity
    // just the same while the latch is off.
    assert!(
        c.set_param(1, "maxVoltage", -2.0),
        "reverse polarity refused"
    );
    c.run(20);
    let volts = c.element_voltages();
    let amps = c.element_currents();
    assert!(
        amps[2] < 1e-4,
        "reverse-blocked triac drew {} A, expected only leakage",
        amps[2]
    );
    assert!(
        close(volts[2], -2.0, 0.05),
        "reverse-blocked triac held {} V, expected nearly the full -2 V supply",
        volts[2]
    );

    // Back to forward polarity, then a gate pulse: 3 V on the gate drives
    // 30 mA through the internal 100 ohm gate resistor, over the 10 mA
    // trigger, so the latch fires and the MT2-MT1 voltage drops to the
    // diode's on-state drop.
    assert!(c.set_param(1, "maxVoltage", 2.0), "forward return refused");
    assert!(c.set_param(6, "maxVoltage", 3.0), "gate pulse refused");
    c.run(5);
    let volts = c.element_voltages();
    let amps = c.element_currents();
    assert!(
        close(amps[1], 0.0276, 5e-4),
        "fired triac drew {} A through the load, expected ~27.6 mA",
        amps[1]
    );
    assert!(
        close(amps[2], 0.0276, 5e-4),
        "fired triac main current was {} A, expected ~27.6 mA",
        amps[2]
    );
    assert!(
        close(volts[2], 0.62, 0.05),
        "fired triac held {} V MT2-MT1, expected the ~0.62 V on drop",
        volts[2]
    );

    // Gate back to 0 V: the 27.6 mA main current stays far above the 8.2 mA
    // holding current, so the latch must hold even with the gate current gone.
    assert!(c.set_param(6, "maxVoltage", 0.0), "gate return refused");
    c.run(5);
    let amps = c.element_currents();
    assert!(
        close(amps[1], 0.0276, 5e-4),
        "triac unlatched after the gate went low, drew {} A",
        amps[1]
    );
    let volts = c.element_voltages();
    assert!(
        close(volts[2], 0.62, 0.05),
        "latched triac drifted to {} V MT2-MT1",
        volts[2]
    );
}
