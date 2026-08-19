/**
 * Helpers shared by several element definitions: the common posts functions,
 * the numeric-token read/write pair, the switch lever tip, the ground symbol
 * bars, the escaped-text writer flag and the source-symbol drawing primitives.
 */

import {
  calcLeads,
  canvasFont,
  circle,
  currentDotsFrom,
  dotPhaseAfter,
  drawLeads,
  endpoints,
  interp,
  interp2,
  powerColor,
  voltageColor,
} from '../../render/draw';
import { FLAG_ESCAPE } from './flags';
import type { Box, CircuitElement, DrawContext, Point, SwitchRect } from '../types';

/** Perpendicular offset of switch throws and transistor collector/emitter. */
export const OPEN_HS = 16;

/** Stroke width of the moving contact (switch lever, SPDT lever, relay
 *  blade): one unit above the 3-unit body weight, so the part that moves
 *  reads as the contact rather than another body line. */
export const CONTACT_STROKE_WIDTH = 4;

/**
 * The integer input count the engine derives from a value: truncated and
 * clamped to the 1..8 range, upstream's `(int) ei.value` guard
 * (VCCSElm.java:202-205, GateElm.java:59). The store's `setParam` and the
 * controlled-source and gate parsers normalise to this, so the frontend post
 * list and the engine's `(x as i64)` build agree and a rebuild never trips the
 * post-count guard (circuit.rs:261-269).
 *
 * The clamp-on-load policy (oversized-gates-load-policy, option 2): clamp, as
 * today, but report the clamp through `warnOnClamp` at the load parsers, so a
 * hand-edited out-of-range token is surfaced as a load warning instead of
 * silently rewritten by the next save. The engine's own clamp makes accepting
 * the raw token impossible without a bigger change, and carrying the original
 * token through the element model would duplicate every field a save rewrites.
 */
export function normalizeInputCount(value: number): number {
  if (!Number.isFinite(value)) return 2;
  const n = Math.trunc(value);
  if (n < 1) return 1;
  if (n > 8) return 8;
  return n;
}

/**
 * Reports a clamp-on-load event when the file's token differs from the value
 * the engine derived. `raw` is the file's value and `clamped` the normalised
 * one; a token the engine truncates in range (2.5 loads as 2) is not a loss
 * and stays silent. `warn` is only handed out by the netlist parser, so the
 * draw and store-edit paths, which normalise too, never report.
 */
export function warnOnClamp(
  warn: ((message: string) => void) | undefined,
  label: string,
  unit: string,
  raw: number,
  clamped: number,
): void {
  if (warn === undefined || !Number.isFinite(raw)) return;
  const n = Math.trunc(raw);
  if (n === clamped) return;
  warn(`${label} with ${n} ${unit} loaded as ${clamped} ${unit}`);
}

/** Body colour for an element: the power colour when that mode is on, else the
 *  midpoint voltage colour. `v` is the element's colouring voltage and `power`
 *  the frame's per-element power, so in power mode bodies heat red as
 *  dissipated power rises and green as the element generates, while leads and
 *  wires keep the plain `voltageColor` (white under power mode). */
export function elementColor(g: DrawContext, v: number, power: number): string {
  return g.showPowerColor ? powerColor(g, power) : voltageColor(g, v);
}

export const twoPosts = (e: CircuitElement): Point[] => [
  { x: e.x1, y: e.y1 },
  { x: e.x2, y: e.y2 },
];

export const onePost = (e: CircuitElement): Point[] => [{ x: e.x1, y: e.y1 }];
/** Bounding box of the given points, upstream's `new Rectangle(p).union(...)`
 *  switch-rect pattern (SwitchElm.java:166-169). */
export function rectOfPoints(pts: Point[]): SwitchRect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Axis-aligned hit-test box enclosing the given points, for a def's `bodyRect`
 *  when the drawn body is a plain shape around the axis (a capacitor's plates,
 *  a lamp's bulb and filament, a source's circle): the whole body is a solid
 *  pick zone, the same `boundingBox.contains` gate the chips use. */
export function boxOfPoints(pts: Point[]): Box {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  if (!Number.isFinite(x0)) return { x0: 0, y0: 0, x1: 0, y1: 0 };
  return { x0, y0, x1, y1 };
}

/** Axis-aligned hit box for a body that spans `bodyLength` between its leads,
 *  grown `hs` perpendicular on each side: the box of the four body corners, the
 *  same solid pick zone the capacitor's plates use. Covers the drawn body, not
 *  the bare leads out to the posts, which the axis and post regions already
 *  reach. `hs` is the widest perpendicular extent of the symbol (a diode's
 *  triangle base, an LDR's light arrows), so the whole drawn mark is grabbable. */
export function bodyBox(e: CircuitElement, bodyLength: number, hs: number): Box {
  const [lead1, lead2] = calcLeads(e, bodyLength);
  const [a1, a2] = interp2(lead1, lead2, 0, hs);
  const [b1, b2] = interp2(lead1, lead2, 1, hs);
  return boxOfPoints([a1, a2, b1, b2]);
}

