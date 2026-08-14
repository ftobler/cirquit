//! LED array (LEDArrayElm.java, dump 405): a chip-shaped crossbar of plain
//! Shockley diodes. Each of the `sizeY` row posts (west) is the anode of the
//! `sizeX` diodes in its row, one per column post (south); an LED conducts
//! when its row sits above its column (LEDArrayElm.java:93-97). There are no
//! voltage sources and no output pins, only the diode grid, so the element is
//! nonlinear exactly like a basket of individual diodes: the columns and rows
//! are all plain posts the surrounding circuit drives or sinks.
//!
//! Every cell uses upstream's built-in "default-led" diode model
//! (DiodeModel.java:90), hardcoded here rather than read from the file, which
//! carries only the two grid sizes.

use crate::element::{Base, Element, SimCtx};
use crate::elements::junction::{
    critical_voltage, limit_junction, ramp_gmin, CONVERGENCE_V, GMIN_RAMP_DENOM, GMIN_RAMP_START,
    JUNCTION_GMIN, MAX_EXP_ARG, VT,
};
use crate::spec::ElementSpec;
use crate::stamp::Stamper;

/// Saturation current of the "default-led" diode model
/// (DiodeModel.java:90).
const LED_LEAKAGE: f64 = 93.2e-12;
/// Emission coefficient of that model, 3.73, scaled into the thermal voltage
/// the junctions use (DiodeModel.java:333, :30).
const LED_VSCALE: f64 = 3.73 * VT;
/// Current above which a cell counts as lit, for the `value()` readout. The
/// gap is enormous: an unlit cell carries at most leakage current (~1e-11 A)
/// or exactly zero at V = 0, a lit one milliamps.
const LIT_CURRENT: f64 = 1e-9;

/// One grid cell's per-step Newton state. The junction parameters are shared
/// module constants, so only the state that varies is stored per cell.
struct LedCell {
    /// Forward voltage, row minus column, at the last Newton iterate, the
    /// anchor for junction limiting (Diode.java:144).
    last_v: f64,
    /// Linearised conductance and Norton current source from the last iterate.
    geq: f64,
    ieq: f64,
    /// Conduction current, row to column, from the last solved step.
    current: f64,
}

impl LedCell {
    fn new() -> Self {
        Self {
            last_v: 0.0,
            geq: 0.0,
            ieq: 0.0,
            current: 0.0,
        }
    }
}

/// Forward junction current and its conductance at `v`, the plain-Shockley
/// branch of the diode's `evaluate` (Diode.java:158-163). The grid never
/// reverses into a Zener branch, so only the forward exponential is needed.
fn evaluate(v: f64, gmin: f64) -> (f64, f64) {
    let arg = (v / LED_VSCALE).min(MAX_EXP_ARG);
    let ev = arg.exp();
    let current = LED_LEAKAGE * (ev - 1.0);
    let g = LED_LEAKAGE * ev / LED_VSCALE;
    (current, g + gmin)
}

pub struct LedArray {
    base: Base,
    size_x: usize,
    size_y: usize,
    vcrit: f64,
    cells: Vec<LedCell>,
}

impl LedArray {
    pub fn new(spec: &ElementSpec) -> Self {
        // A missing or zero size falls back to 8x8, the guard in `setupPins`
        // that also catches a token constructor whose parse threw
        // (LEDArrayElm.java:60-64).
        let mut size_x = spec.param("sizeX", 0.0).round() as usize;
        let mut size_y = spec.param("sizeY", 0.0).round() as usize;
        if size_x == 0 || size_y == 0 {
            size_x = 8;
            size_y = 8;
        }
        Self {
            base: Base::with_posts(size_x + size_y),
            size_x,
            size_y,
            vcrit: critical_voltage(LED_VSCALE, LED_LEAKAGE),
            cells: (0..size_x * size_y).map(|_| LedCell::new()).collect(),
        }
    }
}

