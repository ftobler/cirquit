//! DC motor (DCMotorElm.java, dump 415).
//!
//! The model is a mini-circuit, exactly upstream's: an electrical side and a
//! mechanical side, each an inductor companion driven by a voltage source.
//! The armature is a back-Euler coil inductor (post 0 to internal node 2) in
//! series with the armature resistance (node 2 to node 3) and the back-EMF
//! source (node 3 to post 1), whose value is `inertia_current * Kb`. The
//! mechanical side is the same shape in the torque/rotation analog: an inertia
//! inductor (internal node 4 to internal node 5, inductance `J`) in series
//! with the friction resistor (node 5 to ground, `b`) and the torque source
//! (node 4 to ground), whose value is `coil_current * K`. The inductor
//! "current" on that side is the shaft speed.
//!
//! Everything time-varying is computed once per step in `start_iteration`
//! from the previous step's currents, and the two embedded inductors are
//! forced onto backward Euler exactly as upstream's
//! `ind.setup(..., Inductor.FLAG_BACK_EULER)` does (DCMotorElm.java:30-31).
//! The DC operating point skips the mechanical and magnetic history like the
//! transformer's DC pass, leaving the motor at rest for the transient.

use crate::element::{Base, Element, SimCtx};
use crate::elements::inductor::Inductor;
use crate::spec::ElementSpec;
use crate::stamp::{Stamper, GROUND};
use std::f64::consts::PI;

/// Constructor defaults (DCMotorElm.java:29).
const DEF_INDUCTANCE: f64 = 0.5;
const DEF_RESISTANCE: f64 = 1.0;
const DEF_K: f64 = 0.15;
const DEF_J: f64 = 0.02;
const DEF_B: f64 = 0.05;

/// An inductor spec pointed at the motor's own terminals, forced onto
/// backward Euler exactly as the relay embeds its coil inductor
/// (relay.rs:39-52). The motor's inductors carry no file state of their own,
/// so the current seeds 0.
fn motor_inductor_spec(inductance: f64) -> ElementSpec {
    ElementSpec {
        id: 0,
        kind: "inductor".into(),
        posts: Vec::new(),
        params: [("inductance".into(), inductance)].into_iter().collect(),
        label: None,
        model: None,
        flags: 2, // Inductor.FLAG_BACK_EULER
    }
}

pub struct DcMotor {
    base: Base,
    inductance: f64,
    resistance: f64,
    /// The torque constant; also copied into `kb`, the back-EMF constant,
    /// because the two are one physical quantity (DCMotorElm.java:251-254).
    k: f64,
    kb: f64,
    j: f64,
    b: f64,
    /// The embedded armature inductor, motor node 0 to internal node 2.
    coil: Inductor,
    /// The embedded inertia inductor, internal node 4 to internal node 5.
    inertia: Inductor,
    coil_current: f64,
    inertia_current: f64,
    /// Rotor angle, the state the renderer animates as the rotating spokes.
    angle: f64,
}

impl DcMotor {
    /// Rejects a non-positive armature inductance or rotor inertia: both are
    /// embedded inductor companions, so a non-positive value would stamp an
    /// active negative resistance (the failure class [`Inductor::new`]
    /// refuses). The checks run here rather than letting the embedded
    /// constructor's error through, so the message names the motor element.
    pub fn new(spec: &ElementSpec) -> Result<Self, String> {
        let inductance = spec.param("inductance", DEF_INDUCTANCE);
        if inductance <= 0.0 || inductance.is_nan() {
            return Err(format!(
                "dcMotor (id {}) inductance must be positive, got {}",
                spec.id, inductance
            ));
        }
        let j = spec.param("J", DEF_J);
        if j <= 0.0 || j.is_nan() {
            return Err(format!(
                "dcMotor (id {}) J must be positive, got {}",
                spec.id, j
            ));
        }
        // Both values were validated above, so the embedded constructors
        // cannot refuse them.
        let coil = Inductor::new(&motor_inductor_spec(inductance))
            .expect("armature inductance was validated");
        let inertia = Inductor::new(&motor_inductor_spec(j)).expect("rotor inertia was validated");
        Ok(Self {
            base: Base::with_posts(2),
            inductance,
            resistance: spec.param("resistance", DEF_RESISTANCE),
            k: spec.param("K", DEF_K),
            kb: spec.param("Kb", DEF_K),
            j,
            b: spec.param("b", DEF_B),
            coil,
            inertia,
            coil_current: 0.0,
            inertia_current: 0.0,
            // A fresh motor's spokes start rotated like upstream
            // (DCMotorElm.java:29,37 seed `angle = pi/2`).
            angle: PI / 2.0,
        })
    }

    /// Points the embedded armature inductor at the motor's coil terminals.
    fn sync_coil(&mut self) {
        let (n0, n1) = (self.base.nodes[0], self.base.nodes[2]);
        let (v0, v1) = (self.base.volts[0], self.base.volts[2]);
        let ind = self.coil.base_mut();
        ind.nodes[0] = n0;
        ind.nodes[1] = n1;
        ind.volts[0] = v0;
        ind.volts[1] = v1;
    }

    /// Points the embedded inertia inductor at the motor's mechanical nodes.
    fn sync_inertia(&mut self) {
        let (n0, n1) = (self.base.nodes[4], self.base.nodes[5]);
        let (v0, v1) = (self.base.volts[4], self.base.volts[5]);
        let ind = self.inertia.base_mut();
        ind.nodes[0] = n0;
        ind.nodes[1] = n1;
        ind.volts[0] = v0;
        ind.volts[1] = v1;
    }
}

