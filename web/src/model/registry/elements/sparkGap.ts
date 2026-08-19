import {
  calcLeads,
  currentDots,
  drawLeads,
  elementLength,
  endpoints,
  interpPrecise,
  interp2Precise,
  triangle,
} from '../../../render/draw';
import { elementColor, readParams, twoPosts, bodyBox } from '../shared';
import type { CircuitElement, DrawContext, ElementDef } from '../../types';

/** Two opposing filled arrows between the leads, the spark-gap symbol
 *  (SparkGapElm.java:69-79, :81-96). Each arrow is upstream's `calcArrow`
 *  (CircuitElm.java:520-532): apex at the tip, base `alen` back along the
 *  axis and `alen` to each side. `calcLeads(24)` puts the leads exactly at
 *  the bases, and the tips sit 8 units either side of the midpoint, pointing
 *  at each other across the gap. Upstream only draws current dots while the
 *  gap is conducting; engine state never crosses the boundary, so the dots
 *  are drawn whenever the reported current is visible, which is the same
 *  thing because an open gap carries ~1 nA. */
function drawSparkGap(g: DrawContext, e: CircuitElement): void {
  const [p1, p2] = endpoints(e);
  const dist = 16;
  const alen = 8;
  const [lead1, lead2] = calcLeads(e, dist + alen);
  drawLeads(g, e, lead1, lead2);
  const dn = elementLength(e);
  // The arrow tips and bases are body geometry, so they are interpolated
  // without the grid rounding `interp` applies to posts, keeping the two
  // arrows square to the body on a diagonal.
  const tip1 = interpPrecise(p1, p2, (dn - alen) / (2 * dn));
  const tip2 = interpPrecise(p1, p2, (dn + alen) / (2 * dn));
  const fLead = (dn - dist - alen) / (2 * dn);
  const [a1, a2] = interp2Precise(p1, p2, fLead, alen);
  const [b1, b2] = interp2Precise(p1, p2, 1 - fLead, alen);
  triangle(g, tip1, a1, a2, elementColor(g, g.voltages[0], g.power));
  triangle(g, tip2, b1, b2, elementColor(g, g.voltages[1], g.power));
  currentDots(g, p1, lead1, g.current);
  currentDots(g, lead2, p2, g.current);
}

export const SPARK_GAP_DEF: ElementDef = {
  kind: 'sparkGap',
  label: 'Spark gap',
  category: 'Basics',
  dumpCode: '187',
  postCount: 2,
  posts: twoPosts,
  // Defaults and token order from SparkGapElm.java:30-37 and :48-51, and the
  // token constructor reads the same four tokens (SparkGapElm.java:41-44).
  defaults: { r_on: 1e3, r_off: 1e9, breakdown: 1000, holdcurrent: 0.001 },
  parse: (t, e) => {
    readParams(t, e, ['r_on', 'r_off', 'breakdown', 'holdcurrent']);
  },
  dump: (e) => [
    e.params.r_on ?? 1e3,
    e.params.r_off ?? 1e9,
    e.params.breakdown ?? 1000,
    e.params.holdcurrent ?? 0.001,
  ],
  fields: [
    { name: 'r_on', label: 'On resistance', unit: 'Ω' },
    { name: 'r_off', label: 'Off resistance', unit: 'Ω' },
    { name: 'breakdown', label: 'Breakdown voltage', unit: 'V' },
    { name: 'holdcurrent', label: 'Holding current', unit: 'A' },
  ],
  // The two opposing arrows span the 24-unit body at an 8-unit half width
  // (SparkGapElm.java:85).
  bodyRect: (e) => bodyBox(e, 24, 8),
  draw: drawSparkGap,
};
