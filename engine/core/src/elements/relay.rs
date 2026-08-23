//! Relay models: the combined `Relay` (coil plus SPDT contacts in one part),
//! the split `RelayCoil` and the SPST `RelayContact` driven by a coil through
//! a shared label.

use std::collections::HashMap;

use crate::element::{Base, Element, SimCtx};
use crate::elements::inductor::Inductor;
use crate::spec::ElementSpec;
use crate::stamp::{Stamper, GROUND};

/// Default parameters, from RelayModel.java:30-41. The relay's own token
/// constructor would default the two missing trailing tokens to `offCurrent =
/// onCurrent` and `switchingTime = 0` (RelayElm.java:109-110), which is the
/// trigger for its "old model"; no bundled circuit has fewer than 10 tokens,
/// so the model defaults stand in for a short line instead.
const DEF_INDUCTANCE: f64 = 0.2;
const DEF_R_ON: f64 = 0.05;
const DEF_R_OFF: f64 = 1e6;
const DEF_ON_CURRENT: f64 = 0.02;
const DEF_OFF_CURRENT: f64 = 0.015;
const DEF_COIL_R: f64 = 20.0;
const DEF_SWITCHING_TIME: f64 = 5e-3;

const FLAG_NORMALLY_CLOSED: i64 = 2; // RelayContactElm.java:40
const FLAG_PULLDOWN: i64 = 16; // RelayElm.java:43

/// Relay coil types, from RelayCoilElm.java:61-67.
const TYPE_LATCHING: i32 = 3;
const TYPE_LATCHING_ON: i32 = 4;
const TYPE_LATCHING_OFF: i32 = 5;

fn is_latching_type(t: i32) -> bool {
    matches!(t, TYPE_LATCHING | TYPE_LATCHING_ON | TYPE_LATCHING_OFF)
}

/// A relay spec pointing the embedded coil inductor at its own terminals,
/// forced onto backward Euler exactly as upstream's `ind.setup(...,
/// Inductor.FLAG_BACK_EULER)` does (RelayElm.java:92).
fn coil_inductor_spec(inductance: f64, coil_current: f64) -> ElementSpec {
    ElementSpec {
        id: 0,
        kind: "inductor".into(),
        posts: Vec::new(),
        params: HashMap::from([
            ("inductance".into(), inductance),
            ("current".into(), coil_current),
        ]),
        label: None,
        model: None,
        flags: 2,
    }
}

/// Combined relay: `poleCount` SPDT switches plus one coil, sharing a node
/// layout that matches upstream's post order (RelayElm.java:30-36): pole 0,
/// its two throws, then per extra pole `3p, 3p+1, 3p+2`, then the two coil
/// terminals and one internal node at the far end of the coil resistor.
pub struct Relay {
    base: Base,
    pole_count: usize,
    inductance: f64,
    r_on: f64,
    r_off: f64,
    on_current: f64,
    off_current: f64,
    coil_r: f64,
    switching_time: f64,
    /// The embedded coil inductor, node `3n` to internal node `3n+2`.
    ind: Inductor,
    coil_current: f64,
    /// Current through each pole's closed path, for the node-current report.
    switch_current: Vec<f64>,
    /// Fractional throw position, between 0 and 1; the integer `i_position`
    /// is its settled value (0 off, 1 on, 2 caught mid-throw).
    d_position: f64,
    i_position: i32,
    on_state: bool,
    /// FLAG_PULLDOWN: hold both throw posts of every pole down through r_off
    /// so an unwired open throw reads 0 V instead of floating.
    pulldown: bool,
}

impl Relay {
    pub fn new(spec: &ElementSpec) -> Self {
        let pole_count = (spec.param("poleCount", 1.0) as usize).clamp(1, 8);
        let inductance = spec.param("inductance", DEF_INDUCTANCE);
        let coil_current = spec.param("coilCurrent", 0.0);
        let mut relay = Self {
            base: Base::with_posts(2 + 3 * pole_count),
            pole_count,
            inductance,
            r_on: spec.param("r_on", DEF_R_ON),
            r_off: spec.param("r_off", DEF_R_OFF),
            on_current: spec.param("onCurrent", DEF_ON_CURRENT),
            off_current: spec.param("offCurrent", DEF_OFF_CURRENT),
            coil_r: spec.param("coilR", DEF_COIL_R),
            switching_time: spec.param("switchingTime", DEF_SWITCHING_TIME),
            ind: Inductor::new(&coil_inductor_spec(inductance, coil_current)),
            coil_current,
            switch_current: vec![0.0; pole_count],
            d_position: 0.0,
            i_position: 0,
            on_state: false,
            pulldown: spec.flag(FLAG_PULLDOWN),
        };
        // The saved position token restores the throw state (`postUndump`,
        // RelayElm.java:122-126): 1 is closed, 2 is caught mid-throw.
        match spec.param("position", 0.0) as i32 {
            1 => {
                relay.on_state = true;
                relay.i_position = 1;
            }
            2 => {
                relay.d_position = 0.5;
                relay.i_position = 2;
            }
            _ => {}
        }
        relay
    }

