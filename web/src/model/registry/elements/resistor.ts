import {
  calcLeads,
  currentDotsPath,
  drawLeads,
  endpoints,
  formatValue,
  gradientPolyline,
  label,
  rectCorners,
  ZIGZAG_HS,
  zigzagPoints,
} from '../../../render/draw';
import { readParams, twoPosts, writeParams } from '../shared';
import type { CircuitElement, DrawContext, ElementDef } from '../../types';

function drawResistorBody(g: DrawContext, e: CircuitElement): void {
  const [lead1, lead2] = calcLeads(e, 32);
  drawLeads(g, e, lead1, lead2);
  // The body shades along the voltage drop, the axis from `lead1` at post 0
  // to `lead2` at post 1 (ResistorElm.java:71-96's linear gradient).
  if (g.euroResistors) {
    // IEC rectangle, 32 x 12 as upstream. The axis must be given explicitly:
    // a closed path's last point repeats the first, so its own chord is zero.
    const corners = rectCorners(lead1, lead2, 6);
    gradientPolyline(g, [corners[0], corners[1], corners[2], corners[3], corners[0]], {
      axis: [lead1, lead2],
    });
  } else {
    gradientPolyline(g, zigzagPoints(lead1, lead2, ZIGZAG_HS));
  }
  const [p1, p2] = endpoints(e);
  currentDotsPath(g, [p1, lead1, lead2, p2], g.current);
  label(g, e, formatValue(e.params.resistance ?? 0, 'Ω', g.valueDigits));
}

export const RESISTOR_DEF: ElementDef = {
  kind: 'resistor',
  label: 'Resistor',
  category: 'Basics',
  dumpCode: 'r',
  shortcut: 'r',  // ResistorElm.java
  postCount: 2,
  posts: twoPosts,
  defaults: { resistance: 1000 },
  parse: (t, e) => readParams(t, e, ['resistance']),
  dump: writeParams(['resistance']),
  fields: [{ name: 'resistance', label: 'Resistance', unit: 'Ω' }],
  draw: drawResistorBody,
};
