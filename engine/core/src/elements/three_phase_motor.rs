//! Three-phase induction motor (ThreePhaseMotorElm.java).
//!
//! The model is five magnetically coupled windings stamped as a
//! mutual-inductance Norton companion, the same family as the transformers:
//! three stator coils (phase pairs 0-1, 2-3, 4-5) behind `Rs`, and two rotor
//! coils whose far ends hang off `1.5·Rr` to ground. Two voltage sources pin
//! the rotor coil inner ends and inject the speed-proportional back EMF, so
//! the machine can both draw current and spin.
//!
//! Everything time-varying is computed once per step in `start_iteration`
//! from the previous step's coil currents, exactly as upstream's
//! `startIteration` does (ThreePhaseMotorElm.java:211-224): the companion
//! sources are the previous coil currents (backward Euler, so `a = M⁻¹·dt`,
//! not `dt/2`), the torque integrates the speed, and the back-EMF values are
//! the rotor flux linkage sweeping past the rotor. Within one Newton step
//! those are all constants, so the element stays linear. The DC operating
//! point skips the mechanical and magnetic history like the transformer's DC
//! pass: the motor solves as its passive network with the sources at zero,
//! leaving it at rest for the transient.

use crate::element::{Base, Element, SimCtx};
use crate::spec::ElementSpec;
use crate::stamp::{Stamper, GROUND};

const SQRT3: f64 = 1.732_050_807_568_877_2;
const SQRT3_OVER_2: f64 = 0.866_025_403_784_438_6;
/// Pole pairs of the machine, upstream's `Zp = 2` (ThreePhaseMotorElm.java:115).
const POLE_PAIRS: f64 = 2.0;
/// Number of windings: three stator phases plus two rotor phases
/// (ThreePhaseMotorElm.java:117).
const COIL_COUNT: usize = 5;

/// Node slot of each coil end, upstream's `coilNodes[]`
/// (ThreePhaseMotorElm.java:194). Local indices into `base.nodes`/`base.volts`
/// (posts 0-5, internal nodes 6-12), in the port's local-volts/global-nodes
/// split.
const COIL_NODES: [usize; 10] = [6, 1, 8, 3, 10, 5, 7, 9, 11, 12];

pub struct ThreePhaseMotor {
    base: Base,
    rs: f64,
    rr: f64,
    ls: f64,
    lr: f64,
    lm: f64,
    b: f64,
    j: f64,
    speed: f64,
    /// Winding currents, the state carried across steps.
    coil_currents: [f64; COIL_COUNT],
    /// Companion current-source values, copied from the coil currents in
    /// `start_iteration`.
    source_values: [f64; COIL_COUNT],
    /// `M⁻¹·dt` companion coefficients, row-major `5×5`, computed in `stamp`.
    a: [[f64; COIL_COUNT]; COIL_COUNT],
    /// The two back-EMF source values, recomputed every step.
    vs1: f64,
    vs2: f64,
}

impl ThreePhaseMotor {
    pub fn new(spec: &ElementSpec) -> Self {
        Self {
            base: Base::with_posts(6),
            rs: spec.param("Rs", 0.435),
            rr: spec.param("Rr", 0.816),
            ls: spec.param("Ls", 0.0294),
            lr: spec.param("Lr", 0.0297),
            lm: spec.param("lm", 0.0287),
            b: spec.param("b", 0.05),
            j: spec.param("J", 1.0),
            speed: 0.0,
            coil_currents: [0.0; COIL_COUNT],
            source_values: [0.0; COIL_COUNT],
            a: [[0.0; COIL_COUNT]; COIL_COUNT],
            vs1: 0.0,
            vs2: 0.0,
        }
    }

    /// Node pair of coil `i`, resolved from its local slots to global nodes.
    fn coil_node_pair(&self, i: usize) -> (usize, usize) {
        (
            self.base.nodes[COIL_NODES[2 * i]],
            self.base.nodes[COIL_NODES[2 * i + 1]],
        )
    }

    /// Voltage across coil `i` from the per-element `base.volts` at local
    /// slots, `V(start) - V(end)`.
    fn coil_voltage(&self, i: usize) -> f64 {
        self.base.volts[COIL_NODES[2 * i]] - self.base.volts[COIL_NODES[2 * i + 1]]
    }