    fn n_coil1(&self) -> usize {
        3 * self.pole_count
    }
    fn n_coil2(&self) -> usize {
        3 * self.pole_count + 1
    }
    fn n_coil3(&self) -> usize {
        3 * self.pole_count + 2
    }

    /// Points the embedded coil inductor at the relay's coil terminals. The
    /// inductor owns its own node slots, so every call re-copies the two coil
    /// nodes and their solved voltages, like the mosfet does for its body
    /// diode (mosfet.rs:138-151).
    fn sync_ind(&mut self) {
        let (n0, n1) = (
            self.base.nodes[self.n_coil1()],
            self.base.nodes[self.n_coil3()],
        );
        let (v0, v1) = (
            self.base.volts[self.n_coil1()],
            self.base.volts[self.n_coil3()],
        );
        let ind = self.ind.base_mut();
        ind.nodes[0] = n0;
        ind.nodes[1] = n1;
        ind.volts[0] = v0;
        ind.volts[1] = v1;
    }
}

impl Element for Relay {
    fn kind(&self) -> &'static str {
        "relay"
    }
    fn base(&self) -> &Base {
        &self.base
    }
    fn base_mut(&mut self) -> &mut Base {
        &mut self.base
    }
    fn post_count(&self) -> usize {
        2 + 3 * self.pole_count
    }
    fn internal_node_count(&self) -> usize {
        1
    }
    fn nonlinear(&self) -> bool {
        true
    }
    fn connects(&self, a: usize, b: usize) -> bool {
        // Upstream's getConnection: any two nodes in the same pole group or
        // the coil group are potentially connected (RelayElm.java:570-575).
        // The coil group includes the internal node, which `a / 3` puts in
        // the same group as the two coil terminals.
        a / 3 == b / 3
    }

    fn stamp(&mut self, ctx: &SimCtx, s: &mut Stamper) {
        self.sync_ind();
        self.ind.stamp(ctx, s);
        // The coil resistor from the internal node to coil terminal 2
        // (RelayElm.java:383-387). Constant, so it is part of the snapshot.
        s.resistor(
            self.base.nodes[self.n_coil3()],
            self.base.nodes[self.n_coil2()],
            self.coil_r,
        );
        // Pulldowns hold every throw post down through r_off so an open
        // throw reads 0 V instead of floating, matching the analog switch
        // approach (RelayElm.java:394-401). Constant, so they join the
        // snapshot pass.
        if self.pulldown {
            for p in 0..self.pole_count {
                s.resistor(self.base.nodes[p * 3 + 1], GROUND, self.r_off);
                s.resistor(self.base.nodes[p * 3 + 2], GROUND, self.r_off);
            }
        }
    }

    fn start_iteration(&mut self, ctx: &SimCtx) {
        self.sync_ind();
        self.ind.start_iteration(ctx);
        // Position dynamics with hysteresis against onCurrent/offCurrent; the
        // fractional position moves at the mechanical switching rate and the
        // throw only flips once it has travelled the whole way
        // (RelayElm.java:404-437). A switchingTime of 0 falls back to a
        // one-timestep throw rather than dividing by zero.
        let rate = if self.switching_time > 0.0 {
            ctx.dt / self.switching_time
        } else {
            1.0
        };
        let abs_current = self.coil_current.abs();
        if self.on_state {
            if abs_current < self.off_current {
                self.on_state = false;
                self.i_position = 2;
            } else {
                self.d_position += rate;
                if self.d_position >= 1.0 {
                    self.d_position = 1.0;
                    self.i_position = 1;
                }
            }
        } else if abs_current > self.on_current {
            self.on_state = true;
            self.i_position = 2;
        } else {
            self.d_position -= rate;
            if self.d_position <= 0.0 {
                self.d_position = 0.0;
                self.i_position = 0;
            }
        }
    }

    fn do_step(&mut self, ctx: &SimCtx, s: &mut Stamper) {
        self.sync_ind();
        self.ind.do_step(ctx, s);
        // The switch resistors change when the throw moves, so they are
        // stamped every Newton iteration like upstream's doStep
        // (RelayElm.java:464-484). Under FLAG_PULLDOWN the settled positions
        // skip the pole-to-unselected-throw r_off: the constant pulldowns
        // from stamp() already define the open side. The intermediate
        // position keeps both links whatever the flag, since mid-travel
        // leaves the pole attached to neither throw.
        for p in 0..self.pole_count {
            let po = p * 3;
            let (n0, n1, n2) = (
                self.base.nodes[po],
                self.base.nodes[po + 1],
                self.base.nodes[po + 2],
            );
            match self.i_position {
                0 => {
                    s.resistor(n0, n1, self.r_on);
                    if !self.pulldown {
                        s.resistor(n0, n2, self.r_off);
                    }
                }
                1 => {
                    s.resistor(n0, n2, self.r_on);
                    if !self.pulldown {
                        s.resistor(n0, n1, self.r_off);
                    }
                }
                _ => {
                    s.resistor(n0, n1, self.r_off);
                    s.resistor(n0, n2, self.r_off);
                }
            }
        }
    }

    fn calculate_current(&mut self, ctx: &SimCtx) {
        self.sync_ind();
        self.ind.calculate_current(ctx);
        self.coil_current = self.ind.base().current;
        self.base.current = self.coil_current;
        // Current through each pole's closed path, ignoring the small r_off
        // leakage like upstream (RelayElm.java:492-499).
        let v = &self.base.volts;
        for p in 0..self.pole_count {
            self.switch_current[p] = if self.i_position == 2 {
                0.0
            } else {
                (v[p * 3] - v[p * 3 + 1 + self.i_position as usize]) / self.r_on
            };
        }
    }

    fn state_tokens(&self) -> Vec<(String, f64)> {
        // `position` is the settled integer throw (0/1/2), which is exactly
        // what the constructor's match reproduces; the fractional
        // `d_position` mid-throw is not a file quantity.
        vec![
            ("coilCurrent".into(), self.coil_current),
            ("position".into(), self.i_position as f64),
        ]
    }

    fn step_finished(&mut self, ctx: &SimCtx) {
        self.sync_ind();
        self.ind.step_finished(ctx);
    }

    fn current_into_node(&self, post: usize) -> f64 {
        if post < 3 * self.pole_count {
            let (p, k) = (post / 3, post % 3);
            return if k == 0 {
                -self.switch_current[p]
            } else if k == (1 + self.i_position) as usize {
                self.switch_current[p]
            } else {
                0.0
            };
        }
        if post == 3 * self.pole_count {
            -self.coil_current
        } else {
            self.coil_current
        }
    }

    fn voltage_diff(&self) -> f64 {
        // The coil terminal voltage, what upstream's info box reports as
        // "coil Vd" (RelayElm.java:510-511).
        self.base.volts[self.n_coil1()] - self.base.volts[self.n_coil2()]
    }

    fn power(&self) -> f64 {
        self.voltage_diff() * self.coil_current
    }

    fn set_param(&mut self, name: &str, value: f64) -> bool {
        match name {
            // poleCount changes the post count, so it is rejected and the UI
            // falls back to a full rebuild.
            "poleCount" => return false,
            "inductance" if value > 0.0 => {
                self.inductance = value;
                self.ind.set_param("inductance", value);
            }
            "r_on" if value > 0.0 => self.r_on = value,
            "r_off" if value > 0.0 => self.r_off = value,
            "onCurrent" if value > 0.0 => self.on_current = value,
            "offCurrent" if value > 0.0 => self.off_current = value,
            "coilR" if value > 0.0 => self.coil_r = value,
            "switchingTime" if value > 0.0 => self.switching_time = value,
            _ => return false,
        }
        true
    }

    fn set_state(&mut self, state: i32) -> bool {
        self.i_position = state.clamp(0, 2);
        self.d_position = if state == 1 { 1.0 } else { 0.0 };
        self.on_state = state == 1;
        true
    }

    fn reset(&mut self) {
        self.base.reset();
        self.ind.reset();
        self.coil_current = 0.0;
        self.switch_current.iter_mut().for_each(|c| *c = 0.0);
        self.d_position = 0.0;
        self.i_position = 0;
        // onState survives a reset, like upstream (RelayElm.java:379-380):
        // clearing it leaves a relay flip-flop in a weird state, since the
        // throw position is recomputed from the coil current next iteration.
    }
}