/** Axis-aligned hit box of the whole stored span between the two endpoints,
 *  grown `hs` perpendicular on each side: the four-corner box of `e.x1,y1` to
 *  `e.x2,y2`. The solid pick zone for a body that spans the whole element, not
 *  just a calcLeads-length window, upstream's `setBbox(point1, point2, hs)`
 *  for the transistor, mosfet and their kin, whose bodies run from one post to
 *  the other. */
export function postsBox(e: CircuitElement, hs: number): Box {
  const [a1, a2] = interp2({ x: e.x1, y: e.y1 }, { x: e.x2, y: e.y2 }, 0, hs);
  const [b1, b2] = interp2({ x: e.x1, y: e.y1 }, { x: e.x2, y: e.y2 }, 1, hs);
  return boxOfPoints([a1, a2, b1, b2]);
}

/** Axis-aligned hit box around the free-end control point `(x2, y2)`, `hs` to
 *  every side: the pick zone for a one-post stem part whose symbol (a circle,
 *  a label, a glyph) hangs off the far end, upstream's small symbol box. The
 *  axis band already reaches along the stem, so this only widens the grab
 *  around the drawn mark that sits at or past `point2`. */
export function endpointBox(e: CircuitElement, hs: number): Box {
  return {
    x0: e.x2 - hs,
    y0: e.y2 - hs,
    x1: e.x2 + hs,
    y1: e.y2 + hs,
  };
}

/** True when `p` lies on or inside the rect, with the edges inclusive. */
export function rectContains(r: SwitchRect, p: Point): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

/** Reads numeric tokens into named params, skipping absent ones. */
export function readParams(tokens: string[], e: CircuitElement, names: string[]): void {
  names.forEach((name, i) => {
    const v = Number(tokens[i]);
    if (tokens[i] !== undefined && Number.isFinite(v)) e.params[name] = v;
  });
}

export const writeParams =
  (names: string[]) =>
  (e: CircuitElement): (string | number)[] =>
    names.map((n) => e.params[n] ?? 0);

/** Text and labeled nodes always save the new-style single escaped token. */
export function escapeFlags(e: CircuitElement): number {
  return e.flags | FLAG_ESCAPE;  // TextElm.java:83, LabeledNodeElm.java:52
}

/**
 * Label text drawn past a stem's free end, the port of `drawLabeledNode`
 * (CircuitElm.java:945-973): a horizontal stem puts the text right of the end
 * (left when the stem runs right-to-left), a vertical one centers it past the
 * end, `h` units along the stem's direction (down when it runs downward).
 * `color` is the caller's text colour (whiteColor, or selection when the part
 * is highlighted); the font is the caller's, which the width measurement uses.
 */
export function labeledNodeText(
  g: DrawContext,
  text: string,
  pt1: Point,
  pt2: Point,
  color: string,
): void {
  const w = g.ctx.measureText(text).width;
  const h = g.valueFontSize;
  g.ctx.fillStyle = color;
  g.ctx.textBaseline = 'middle';
  let x = pt2.x;
  let y = pt2.y;
  if (pt1.y !== pt2.y) {
    x -= w / 2;
    y += Math.sign(pt2.y - pt1.y) * h;
  } else if (pt2.x > pt1.x) {
    x += 4;
  } else {
    x -= 4 + w;
  }
  g.ctx.textAlign = 'left';
  g.ctx.fillText(text, x, y);
}

/**
 * The switch lever as a segment. Upstream draws it from `interpPoint(lead1,
 * lead2, 0, hs1)` to `interpPoint(lead1, lead2, 1, hs2)`, where open means
 * `hs1 = 0, hs2 = openhs` and closed means both `hs = 2` (SwitchElm.java:
 * 118-132). So the closed lever does not lie on the axis: it rides 2 units on
 * the lift side, and only the open tip leaves the axis. Positive perpendicular
 * is up on screen (canvas y grows downward), matching upstream and the SPDT
 * throw offsets.
 */
export function switchLever(lead1: Point, lead2: Point, closed: boolean): [Point, Point] {
  const hs1 = closed ? 2 : 0;
  const hs2 = closed ? 2 : OPEN_HS;
  return [interp(lead1, lead2, 0, hs1), interp(lead1, lead2, 1, hs2)];
}

/** Free end of a switch lever: at the contact when closed, lifted when open. */
export function switchLeverTip(lead1: Point, lead2: Point, closed: boolean): Point {
  return switchLever(lead1, lead2, closed)[1];
}

/**
 * The IEC armature drawn on top of the lever when FLAG_IEC is set
 * (SwitchElm.java:103-112, :146-161): a top bar, a dashed toggle link and the
 * X of the non-momentary mark. `x0` is the one point the draw recomputes, to
 * the open half-lift when open and to the closed 2-unit offset when closed.
 */
export function switchIecPoints(lead1: Point, lead2: Point, closed: boolean): Point[] {
  return [
    interp(lead1, lead2, 0.5, closed ? 2 : OPEN_HS / 2),
    interp(lead1, lead2, 0.5, 24),
    interp(lead1, lead2, 0.4, 24),
    interp(lead1, lead2, 0.6, 24),
    interp(lead1, lead2, 0.5, 19),
    interp(lead1, lead2, 0.4, 16),
    interp(lead1, lead2, 0.5, 13),
  ];
}