    /// Self-inductance of coil `i`: the three stator coils carry `Ls`, the two
    /// rotor coils `1.5·Lr` (ThreePhaseMotorElm.java:138-139).
    fn coil_inductance(&self, i: usize) -> f64 {
        if i < 3 {
            self.ls
        } else {
            self.lr * 1.5
        }
    }

    /// Builds `M⁻¹·dt` from the mutual-inductance matrix, exactly the custom
    /// transformer's companion (ThreePhaseMotorElm.java:143-176). The scale is
    /// `dt`, not `dt/2`, because `start_iteration` injects only the previous
    /// coil currents: the motor integrates backward Euler.
    fn compute_coefficients(&mut self, dt: f64) {
        let mut m = [[0.0; COIL_COUNT]; COIL_COUNT];
        for (i, row) in m.iter_mut().enumerate() {
            row[i] = self.coil_inductance(i);
        }
        // Stator-rotor couplings (ThreePhaseMotorElm.java:149-154). The
        // products `k0·sqrt(Li·Lj)` with `k0 = Lm/sqrt(Ls·1.5·Lr)` all reduce
        // to `Lm` times the three-phase winding factors, written out directly.
        m[0][3] = self.lm;
        m[3][0] = self.lm;
        m[1][3] = -self.lm / 2.0;
        m[3][1] = -self.lm / 2.0;
        m[1][4] = SQRT3_OVER_2 * self.lm;
        m[4][1] = SQRT3_OVER_2 * self.lm;
        m[2][3] = -self.lm / 2.0;
        m[3][2] = -self.lm / 2.0;
        m[2][4] = -SQRT3_OVER_2 * self.lm;
        m[4][2] = -SQRT3_OVER_2 * self.lm;

        let inv = invert(&m);
        for (i, arow) in self.a.iter_mut().enumerate() {
            for (j, aij) in arow.iter_mut().enumerate() {
                *aij = inv[i][j] * dt;
            }
        }
    }
}

/// Dense Gauss-Jordan inverse of a square matrix, the same algorithm the
/// transformer family uses. The mutual-inductance matrix is positive definite
/// for physical couplings, so the partial pivot never hits a zero diagonal.
fn invert<const N: usize>(m: &[[f64; N]; N]) -> [[f64; N]; N] {
    let mut a = *m;
    let mut inv = [[0.0; N]; N];
    for (i, row) in inv.iter_mut().enumerate() {
        row[i] = 1.0;
    }
    for col in 0..N {
        let mut piv = col;
        for r in (col + 1)..N {
            if a[r][col].abs() > a[piv][col].abs() {
                piv = r;
            }
        }
        if piv != col {
            a.swap(col, piv);
            inv.swap(col, piv);
        }
        let d = a[col][col];
        for k in 0..N {
            a[col][k] /= d;
            inv[col][k] /= d;
        }
        for r in 0..N {
            if r == col {
                continue;
            }
            let f = a[r][col];
            if f == 0.0 {
                continue;
            }
            for k in 0..N {
                a[r][k] -= f * a[col][k];
                inv[r][k] -= f * inv[col][k];
            }
        }
    }
    inv
}

