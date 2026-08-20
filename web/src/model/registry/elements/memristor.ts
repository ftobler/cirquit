import {
  calcLeads,
  currentDotsPath,
  drawLeads,
  endpoints,
  interp,
  line,
} from '../../../render/draw';
import { bodyBox, elementColor, readParams, twoPosts, writeParams } from '../shared';
import type { CircuitElement, DrawContext, ElementDef } from '../../types';

/** Zigzag cycles of the memristor body, fixed at 6 like upstream
 *  (MemristorElm.java:80). */
const MEMRISTOR_SEGMENTS = 6;

/**
 * The memristor's charge-controlled zigzag, ported straight from
 * `MemristorElm.draw` (MemristorElm.java:79-110): six segments whose peak
 * half-height `hs = 2 + 8*(1 - dopeWidth/totalWidth)` collapses from 10 at an
 * undoped device down to 2 once fully doped, so the symbol shrinks toward a
 * plain wire as the doped region grows. Each segment is stroked in the
 * upstream per-point colour (voltage-graded in voltage mode, one flat power
 * colour in power mode, the same `elementColor` split the resistor body
 * uses). `dopeWidth` is live engine state that never round-trips back to the
 * params (the same gap the lamp's temperature has), so the drawn height
 * follows the last value the file carried, exactly as the other stateful
 * resistors fall back to their file values.
 */
function drawMemristorBody(g: DrawContext, e: CircuitElement): void {
  const [lead1, lead2] = calcLeads(e, 32);
  drawLeads(g, e, lead1, lead2);
  const ratio = Math.min(1, Math.max(0, g.state ?? 0));
  const hs = 2 + Math.round(8 * (1 - ratio));
  const segf = 1 / MEMRISTOR_SEGMENTS;
  let ox = 0;
  for (let i = 0; i <= MEMRISTOR_SEGMENTS; i++) {
    const nx = i === MEMRISTOR_SEGMENTS ? 0 : (i & 1) === 0 ? 1 : -1;
    const v = g.voltages[0] + ((g.voltages[1] - g.voltages[0]) * i) / MEMRISTOR_SEGMENTS;
    const color = elementColor(g, v, g.power);
    const p1 = interp(lead1, lead2, i * segf, hs * ox);
    const p2 = interp(lead1, lead2, i * segf, hs * nx);
    // The zigzag is drawThickLine upstream (MemristorElm.java:100-104), the
    // 3-unit body weight.
    line(g, p1, p2, color);
    if (i === MEMRISTOR_SEGMENTS) break;
    // The run joins the current peak to the next peak at the SAME offset
    // `hs*nx`, a horizontal flat top. Upstream overwrites its first point
    // with the next fraction before the stroke and draws ps1-ps2
    // (MemristorElm.java:103-104); starting from `p1` (the low vertex at
    // `hs*ox`) instead would jump the axis back into the next peak.
    line(g, p2, interp(lead1, lead2, (i + 1) * segf, hs * nx), color);
    ox = nx;
  }
  const [p1, p2] = endpoints(e);
  currentDotsPath(g, [p1, lead1, lead2, p2], g.current);
}

export const MEMRISTOR_DEF: ElementDef = {
  kind: 'memristor',
  label: 'Memristor',
  category: 'Basics',
  // getDumpType() returns the char 'm' (MemristorElm.java:51).
  dumpCode: 'm',
  postCount: 2,
  posts: twoPosts,
  // MemristorElm.java's no-args constructor: r_off defaults to 160*r_on, an
  // undoped start, a 10 nm device, and the 1e-10 mobility (MemristorElm.java:
  // 31-35). `current` is the saved operating-point token, not a constructor
  // default in the original.
  defaults: { r_on: 100, r_off: 16000, dopeWidth: 0, totalWidth: 1e-8, mobility: 1e-10, current: 0 },
  // The token constructor reads r_on, r_off, dopeWidth, totalWidth, mobility,
  // then an optional saved current (MemristorElm.java:41-48).
  parse: (t, e) => {
    readParams(t, e, ['r_on', 'r_off', 'dopeWidth', 'totalWidth', 'mobility']);
    if (t[5] !== undefined) {
      const v = Number(t[5]);
      if (Number.isFinite(v)) e.params.current = v;
    }
  },
  dump: writeParams(['r_on', 'r_off', 'dopeWidth', 'totalWidth', 'mobility', 'current']),
  // getEditInfo's five fields, in order (MemristorElm.java:150-161).
  // dopeWidth and totalWidth are edited in nm upstream (the dialog shows
  // `*1e9` and setEditValue converts back with `*1e-9`); this port's
  // engineering-prefix 'm' display reproduces the same numbers, so a 10 nm
  // device reads "10n m". `current` is simulation state like the fuse's heat,
  // not something to edit.
  fields: [
    { name: 'r_on', label: 'Min Resistance', unit: 'Ω', min: 0 },
    { name: 'r_off', label: 'Max Resistance', unit: 'Ω', min: 0 },
    { name: 'dopeWidth', label: 'Width of Doped Region', unit: 'm', min: 0 },
    { name: 'totalWidth', label: 'Total Width', unit: 'm', min: 0 },
    { name: 'mobility', label: 'Mobility', unit: 'm²/Vs', min: 0 },
  ],
  // The zigzag body, whose peak half-height collapses from 10 to 2 as the
  // device dopes (MemristorElm.java:85-86); the box uses the full 10 so the
  // symbol is grabbable in every state.
  bodyRect: (e) => bodyBox(e, 32, 10),
  draw: drawMemristorBody,
};
