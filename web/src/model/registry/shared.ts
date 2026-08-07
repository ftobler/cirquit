/**
 * Helpers shared by several element definitions: the common posts functions,
 * the numeric-token read/write pair, the open-switch lever tip, the escaped-text
 * writer flag and the source-symbol drawing primitives.
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
  voltageColor,
} from '../../render/draw';
import { FLAG_ESCAPE } from './flags';
import type { CircuitElement, DrawContext, Point } from '../types';

/** Perpendicular offset of switch throws and transistor collector/emitter. */
export const OPEN_HS = 16;

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
 * Free end of a switch lever: at the contact when closed, lifted when open.
 *
 * The lever pivots at lead1; open, it lifts away from the contact. Positive
 * perpendicular is up on screen (canvas y grows downward), matching upstream
 * and the SPDT throw offsets.
 */
export function switchLeverTip(lead1: Point, lead2: Point, closed: boolean): Point {
  return closed ? lead2 : interp(lead1, lead2, 1, OPEN_HS);
}

function drawSourceCircle(g: DrawContext, e: CircuitElement, radius: number): [Point, Point] {
  const [lead1, lead2] = calcLeads(e, radius * 2);
  drawLeads(g, e, lead1, lead2);
  const mid = interp(lead1, lead2, 0.5);
  circle(g, mid, radius, voltageColor(g, (g.voltages[0] + g.voltages[1]) / 2));
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
  g.ctx.lineWidth = 1.2;
  g.ctx.beginPath();
  pts.forEach((p, i) => (i === 0 ? g.ctx.moveTo(p.x, p.y) : g.ctx.lineTo(p.x, p.y)));
  g.ctx.stroke();
}

export { drawSourceCircle, drawWaveformGlyph };
