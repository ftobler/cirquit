import {
  calcLeads,
  currentDotsPath,
  drawLeads,
  endpoints,
  interp,
  interp2,
  line,
  polygon,
} from '../../../render/draw';
import { elementColor, readParams, twoPosts } from '../shared';
import type { CircuitElement, DrawContext, ElementDef } from '../../types';

/**
 * The diac symbol (DiacElm.java:78-117): a plate at each lead end, then two
 * opposing filled arrows between them. The upper arrow points at the
 * cathode-side plate and is coloured with post 0, the lower arrow points the
 * other way and is coloured with post 1, matching upstream's two
 * `fillPolygon` colour choices (DiacElm.java:106-113).
 */
function drawDiac(g: DrawContext, e: CircuitElement): void {
  const [lead1, lead2] = calcLeads(e, 16);
  drawLeads(g, e, lead1, lead2);
  const color0 = elementColor(g, g.voltages[0], g.power);
  const color1 = elementColor(g, g.voltages[1], g.power);
  const [p1a, p1b] = interp2(lead1, lead2, 0, 16);
  const [p2a, p2b] = interp2(lead1, lead2, 1, 16);
  line(g, p1a, p1b, color0, 2.5);
  line(g, p2a, p2b, color1, 2.5);
  polygon(
    g,
    [interp(lead1, lead2, 1, 8), interp(lead1, lead2, 0, 16), interp(lead1, lead2, 0, 0)],
    color0,
  );
  polygon(
    g,
    [interp(lead1, lead2, 0, -8), interp(lead1, lead2, 1, -16), interp(lead1, lead2, 1, 0)],
    color1,
  );
  const [p1, p2] = endpoints(e);
  currentDotsPath(g, [p1, lead1, lead2, p2], g.current);
}

export const DIAC_DEF: ElementDef = {
  kind: 'diac',
  label: 'DIAC',
  category: 'Semiconductors',
  dumpCode: '203',
  postCount: 2,
  posts: twoPosts,
  // Defaults from the constructors (DiacElm.java:33-40). Upstream's text
  // constructor reads all four tokens unconditionally; a bare line, which the
  // corpus never carries, falls back to these.
  defaults: { r_on: 500, r_off: 1e8, breakdown: 30, holdcurrent: 0.01 },
  // Token order from the token constructor (DiacElm.java:45-48).
  parse: (t, e) => {
    readParams(t, e, ['r_on', 'r_off', 'breakdown', 'holdcurrent']);
  },
  dump: (e) => [
    e.params.r_on ?? 500,
    e.params.r_off ?? 1e8,
    e.params.breakdown ?? 30,
    e.params.holdcurrent ?? 0.01,
  ],
  fields: [
    { name: 'r_on', label: 'On resistance', unit: 'Ω' },
    { name: 'r_off', label: 'Off resistance', unit: 'Ω' },
    { name: 'breakdown', label: 'Breakdown voltage', unit: 'V' },
    { name: 'holdcurrent', label: 'Holding current', unit: 'A' },
  ],
  draw: drawDiac,
};
