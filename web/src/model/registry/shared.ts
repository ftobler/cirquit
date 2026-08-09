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
import type { CircuitElement, DrawContext, Point } from '../types';

/** Perpendicular offset of switch throws and transistor collector/emitter. */
export const OPEN_HS = 16;

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