impl Element for ThreePhaseMotor {
    fn kind(&self) -> &'static str {
        "threePhaseMotor"
    }
    fn base(&self) -> &Base {
        &self.base
    }
    fn base_mut(&mut self) -> &mut Base {
        &mut self.base
    }
    fn post_count(&self) -> usize {
        6
    }
    fn internal_node_count(&self) -> usize {
        7
    }
    fn voltage_source_count(&self) -> usize {
        2
    }

    fn voltage_source_nodes(&self, k: usize) -> (usize, usize) {
        // Both sources hang a rotor coil inner end off ground
        // (ThreePhaseMotorElm.java:181-182, setVoltageSource :201-207).
        if k == 0 {
            (self.base.nodes[7], GROUND)
        } else {
            (self.base.nodes[11], GROUND)
        }
    }

    fn stamp(&mut self, ctx: &SimCtx, s: &mut Stamper) {
        self.compute_coefficients(ctx.dt);
        let n = &self.base.nodes;
        // Stator phase resistances and the two rotor winding bleeder resistors
        // (ThreePhaseMotorElm.java:132-136).
        s.resistor(n[0], n[6], self.rs);
        s.resistor(n[2], n[8], self.rs);
        s.resistor(n[4], n[10], self.rs);
        s.resistor(n[9], GROUND, 1.5 * self.rr);
        s.resistor(n[12], GROUND, 1.5 * self.rr);
        // The mutual-inductance companion: diagonal conductances and
        // off-diagonal VCCS, the transformer family's stamp.
        for i in 0..COIL_COUNT {
            let (na, nb) = self.coil_node_pair(i);
            s.conductance(na, nb, self.a[i][i]);
            for j in 0..COIL_COUNT {
                if i == j {
                    continue;
                }
                let (ma, mb) = self.coil_node_pair(j);
                s.vccs(na, nb, ma, mb, self.a[i][j]);
            }
        }
        // The back-EMF sources pin the rotor coil inner ends (n002, n006);
        // their values move with the speed in `do_step`.
        s.voltage_source(n[7], GROUND, self.base.vs_base, 0.0);
        s.voltage_source(n[11], GROUND, self.base.vs_base + 1, 0.0);
    }

    fn start_iteration(&mut self, ctx: &SimCtx) {
        if ctx.dc_analysis {
            return;
        }
        self.source_values = self.coil_currents;
        let [i0, i1, i2, i3, i4] = self.coil_currents;
        // Electromagnetic torque from the stator-rotor flux interaction, and
        // the mechanical integration against friction and inertia
        // (ThreePhaseMotorElm.java:218-220).
        let torque = POLE_PAIRS * SQRT3_OVER_2 * self.lm * ((i1 - i2) * i3 - SQRT3 * i0 * i4);
        self.speed += ctx.dt * (torque - self.b * self.speed) / self.j;
        // Back EMF of the rotating rotor flux seen by the two rotor coils
        // (ThreePhaseMotorElm.java:222-223).
        self.vs1 =
            -POLE_PAIRS * self.speed * (self.lm * SQRT3_OVER_2 * (i1 - i2) + 1.5 * self.lr * i4);
        self.vs2 = POLE_PAIRS * self.speed * (1.5 * self.lm * i0 + 1.5 * self.lr * i3);
    }

    fn do_step(&mut self, ctx: &SimCtx, s: &mut Stamper) {
        if ctx.dc_analysis {
            return;
        }
        for i in 0..COIL_COUNT {
            let (a, b) = self.coil_node_pair(i);
            s.current_source(a, b, self.source_values[i]);
        }
        // `voltage_source(n002, ground, v)` constrains `V(ground) - V(n002) = v`,
        // so stamping `-vs1` holds `V(n002) = vs1`, matching upstream's
        // `updateVoltageSource(n002, ground, voltSources[0], -vs1value)`.
        s.voltage_source_value(self.base.vs_base, -self.vs1);
        s.voltage_source_value(self.base.vs_base + 1, -self.vs2);
    }

    fn calculate_current(&mut self, ctx: &SimCtx) {
        for i in 0..COIL_COUNT {
            let mut val = if ctx.dc_analysis {
                0.0
            } else {
                self.source_values[i]
            };
            for j in 0..COIL_COUNT {
                val += self.a[i][j] * self.coil_voltage(j);
            }
            if !ctx.dc_analysis {
                self.coil_currents[i] = val;
            }
        }
        self.base.current = self.coil_currents[0];
    }

    fn current_into_node(&self, post: usize) -> f64 {
        // Upstream's getCurrentIntoNode (ThreePhaseMotorElm.java:388-392):
        // the phase current enters the winding's first post and leaves its
        // second.
        match post {
            0 | 2 | 4 => -self.coil_currents[post / 2],
            _ => self.coil_currents[post / 2],
        }
    }

    fn set_param(&mut self, name: &str, value: f64) -> bool {
        match name {
            "Rs" if value > 0.0 => self.rs = value,
            "Rr" if value > 0.0 => self.rr = value,
            "Ls" if value > 0.0 => self.ls = value,
            "Lr" if value > 0.0 => self.lr = value,
            "lm" if value > 0.0 => self.lm = value,
            "b" => self.b = value,
            "J" if value > 0.0 => self.j = value,
            _ => return false,
        }
        true
    }

    fn reset(&mut self) {
        self.base.reset();
        self.speed = 0.0;
        self.coil_currents = [0.0; COIL_COUNT];
        self.source_values = [0.0; COIL_COUNT];
        self.vs1 = 0.0;
        self.vs2 = 0.0;
    }
}
