import {
  calcLeads,
  currentDotsPath,
  drawLeads,
  endpoints,
  interpPrecise,
  interp2Precise,
  line,
  polyline,
  triangle,
} from '../../../render/draw';
import { elementColor, twoPosts } from '../shared';
import type { CircuitElement, DrawContext, ElementDef, Point } from '../../types';

export function drawDiodeBody(g: DrawContext, e: CircuitElement, zener: boolean): void {
  const [lead1, lead2] = calcLeads(e, 16);
  drawLeads(g, e, lead1, lead2);
  // Each sub-shape takes its own side's colour rather than a forced gradient
  // through a shape that is not a curve along the axis: the triangle (base at
  // the anode/lead1 end) samples post 0, the cathode bar at the lead2 end
  // samples post 1. This is the per-terminal split upstream's two
  // setVoltageColor calls express (DiodeElm.java:156-163) and the capacitor's
  // plate pair exemplifies (capacitor.ts:22-23).
  const anodeColor = elementColor(g, g.voltages[0], g.power);
  const cathodeColor = elementColor(g, g.voltages[1], g.power);
  // Both DiodeElm and ZenerElm use hs = 8 for the triangle base and the
  // cathode bar (DiodeElm.java:118, ZenerElm.java:45). Body geometry, so the
  // base and bar stay perpendicular to the body at any angle.
  const [t1, t2] = interp2Precise(lead1, lead2, 0, 8);
  triangle(g, t1, t2, lead2, anodeColor);
  if (zener) {
    const { bar, wing0, wing1 } = zenerMarks(lead1, lead2);
    // The cathode bar and wings are drawThickLine strokes upstream
    // (ZenerElm.java:71-78), the 3-unit body weight.
    polyline(g, [wing0, bar[0], bar[1], wing1], cathodeColor);
  } else {
    const [b1, b2] = interp2Precise(lead1, lead2, 1, 8);
    line(g, b1, b2, cathodeColor);
  }
  const [p1, p2] = endpoints(e);
  currentDotsPath(g, [p1, lead1, lead2, p2], g.current);
}

/**
 * The zener's distinguishing cathode marks (ZenerElm.java:56-59): a bar at the
 * end of the triangle and two short wings swept out and back along it. Each
 * wing starts a fifth of the way back along the bar and steps 8 across the
 * perpendicular, so the pair spreads past both bar ends, not inward.
 */
export function zenerMarks(lead1: Point, lead2: Point): {
  bar: [Point, Point];
  wing0: Point;
  wing1: Point;
} {
  // The bar and the wings swept back off it are body geometry, so they are
  // interpolated without the grid rounding `interp` applies to posts.
  const [b1, b2] = interp2Precise(lead1, lead2, 1, 8);
  return {
    bar: [b1, b2],
    wing0: interpPrecise(b1, b2, -0.2, -8),
    wing1: interpPrecise(b2, b1, -0.2, -8),
  };
}

export const DIODE_DEF: ElementDef = {
  kind: 'diode',
  label: 'Diode',
  category: 'Semiconductors',
  dumpCode: 'd',
  shortcut: 'd',  // DiodeElm.java
  postCount: 2,
  posts: twoPosts,
  // The default matches upstream's "default" model (DiodeModel.java:83):
  // fwdrop 0.805904783, n = 2, series resistance 0. Is is derived from the
  // forward drop, so it is not a UI field.
  defaults: { forwardVoltage: 0.805904783, seriesResistance: 0, emissionCoefficient: 2 },
  // FLAG_MODEL (bit 2) carries an escaped model name; FLAG_FWDROP (bit 1)
  // carries the forward drop the model was derived from.
  parse: (t, e) => {
    if ((e.flags & 2) !== 0) e.modelName = t[0];
    else if ((e.flags & 1) !== 0) e.params.forwardVoltage = Number(t[0]);
  },
  dump: (e) =>
    // Upstream's value form is the single fwdrop token, from which the model
    // derives everything else; seriesResistance and emissionCoefficient are
    // engine params that a named model would encode, so they intentionally do
    // not survive a save in the value form.
    e.modelName != null
      ? [e.modelName]
      : [e.params.forwardVoltage ?? 0.805904783],
  // The value form must carry exactly FLAG_FWDROP: with bit 2 (FLAG_MODEL)
  // left over from a loaded name, a reload would read the fwdrop token as a
  // bogus model name and silently lose the edit.
  dumpFlags: (e) => (e.modelName != null ? e.flags | 2 : (e.flags & ~2) | 1),
  fields: [
    // The model choice is upstream's edit item 0 (DiodeElm.java:197-210).
    { name: 'modelName', label: 'Model', type: 'modelChoice', target: 'modelName', modelFamily: 'diode' },
    { name: 'forwardVoltage', label: 'Forward drop', unit: 'V' },
    { name: 'seriesResistance', label: 'Series resistance', unit: 'Ω' },
    { name: 'emissionCoefficient', label: 'Emission coefficient' },
  ],
  draw: (g, e) => drawDiodeBody(g, e, false),
};
