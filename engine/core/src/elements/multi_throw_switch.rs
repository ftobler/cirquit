//! Multi-throw (SPDT and up) switch.

use crate::element::{Base, Element, SimCtx};
use crate::spec::ElementSpec;
use crate::stamp::Stamper;

/// The centre-off flag (Switch2Elm.java:30): with exactly two throws the
/// switch gains a third stop, position 2, which connects nothing.
const FLAG_CENTER_OFF: i64 = 1;

/// Multi-throw switch. Post 0 is the common terminal, the rest are throws.
pub struct MultiThrowSwitch {
    base: Base,
    position: i32,
    throw_count: usize,
    /// Position 2 is an open stop rather than a throw (upstream's
    /// `hasCenterOff`, Switch2Elm.java:226). Only meaningful with two throws.
    center_off: bool,
}

impl MultiThrowSwitch {
    pub fn new(spec: &ElementSpec) -> Self {
        let throws = (spec.param("throwCount", 2.0) as usize).clamp(2, 8);
        Self {
            base: Base::with_posts(1 + throws),
            position: spec.param("position", 0.0) as i32,
            throw_count: throws,
            center_off: spec.flag(FLAG_CENTER_OFF) && throws == 2,
        }
    }

    /// The throw post a closed position connects the common to, or `None` for
    /// the centre-off open stop. Clamped like upstream's `position` indexing
    /// (Switch2Elm.java:104), except position 2 of a centre-off SPDT is the
    /// middle stop, not a throw.
    fn selected_post(&self) -> Option<usize> {
        if self.center_off && self.position == 2 {
            None
        } else {
            Some(1 + (self.position as usize).min(self.throw_count - 1))
        }
    }
}

impl Element for MultiThrowSwitch {
    fn kind(&self) -> &'static str {
        "switch2"
    }
    fn base(&self) -> &Base {
        &self.base
    }
    fn base_mut(&mut self) -> &mut Base {
        &mut self.base
    }
    fn post_count(&self) -> usize {
        1 + self.throw_count
    }
    fn voltage_source_count(&self) -> usize {
        // Upstream returns 0 for the open centre stop so no current unknown is
        // allocated (Switch2Elm.java:149-153); a position change into or out
        // of the middle therefore renumbers the source rows, which the
        // reanalyze-on-toggle path already handles.
        usize::from(self.selected_post().is_some())
    }
    fn voltage_source_nodes(&self, _k: usize) -> (usize, usize) {
        // `stamp` drives the source between the common post and the selected
        // throw, so the unknown must join the selected throw's closure, not
        // the first non-ground post's. Upstream's `setVoltageSource` records
        // exactly this pairing. Never called while open (`voltage_source_count`
        // is 0 then); the unwrap is a panic-with-reason if that ever changes.
        let sel = self.selected_post().expect("open position has no source");
        (self.base.nodes[0], self.base.nodes[sel])
    }
    fn connects(&self, a: usize, b: usize) -> bool {
        // The open centre stop ties nothing together, upstream's
        // `getConnection` (Switch2Elm.java:174-178).
        let Some(sel) = self.selected_post() else {
            return false;
        };
        (a == 0 && b == sel) || (b == 0 && a == sel)
    }
    fn stamp(&mut self, _ctx: &SimCtx, s: &mut Stamper) {
        // Nothing to stamp in the open centre stop (Switch2Elm.java:140-147).
        let Some(sel) = self.selected_post() else {
            return;
        };
        s.voltage_source(
            self.base.nodes[0],
            self.base.nodes[sel],
            self.base.vs_base,
            0.0,
        );
    }
    fn calculate_current(&mut self, _ctx: &SimCtx) {
        // The open centre stop has no source unknown to read, and its current
        // is definitionally zero (Switch2Elm.java:129-134).
        self.base.current = self.base.vs_currents.first().copied().unwrap_or(0.0);
    }
    fn current_into_node(&self, post: usize) -> f64 {
        let Some(sel) = self.selected_post() else {
            return 0.0;
        };
        if post == 0 {
            -self.base.current
        } else if post == sel {
            self.base.current
        } else {
            0.0
        }
    }
    fn set_state(&mut self, state: i32) -> bool {
        // Centre-off positions are stops, 0..=2, so the open middle must be
        // stored verbatim rather than wrapped onto a throw. Plain switches
        // keep the old modulo wrap.
        self.position = if self.center_off {
            state
        } else {
            state.rem_euclid(self.throw_count as i32)
        };
        true
    }
}
