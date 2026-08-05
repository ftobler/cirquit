/** Drawing primitives shared by every element renderer. */

import type { CircuitElement, DrawContext, Point, Theme } from '../model/types';

/**
 * Point along `a -> b` at fraction `f`, displaced `g` units perpendicular to
 * the line. Coordinates are rounded, so terminals land exactly on the grid and
 * two elements meeting at a post always agree on the pixel.
 */
export function interp(a: Point, b: Point, f: number, g = 0): Point {
  let px = b.y - a.y;
  let py = a.x - b.x;
  const r = Math.hypot(px, py);
  if (r === 0) return { x: a.x, y: a.y };
  px /= r;
  py /= r;
  return {
    x: Math.round(a.x + f * (b.x - a.x) + g * px),
    y: Math.round(a.y + f * (b.y - a.y) + g * py),
  };
}

/** Both perpendicular displacements at once: `+g` then `-g`. */
export function interp2(a: Point, b: Point, f: number, g: number): [Point, Point] {
  return [interp(a, b, f, g), interp(a, b, f, -g)];
}

export function elementLength(e: CircuitElement): number {
  return Math.hypot(e.x2 - e.x1, e.y2 - e.y1);
}

export function endpoints(e: CircuitElement): [Point, Point] {
  return [
    { x: e.x1, y: e.y1 },
    { x: e.x2, y: e.y2 },
  ];
}

/**
 * Points where the element's body starts and ends, leaving straight lead wires
 * of equal length at each side.
 */
export function calcLeads(e: CircuitElement, bodyLength: number): [Point, Point] {
  const [p1, p2] = endpoints(e);
  const dn = elementLength(e);
  if (dn < bodyLength) return [p1, p2];
  const f = (dn - bodyLength) / (2 * dn);
  return [interp(p1, p2, f), interp(p1, p2, 1 - f)];
}

/** Clamped linear blend between two hex colours. */
function mix(a: string, b: string, t: number): string {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  const k = Math.max(0, Math.min(1, t));
  const c = pa.map((v, i) => Math.round(v + (pb[i] - v) * k));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

/**
 * Colour for a node at `v` volts: negative shades toward red, positive toward
 * green, with the neutral colour at zero.
 */
export function voltageColor(g: DrawContext, v: number): string {
  if (!g.showVoltageColor || !Number.isFinite(v)) return g.theme.wire;
  const range = g.voltageRange || 5;
  const t = Math.max(-1, Math.min(1, v / range));
  return t >= 0
    ? mix(g.theme.neutral, g.theme.positive, t)
    : mix(g.theme.neutral, g.theme.negative, -t);
}

export function strokeStyle(g: DrawContext, color: string, width = 2): void {
  g.ctx.strokeStyle = g.selected ? g.theme.selection : color;
  g.ctx.lineWidth = width;
  g.ctx.lineCap = 'round';
  g.ctx.lineJoin = 'round';
}

export function line(g: DrawContext, a: Point, b: Point, color: string, width = 2): void {
  strokeStyle(g, color, width);
  g.ctx.beginPath();
  g.ctx.moveTo(a.x, a.y);
  g.ctx.lineTo(b.x, b.y);
  g.ctx.stroke();
}

export function polyline(g: DrawContext, pts: Point[], color: string, width = 2): void {
  if (pts.length < 2) return;
  strokeStyle(g, color, width);
  g.ctx.beginPath();
  g.ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) g.ctx.lineTo(pts[i].x, pts[i].y);
  g.ctx.stroke();
}

export function circle(
  g: DrawContext,
  c: Point,
  r: number,
  color: string,
  fill = false,
  width = 2,
): void {
  strokeStyle(g, color, width);
  g.ctx.beginPath();
  g.ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
  if (fill) {
    g.ctx.fillStyle = g.selected ? g.theme.selection : color;
    g.ctx.fill();
  }
  g.ctx.stroke();
}

/** Filled triangle, used for diodes, op-amps and arrowheads. */
export function triangle(g: DrawContext, a: Point, b: Point, c: Point, color: string): void {
  g.ctx.fillStyle = g.selected ? g.theme.selection : color;
  g.ctx.beginPath();
  g.ctx.moveTo(a.x, a.y);
  g.ctx.lineTo(b.x, b.y);
  g.ctx.lineTo(c.x, c.y);
  g.ctx.closePath();
  g.ctx.fill();
}

/** Arrowhead at `tip`, pointing away from `from`. */
export function arrowHead(g: DrawContext, from: Point, tip: Point, size: number, color: string) {
  const [l, r] = interp2(from, tip, 1 - size / Math.max(1, Math.hypot(tip.x - from.x, tip.y - from.y)), size / 2);
  triangle(g, tip, l, r, color);
}