impl Element for LedArray {
    fn kind(&self) -> &'static str {
        "ledArray"
    }
    fn base(&self) -> &Base {
        &self.base
    }
    fn base_mut(&mut self) -> &mut Base {
        &mut self.base
    }
    fn post_count(&self) -> usize {
        self.size_x + self.size_y
    }
    fn nonlinear(&self) -> bool {
        true
    }
    /// The diode grid couples every row to every column
    /// (getMatrixConnection = true, LEDArrayElm.java:184), so all the posts
    /// land in one matrix closure.
    fn matrix_connects(&self, _a: usize, _b: usize) -> bool {
        true
    }

    fn do_step(&mut self, ctx: &SimCtx, s: &mut Stamper) {
        // One junction per cell, anode on the row post, cathode on the column
        // post, exactly the `diodes[i].stamp(nodes[sizeX+iy], nodes[ix])` grid
        // (LEDArrayElm.java:93-97) with the cell order `i = iy*sizeX + ix`.
        for iy in 0..self.size_y {
            let row = self.size_x + iy;
            let row_node = self.base.nodes[row];
            for ix in 0..self.size_x {
                let idx = iy * self.size_x + ix;
                let col_node = self.base.nodes[ix];
                let mut v = self.base.volts[row] - self.base.volts[ix];
                let cell = &mut self.cells[idx];
                if (v - cell.last_v).abs() > CONVERGENCE_V {
                    s.not_converged();
                }
                v = limit_junction(v, cell.last_v, LED_VSCALE, self.vcrit);
                cell.last_v = v;
                let gmin = if ctx.subiter > GMIN_RAMP_START as usize {
                    ramp_gmin(ctx.subiter as u32, GMIN_RAMP_DENOM)
                } else {
                    JUNCTION_GMIN
                };
                let (current, g) = evaluate(v, gmin);
                cell.geq = g;
                cell.ieq = current - g * v;
                s.conductance(row_node, col_node, g);
                s.current_source(row_node, col_node, cell.ieq);
            }
        }
    }

    fn calculate_current(&mut self, _ctx: &SimCtx) {
        // The linearised current at the solved voltage, the same expression
        // `Diode::calculate_current` uses. The per-cell values feed the lit
        // readout; the total is the element's `current` for scopes.
        let mut total = 0.0;
        for iy in 0..self.size_y {
            let row = self.size_x + iy;
            for ix in 0..self.size_x {
                let idx = iy * self.size_x + ix;
                let v = self.base.volts[row] - self.base.volts[ix];
                let cell = &mut self.cells[idx];
                cell.current = cell.geq * v + cell.ieq;
                total += cell.current;
            }
        }
        self.base.current = total;
    }

    /// The posts are the diode anodes (rows) and cathodes (columns), and each
    /// cell's `current` flows from its row post into the element and out its
    /// column post (`do_step` stamps row to column), so a row post drains the
    /// sum of its row's cell currents and a column post receives the sum of
    /// its column's. Without this the wire-current recovery would read a
    /// silent zero at every post and wires sharing the grid's nodes would
    /// animate the wrong current.
    fn current_into_node(&self, post: usize) -> f64 {
        if post < self.size_x {
            let mut total = 0.0;
            for iy in 0..self.size_y {
                total += self.cells[iy * self.size_x + post].current;
            }
            total
        } else {
            let row = post - self.size_x;
            let mut total = 0.0;
            for ix in 0..self.size_x {
                total += self.cells[row * self.size_x + ix].current;
            }
            -total
        }
    }

    /// Re-anchors every junction from the restored node voltages after a
    /// rejected step, the same re-linearisation `Diode::restore_iteration`
    /// performs.
    fn restore_iteration(&mut self) {
        for iy in 0..self.size_y {
            for ix in 0..self.size_x {
                let idx = iy * self.size_x + ix;
                self.cells[idx].last_v = self.base.volts[self.size_x + iy] - self.base.volts[ix];
            }
        }
    }

    fn reset(&mut self) {
        self.base.reset();
        for cell in self.cells.iter_mut() {
            cell.last_v = 0.0;
            cell.geq = 0.0;
            cell.ieq = 0.0;
            cell.current = 0.0;
        }
    }

    /// The lit cells as a bit pattern, bit `iy*sizeX + ix` set when that cell
    /// carried more than [`LIT_CURRENT`] at the last solve. Upstream draws
    /// brightness from the cell currents (LEDArrayElm.java:157-177); this is
    /// the same reading as a number. Cells past the 64th are dropped: f64
    /// cannot carry a faithful 256-bit pattern, and the default 8x8 grid is
    /// exactly 64 cells.
    fn value(&self) -> f64 {
        let mut pattern: u64 = 0;
        for (i, cell) in self.cells.iter().enumerate() {
            if i < 64 && cell.current > LIT_CURRENT {
                pattern |= 1u64 << i;
            }
        }
        pattern as f64
    }
}
