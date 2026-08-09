/**
 * The inverting buffer: a triangle with an output bubble, or the IEC
 * rectangle with "1" inside (InverterElm.java:68-110). Unlike the gates, the
 * euro rectangle here is shorter than the ANSI body, leaving room for the
 * output bubble, exactly as InverterElm.java:96-108 draws it.
 */

import {
  canvasFont,
  circle,
  closedPolyline,
  currentDots,
  elementLength,
  endpoints,
  interp,
  interp2,
  line,
  voltageColor,
} from '../../../render/draw';
import { readParams, writeParams, twoPosts } from '../shared';
import type { CircuitElement, DrawContext, ElementDef } from '../../types';

const HS = 16;    // InverterElm.java:88
const WW = 16;    // InverterElm.java:89

function drawInverter(g: DrawContext, e: CircuitElement): void {
  const [p1, p2] = endpoints(e);
  const dn = Math.max(1, elementLength(e));
  const ww = Math.min(WW, dn / 2);
  const lead1 = interp(p1, p2, 0.5 - ww / dn);
  const lead2 = interp(p1, p2, 0.5 + (ww + 2) / dn);
  const pcircle = interp(p1, p2, 0.5 + (ww - 2) / dn);

  line(g, p1, lead1, voltageColor(g, g.voltages[0]));
  line(g, lead2, p2, voltageColor(g, g.voltages[1]));

  const color = g.theme.wire;
  if (g.euroGates) {
    // The IEC rectangle runs from `lead1` to a point pulled back from the
    // bubble, and the "1" glyph centres on it (InverterElm.java:96-102).
    const l2 = interp(p1, p2, 0.5 + (ww - 5) / dn);
    const [top, bottom] = interp2(lead1, l2, 0, HS);
    const [bottom2, top2] = interp2(lead1, l2, 1, HS);
    closedPolyline(g, [top, bottom, bottom2, top2, top], color);
    const center = interp(lead1, l2, 0.5);
    g.ctx.fillStyle = g.theme.text;
    g.ctx.font = canvasFont(12);
    g.ctx.textAlign = 'center';
    g.ctx.textBaseline = 'middle';
    g.ctx.fillText('1', center.x, center.y - 6);
  } else {
    // The ANSI triangle, base on the body and apex pulled back from the
    // bubble (InverterElm.java:104-107).
    const [t0, t1] = interp2(lead1, lead2, 0, HS);
    const apex = interp(p1, p2, 0.5 + (ww - 5) / dn);
    closedPolyline(g, [t0, t1, apex, t0], color);
  }
  circle(g, pcircle, 3, g.theme.wire, false, 3);
  currentDots(g, lead2, p2, g.current);
}

export const INVERTER_DEF: ElementDef = {
  kind: 'inverter',
  label: 'Inverter',
  category: 'Logic',
  dumpCode: 'I',
  postCount: 2,
  posts: twoPosts,
  noDiagonal: true,   // InverterElm.java:30
  defaultLength: 4,   // the base getDragLength() of 64
  defaults: { slewRate: 0.5, highVoltage: 5 },
  parse: (t, e) => readParams(t, e, ['slewRate', 'highVoltage']),
  dump: writeParams(['slewRate', 'highVoltage']),
  fields: [
    { name: 'slewRate', label: 'Slew rate', unit: 'V/ns' },
    { name: 'highVoltage', label: 'High logic voltage', unit: 'V' },
  ],
  draw: drawInverter,
};