/// Split relay coil: inductor plus series `coilR`, a six-state pick-up
/// machine on an averaged coil current, and a resolved list of contacts to
/// drive when the machine fires.
pub struct RelayCoil {
    base: Base,
    label: Option<String>,
    inductance: f64,
    on_current: f64,
    off_current: f64,
    coil_r: f64,
    switching_time: f64,
    relay_type: i32,
    /// State machine state: 0 waiting for onCurrent, 1 waiting to turn on,
    /// 2 waiting for offCurrent, 3 waiting to turn off (RelayCoilElm.java:54-58).
    state: i32,
    switch_position: i32,
    last_transition: f64,
    switching_time_on: f64,
    switching_time_off: f64,
    /// Low-pass filtered coil current the pick-up thresholds compare against
    /// (RelayCoilElm.java:303-304).
    avg_current: f64,
    ind: Inductor,
    coil_current: f64,
    contacts: Vec<usize>,
    /// (contact element index, energised-frame position) pairs to apply.
    pending: Vec<(usize, i32)>,
}

impl RelayCoil {
    pub fn new(spec: &ElementSpec) -> Self {
        let inductance = spec.param("inductance", DEF_INDUCTANCE);
        let coil_current = spec.param("coilCurrent", 0.0);
        let mut coil = Self {
            base: Base::with_posts(2),
            label: spec.label.clone(),
            inductance,
            on_current: spec.param("onCurrent", DEF_ON_CURRENT),
            off_current: spec.param("offCurrent", DEF_OFF_CURRENT),
            coil_r: spec.param("coilR", DEF_COIL_R),
            switching_time: spec.param("switchingTime", DEF_SWITCHING_TIME),
            relay_type: spec.param("type", 0.0) as i32,
            state: spec.param("state", 0.0) as i32,
            switch_position: spec.param("switchPosition", 0.0) as i32,
            last_transition: 0.0,
            switching_time_on: 0.0,
            switching_time_off: 0.0,
            avg_current: 0.0,
            ind: Inductor::new(&coil_inductor_spec(inductance, coil_current)),
            coil_current,
            contacts: Vec::new(),
            pending: Vec::new(),
        };
        coil.setup_times();
        coil
    }

