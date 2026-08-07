import {
  calcLeads,
  currentDotsPath,
  drawLeads,
  endpoints,
  interp,
  interp2,
  line,
  polyline,
  triangle,
  voltageColor,
} from '../../../render/draw';
import { twoPosts } from '../shared';
import type { CircuitElement, DrawContext, ElementDef } from '../../types';

export function drawDiodeBody(g: DrawContext, e: CircuitElement, zener: boolean): void {
  const [lead1, lead2] = calcLeads(e, 16);
  drawLeads(g, e, lead1, lead2);
  const color = voltageColor(g, (g.voltages[0] + g.voltages[1]) / 2);
  const [t1, t2] = interp2(lead1, lead2, 0, 7);
  triangle(g, t1, t2, lead2, color);
  const [b1, b2] = interp2(lead1, lead2, 1, 7);
  if (zener) {
    // Cathode bar with the characteristic swept ends.
    polyline(
      g,
      [interp(lead1, lead2, 1, 7), b1, b2, interp(lead1, lead2, 1.35, -7)],
      color,
      2,
    );
    const [z1, z2] = interp2(lead1, lead2, 1, 7);
    line(g, interp(lead1, lead2, -0.35, 7), z1, color, 2);
    void z2;
  } else {
    line(g, b1, b2, color, 2.5);
  }
  const [p1, p2] = endpoints(e);
  currentDotsPath(g, [p1, lead1, lead2, p2], g.current);
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
