/**
 * Unijunction transistor (UnijunctionElm, dump 417): a three-terminal device
 * whose emitter E fires a relaxation oscillator built from the base-one/base-two
 * bar. Upstream models it as a composite; the engine holds the electrical
 * model, this file owns the geometry ported from `UnijunctionElm.setPoints`
 * (UnijunctionElm.java:99-123). The line is bare: no tokens follow the common
 * fields, because the composite dumps with the model masked out
 * (UnijunctionElm.java:49-52).
 */

import {
  arrowHead,
  currentDots,
  dsign,
  elementLength,
  endpoints,
  interp,
  interp2,
  lead,
  polygon,
  powerColor,
  voltageColor,
} from '../../../render/draw';
import type { CircuitElement, DrawContext, ElementDef, Point } from '../../types';
import { boxOfPoints } from '../shared';

/** FLAG_FLIP, the geometry's flip bit (UnijunctionElm.java:27). */
export const UJT_FLIP = 2;

const UJT_HS = 16;  // `hs` in setPoints

interface UjtGeometry {
  b1: Point[];
  b2: Point[];
  emitter: Point[];
  /** The emitter's filled base region corners, `ra` in setPoints. */
  ra: Point[];
}

/** Port of `setPoints` (UnijunctionElm.java:99-123): the b1/b2 rails run
 *  along the bottom edge at half spacing and the emitter lead and its filled
 *  base wedge hang off the top edge. Posts 0=E, 1=B1, 2=B2 come straight out
 *  of this table (UnijunctionElm.java:126-128). */
function ujtGeometry(e: CircuitElement): UjtGeometry {
  const [p1, p2] = endpoints(e);
  const d = dsign(p1, p2);
  const flip = (e.flags & UJT_FLIP) !== 0 ? -1 : 1;
  const hs2 = UJT_HS * d * flip;
  const dn = Math.max(1, elementLength(e));
  // The two rails start on the same edge of the axis; each `interpPoint2`
  // pair places B1 above and B2 below the rail line.
  const pA = interp(p1, p2, 0, -hs2);
  const pB = interp(p1, p2, 1, -hs2);
  const [b1a, b2a] = interp2(pA, pB, 1, -hs2);
  const [b1b, b2b] = interp2(pA, pB, 1, -hs2 / 2);
  const [b1c, b2c] = interp2(pA, pB, 1 - 10 / dn, -hs2 / 2);
  const emitter = [
    interp(pA, pB, 0, hs2),
    interp(pA, pB, 1 - 28 / dn, hs2),
    interp(pA, pB, 1 - 14 / dn),
  ];
  const [ra0, ra1] = interp2(pA, pB, 1 - 13 / dn, UJT_HS);
  const [ra2, ra3] = interp2(pA, pB, 1 - 10 / dn, UJT_HS);
  return { b1: [b1a, b1b, b1c], b2: [b2a, b2b, b2c], emitter, ra: [ra0, ra1, ra2, ra3] };
}

/** Terminal coordinates in post order: E, B1, B2 (UnijunctionElm.java:126-128). */
function ujtPosts(e: CircuitElement): Point[] {
  const geo = ujtGeometry(e);
  return [geo.emitter[0], geo.b1[0], geo.b2[0]];
}

function drawUjt(g: DrawContext, e: CircuitElement): void {
  const { b1, b2, emitter, ra } = ujtGeometry(e);
  const c1 = voltageColor(g, g.voltages[1]);
  const c2 = voltageColor(g, g.voltages[2]);
  const c0 = voltageColor(g, g.voltages[0]);
  // The base-one and base-two rails, then the emitter lead over them
  // (UnijunctionElm.java:72-79).
  lead(g, b1[0], b1[1], c1);
  lead(g, b1[1], b1[2], c1);
  lead(g, b2[0], b2[1], c2);
  lead(g, b2[1], b2[2], c2);
  lead(g, emitter[0], emitter[1], c0);
  lead(g, emitter[1], emitter[2], c0);
  arrowHead(g, emitter[1], emitter[2], 8, c0);
  // The filled emitter wedge and the power-coloured base region, the two
  // fillPolygon calls in draw (UnijunctionElm.java:80-82).
  polygon(g, [ra[0], ra[1], ra[3], ra[2]], powerColor(g, g.power));
  currentDots(g, emitter[0], emitter[1], g.current);
}

export const UNIJUNCTION_DEF: ElementDef = {
  kind: 'unijunction',
  label: 'Unijunction transistor',
  category: 'Semiconductors',
  dumpCode: '417',
  postCount: 3,
  posts: ujtPosts,
  canMirror: true, // UnijunctionElm.flipX/flipY toggle FLAG_FLIP
  noDiagonal: true, // UnijunctionElm.java:42
  defaultLength: 4, // the base getDragLength() of 64
  // The whole symbol, the b1/b2 rails, the emitter lead and its filled base
  // wedge, is a solid pick zone.
  bodyRect: (e) => {
    const { b1, b2, emitter, ra } = ujtGeometry(e);
    return boxOfPoints([...b1, ...b2, ...emitter, ...ra]);
  },
  draw: drawUjt,
};
