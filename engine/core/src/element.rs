//! The element interface every device model implements.

use crate::stamp::Stamper;

/// Ambient state handed to elements during a timestep.
#[derive(Debug, Clone, Copy)]
pub struct SimCtx {
    /// Simulated time at the *end* of the step being computed, in seconds.
    pub time: f64,
    /// Timestep length, in seconds.
    pub dt: f64,
    /// True while solving the operating point, where reactive elements are
    /// held at their steady state instead of integrating.
    pub dc_analysis: bool,
    /// Newton iteration counter within the current timestep.
    pub subiter: usize,
}

impl Default for SimCtx {
    fn default() -> Self {
        Self {
            time: 0.0,
            dt: 5e-6,
            dc_analysis: false,
            subiter: 0,
        }
    }
}

/// State shared by every element: node assignments, terminal voltages and the
/// currents the solver hands back.
#[derive(Debug, Default, Clone)]
pub struct Base {
    /// Node index per terminal, then per internal node.
    pub nodes: Vec<usize>,
    /// Solved voltage at each entry of `nodes`.
    pub volts: Vec<f64>,
    /// Original post coordinate per terminal. Survives node merging so the
    /// wire-current recovery can still tell which terminal was where.
    pub posts: Vec<[i32; 2]>,
    /// Index of this element's first voltage-source unknown.
    pub vs_base: usize,
    /// Solved current through each of this element's voltage sources.
    pub vs_currents: Vec<f64>,
    /// Current through the element, positive flowing into post 0 and out of
    /// post 1.
    pub current: f64,
}

impl Base {
    pub fn with_posts(posts: usize) -> Self {
        Self {
            nodes: vec![0; posts],
            volts: vec![0.0; posts],
            posts: Vec::new(),
            vs_base: 0,
            vs_currents: Vec::new(),
            current: 0.0,
        }
    }

    #[inline]
    pub fn node(&self, i: usize) -> usize {
        self.nodes[i]
    }

    /// Voltage across a two-terminal element, `V(post0) - V(post1)`.
    #[inline]
    pub fn voltage_diff(&self) -> f64 {
        self.volts[0] - self.volts[1]
    }

    pub fn reset(&mut self) {
        self.volts.iter_mut().for_each(|v| *v = 0.0);
        self.vs_currents.iter_mut().for_each(|v| *v = 0.0);
        self.current = 0.0;
    }
}

/// A circuit device.
///
/// The lifecycle per element is:
///
/// 1. [`Element::stamp`] once after analysis, contributing everything that is
///    constant for the whole run. The resulting matrix is snapshotted.
/// 2. [`Element::start_iteration`] once per timestep, before Newton begins.
/// 3. [`Element::do_step`] once per Newton iteration, contributing anything
///    that changes: companion source values, linearised nonlinear devices.
/// 4. [`Element::calculate_current`] after the solve converges.
pub trait Element {
    /// Stable type name, matching the TypeScript element registry.
    fn kind(&self) -> &'static str;

    fn base(&self) -> &Base;
    fn base_mut(&mut self) -> &mut Base;

    fn post_count(&self) -> usize;

    /// Extra nodes the element needs that are not exposed as terminals.
    fn internal_node_count(&self) -> usize {
        0
    }

    /// Number of current unknowns this element adds to the system.
    fn voltage_source_count(&self) -> usize {
        0
    }

    /// True if the element must be re-linearised on every Newton iteration.
    fn nonlinear(&self) -> bool {
        false
    }

    /// Contributions that never change over the run.
    fn stamp(&mut self, _ctx: &SimCtx, _s: &mut Stamper) {}

    /// Called once per timestep before the Newton loop.
    fn start_iteration(&mut self, _ctx: &SimCtx) {}

    /// Called on every Newton iteration.
    fn do_step(&mut self, _ctx: &SimCtx, _s: &mut Stamper) {}

    /// Called once after the timestep converges.
    fn step_finished(&mut self, _ctx: &SimCtx) {}

    /// Derives `base.current` from the solved voltages.
    fn calculate_current(&mut self, _ctx: &SimCtx) {}

    /// Whether posts `a` and `b` are coupled in the matrix. Used to find
    /// floating subcircuits; current sources return false because they do not
    /// tie their terminals together.
    fn connects(&self, _a: usize, _b: usize) -> bool {
        true
    }

    /// True for ideal shorts that are merged out of the matrix before
    /// stamping: wires and closed switches. Upstream calls these removable
    /// wires. Merging them (rather than stamping a 0 V source per wire) keeps
    /// parallel wires and wire rings from producing duplicate constraint rows.
    fn removable_wire(&self) -> bool {
        false
    }

    /// Current flowing into the node at `post` from this element, used by the
    /// wire-current recovery. For a two-terminal element positive current
    /// enters post 0, so post 0 drains `current` and post 1 injects it.
    fn current_into_node(&self, post: usize) -> f64 {
        if self.post_count() == 2 {
            if post == 0 {
                -self.base().current
            } else {
                self.base().current
            }
        } else {
            0.0
        }
    }

    /// True for ground symbols, whose terminal is pinned to the reference.
    fn is_ground(&self) -> bool {
        false
    }

    /// Named-node label, for elements that connect by name rather than by
    /// position.
    fn node_label(&self) -> Option<&str> {
        None
    }

    /// Live parameter change from the UI (sliders, dialogs). Returns true if
    /// the parameter was applied; false if the name was not recognised, so the
    /// caller can fall back to a full rebuild instead of silently dropping the
    /// edit.
    fn set_param(&mut self, _name: &str, _value: f64) -> bool {
        false
    }

    /// Interactive state change, e.g. throwing a switch.
    fn set_state(&mut self, _state: i32) -> bool {
        false
    }

    fn reset(&mut self) {
        self.base_mut().reset();
    }
}

/// Convenience for the very common two-terminal case.
pub(crate) fn two_terminal_current(base: &Base, resistance: f64) -> f64 {
    if resistance > 0.0 {
        base.voltage_diff() / resistance
    } else {
        0.0
    }
}
