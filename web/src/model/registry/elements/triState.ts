/**
 * The tri-state buffer: an input triangle whose control post hangs off the
 * body midpoint, flipped by FLAG_FLIP (TriStateElm.java:102-125). Single-bit
 * only: upstream's busWidth is XML-only and this port has no buses.
 */

import {
  calcLeads,
  currentDots,
  elementLength,
  endpoints,
  interp,
  interp2,
  line,
  polyline,
  voltageColor,
} from '../../../render/draw';
import { TRI_STATE_FLIP } from '../flags';
import { readParams, writeParams } from '../shared';
import type { CircuitElement, DrawContext, ElementDef, Point } from '../../types';

const HS = 16;   // TriStateElm.java:109
const WW = 16;   // TriStateElm.java:111
const LEN = 32;  // TriStateElm.java:104

/** The sign of the control-side offset: -1 below the axis, FLAG_FLIP puts it
 *  above (TriStateElm.java:122). */
function controlSign(e: CircuitElement): number {
  return (e.flags & TRI_STATE_FLIP) !== 0 ? 1 : -1;
}

/** The triangle body's leads and control-lead points. */
function triStateBody(e: CircuitElement): {
  lead1: Point;
  lead2: Point;
  point3: Point;
  lead3: Point;
  apex: Point;
} {
  const dn = Math.max(1, elementLength(e));
  const ww = Math.min(WW, dn / 2);
  const [lead1, lead2] = calcLeads(e, LEN);
  const sign = controlSign(e);
  return {
    lead1,
    lead2,
    point3: interp(lead1, lead2, 0.5, sign * HS),
    lead3: interp(lead1, lead2, 0.5, sign * (HS / 2 + 2)),
    // The apex fraction uses the *lead* length, which `calcLeads` fixes at
    // LEN, not the element length (TriStateElm.java:116).
    apex: interp(lead1, lead2, 0.5 + (ww - 2) / LEN),
  };
}

function triStatePosts(e: CircuitElement): Point[] {
  const [p1, p2] = endpoints(e);
  const { point3 } = triStateBody(e);
  return [p1, p2, point3];
}

function drawTriState(g: DrawContext, e: CircuitElement): void {
  const [p1, p2] = endpoints(e);
  const { lead1, lead2, point3, lead3, apex } = triStateBody(e);

  // The control stub hangs below the triangle, voltage-coloured by its own
  // node (TriStateElm.java:131-133).
  line(g, point3, lead3, voltageColor(g, g.voltages[2]));
  // draw2Leads: the input and output wires (TriStateElm.java:141-143).
  line(g, p1, lead1, voltageColor(g, g.voltages[0]));
  line(g, lead2, p2, voltageColor(g, g.voltages[1]));

  const [t0, t1] = interp2(lead1, lead2, 0, HS + 2);
  polyline(g, [t0, t1, apex, t0], g.theme.wire);
  currentDots(g, lead2, p2, g.current);
}

export const TRI_STATE_DEF: ElementDef = {
  kind: 'triState',
  label: 'Tri-state buffer',
  category: 'Logic',
  dumpCode: '180',
  postCount: 3,
  posts: triStatePosts,
  canMirror: true,
  noDiagonal: true,   // TriStateElm.java:46
  defaultLength: 4,   // the base getDragLength() of 64
  // r_off_ground is deliberately 0, the token-constructor value (a bare `180`
  // line round-trips), not the 1e8 pulldown upstream's fresh placement drags
  // in (TriStateElm.java:44-45 vs :56). This port is file-first.
  defaults: { r_on: 0.1, r_off: 1e10, r_off_ground: 0, highVoltage: 5 },
  parse: (t, e) => readParams(t, e, ['r_on', 'r_off', 'r_off_ground', 'highVoltage']),
  dump: writeParams(['r_on', 'r_off', 'r_off_ground', 'highVoltage']),
  fields: [
    { name: 'r_on', label: 'On resistance', unit: 'Ω' },
    { name: 'r_off', label: 'Off resistance', unit: 'Ω' },
    { name: 'r_off_ground', label: 'Output pulldown resistance', unit: 'Ω' },
    { name: 'highVoltage', label: 'High logic voltage', unit: 'V' },
  ],
  draw: drawTriState,
};