/**
 * Bars of the ground symbol hanging off the free end of its stem.
 *
 * Upstream GroundElm.java draws the stem across the whole dragged span and
 * hangs the symbol off `point2`, the end opposite the post (GroundElm.java:65).
 * The earth symbol is three shrinking bars past that end; chassis, signal and
 * common all share one base bar there, and chassis adds diagonal stubs and
 * signal a V on top. Each bar comes back as its two endpoints, in draw order.
 */
export function groundBars(p1: Point, p2: Point, symbolType: number): [Point, Point][] {
  const dn = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  const pastEnd = (d: number): Point =>
    dn === 0
      ? p2
      : { x: p2.x + (d * (p2.x - p1.x)) / dn, y: p2.y + (d * (p2.y - p1.y)) / dn };
  if (symbolType === 0) {
    // Three bars at fractions 1 + b/dn past the far end, with half-widths
    // 10, 6, 2 (GroundElm.java:68-73).
    const bars: [Point, Point][] = [];
    for (let i = 0; i < 3; i++) bars.push(interp2(p1, p2, 1 + (i * 5) / dn, 10 - i * 4));
    return bars;
  }
  const [s1, s2] = interp2(p1, p2, 1, 10);
  if (symbolType === 1) {
    // Three diagonal stubs down the base bar (GroundElm.java:77-81), each
    // starting a third of the way across and running 8 along the stem and 5
    // back across the perpendicular.
    const bars: [Point, Point][] = [[s1, s2]];
    for (let i = 0; i <= 2; i++) {
      const p = interp(s1, s2, i / 2);
      const ux = dn === 0 ? 0 : (p2.x - p1.x) / dn;
      const uy = dn === 0 ? 0 : (p2.y - p1.y) / dn;
      const px = dn === 0 ? 0 : (p2.y - p1.y) / dn;
      const py = dn === 0 ? 0 : (p1.x - p2.x) / dn;
      bars.push([p, { x: p.x + 8 * ux - 5 * px, y: p.y + 8 * uy - 5 * py }]);
    }
    return bars;
  }
  if (symbolType === 2) {
    // Signal: a V from the bar ends to a point 10 past the far end.
    return [[s1, s2], [s1, pastEnd(10)], [s2, pastEnd(10)]];
  }
  return [[s1, s2]];  // common is just the base bar
}

function drawSourceCircle(g: DrawContext, e: CircuitElement, radius: number): [Point, Point] {
  const [lead1, lead2] = calcLeads(e, radius * 2);
  drawLeads(g, e, lead1, lead2);
  const mid = interp(lead1, lead2, 0.5);
  circle(g, mid, radius, elementColor(g, (g.voltages[0] + g.voltages[1]) / 2, g.power));
  // The source circle opens a gap in the current path like the capacitor's
  // plates, so the dots run each lead separately with the second starting at
  // the phase the first would have reached at the gap.
  const [p1, p2] = endpoints(e);
  const leadLen = Math.hypot(lead1.x - p1.x, lead1.y - p1.y);
  currentDotsFrom(g, p1, lead1, g.current, g.dotPhase);
  currentDotsFrom(g, lead2, p2, g.current, dotPhaseAfter(g.dotPhase, leadLen));
  return [lead1, lead2];
}

/** Waveform glyph inside a source symbol. */
function drawWaveformGlyph(g: DrawContext, centre: Point, waveform: number, r: number): void {
  const color = g.theme.text;
  if (waveform === 0) {
    // DC: a plus toward the positive terminal and a minus toward the other.
    g.ctx.fillStyle = color;
    g.ctx.font = canvasFont(11);
    g.ctx.textAlign = 'center';
    g.ctx.textBaseline = 'middle';
    g.ctx.fillText('+', centre.x, centre.y - r * 0.45);
    g.ctx.fillText('−', centre.x, centre.y + r * 0.45);
    return;
  }
  const pts: Point[] = [];
  const n = 24;
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const x = centre.x - r * 0.6 + f * r * 1.2;
    let s: number;
    switch (waveform) {
      case 2: // square
        s = f < 0.5 ? 1 : -1;
        break;
      case 3: // triangle
        s = f < 0.5 ? -1 + 4 * f : 3 - 4 * f;
        break;
      case 4: // sawtooth
        s = 2 * f - 1;
        break;
      case 5: // pulse
        s = f < 0.5 ? 1 : 0;
        break;
      default: // sine
        s = Math.sin(f * Math.PI * 2);
    }
    pts.push({ x, y: centre.y - s * r * 0.4 });
  }
  g.ctx.strokeStyle = color;
  // The waveform glyph is drawn at lineWidth 3 upstream (VoltageElm.java:
  // 392), the same body weight as the source circle that frames it.
  g.ctx.lineWidth = 3;
  g.ctx.beginPath();
  pts.forEach((p, i) => (i === 0 ? g.ctx.moveTo(p.x, p.y) : g.ctx.lineTo(p.x, p.y)));
  g.ctx.stroke();
}

export { drawSourceCircle, drawWaveformGlyph };
