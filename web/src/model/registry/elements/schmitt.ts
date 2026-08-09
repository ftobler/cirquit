/**
 * The Schmitt triggers, inverting and non-inverting, sharing the triangle
 * plus the hysteresis Z. Upstream has no IEC branch for these: both variants
 * always draw the ANSI shape, and only the inverting one adds the output
 * bubble (InvertingSchmittElm.java:84-115, SchmittElm.java:72-95).
 */

import {
  circle,
  closedPolyline,
  currentDots,
  elementLength,
  endpoints,
  interp,
  interp2,
  line,
  polyline,
  voltageColor,
} from '../../../render/draw';
import { readParams, writeParams, twoPosts } from '../shared';
import type { CircuitElement, DrawContext, ElementDef, Point } from '../../types';

const HS = 16;   // InvertingSchmittElm.java:101
const WW = 16;   // InvertingSchmittElm.java:102

/** The hysteresis Z over the triangle (getSchmittPolygon, CircuitElm.java:1057-1069,
 *  called with gsize 1 and centre 0.3, InvertingSchmittElm.java:113). */
function zSymbol(lead1: Point, lead2: Point): Point[] {
  const len = Math.hypot(lead2.x - lead1.x, lead2.y - lead1.y) || 1;
  const h1 = 3;
  const h2 = 6;
  const ctr = 0.3;
  return [
    interp(lead1, lead2, ctr - h2 / len, 3),
    interp(lead1, lead2, ctr + h1 / len, 3),
    interp(lead1, lead2, ctr + h1 / len, -3),
    interp(lead1, lead2, ctr + h2 / len, -3),
    interp(lead1, lead2, ctr - h1 / len, -3),
    interp(lead1, lead2, ctr - h1 / len, 3),
  ];
}

/** Draws either Schmitt variant; `inverting` selects the output bubble and
 *  the lead2 fraction (SchmittElm.java:90 uses ww-3, the inverting ww+2). */
function drawSchmitt(g: DrawContext, e: CircuitElement, inverting: boolean): void {
  const [p1, p2] = endpoints(e);
  const dn = Math.max(1, elementLength(e));
  const ww = Math.min(WW, dn / 2);
  const lead1 = interp(p1, p2, 0.5 - ww / dn);
  const lead2 = interp(p1, p2, 0.5 + (inverting ? ww + 2 : ww - 3) / dn);

  line(g, p1, lead1, voltageColor(g, g.voltages[0]));
  line(g, lead2, p2, voltageColor(g, g.voltages[1]));

  const [t0, t1] = interp2(lead1, lead2, 0, HS);
  const apex = interp(p1, p2, 0.5 + (ww - 5) / dn);
  closedPolyline(g, [t0, t1, apex, t0], g.theme.wire);
  // The hysteresis Z is a drawPolygon at setLineWidth(2) upstream
  // (SchmittElm.java:77-78), deliberately finer than the 3-unit body.
  polyline(g, zSymbol(lead1, lead2), g.theme.wire, 2);
  if (inverting) {
    circle(g, interp(p1, p2, 0.5 + (ww - 2) / dn), 3, g.theme.wire, false);
  }
  currentDots(g, lead2, p2, g.current);
}

const SCHMITT_DEFAULTS = {
  slewRate: 0.5,
  lowerTrigger: 1.66,
  upperTrigger: 3.33,
  logicOnLevel: 5,
  logicOffLevel: 0,
};

const SCHMITT_FIELDS = [
  { name: 'lowerTrigger', label: 'Lower threshold', unit: 'V' },
  { name: 'upperTrigger', label: 'Upper threshold', unit: 'V' },
  { name: 'slewRate', label: 'Slew rate', unit: 'V/ns' },
  { name: 'logicOnLevel', label: 'High logic voltage', unit: 'V' },
  { name: 'logicOffLevel', label: 'Low voltage', unit: 'V' },
] as const;

export const SCHMITT_DEF: ElementDef = {
  kind: 'schmitt',
  label: 'Schmitt trigger',
  category: 'Logic',
  dumpCode: '182',
  postCount: 2,
  posts: twoPosts,
  noDiagonal: true,   // InvertingSchmittElm.java:37
  defaultLength: 4,   // the base getDragLength() of 64
  defaults: SCHMITT_DEFAULTS,
  parse: (t, e) =>
    readParams(t, e, ['slewRate', 'lowerTrigger', 'upperTrigger', 'logicOnLevel', 'logicOffLevel']),
  dump: writeParams(['slewRate', 'lowerTrigger', 'upperTrigger', 'logicOnLevel', 'logicOffLevel']),
  fields: [...SCHMITT_FIELDS],
  draw: (g, e) => drawSchmitt(g, e, false),
};

export const INVERTING_SCHMITT_DEF: ElementDef = {
  kind: 'invertingSchmitt',
  label: 'Inverting Schmitt trigger',
  category: 'Logic',
  dumpCode: '183',
  postCount: 2,
  posts: twoPosts,
  noDiagonal: true,
  defaultLength: 4,
  defaults: SCHMITT_DEFAULTS,
  parse: (t, e) =>
    readParams(t, e, ['slewRate', 'lowerTrigger', 'upperTrigger', 'logicOnLevel', 'logicOffLevel']),
  dump: writeParams(['slewRate', 'lowerTrigger', 'upperTrigger', 'logicOnLevel', 'logicOffLevel']),
  fields: [...SCHMITT_FIELDS],
  draw: (g, e) => drawSchmitt(g, e, true),
};