    /// Delay types get their switching time on one edge and none on the other
    /// (RelayCoilElm.java:284-292).
    fn setup_times(&mut self) {
        match self.relay_type {
            1 => {
                self.switching_time_on = self.switching_time;
                self.switching_time_off = 0.0;
            }
            2 => {
                self.switching_time_off = self.switching_time;
                self.switching_time_on = 0.0;
            }
            _ => {
                self.switching_time_on = self.switching_time;
                self.switching_time_off = self.switching_time;
            }
        }
    }

    fn sync_ind(&mut self) {
        let (n0, n1) = (self.base.nodes[0], self.base.nodes[2]);
        let (v0, v1) = (self.base.volts[0], self.base.volts[2]);
        let ind = self.ind.base_mut();
        ind.nodes[0] = n0;
        ind.nodes[1] = n1;
        ind.volts[0] = v0;
        ind.volts[1] = v1;
    }

    /// Queues a contact drive. The position is in the energised frame: 0
    /// closes the contact, 1 opens it; FLAG_NORMALLY_CLOSED inverts.
    fn drive_contacts(&mut self, position: i32) {
        self.pending = self.contacts.iter().map(|&c| (c, position)).collect();
    }
}

impl Element for RelayCoil {
    fn kind(&self) -> &'static str {
        "relayCoil"
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
        1
    }
    fn connects(&self, _a: usize, _b: usize) -> bool {
        true
    }
    fn link_label(&self) -> Option<&str> {
        self.label.as_deref()
    }
    fn set_relay_contacts(&mut self, contacts: Vec<usize>) {
        self.contacts = contacts;
        // Initial sync, upstream's `stamp()`-time toggle
        // (RelayCoilElm.java:296-298): a coil announces its resting
        // switchPosition to its contacts on load. Set/reset coils skip it, so
        // their stale initial switchPosition cannot fight the sibling
        // set/reset coil's.
        if self.relay_type != TYPE_LATCHING_ON && self.relay_type != TYPE_LATCHING_OFF {
            self.drive_contacts(1 - self.switch_position);
        }
    }
    fn relay_contact_updates(&mut self) -> Vec<(usize, i32)> {
        std::mem::take(&mut self.pending)
    }

    fn stamp(&mut self, ctx: &SimCtx, s: &mut Stamper) {
        self.sync_ind();
        self.ind.stamp(ctx, s);
        s.resistor(self.base.nodes[2], self.base.nodes[1], self.coil_r);
    }

    fn start_iteration(&mut self, ctx: &SimCtx) {
        self.sync_ind();
        self.ind.start_iteration(ctx);
        let abs_current = self.coil_current.abs();
        let a = (-ctx.dt * 1e3).exp();
        self.avg_current = a * self.avg_current + (1.0 - a) * abs_current;
        let old_switch_position = self.switch_position;
        // `start_iteration` sees the end-of-step time (`ctx.time`), but the
        // transition belongs to the committed time the step started from,
        // which is `ctx.time - ctx.dt`; the DC operating point does not
        // advance the clock, so there `ctx.time` already is that time
        // (RelayCoilElm.java:309,333). Recording the committed time keeps a
        // rejected (halved) step from delaying a fire by up to a rejected dt.
        let transition_time = if ctx.dc_analysis {
            ctx.time
        } else {
            ctx.time - ctx.dt
        };

        // The pick-up state machine, ported from RelayCoilElm.java:300-348.
        match self.state {
            0 => {
                if self.avg_current > self.on_current {
                    self.last_transition = transition_time;
                    self.state = 1;
                }
            }
            1 => {
                if self.avg_current < self.off_current {
                    self.state = 0;
                } else if ctx.time - self.last_transition > self.switching_time_on {
                    self.state = 2;
                    match self.relay_type {
                        TYPE_LATCHING => self.switch_position = 1 - self.switch_position,
                        TYPE_LATCHING_ON => {
                            self.switch_position = 1;
                            self.drive_contacts(0);
                        }
                        TYPE_LATCHING_OFF => {
                            self.switch_position = 0;
                            self.drive_contacts(1);
                        }
                        _ => self.switch_position = 1,
                    }
                }
            }
            2 => {
                if self.avg_current < self.off_current {
                    self.last_transition = transition_time;
                    self.state = 3;
                }
            }
            _ => {
                if self.avg_current > self.on_current {
                    self.state = 2;
                } else if ctx.time - self.last_transition > self.switching_time_off {
                    self.state = 0;
                    if !is_latching_type(self.relay_type) {
                        self.switch_position = 0;
                    }
                }
            }
        }

        // Non set/reset coils drive their contacts whenever switchPosition
        // moves; set/reset coils pushed explicitly above, because a set coil
        // may fire without its own switchPosition changing.
        if self.relay_type != TYPE_LATCHING_ON
            && self.relay_type != TYPE_LATCHING_OFF
            && old_switch_position != self.switch_position
        {
            self.drive_contacts(1 - self.switch_position);
        }
    }

    fn do_step(&mut self, ctx: &SimCtx, s: &mut Stamper) {
        self.sync_ind();
        self.ind.do_step(ctx, s);
    }

    fn calculate_current(&mut self, ctx: &SimCtx) {
        self.sync_ind();
        self.ind.calculate_current(ctx);
        self.coil_current = self.ind.base().current;
        self.base.current = self.coil_current;
    }

    fn state_tokens(&self) -> Vec<(String, f64)> {
        vec![
            ("coilCurrent".into(), self.coil_current),
            ("state".into(), self.state as f64),
            ("switchPosition".into(), self.switch_position as f64),
        ]
    }

    fn step_finished(&mut self, ctx: &SimCtx) {
        self.sync_ind();
        self.ind.step_finished(ctx);
    }

    fn current_into_node(&self, post: usize) -> f64 {
        if post == 0 {
            -self.coil_current
        } else {
            self.coil_current
        }
    }

    fn voltage_diff(&self) -> f64 {
        self.base.volts[0] - self.base.volts[1]
    }

    fn power(&self) -> f64 {
        self.voltage_diff() * self.coil_current
    }

    fn set_param(&mut self, name: &str, value: f64) -> bool {
        match name {
            "inductance" if value > 0.0 => {
                self.inductance = value;
                self.ind.set_param("inductance", value);
            }
            "onCurrent" if value > 0.0 => self.on_current = value,
            "offCurrent" if value > 0.0 => self.off_current = value,
            "coilR" if value > 0.0 => self.coil_r = value,
            "switchingTime" if value > 0.0 => {
                self.switching_time = value;
                self.setup_times();
            }
            "type" => {
                self.relay_type = value as i32;
                self.setup_times();
            }
            _ => return false,
        }
        true
    }

    fn reset(&mut self) {
        self.base.reset();
        self.ind.reset();
        self.coil_current = 0.0;
        self.avg_current = 0.0;
        // state, switchPosition and lastTransition survive a reset, like
        // upstream (RelayCoilElm.java:267-276), so a latched coil stays
        // latched and a coil reset while waiting to turn on keeps its delay
        // clock. The contact's own reset() zeroed its i_position, so
        // re-announce the resting position here: upstream's stamp() re-runs
        // after a reset and its toggleSwitchPositions() does the same
        // (RelayCoilElm.java:296-298). Set/reset coils skip it just as they do
        // in stamp(), since only their firing, not their switchPosition, may
        // move a contact.
        if self.relay_type != TYPE_LATCHING_ON && self.relay_type != TYPE_LATCHING_OFF {
            self.drive_contacts(1 - self.switch_position);
        }
    }
}

