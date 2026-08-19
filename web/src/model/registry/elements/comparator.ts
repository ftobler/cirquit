/**
 * Comparator (ComparatorElm.java, dump 401): a CompositeElm whose output is
 * open-drain style, an internal op-amp driving an analog switch that pulls the
 * output to ground. Drawn like a small op-amp with a "≥?" at the output.
 *
 * Token layout after the common fields is one `_`-joined dump token per
 * composite child, exactly the OTA's shape (CompositeElm.dump): the internal
 * op-amp, the analog switch and the ground child, opaque to the frontend and
 * carried raw on both sides. The flags bits are the comparator's own:
 * FLAG_SMALL (2) picks the half-size body, FLAG_SWAP (4) swaps which input
 * sits on the non-inverting side (ComparatorElm.java:10-11).
 */

import {
  canvasFont,
  closedPolyline,
  currentDots,
  dsign,
  elementLength,
  endpoints,
  interp,
  interp2,
  isHighlighted,
  lead,
  triangle,
  voltageColor,
} from '../../../render/draw';
import { COMPARATOR_SMALL, COMPARATOR_SWAP } from '../flags';
import { boxOfPoints } from '../shared';
import type { CircuitElement, DrawContext, ElementDef, Point } from '../../types';

/** Symbol geometry constants, the size-scaled op-amp pair (ComparatorElm.java:
 *  34-39). */
function opSize(e: CircuitElement): number {
  return (e.flags & COMPARATOR_SMALL) !== 0 ? 1 : 2;
}

function opHeight(e: CircuitElement): number {
  return 8 * opSize(e);
}

function opWidth(e: CircuitElement): number {
  return 13 * opSize(e);
}

function opBodyLeads(e: CircuitElement): [Point, Point] {
  const [p1, p2] = endpoints(e);
  const dn = elementLength(e);
  const ww = Math.min(opWidth(e), dn / 2);
  const f = (dn - ww * 2) / (2 * dn);
  return [interp(p1, p2, f), interp(p1, p2, 1 - f)];
}

/** The comparator's input side: `opheight*dsign`, negated by FLAG_SWAP
 *  (ComparatorElm.java:77-79). */
function inputSide(e: CircuitElement): number {
  const [p1, p2] = endpoints(e);
  let hs = opHeight(e) * dsign(p1, p2);
  if ((e.flags & COMPARATOR_SWAP) !== 0) hs = -hs;
  return hs;
}

function comparatorPosts(e: CircuitElement): Point[] {
  const p1 = endpoints(e)[0];
  const p2 = endpoints(e)[1];
  const hs = inputSide(e);
  // Posts are V- on the minus side, V+ on the plus side, then the output
  // (ComparatorElm.java:86-88).
  return [interp(p1, p2, 0, hs), interp(p1, p2, 0, -hs), p2];
}

function drawComparator(g: DrawContext, e: CircuitElement): void {
  const p2 = endpoints(e)[1];
  const [lead1, lead2] = opBodyLeads(e);
  const posts = comparatorPosts(e);
  const hs = inputSide(e);

  // The two input leads to the triangle base and the output lead.
  lead(g, posts[0], interp(lead1, lead2, 0, hs), voltageColor(g, g.voltages[0]));
  lead(g, posts[1], interp(lead1, lead2, 0, -hs), voltageColor(g, g.voltages[1]));
  lead(g, lead2, p2, voltageColor(g, g.voltages[2]));

  // The triangle, a stroked outline exactly like the op-amp's
  // (ComparatorElm.java:51, 83-85).
  const [t1, t2] = interp2(lead1, lead2, 0, hs * 2);
  if (!isHighlighted(g)) triangle(g, t1, t2, lead2, g.theme.panel);
  closedPolyline(g, [t1, t2, lead2, t1], g.theme.wire);

  // The minus on the inverting side two pixels up, the plus on the other, and
  // the "≥?" comparator glyph at the body's midpoint (ComparatorElm.java:
  // 52-55, 80-81). `hs` already carries the FLAG_SWAP negation (inputSide
  // above), so the glyphs track the swapped input side without a second sign
  // flip (ComparatorElm.java:77-80, `interpPoint2(..., hs*sgn)` with
  // sgn = the swap).
  const [minus, plus] = interp2(lead1, lead2, 0.2, hs);
  g.ctx.fillStyle = g.theme.text;
  g.ctx.font = canvasFont(opSize(e) === 2 ? 14 : 10);  // plusFont, :85
  g.ctx.textAlign = 'center';
  g.ctx.textBaseline = 'middle';
  g.ctx.fillText('−', minus.x, minus.y - 2);
  g.ctx.fillText('+', plus.x, plus.y);
  g.ctx.font = canvasFont(opSize(e) === 2 ? 14 : 10);
  const centre = interp(lead1, lead2, 0.5, 0);
  g.ctx.fillText('≥?', centre.x, centre.y);

  currentDots(g, p2, lead2, -g.current);
}

export const COMPARATOR_DEF: ElementDef = {
  kind: 'comparator',
  label: 'Comparator',
  category: 'Active',
  dumpCode: '401',
  postCount: 3,
  posts: comparatorPosts,
  canMirror: true,  // ComparatorElm.java:97-112
  noDiagonal: true,  // ComparatorElm.java:19
  // The line is `... flags <child dump token>...`, one `_`-joined token per
  // composite child (the op-amp, the analog switch, the ground), carried raw
  // like the OTA's.
  rawTokens: true,
  parse: (t, e) => {
    e.model = t;
  },
  dump: (e) => (Array.isArray(e.model) ? e.model : []),
  // The triangle body is a solid pick zone: the base at lead1 grown hs*2, the
  // apex at lead2, the same box upstream's setBbox(opheight*2) wraps
  // (ComparatorElm.java:44).
  bodyRect: (e) => {
    const [lead1, lead2] = opBodyLeads(e);
    const hs = inputSide(e);
    const [t1, t2] = interp2(lead1, lead2, 0, hs * 2);
    return boxOfPoints([t1, t2, lead2]);
  },
  draw: drawComparator,
};
