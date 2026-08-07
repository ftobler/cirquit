import {
  calcLeads,
  currentDotsPath,
  drawLeads,
  endpoints,
  interp,
  interp2,
  line,
  triangle,
  voltageColor,
} from '../../../render/draw';
import { twoPosts } from '../shared';
import type { CircuitElement, DrawContext, ElementDef, Point } from '../../types';

export function drawDiodeBody(g: DrawContext, e: CircuitElement, zener: boolean): void {
  const [lead1, lead2] = calcLeads(e, 16);
  drawLeads(g, e, lead1, lead2);
  const color = voltageColor(g, (g.voltages[0] + g.voltages[1]) / 2);
  // Both DiodeElm and ZenerElm use hs = 8 for the triangle base and the
  // cathode bar (DiodeElm.java:118, ZenerElm.java:45).
  const [t1, t2] = interp2(lead1, lead2, 0, 8);
  triangle(g, t1, t2, lead2, color);
  if (zener) {
    const { bar, wing0, wing1 } = zenerMarks(lead1, lead2);
    line(g, bar[0], bar[1], color, 2.5);
    line(g, wing0, bar[0], color, 2);
    line(g, wing1, bar[1], color, 2);
  } else {
    const [b1, b2] = interp2(lead1, lead2, 1, 8);
    line(g, b1, b2, color, 2.5);
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
  const [b1, b2] = interp2(lead1, lead2, 1, 8);
  return {
    bar: [b1, b2],
    wing0: interp(b1, b2, -0.2, -8),
    wing1: interp(b2, b1, -0.2, -8),
  };
}

export const DIODE_DEF: ElementDef = {
  kind: 'diode',
  label: 'Diode',
  category: 'Semiconductors',
  dumpCode: 'd',
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
    { name: 'forwardVoltage', label: 'Forward drop', unit: 'V' },
    { name: 'seriesResistance', label: 'Series resistance', unit: 'Ω' },
    { name: 'emissionCoefficient', label: 'Emission coefficient' },
  ],
  draw: (g, e) => drawDiodeBody(g, e, false),
};