/** Spacing between current-flow dots, in circuit units. */
const DOT_SPACING = 8;

/**
 * Animated dots showing current direction and magnitude along a segment.
 *
 * `dotPhase` accumulates `current * speed` over time, so faster current moves
 * the dots faster and reversing the current reverses them.
 */
export function currentDots(g: DrawContext, a: Point, b: Point, current: number): void {
  if (!g.showCurrent || !Number.isFinite(current) || current === 0) return;
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 1) return;

  // Wrap the phase into one dot interval so the pattern is continuous.
  let offset = g.dotPhase % DOT_SPACING;
  if (offset < 0) offset += DOT_SPACING;

  g.ctx.fillStyle = g.theme.currentDot;
  for (let d = offset; d < len; d += DOT_SPACING) {
    const p = interp(a, b, d / len);
    g.ctx.beginPath();
    g.ctx.arc(p.x, p.y, 1.6, 0, Math.PI * 2);
    g.ctx.fill();
  }
}

/** Draws the lead wires and their current dots for a two-terminal element. */
export function drawLeads(g: DrawContext, e: CircuitElement, lead1: Point, lead2: Point): void {
  const [p1, p2] = endpoints(e);
  line(g, p1, lead1, voltageColor(g, g.voltages[0]));
  line(g, lead2, p2, voltageColor(g, g.voltages[1]));
  currentDots(g, p1, lead1, g.current);
  currentDots(g, lead2, p2, g.current);
}

const PREFIXES = [
  { limit: 1e9, suffix: 'G', scale: 1e9 },
  { limit: 1e6, suffix: 'M', scale: 1e6 },
  { limit: 1e3, suffix: 'k', scale: 1e3 },
  { limit: 1, suffix: '', scale: 1 },
  { limit: 1e-3, suffix: 'm', scale: 1e-3 },
  { limit: 1e-6, suffix: 'µ', scale: 1e-6 },
  { limit: 1e-9, suffix: 'n', scale: 1e-9 },
  { limit: 1e-12, suffix: 'p', scale: 1e-12 },
];

/** Formats a value with an engineering prefix, e.g. `4.7k`, `100µ`. */
export function formatValue(v: number, unit = '', digits = 3): string {
  if (!Number.isFinite(v)) return '--';
  if (v === 0) return `0 ${unit}`.trim();
  const abs = Math.abs(v);
  const p = PREFIXES.find((x) => abs >= x.limit) ?? PREFIXES[PREFIXES.length - 1];
  const scaled = v / p.scale;
  const text = Math.abs(scaled) >= 100 ? scaled.toFixed(0) : scaled.toPrecision(digits);
  // Trim trailing zeroes left by toPrecision, but keep integers intact.
  const trimmed = text.includes('.') ? text.replace(/\.?0+$/, '') : text;
  return `${trimmed}${p.suffix}${unit ? ` ${unit}` : ''}`.trim();
}

/** Value caption drawn alongside an element body. */
export function label(g: DrawContext, e: CircuitElement, text: string, offset = 12): void {
  if (!g.showValues || !text) return;
  const [p1, p2] = endpoints(e);
  const p = interp(p1, p2, 0.5, offset);
  const horizontal = Math.abs(e.x2 - e.x1) >= Math.abs(e.y2 - e.y1);
  g.ctx.fillStyle = g.theme.text;
  g.ctx.font = `${Math.max(9, 11)}px system-ui, sans-serif`;
  g.ctx.textAlign = horizontal ? 'center' : 'left';
  g.ctx.textBaseline = 'middle';
  g.ctx.fillText(text, p.x, p.y);
}

export function makeTheme(dark: boolean): Theme {
  return dark
    ? {
        background: '#0d1117',
        grid: '#1b2230',
        wire: '#c9d1d9',
        text: '#8b949e',
        selection: '#58a6ff',
        highlight: '#f0883e',
        negative: '#ff5555',
        neutral: '#6e7781',
        positive: '#3fb950',
        currentDot: '#ffd866',
        panel: '#161b22',
        border: '#30363d',
      }
    : {
        background: '#ffffff',
        grid: '#eaeef2',
        wire: '#24292f',
        text: '#57606a',
        selection: '#0969da',
        highlight: '#bc4c00',
        negative: '#cf222e',
        neutral: '#8c959f',
        positive: '#1a7f37',
        currentDot: '#9a6700',
        panel: '#f6f8fa',
        border: '#d0d7de',
      };
}