/// Split relay contact: a two-terminal SPST whose `i_position` comes from the
/// file or from a matching coil. Position 0 stamps `r_on`, anything else
/// `r_off` (RelayContactElm.java:216-218). The third drawn throw is cosmetic.
pub struct RelayContact {
    base: Base,
    label: Option<String>,
    r_on: f64,
    r_off: f64,
    i_position: i32,
    normally_closed: bool,
}

impl RelayContact {
    pub fn new(spec: &ElementSpec) -> Self {
        Self {
            base: Base::with_posts(2),
            label: spec.label.clone(),
            r_on: spec.param("r_on", DEF_R_ON),
            r_off: spec.param("r_off", DEF_R_OFF),
            i_position: spec.param("i_position", 0.0) as i32,
            normally_closed: spec.flag(FLAG_NORMALLY_CLOSED),
        }
    }
}

impl Element for RelayContact {
    fn kind(&self) -> &'static str {
        "relayContact"
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
    fn nonlinear(&self) -> bool {
        true
    }
    fn connects(&self, _a: usize, _b: usize) -> bool {
        true
    }
    fn link_label(&self) -> Option<&str> {
        self.label.as_deref()
    }
    fn set_relay_position(&mut self, position: i32) {
        // The coil drives in the energised frame; FLAG_NORMALLY_CLOSED
        // inverts (RelayContactElm.java:188-191).
        self.i_position = if self.normally_closed {
            1 - position
        } else {
            position
        };
    }

    fn do_step(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        let r = if self.i_position == 0 {
            self.r_on
        } else {
            self.r_off
        };
        s.resistor(self.base.nodes[0], self.base.nodes[1], r);
    }

    fn calculate_current(&mut self, _ctx: &SimCtx) {
        // The open contact reports zero even though a little r_off current
        // flows, exactly like upstream (RelayContactElm.java:219-225).
        self.base.current = if self.i_position == 0 {
            self.base.voltage_diff() / self.r_on
        } else {
            0.0
        };
    }

    fn state_tokens(&self) -> Vec<(String, f64)> {
        vec![("i_position".into(), self.i_position as f64)]
    }

    fn current_into_node(&self, post: usize) -> f64 {
        if post == 0 {
            -self.base.current
        } else {
            self.base.current
        }
    }

    fn set_param(&mut self, name: &str, value: f64) -> bool {
        match name {
            "r_on" if value > 0.0 => self.r_on = value,
            "r_off" if value > 0.0 => self.r_off = value,
            "i_position" => self.i_position = value as i32,
            _ => return false,
        }
        true
    }

    fn reset(&mut self) {
        self.base.reset();
        self.i_position = 0;
    }
}
