import {
  canvasFont,
  closedPolyline,
  currentDots,
  dsign,
  elementLength,
  endpoints,
  interp,
  interp2,
  line,
  triangle,
  voltageColor,
} from '../../../render/draw';
import { OPAMP_GAIN, OPAMP_SMALL, OPAMP_SWAP } from '../flags';
import { readParams } from '../shared';
import type { CircuitElement, DrawContext, ElementDef, Point } from '../../types';

function drawOpAmpBody(g: DrawContext, e: CircuitElement): void {
  const [p1, p2] = endpoints(e);
  const [lead1, lead2] = opAmpBodyLeads(e);
  const posts = opAmpPosts(e);
  const hs = opampInputSign(e, p1, p2);

  // Input leads run from the posts to the triangle base, so they never cross a
  // swapped body: the anchors carry the same flag-derived side as the posts.
  line(g, posts[0], interp(lead1, lead2, 0, hs), voltageColor(g, g.voltages[0]));
  line(g, posts[1], interp(lead1, lead2, 0, -hs), voltageColor(g, g.voltages[1]));
  line(g, lead2, p2, voltageColor(g, g.voltages[2]));

  const [t1, t2] = interp2(lead1, lead2, 0, hs * 2);
  triangle(g, t1, t2, lead2, g.theme.panel);
  // The triangle outline is a drawThickPolygon upstream (OpAmpElm.java:101),
  // the 3-unit body weight.
  closedPolyline(g, [t1, t2, lead2, t1], g.theme.wire);

  // The minus glyph sits on the inverting input, the plus on the other. The
  // minus anchor is 2 above its lead, the plus exactly on it (OpAmpElm.java:
  // 103-104).
  const [minus, plus] = opAmpLabelAnchors(e);
  g.ctx.fillStyle = g.theme.text;
  g.ctx.font = canvasFont(opampSize(e) === 2 ? 14 : 10);  // OpAmpElm.java:139
  g.ctx.textAlign = 'center';
  g.ctx.textBaseline = 'middle';
  g.ctx.fillText('−', minus.x, minus.y - 2);
  g.ctx.fillText('+', plus.x, plus.y);
  currentDots(g, lead2, p2, g.current);
}

/** Default op-amp geometry is size 2 (16/26); FLAG_SMALL selects the 8/13
 *  small variant (OpAmpElm.java:113-118). */
function opampSize(e: CircuitElement): number {
  return (e.flags & OPAMP_SMALL) !== 0 ? 1 : 2;
}

function opampHeight(e: CircuitElement): number {
  return 8 * opampSize(e);
}

function opampWidth(e: CircuitElement): number {
  return 13 * opampSize(e);
}

/** The op-amp body's two lead stubs, base and apex of the triangle. */
function opAmpBodyLeads(e: CircuitElement): [Point, Point] {
  const [p1, p2] = endpoints(e);
  const dn = elementLength(e);
  const ww = Math.min(opampWidth(e), dn / 2);
  const f = (dn - ww * 2) / (2 * dn);
  return [interp(p1, p2, f), interp(p1, p2, 1 - f)];
}

/** Signed perpendicular offset of the inverting input: the size-scaled half
 *  separation, oriented by `dsign`, then negated by FLAG_SWAP. Shared by the
 *  posts and the drawing so leads and labels track a swapped body
 *  (OpAmpElm.java:127-129). */
export function opampInputSign(e: CircuitElement, p1: Point, p2: Point): number {
  let hs = opampHeight(e) * dsign(p1, p2);
  if ((e.flags & OPAMP_SWAP) !== 0) hs = -hs;
  return hs;
}

/** Body points where the op-amp's input leads attach, inverting first, ordered
 *  like `opAmpPosts`. */
export function opAmpInputAnchors(e: CircuitElement): [Point, Point] {
  const [p1, p2] = endpoints(e);
  const [lead1, lead2] = opAmpBodyLeads(e);
  const hs = opampInputSign(e, p1, p2);
  return [interp(lead1, lead2, 0, hs), interp(lead1, lead2, 0, -hs)];
}

/** Centres of the minus and plus glyphs, inverting and non-inverting sides,
 *  at fraction 0.2 of the base-to-apex span (OpAmpElm.java:135). */
export function opAmpLabelAnchors(e: CircuitElement): [Point, Point] {
  const [p1, p2] = endpoints(e);
  const [lead1, lead2] = opAmpBodyLeads(e);
  const hs = opampInputSign(e, p1, p2);
  return [interp(lead1, lead2, 0.2, hs), interp(lead1, lead2, 0.2, -hs)];
}

function opAmpPosts(e: CircuitElement): Point[] {
  const [p1, p2] = endpoints(e);
  const [inverting, nonInverting] = interp2(p1, p2, 0, opampInputSign(e, p1, p2));
  return [inverting, nonInverting, p2];
}

export const OPAMP_DEF: ElementDef = {
  kind: 'opamp',
  label: 'Op-amp',
  category: 'Active',
  dumpCode: 'a',
  postCount: 3,
  posts: opAmpPosts,
  canMirror: true,
  noDiagonal: true,  // OpAmpElm.java:34
  defaultFlags: OPAMP_GAIN,  // OpAmpElm.java:38,40
  defaults: { maxOut: 15, minOut: -15, gain: 100000 },
  parse: (t, e) => readParams(t, e, ['maxOut', 'minOut', 'gbw', 'volts0', 'volts1', 'gain']),
  dump: (e) => [
    e.params.maxOut ?? 15,
    e.params.minOut ?? -15,
    e.params.gbw ?? 1e6,
    e.params.volts0 ?? 0,
    e.params.volts1 ?? 0,
    e.params.gain ?? 100000,
  ],
  fields: [
    { name: 'maxOut', label: 'Max output', unit: 'V' },
    { name: 'minOut', label: 'Min output', unit: 'V' },
    { name: 'gain', label: 'Open-loop gain' },
  ],
  draw: drawOpAmpBody,
};
