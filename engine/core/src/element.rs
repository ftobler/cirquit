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

    /// The two terminal node indices a voltage-source element stamps for its
    /// `k`-th source. The closure builder assigns the source's unknown to the
    /// closure of the terminal it actually stamps, so an element whose stamped
    /// terminals differ from its `nodes[0], nodes[1]` default must override
    /// this: the SPDT stamps `(common, selected throw)`, which only the
    /// element knows (upstream's `setVoltageSource`).
    fn voltage_source_nodes(&self, _k: usize) -> (usize, usize) {
        let n = self.base();
        (n.nodes[0], n.nodes[1])
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

    /// Re-anchors Newton iteration state from `base.volts` after a rejected
    /// timestep, so the retry at a smaller `dt` starts exactly where the last
    /// committed step left off. Default is a no-op: only elements whose
    /// `do_step` mutates persistent state need it.
    fn restore_iteration(&mut self) {}

    /// Derives `base.current` from the solved voltages.
    fn calculate_current(&mut self, _ctx: &SimCtx) {}

    /// Whether posts `a` and `b` are coupled in the matrix. Used to find
    /// floating subcircuits; current sources return false because they do not
    /// tie their terminals together.
    fn connects(&self, _a: usize, _b: usize) -> bool {
        true
    }

    /// Whether posts `a` and `b` land in the same matrix closure. Defaults to
    /// [`Element::connects`]; overridden to true (every post pair) on elements
    /// whose stamps couple rows that `connects` leaves apart. Upstream's
    /// `getMatrixConnection` (CircuitElm.java:1286-1289): same matrix = same
    /// closure, which may differ from `getConnection` for devices whose gates
    /// or controls affect other rows.
    fn matrix_connects(&self, a: usize, b: usize) -> bool {
        self.connects(a, b)
    }

    /// Whether a DC current can flow between posts `a` and `b`, used to find
    /// current sources with no DC path (upstream's INDUCT `FindPathInfo`).
    /// Defaults to [`Element::connects`]; a capacitor is an open at DC and
    /// overrides this to false, while an inductor (a short at DC) inherits.
    fn dc_connects(&self, a: usize, b: usize) -> bool {
        self.connects(a, b)
    }

    /// The two terminals of a current-output device, for the broken-path
    /// check (upstream's INDUCT `FindPathInfo`). Analysis unions every
    /// element's `dc_connects` pairs and marks a source broken when its two
    /// output terminals have no DC path through the rest of the circuit. Only
    /// current sources implement it; the default is inert. The controlled
    /// current source reports its C+/C- pair, which is not its first two
    /// posts, so the pair has to come from here rather than a kind check.
    fn current_output_nodes(&self) -> Option<(usize, usize)> {
        None
    }

    /// Broken flag set by analysis when the element has no DC current path.
    /// Only current sources implement it; the default is inert.
    fn set_broken(&mut self, _broken: bool) {}

    /// True for ideal shorts that are merged out of the matrix before
    /// stamping: wires and closed switches. Upstream calls these removable
    /// wires. Merging them (rather than stamping a 0 V source per wire) keeps
    /// parallel wires and wire rings from producing duplicate constraint rows.
    fn removable_wire(&self) -> bool {
        false
    }

    /// The number of post pairs an ideal-short element merges into single
    /// nodes before stamping. Defaults to one pair (a plain wire or a closed
    /// switch); the bus splitter overrides with its bit count. Kept as a
    /// count plus [`Element::removable_wire_pair`] rather than a returned
    /// collection because both callers run every accepted step on every
    /// removable element, where an allocation apiece would be pure churn.
    fn removable_wire_pair_count(&self) -> usize {
        1
    }

    /// The `k`-th of [`Element::removable_wire_pair_count`] merge pairs,
    /// expressed as terminal indices into this element's posts.
    fn removable_wire_pair(&self, k: usize) -> (usize, usize) {
        let _ = k;
        (0, 1)
    }

    /// The bus bit a terminal carries at its coordinate, upstream's `Point.z`
    /// (`ChipElm.Pin.busZ`, ChipElm.java:708). Terminals merge into one node
    /// only when both the coordinate and the bit match, which is what keeps a
    /// bus wire's N signals apart where N wide pins overlap. Plain posts are
    /// bit 0, the same default upstream gives every non-bus post.
    fn post_bus_z(&self, _post: usize) -> usize {
        0
    }

    /// Receives one recovered wire current, for removable wires that span
    /// more than one node pair (a bus wire's bits). `pair` indexes
    /// [`Element::removable_wire_pair`]; single-pair shorts ignore the index
    /// and keep the base-class behaviour of writing `base.current` directly,
    /// which the recovery does itself.
    fn set_recovered_pair_current(&mut self, _pair: usize, _current: f64) {}

    /// Current flowing into the node at `post` from this element, used by the
    /// wire-current recovery. For a two-terminal element positive current
    /// enters post 0, so post 0 drains `current` and post 1 injects it.
    ///
    /// THIS BASE IS ONLY CORRECT FOR TWO-TERMINAL ELEMENTS. Any element with
    /// more than two posts MUST override it: the default cannot distribute
    /// `current` among the posts and returns a silent zero, which the
    /// wire-current recovery reads as "this element injects nothing at this
    /// node" and leaves every wire sharing the post animating the wrong
    /// current. The `debug_assert!` turns that silent wrong current into an
    /// early test-time failure in debug builds; release builds keep the
    /// pre-existing zero so element files that predate this guard still run.
    /// Single-post elements keep the default, which reads zero: no current
    /// can be attributed to a lone terminal, exact for the meter and readout
    /// family whose `calculate_current` zeroes it.
    fn current_into_node(&self, post: usize) -> f64 {
        if self.post_count() == 2 {
            if post == 0 {
                -self.base().current
            } else {
                self.base().current
            }
        } else {
            debug_assert!(
                self.post_count() < 2,
                "current_into_node has no default for a {}-post element: it \
                 MUST override to report real per-post currents (or an \
                 explicit documented 0.0 where none can be attributed)",
                self.post_count()
            );
            0.0
        }
    }

    /// True for ground symbols, whose terminal is pinned to the reference.
    fn is_ground(&self) -> bool {
        false
    }

    /// True for a capacitor with no series resistance, upstream's
    /// `isIdealCapacitor()` (CapacitorElm.java:271). The capacitor
    /// validation walk traverses these, and only these get the 0.1 ohm
    /// damping when they sit in a CAP_V loop.
    fn is_ideal_capacitor(&self) -> bool {
        false
    }

    /// True for voltage sources, upstream's `VoltageElm` family. A capacitor
    /// loop containing one is the CAP_V loop the validation walk looks for,
    /// because a voltage source pins the loop and lets the ideal-capacitor
    /// companion ring.
    fn is_voltage_source(&self) -> bool {
        false
    }

    /// Zeroes an element whose two posts turned out to be one merged node, so
    /// it contributes nothing. The capacitor override drops the stored charge
    /// (CapacitorElm.java:63-66).
    fn shorted(&mut self) {}

    /// Forces a series resistance at analysis time. The capacitor override
    /// stores the value and recomputes `cap_node` so the next node pass sees
    /// the new internal node (`getInternalNodeCount`, CapacitorElm.java:213).
    fn set_series_resistance(&mut self, _r: f64) {}

    /// Named-node label, for elements that connect by name rather than by
    /// position.
    fn node_label(&self) -> Option<&str> {
        None
    }

    /// Linking label for relay coils and contacts, which pair by name like
    /// labeled nodes but connect no nodes. The circuit resolves the label
    /// once in `set_circuit` so the per-step state machine never re-scans.
    fn link_label(&self) -> Option<&str> {
        None
    }

    /// Hands a relay coil the element indices of its label-matched contacts.
    /// The coil also announces its resting switch position here, which is
    /// upstream's `stamp()`-time toggle (RelayCoilElm.java:296-298).
    fn set_relay_contacts(&mut self, _contacts: Vec<usize>) {}

    /// Contact drives a relay coil queued during `start_iteration`. The
    /// circuit drains these once per timestep so a coil can set another
    /// element's position before its `do_step` stamps the new conductance.
    fn relay_contact_updates(&mut self) -> Vec<(usize, i32)> {
        Vec::new()
    }

    /// Applies a position pushed by a matching relay coil. The drive is in
    /// the coil's energised frame; `FLAG_NORMALLY_CLOSED` inverts it.
    fn set_relay_position(&mut self, _position: i32) {}

    /// Live parameter change from the UI (sliders, dialogs). Returns true if
    /// the parameter was applied; false if the name was not recognised, so the
    /// caller can fall back to a full rebuild instead of silently dropping the
    /// edit.
    fn set_param(&mut self, _name: &str, _value: f64) -> bool {
        false
    }

    /// A string-valued parameter, for the composite children a parent must
    /// configure after the child is built (the optocoupler hands its CCCS
    /// child the CTR expression, which is not a number). The default declines;
    /// only the expression-driven controlled sources accept one.
    fn set_string_param(&mut self, _name: &str, _value: &str) -> bool {
        false
    }

    /// Live frequency edit. A source rewinds its phase reference so the
    /// waveform stays continuous at the edit instant, which no other element
    /// needs, so the default declines the name and the caller falls back to a
    /// full rebuild.
    fn set_frequency(&mut self, _ctx: &SimCtx, _new_freq: f64) -> bool {
        false
    }

    /// Interactive state change, e.g. throwing a switch.
    fn set_state(&mut self, _state: i32) -> bool {
        false
    }

    /// Seed the global node-voltage vector from file state before the first
    /// solve. Only devices whose format stores operating-point tokens use it.
    fn seed_initial_voltages(&mut self, _v: &mut [f64]) {}

    fn reset(&mut self) {
        self.base_mut().reset();
    }

    /// Re-arms an element that can pause the simulation (the stop trigger)
    /// without rewinding time. Default is a no-op; only elements that latch a
    /// pause state override it, and the frontend calls it when a run resumes.
    fn clear_stop(&mut self) {}

    /// The voltage this element plots on a voltage scope and shows in the
    /// readout. The default is `V(post0) - V(post1)`, with a guard for the
    /// one-post elements (ground, rail, labeled node) that have no second
    /// terminal to subtract; multi-terminal elements override it with the
    /// quantity that means something for them: the op-amp plots
    /// `V(out) - V(+)` (`OpAmpElm.java:206`), and voltage and current sources
    /// their positive EMF (`VoltageElm.java:462`, `CurrentElm.java:199-201`).
    fn voltage_diff(&self) -> f64 {
        let b = self.base();
        if b.volts.len() >= 2 {
            b.volts[0] - b.volts[1]
        } else {
            // One-post elements read out their single node voltage
            // (LabeledNodeElm.java:243). The guard keeps a never-assigned
            // element from panicking; ground still reads 0 because its node is
            // the reference.
            b.volts.first().copied().unwrap_or(0.0)
        }
    }

    /// The power this element plots on a power scope. The default is the
    /// voltage-diff times the element current; elements whose `voltage_diff`
    /// is not `V(post0) - V(post1)` (sources with a positive-EMF readout, the
    /// op-amp) override it so a delivering part still reads negative.
    fn power(&self) -> f64 {
        self.voltage_diff() * self.base().current
    }

    /// The charge a charge scope samples, upstream's `getScopeValue(VAL_CHARGE)`
    /// (CapacitorElm.java:225-229). The default is zero, which is right for
    /// every element: only the capacitor holds a charge worth plotting.
    fn charge(&self) -> f64 {
        0.0
    }

    /// The value a per-element scope plot samples, upstream's
    /// `getScopeValue(val)` for the VAL_ ids that are not one of the generic
    /// quantities (TransistorElm.java:582-593, LampElm.java:218-219): a
    /// transistor's Ib/Ic/Ie/Vbe/Vbc/Vce and a lamp's hot resistance. `value`
    /// names the request, so only the element family that owns it answers with
    /// anything but zero; the frontend maps the file token per element kind
    /// before the spec reaches the engine, which is what keeps a scope from
    /// ever asking an element that has no answer.
    fn scope_value(&self, _value: crate::spec::ScopeValue) -> f64 {
        0.0
    }

    /// Instrument reading reported back to the UI each frame, the probe's
    /// meter mode. Defaults to the two-terminal voltage difference, so every
    /// other element reports what a voltage scope on it would plot.
    fn value(&self) -> f64 {
        self.voltage_diff()
    }

    /// Live per-element state the renderer animates, one scalar per element,
    /// shipped in the same flat per-element array as the currents and voltages
    /// (the wasm façade's `elementStates`, next to `elementCurrents`). Each
    /// element defines what its number means: a fuse reports its melt fraction
    /// `heat / i2t` (at or above 1 meaning blown), a lamp its filament
    /// temperature in kelvin, everything else 0. The scalar is deliberately
    /// generic rather than fuse-shaped, because every consumer queued behind
    /// this channel is one number too: relay armature position, spark-gap
    /// conduction, SCR/triac latch state, motor-protection-switch trip.
    /// Per-element state that is not a scalar needs its own channel (the
    /// transmission-line wave is a whole array per element).
    fn display_state(&self) -> f64 {
        0.0
    }

    /// Live values of the file-format tokens this element owns, in the same
    /// names the constructor's `spec.param` reads. Default: none. Called only
    /// at save/rebuild time, never per step.
    ///
    /// The golden rule for every implementation: feeding the returned tokens
    /// back through the constructor's `spec.param(name, default)` must
    /// reproduce the live internal state. That rule is what decides the
    /// base-relative conversions here, most noticeably the transistor, whose
    /// file tokens are node differences, not its swapped internal fields.
    fn state_tokens(&self) -> Vec<(String, f64)> {
        vec![]
    }

    /// Per-element sample array the renderer can pull on demand, one value per
    /// drawn segment of the element body. Default: nothing. The transmission
    /// line ships its delay-line wave here, already averaged from the two
    /// travelling waves and resampled to `segments` strips; every other
    /// element reports empty, so the frontend only pays for the call on kinds
    /// that ask.
    fn body_samples(&self, _segments: usize) -> Vec<f32> {
        Vec::new()
    }

    /// A data recorder's recorded samples, oldest first, for the frontend's
    /// export button. Default: nothing; only the data recorder reports, so
    /// the frontend only pays for the call on that kind.
    fn data_recorder_data(&self) -> Vec<f64> {
        Vec::new()
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

#[cfg(test)]
mod tests {
    use super::*;

    /// A bare element with no overrides, to exercise the trait defaults in
    /// isolation.
    struct DefaultElm {
        base: Base,
        posts: usize,
    }

    impl DefaultElm {
        fn new(posts: usize, current: f64) -> Self {
            let mut base = Base::with_posts(posts);
            base.current = current;
            Self { base, posts }
        }
    }

    impl Element for DefaultElm {
        fn kind(&self) -> &'static str {
            "defaultElm"
        }
        fn base(&self) -> &Base {
            &self.base
        }
        fn base_mut(&mut self) -> &mut Base {
            &mut self.base
        }
        fn post_count(&self) -> usize {
            self.posts
        }
    }

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-12
    }

    #[test]
    fn default_current_into_node_follows_the_two_terminal_sign_convention() {
        let elm = DefaultElm::new(2, 3.0);
        // Positive current enters post 0, so post 0 drains `current` and post
        // 1 injects it.
        assert!(close(elm.current_into_node(0), -3.0));
        assert!(close(elm.current_into_node(1), 3.0));
    }

    #[cfg(debug_assertions)]
    #[test]
    #[should_panic(expected = "MUST override")]
    fn default_current_into_node_panics_for_a_multi_post_element() {
        // A three-post element that relies on the default cannot distribute
        // `current` among its posts, so consulting it must trip the guard
        // rather than silently report zero.
        let elm = DefaultElm::new(3, 1.0);
        let _ = elm.current_into_node(0);
    }
}