impl Element for DcMotor {
    fn kind(&self) -> &'static str {
        "dcMotor"
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
    fn internal_node_count(&self) -> usize {
        4
    }
    fn voltage_source_count(&self) -> usize {
        2
    }
    fn voltage_source_nodes(&self, k: usize) -> (usize, usize) {
        // The back-EMF source spans the armature resistor output to post 1;
        // the torque source pins the inertia loop's drive node
        // (DCMotorElm.java:94-99).
        if k == 0 {
            (self.base.nodes[3], self.base.nodes[1])
        } else {
            (self.base.nodes[4], GROUND)
        }
    }

    fn stamp(&mut self, ctx: &SimCtx, s: &mut Stamper) {
        self.sync_coil();
        self.coil.stamp(ctx, s);
        self.sync_inertia();
        self.inertia.stamp(ctx, s);
        let n = &self.base.nodes;
        // The armature resistance (DCMotorElm.java:118) and the mechanical
        // friction (DCMotorElm.java:126) are constant.
        s.resistor(n[2], n[3], self.resistance);
        s.resistor(n[5], GROUND, self.b);
        // The back-EMF and torque sources hold their values in `do_step`.
        s.voltage_source(n[3], n[1], self.base.vs_base, 0.0);
        s.voltage_source(n[4], GROUND, self.base.vs_base + 1, 0.0);
    }

    fn start_iteration(&mut self, ctx: &SimCtx) {
        if ctx.dc_analysis {
            return;
        }
        self.sync_coil();
        self.coil.start_iteration(ctx);
        self.sync_inertia();
        self.inertia.start_iteration(ctx);
        // The rotor angle advances with the last solved speed, upstream's
        // `angle = angle + speed*sim.timeStep` (DCMotorElm.java:136).
        self.angle += self.inertia_current * ctx.dt;
    }

    fn do_step(&mut self, ctx: &SimCtx, s: &mut Stamper) {
        self.sync_coil();
        self.coil.do_step(ctx, s);
        self.sync_inertia();
        self.inertia.do_step(ctx, s);
        // The back-EMF of the spinning rotor opposes the armature drive and
        // the torque source drives the inertia loop (DCMotorElm.java:151-155).
        // Upstream's `stampVoltageSource(n1, n2, v)` constrains V(n1) - V(n2)
        // = v, the opposite of this port's `voltage_source` (V(n2) - V(n1) = v),
        // so the values are negated to keep the physics and the rotor's spin
        // direction identical to upstream's.
        s.voltage_source_value(self.base.vs_base, -self.inertia_current * self.kb);
        s.voltage_source_value(self.base.vs_base + 1, -self.coil_current * self.k);
    }

    fn calculate_current(&mut self, ctx: &SimCtx) {
        self.sync_coil();
        self.coil.calculate_current(ctx);
        self.sync_inertia();
        self.inertia.calculate_current(ctx);
        if ctx.dc_analysis {
            // The DC pass stamps the coil as a 1e-6 ohm short, so the
            // embedded inductor would report a huge short-circuit current.
            // Like the three-phase motor, keep the running currents at rest
            // for the transient.
            self.base.current = 0.0;
            return;
        }
        self.coil_current = self.coil.base().current;
        self.inertia_current = self.inertia.base().current;
        self.base.current = self.coil_current;
    }

    fn step_finished(&mut self, ctx: &SimCtx) {
        // The DC operating point must not commit its short-circuit solve into
        // the coil histories; the motor starts the transient at rest, the
        // transformer family's DC skip (transformer.rs:332-334).
        if ctx.dc_analysis {
            return;
        }
        self.sync_coil();
        self.coil.step_finished(ctx);
        self.sync_inertia();
        self.inertia.step_finished(ctx);
    }

    fn current_into_node(&self, post: usize) -> f64 {
        // The armature current enters post 0 and leaves post 1, the same
        // direction the coil current is defined (DCMotorElm.java:160).
        if post == 0 {
            -self.coil_current
        } else {
            self.coil_current
        }
    }

    fn display_state(&self) -> f64 {
        // The rotor angle drives the drawn spokes, scaled by the gear ratio
        // on the frontend (DCMotorElm.java:81).
        self.angle
    }

    fn set_param(&mut self, name: &str, value: f64) -> bool {
        match name {
            "inductance" if value > 0.0 => {
                self.inductance = value;
                self.coil.set_param("inductance", value);
            }
            "resistance" if value > 0.0 => self.resistance = value,
            "K" if value > 0.0 => {
                // The torque edit moves both constants (DCMotorElm.java:
                // 251-254); the file's separate `Kb` token only ever equals K.
                self.k = value;
                self.kb = value;
            }
            "J" if value > 0.0 => {
                self.j = value;
                self.inertia.set_param("inductance", value);
            }
            "b" if value > 0.0 => self.b = value,
            // gearRatio is draw-only (the spokes rotate by angle*gearRatio
            // on the frontend); it is a file token, so accept the edit
            // without storing anything the engine would never read.
            "gearRatio" => {}
            _ => return false,
        }
        true
    }

    fn reset(&mut self) {
        self.base.reset();
        self.coil.reset();
        self.inertia.reset();
        self.coil_current = 0.0;
        self.inertia_current = 0.0;
        self.angle = 0.0;
    }
}
