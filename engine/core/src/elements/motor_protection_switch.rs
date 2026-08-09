//! Motor protection switch (MotorProtectionSwitchElm.java, dump 428): three
//! independent fuse channels, one per motor phase, sharing a single trip
//! flag. Each channel runs the same leaky I²t integrator as a fuse on its
//! own current; the first channel to cross the rating opens all three at
//! once, and a label links the switch to the relay contact that drops out of
//! the motor circuit when it trips.

use crate::element::{Base, Element, SimCtx};
use crate::spec::ElementSpec;
use crate::stamp::Stamper;

/// Upstream's no-args constructor defaults, sourced from a Littelfuse
/// 218-series datasheet (MotorProtectionSwitchElm.java:38-46).
const DEFAULT_RESISTANCE: f64 = 0.0613;
const DEFAULT_I2T: f64 = 6.73;
/// Resistance substituted once the switch has tripped: large enough to read
/// as open, finite so the matrix never goes singular
/// (MotorProtectionSwitchElm.java:37).
const TRIPPED_RESISTANCE: f64 = 1e9;
/// Upstream assumes a channel can dissipate its entire I²t rating in three
/// seconds (MotorProtectionSwitchElm.java:232).
const COOLING_SECONDS: f64 = 3.0;
/// The switch always has three pole pairs (MotorProtectionSwitchElm.java:43).
const CHANNELS: usize = 3;

/// Three fuse channels sharing one blown flag
/// (MotorProtectionSwitchElm.java:221-243). Each channel stamps a plain
/// resistor, so the element is nonlinear only because the stamped value
/// moves when the switch trips, exactly like the fuse.
pub struct MotorProtectionSwitch {
    base: Base,
    resistance: f64,
    i2t: f64,
    /// Heat per channel, one integrator per pole pair.
    heats: [f64; CHANNELS],
    /// Current per channel from the last solved step.
    currents: [f64; CHANNELS],
    blown: bool,
    /// Linking label for the relay contact this switch drives.
    label: Option<String>,
    /// Element indices of the label-matched relay contacts.
    contacts: Vec<usize>,
    /// Contact drives queued during `start_iteration`, drained by the circuit
    /// once per timestep.
    pending: Vec<(usize, i32)>,
}

impl MotorProtectionSwitch {
    pub fn new(spec: &ElementSpec) -> Self {
        Self {
            base: Base::with_posts(6),
            resistance: spec.param("resistance", DEFAULT_RESISTANCE),
            i2t: spec.param("i2t", DEFAULT_I2T),
            heats: [0.0; CHANNELS],
            currents: [0.0; CHANNELS],
            blown: spec.param("blown", 0.0) != 0.0,
            label: spec.label.clone(),
            contacts: Vec::new(),
            pending: Vec::new(),
        }
    }

    fn effective_resistance(&self) -> f64 {
        if self.blown {
            TRIPPED_RESISTANCE
        } else {
            self.resistance
        }
    }

    /// Queues a contact drive. The position is in the energised frame: 1
    /// while intact, 0 when tripped (MotorProtectionSwitchElm.java:247).
    fn drive_contacts(&mut self, position: i32) {
        self.pending = self.contacts.iter().map(|&c| (c, position)).collect();
    }
}

impl Element for MotorProtectionSwitch {
    fn kind(&self) -> &'static str {
        "motorProtectionSwitch"
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
    /// Tripping swaps the resistor stamped into the matrix from one timestep
    /// to the next, which needs a full refactor rather than an RHS-only
    /// update, the same reason the fuse is nonlinear.
    fn nonlinear(&self) -> bool {
        true
    }
    /// Only posts within one pole pair are coupled: n1/2 == n2/2
    /// (MotorProtectionSwitchElm.java:217-219).
    fn connects(&self, a: usize, b: usize) -> bool {
        a / 2 == b / 2
    }
    fn link_label(&self) -> Option<&str> {
        self.label.as_deref()
    }
    fn set_relay_contacts(&mut self, contacts: Vec<usize>) {
        self.contacts = contacts;
        // Announce the resting position at build time. Upstream syncs its
        // relay contacts from `draw()` every frame and from `reset()`
        // (MotorProtectionSwitchElm.java:83-89, :193-207); the port's engine
        // never draws, so the announcement must happen here instead, or a
        // switch loaded already-blown would leave its contact closed.
        self.drive_contacts(if self.blown { 0 } else { 1 });
    }
    fn relay_contact_updates(&mut self) -> Vec<(usize, i32)> {
        std::mem::take(&mut self.pending)
    }

    /// Heat accumulates from the *previous* timestep's current once per
    /// timestep, before Newton begins, exactly like the fuse: a channel
    /// crossing its rating trips the whole switch, and the `blown` decision
    /// is fixed for every Newton iteration of this timestep.
    fn start_iteration(&mut self, ctx: &SimCtx) {
        let was_blown = self.blown;
        for j in 0..CHANNELS {
            let i = self.currents[j];
            let mut heat = self.heats[j];
            heat += i * i * ctx.dt;
            // Each channel can dissipate its entire rating in three seconds
            // (MotorProtectionSwitchElm.java:232).
            heat -= ctx.dt * self.i2t / COOLING_SECONDS;
            if heat < 0.0 {
                heat = 0.0;
            }
            if heat > self.i2t {
                self.blown = true;
            }
            self.heats[j] = heat;
        }
        if self.blown != was_blown {
            self.drive_contacts(if self.blown { 0 } else { 1 });
        }
    }

    fn do_step(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        let r = self.effective_resistance();
        for j in 0..CHANNELS {
            s.resistor(self.base.nodes[2 * j], self.base.nodes[2 * j + 1], r);
        }
    }

    fn calculate_current(&mut self, _ctx: &SimCtx) {
        let r = self.effective_resistance();
        for j in 0..CHANNELS {
            self.currents[j] = (self.base.volts[2 * j] - self.base.volts[2 * j + 1]) / r;
        }
        self.base.current = self.currents.iter().sum();
    }

    fn current_into_node(&self, post: usize) -> f64 {
        let channel = post / 2;
        if post % 2 == 1 {
            self.currents[channel]
        } else {
            -self.currents[channel]
        }
    }

    fn set_param(&mut self, name: &str, value: f64) -> bool {
        match name {
            "resistance" if value > 0.0 => self.resistance = value,
            "i2t" if value > 0.0 => self.i2t = value,
            _ => return false,
        }
        true
    }

    fn reset(&mut self) {
        self.base.reset();
        self.heats = [0.0; CHANNELS];
        self.currents = [0.0; CHANNELS];
        self.blown = false;
        // Upstream's reset() re-runs setSwitchPositions
        // (MotorProtectionSwitchElm.java:83-89), pushing its contacts back to
        // the closed frame.
        self.drive_contacts(1);
    }
}
