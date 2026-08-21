/** Drawing primitives shared by every element renderer. */

import type { CircuitElement, DrawContext, Point, Theme, ThemeColors } from '../model/types';
import { DOT_SPACING, dotPhaseAfter, MIN_CURRENT_FLOW, TOO_FAST } from './dots';

export { dotPhaseAfter };

/**
 * Canvas text stack. A 2D context inherits nothing from CSS, so the family has
 * to be repeated here; keep it in step with the body rule in styles.css.
 */
export const CANVAS_FONT_FAMILY = "'Roboto Variable', Roboto, system-ui, sans-serif";

/** Builds a canvas `font` string at a given pixel size. */
export function canvasFont(px: number): string {
  return `${px}px ${CANVAS_FONT_FAMILY}`;
}

/**
 * Upstream's `dsign` (CircuitElm.java:335): sign of the axis direction, +1 for
 * a part drawn right or down, -1 for left or up. The hanging posts of an
 * op-amp or transistor sit on the side this picks, which is what keeps their
 * terminal coordinates identical to the original in every orientation.
 */
export function dsign(a: Point, b: Point): number {
  return b.y === a.y ? Math.sign(b.x - a.x) : Math.sign(b.y - a.y);
}

/**
 * Point along `a -> b` at fraction `f`, displaced `g` units perpendicular to
 * the line. Coordinates are rounded, so terminals land exactly on the grid and
 * two elements meeting at a post always agree on the pixel.
 *
 * The `+ .48` is upstream's half-point floor (CircuitElm.java:404-405,
 * :420-421), not a rounding bug: a raw coordinate of exactly x.5 lands on x,
 * the integer below, where `Math.round` would nudge it to x+1 and move the
 * post off the grid orientation the original tooling snapped to.
 *
 * THE ROUNDING RULE: `interp` rounds, and is for points that must land on the
 * grid: posts, lead ends, anything another element's geometry has to agree
 * with. Body geometry (plates, bars, arrowheads, glyph positions) uses
 * `interpPrecise` and `interp2Precise`, so a diagonal element's symbol keeps
 * its exact shape at any angle.
 */
export function interp(a: Point, b: Point, f: number, g = 0): Point {
  let px = b.y - a.y;
  let py = a.x - b.x;
  const r = Math.hypot(px, py);
  if (r === 0) return { x: a.x, y: a.y };
  px /= r;
  py /= r;
  return {
    x: Math.floor(a.x + f * (b.x - a.x) + g * px + 0.48),
    y: Math.floor(a.y + f * (b.y - a.y) + g * py + 0.48),
  };
}

/**
 * Point along `a -> b` at fraction `f`, displaced `g` units perpendicular to
 * the line, at exact float coordinates. `interp` rounds so terminals land on
 * grid pixels; animated dots must not round, or they bounce between pixel
 * rows and wiggle on diagonal segments.
 */
export function interpPrecise(a: Point, b: Point, f: number, g = 0): Point {
  let px = b.y - a.y;
  let py = a.x - b.x;
  const r = Math.hypot(px, py);
  if (r === 0) return { x: a.x, y: a.y };
  px /= r;
  py /= r;
  return {
    x: a.x + f * (b.x - a.x) + g * px,
    y: a.y + f * (b.y - a.y) + g * py,
  };
}

/** Both perpendicular displacements at once: `+g` then `-g`. */
export function interp2(a: Point, b: Point, f: number, g: number): [Point, Point] {
  return [interp(a, b, f, g), interp(a, b, f, -g)];
}

/**
 * Both perpendicular displacements at once, at exact float coordinates, for
 * body geometry that must stay perpendicular to the axis on a diagonal.
 */
export function interp2Precise(a: Point, b: Point, f: number, g: number): [Point, Point] {
  return [interpPrecise(a, b, f, g), interpPrecise(a, b, f, -g)];
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

/** Maps a filament temperature in kelvin to its incandescent colour, the four
 *  bands of LampElm.getTempColor (LampElm.java:101-121): black below 800 K,
 *  then red, orange, yellow, white above 2400 K. The breakpoints and the
 *  integer truncation are upstream's exactly, so the bulb matches the original
 *  at every temperature. */
export function tempColor(temp: number): string {
  const clamp0 = (x: number) => Math.max(0, Math.trunc(x));
  if (temp < 1200) {
    const x = clamp0((255 * (temp - 800)) / 400);
    return `rgb(${x},0,0)`;
  }
  if (temp < 1700) {
    const x = clamp0((255 * (temp - 1200)) / 500);
    return `rgb(255,${x},0)`;
  }
  if (temp < 2400) {
    const x = clamp0((255 * (temp - 1700)) / 700);
    return `rgb(255,255,${x})`;
  }
  return 'rgb(255,255,255)';
}

/** Parses the hex or `rgb(r,g,b)` colours the theme and `mix` produce into
 *  their channels, for a blend that needs the numbers rather than the string.
 *  Exported for the scope's X-Y trail fade, which repaints the theme
 *  background at a fractional alpha. */
export function parseRgb(color: string): [number, number, number] {
  const hex = /^#([0-9a-f]{6})$/i.exec(color);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const rgb = /^rgb\((\d+),(\d+),(\d+)\)$/.exec(color);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  return [255, 255, 255];
}

/** Colour of the melting fuse filament at melt fraction `heat / i2t`, the
 *  ramp of FuseElm.getTempColor (FuseElm.java:82-105): below a third of the
 *  rating it blends from the filament's voltage colour toward red, then red,
 *  yellow and white as the pop approaches. Pure in the voltage colour string,
 *  so the draw and a unit test share one implementation.
 */
export function fuseColor(voltage: string, fraction: number): string {
  const c = parseRgb(voltage);
  if (fraction < 0.3333) {
    const x = Math.max(0, Math.trunc(255 * fraction * 3));
    return `rgb(${x + Math.trunc(((255 - x) * c[0]) / 255)},${Math.trunc(
      ((255 - x) * c[1]) / 255,
    )},${Math.trunc(((255 - x) * c[2]) / 255)})`;
  }
  if (fraction < 0.6667) {
    const x = Math.max(0, Math.trunc((fraction - 0.3333) * 3 * 255));
    return `rgb(255,${x},0)`;
  }
  if (fraction < 1) {
    const x = Math.max(0, Math.trunc((fraction - 0.6666) * 3 * 255));
    return `rgb(255,255,${x})`;
  }
  return 'rgb(255,255,255)';
}

/** Power brightness multiplier from the file-format powerRange token, the
 *  same `exp(powerBar/4.762 - 7)` upstream recomputes every frame
 *  (UIManager.java:630). */
export function powerMult(powerRange: number): number {
  return Math.exp(powerRange / 4.762 - 7);
}

/**
 * Ramp position for a power value: -1 at the negative/red end (large
 * dissipated power), +1 at the positive/green end (large generated power),
 * 0 at neutral. Mirrors upstream's `i = 100 - 100*w0*powerMult` index
 * (CircuitElm.setPowerColor, CircuitElm.java:1252-1253).
 */
export function powerColorT(power: number, powerRange: number): number {
  if (!Number.isFinite(power)) return 0;
  const t = -power * powerMult(powerRange);
  return Math.max(-1, Math.min(1, t));
}

/** Body colour for an element dissipating `power` watts: red as dissipated
 *  power rises, green as the element generates, on the same ramp the voltage
 *  colours use (CircuitElm.java:1244-1258). */
export function powerColor(g: DrawContext, power: number): string {
  if (!g.showPowerColor || !Number.isFinite(power)) return g.theme.wire;
  const t = powerColorT(power, g.powerRange);
  return t >= 0
    ? mix(g.theme.neutral, g.theme.positive, t)
    : mix(g.theme.neutral, g.theme.negative, -t);
}

/** Colour for an element's stroke and fill: selection outranks hover, hover
 *  outranks the element's own colour. Hover and the shift-highlighted net
 *  share `theme.highlight`, exactly as upstream's needsHighlight covers the
 *  hovered element, the selection and the highlighted net from one flag pair
 *  (CircuitElm.java:1305-1313). Upstream paints all three in the single
 *  selectColor, so the port keeps hover and selection in one blue family
 *  rather than separate hues; the highlighted net follows hover. */
export function limbColor(g: DrawContext, color: string): string {
  if (g.selected) return g.theme.selection;
  if (g.hovered || g.onHighlightedNet) return g.theme.highlight;
  return color;
}

/** True when `limbColor` would repaint the element: selection, hover or the
 *  shift-highlighted net. Filled bodies gate their fill on this, so a
 *  highlighted part reads as its outline rather than a solid block of the
 *  selection or highlight colour. */
export function isHighlighted(g: DrawContext): boolean {
  return g.selected || g.hovered || g.onHighlightedNet;
}

export function strokeStyle(
  g: DrawContext,
  color: string,
  width = 3,
  cap: CanvasLineCap = 'butt',
  join: CanvasLineJoin = 'miter',
): void {
  g.ctx.strokeStyle = limbColor(g, color);
  g.ctx.lineWidth = width;
  // Butt is the ambient cap, miter the ambient join: the crisp-line decision
  // that symbol ends stay flush and polygon corners keep their sharp points.
  // Wires and terminal leads opt into round through the cap argument, so a
  // routed corner, a diagonal wire end or a lead end reads as a continuous
  // conductor (upstream's ambient round cap, UIManager.java:636). Miter is
  // upstream's join too: it never
  // sets lineJoin, so the canvas default is what the original renders. That
  // default is right for polygons, whose corners miter into crisp points. The
  // coil does not come through here: it strokes each loop as its own arc via
  // `gradientCoil`, which picks its own join. The width
  // default of 3 is upstream's `drawThickLine` (CircuitElm.java:1007-1021);
  // fine detail sites that upstream strokes with a plain `g.drawLine` pass 1
  // explicitly.
  g.ctx.lineCap = cap;
  g.ctx.lineJoin = join;
}

export function line(
  g: DrawContext,
  a: Point,
  b: Point,
  color: string,
  width = 3,
  cap: CanvasLineCap = 'butt',
  join: CanvasLineJoin = 'miter',
): void {
  strokeStyle(g, color, width, cap, join);
  g.ctx.beginPath();
  g.ctx.moveTo(a.x, a.y);
  g.ctx.lineTo(b.x, b.y);
  g.ctx.stroke();
}

export function polyline(
  g: DrawContext,
  pts: Point[],
  color: string,
  width = 3,
  cap: CanvasLineCap = 'butt',
  join: CanvasLineJoin = 'miter',
  closed = false,
): void {
  if (pts.length < 2) return;
  strokeStyle(g, color, width, cap, join);
  g.ctx.beginPath();
  g.ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) g.ctx.lineTo(pts[i].x, pts[i].y);
  if (closed) g.ctx.closePath();
  g.ctx.stroke();
}

/**
 * A stroked polyline whose last segment is joined back to its first point.
 * A plain polyline that repeats the first corner is not a closed path: the
 * corner where the path starts and ends is two stroke ends, not a join, so
 * with butt caps the outer corner square is left unpainted. closePath makes
 * that corner a real join like the others (upstream strokes these shapes as
 * strokeRect or polygon primitives, closed by definition).
 */
export function closedPolyline(
  g: DrawContext,
  pts: Point[],
  color: string,
  width = 3,
  cap: CanvasLineCap = 'butt',
  join: CanvasLineJoin = 'miter',
): void {
  polyline(g, pts, color, width, cap, join, true);
}

/**
 * Voltage at fraction `f` along a gradient axis, clamped to the post range:
 * the linear interpolation upstream's gradient stops express, with the ends
 * clamped so a sub-shape sitting past a post still takes the post's colour.
 * `v0`/`v1` are the two posts of the gradient, the element's own 0 and 1 by
 * default; a relay coil or transformer winding passes its winding's pair.
 */
export function axisVoltage(
  g: DrawContext,
  f: number,
  v0 = g.voltages[0],
  v1 = g.voltages[1],
): number {
  return v0 + (v1 - v0) * Math.max(0, Math.min(1, f));
}

/** Body colour at fraction `f` along a gradient axis: `elementColor`'s split
 *  (the voltage colour when Show Voltage is on, the flat power colour under
 *  Show Power), inlined here so draw.ts never imports from the registry
 *  layer, which imports draw.ts. */
export function axisColor(
  g: DrawContext,
  f: number,
  v0 = g.voltages[0],
  v1 = g.voltages[1],
): string {
  return g.showPowerColor ? powerColor(g, g.power) : voltageColor(g, axisVoltage(g, f, v0, v1));
}

/**
 * Gradient stops that reproduce `axisColor(g, f)` exactly along the axis. The
 * voltage ramp is piecewise linear in `f`: the theme's colour scale mixes
 * linearly and its kinks sit where the interpolated voltage crosses 0 and
 * ±`voltageRange`. Stops at exactly those breakpoints (plus the two ends) let
 * a real CanvasGradient interpolate the ramp with no error, which is what the
 * per-segment strokes only approximated. Power mode and a zero or non-finite
 * drop are flat: two stops at the ends both in the one colour.
 */
function rampStops(g: DrawContext, v0: number, v1: number): [number, string][] {
  const colorAt = (f: number): string => axisColor(g, f, v0, v1);
  if (g.showPowerColor || !Number.isFinite(v0) || !Number.isFinite(v1) || v0 === v1) {
    return [[0, colorAt(0)], [1, colorAt(1)]];
  }
  const range = g.voltageRange || 5;
  const fs = new Set<number>([0, 1]);
  for (const v of [0, range, -range]) {
    const f = (v - v0) / (v1 - v0);
    if (f > 0 && f < 1) fs.add(f);
  }
  return [...fs].sort((a, b) => a - b).map((f) => [f, colorAt(f)] as [number, string]);
}

/** Body paint for a stroke along a gradient axis: the selection and highlight
 *  overrides take the flat colour, a zero-length axis takes the colour at the
 *  start fraction, and everything else ramps through `rampStops`. Shared by
 *  `gradientPolyline` and `gradientCoil`, so a coil's loops reuse the one
 *  gradient along the body axis instead of each loop creating its own. */
function axisPaint(g: DrawContext, v0: number, v1: number, axis: [Point, Point]): string | CanvasGradient {
  if (g.selected) return g.theme.selection;
  if (g.hovered || g.onHighlightedNet) return g.theme.highlight;
  const ax = axis[1].x - axis[0].x;
  const ay = axis[1].y - axis[0].y;
  if (ax * ax + ay * ay === 0) {
    // A zero-length axis has no direction to ramp along; the old code took
    // every point's fraction as 0, so keep the colour at the start.
    return axisColor(g, 0, v0, v1);
  }
  const grad = g.ctx.createLinearGradient(axis[0].x, axis[0].y, axis[1].x, axis[1].y);
  for (const [f, color] of rampStops(g, v0, v1)) grad.addColorStop(f, color);
  return grad;
}

/**
 * Strokes a polyline once with a real linear gradient along the body axis, so
 * a two-terminal body shades smoothly along the voltage drop at any zoom. The
 * gradient runs from the axis start at post `v0` to the axis end at post
 * `v1`, and every point projects onto that axis exactly as the old per-2-unit
 * strokes did, only continuously. Stops sit at the exact breakpoints of the
 * colour ramp, so the result matches the piecewise scale rather than a naive
 * straight blend between the two end colours.
 *
 * The axis defaults to the first and last points; a closed polyline (whose
 * last point repeats the first) must pass `axis` explicitly, and is stroked
 * as a closed path so the start corner joins like the others. Selection,
 * hover and the shift-highlighted net override the ramp with one flat colour,
 * the same precedence `limbColor` gives a solid stroke. Coils do not call
 * this directly: they stroke each loop as its own arc through `gradientCoil`.
 */
export function gradientPolyline(
  g: DrawContext,
  pts: Point[],
  opts: {
    /** Colour ramp endpoints, the element's posts 0/1 by default. */
    v0?: number;
    v1?: number;
    /** Cap for the stroke; defaults butt, the ambient cap. */
    cap?: CanvasLineCap;
    /** Join for the stroke; defaults miter, the ambient join. */
    join?: CanvasLineJoin;
    /** Body axis the ramp runs along; defaults to `[pts[0], pts[pts.length -
     *  1]]`, which is right for every open body. */
    axis?: [Point, Point];
  } = {},
): void {
  if (pts.length < 2) return;
  const axis = opts.axis ?? [pts[0], pts[pts.length - 1]];
  const v0 = opts.v0 ?? g.voltages[0];
  const v1 = opts.v1 ?? g.voltages[1];

  g.ctx.strokeStyle = axisPaint(g, v0, v1, axis);
  g.ctx.lineWidth = 3;
  // Butt is the ambient cap, miter the ambient join, exactly like `line`.
  g.ctx.lineCap = opts.cap ?? 'butt';
  g.ctx.lineJoin = opts.join ?? 'miter';
  g.ctx.beginPath();
  g.ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) g.ctx.lineTo(pts[i].x, pts[i].y);
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (first.x === last.x && first.y === last.y) g.ctx.closePath();
  g.ctx.stroke();
}

/**
 * Strokes each loop of a coil as its own path, so the same-side semicircles
 * read as three distinct arcs instead of one blending polyline. Each run is a
 * full arc from the axis back to the axis, stroked with a butt cap: the flat,
 * rectangular line end that keeps every arc's ends crisp. All the loops share
 * the one gradient along the `a`-`b` axis, so the shade stays continuous
 * across the arcs. Upstream draws the coil as one round-capped polyline
 * (CircuitElm.drawCoil); the split and the flat ends are the deliberate
 * deviation that makes the arcs read.
 */
export function gradientCoil(
  g: DrawContext,
  a: Point,
  b: Point,
  loops: number,
  opts: {
    /** Colour ramp endpoints, the element's posts 0/1 by default. */
    v0?: number;
    v1?: number;
  } = {},
): void {
  const v0 = opts.v0 ?? g.voltages[0];
  const v1 = opts.v1 ?? g.voltages[1];
  g.ctx.strokeStyle = axisPaint(g, v0, v1, [a, b]);
  g.ctx.lineWidth = 3;
  // Butt ends each arc flat; bevel stays from the single-path coil, where it
  // flattened the cusps where the loops meet the axis.
  g.ctx.lineCap = 'round';
  g.ctx.lineJoin = 'bevel';
  for (const run of coilLoopPoints(a, b, loops)) {
    g.ctx.beginPath();
    g.ctx.moveTo(run[0].x, run[0].y);
    for (let i = 1; i < run.length; i++) g.ctx.lineTo(run[i].x, run[i].y);
    g.ctx.stroke();
  }
}

export function circle(
  g: DrawContext,
  c: Point,
  r: number,
  color: string,
  fill = false,
  width = 3,
): void {
  strokeStyle(g, color, width);
  g.ctx.beginPath();
  g.ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
  if (fill) {
    g.ctx.fillStyle = limbColor(g, color);
    g.ctx.fill();
  }
  g.ctx.stroke();
}

/** Filled triangle, used for diodes, op-amps and arrowheads. */
export function triangle(g: DrawContext, a: Point, b: Point, c: Point, color: string): void {
  g.ctx.fillStyle = limbColor(g, color);
  g.ctx.beginPath();
  g.ctx.moveTo(a.x, a.y);
  g.ctx.lineTo(b.x, b.y);
  g.ctx.lineTo(c.x, c.y);
  g.ctx.closePath();
  g.ctx.fill();
}

/** Filled polygon, used for the transistor's base bar. */
export function polygon(g: DrawContext, pts: Point[], color: string): void {
  if (pts.length < 3) return;
  g.ctx.fillStyle = limbColor(g, color);
  g.ctx.beginPath();
  g.ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) g.ctx.lineTo(pts[i].x, pts[i].y);
  g.ctx.closePath();
  g.ctx.fill();
}

/**
 * The four corners of the rectangle straddling the segment `a`-`b`,
 * `halfHeight` to each side, ordered `[a1, b1, b2, a2]` for a closed loop.
 *
 * Same perpendicular as `interp`, but without the grid rounding, so the box is
 * an exact rectangle at any angle: the long edges equal `|b - a|` and the
 * short edges equal `2 * halfHeight`. Rounding the corners would skew those
 * lengths by up to a pixel on diagonal elements.
 */
export function rectCorners(a: Point, b: Point, halfHeight: number): [Point, Point, Point, Point] {
  let px = b.y - a.y;
  let py = a.x - b.x;
  const r = Math.hypot(px, py);
  if (r === 0) return [a, a, a, a];
  px /= r;
  py /= r;
  const a1 = { x: a.x + halfHeight * px, y: a.y + halfHeight * py };
  const a2 = { x: a.x - halfHeight * px, y: a.y - halfHeight * py };
  const b1 = { x: b.x + halfHeight * px, y: b.y + halfHeight * py };
  const b2 = { x: b.x - halfHeight * px, y: b.y - halfHeight * py };
  return [a1, b1, b2, a2];
}

/**
 * Rectangle straddling the segment `a`-`b`, `halfHeight` to each side. Built
 * from interpolated points rather than `strokeRect` because the context is not
 * rotated per element; this keeps the box square to the element at any angle.
 * The explicit corner list keeps the repeated first point, so the geometry
 * tests can assert the four corners; `closedPolyline` makes the path a real
 * closed subpath, which the repetition alone would not.
 */
export function bodyRect(
  g: DrawContext,
  a: Point,
  b: Point,
  halfHeight: number,
  color: string,
): void {
  const [a1, b1, b2, a2] = rectCorners(a, b, halfHeight);
  closedPolyline(g, [a1, b1, b2, a2, a1], color);
}

/** Half-height of the American zigzag peaks for the plain resistor and the
 *  potentiometer, upstream's `hs` when `showEuroResistors()` is false
 *  (ResistorElm.java:80-83, PotElm.java:226): the zigzag is taller than the
 *  6-unit IEC box so the two symbols read apart. The thermistor and LDR do
 *  NOT use this: upstream gives them one `hs = 6` shared by the euro box and
 *  the zigzag (ThermistorNTCElm.java:134, LDRElm.java:106), so those two pass
 *  their own box half-height to `zigzagPoints`. */
export const ZIGZAG_HS = 8;

/**
 * Points of the American zigzag resistor body between `a` and `b`, peaking
 * `halfHeight` to each side: four full cycles, alternating up and down at
 * every odd 1/16 of the length, then back to the axis at `b`. The exact
 * polyline upstream strokes when `showEuroResistors()` is false (ResistorElm.
 * java:84-96), and the same shape the pot's per-segment walk produces
 * (PotElm.java:234-248). Only the body changes with the toggle; the lead
 * lines and terminal posts are identical either way.
 *
 * Computed without the grid rounding `interp` applies, like `rectCorners`, so
 * the peak positions stay exact at any rotation; rounding would shrink the
 * peaks by up to a pixel.
 */
export function zigzagPoints(a: Point, b: Point, halfHeight: number): Point[] {
  let px = b.y - a.y;
  let py = a.x - b.x;
  const len = Math.hypot(px, py);
  if (len === 0) return [a, b];
  px /= len;
  py /= len;
  const pts: Point[] = [{ x: a.x, y: a.y }];
  for (let i = 0; i < 4; i++) {
    // Each cycle is an up peak at its 1/16 then a down peak at its 3/16.
    const fUp = (1 + 4 * i) / 16;
    pts.push({
      x: a.x + fUp * (b.x - a.x) + halfHeight * px,
      y: a.y + fUp * (b.y - a.y) + halfHeight * py,
    });
    const fDown = (3 + 4 * i) / 16;
    pts.push({
      x: a.x + fDown * (b.x - a.x) - halfHeight * px,
      y: a.y + fDown * (b.y - a.y) - halfHeight * py,
    });
  }
  pts.push({ x: b.x, y: b.y });
  return pts;
}

/** Loops in an inductor coil. Upstream scales this with length; a fixed three
 *  reads better at the 32-unit body every inductor uses. */
export const COIL_LOOPS = 3;

/**
 * Same-side semicircles along `a`-`b`: the coil symbol. Each loop is a
 * 180-degree arc of radius `len/(2*loops)` bulging to one side, so the curve
 * returns to the axis between loops. Alternating sides would draw a zigzag,
 * which is the American resistor symbol, not a coil.
 *
 * Computed without the grid rounding `interp` applies, like `rectCorners`, so
 * the radius and along-axis spacing stay exact at any rotation; rounding would
 * shrink the peak by up to a pixel and break the geometric tests.
 */
export function coilPoints(a: Point, b: Point, loops: number, steps = 12): Point[] {
  const runs = coilLoopPoints(a, b, loops, steps);
  const pts: Point[] = [];
  for (let k = 0; k < runs.length; k++) {
    // The first point of every loop after the first is the previous loop's
    // endpoint, the shared axis crossing; skip it so the polyline does not
    // double back over it.
    for (let s = k === 0 ? 0 : 1; s < runs[k].length; s++) pts.push(runs[k][s]);
  }
  return pts;
}

/**
 * The same coil as `coilPoints`, split into one point run per loop. Each run
 * is a full semicircle from the axis back to the axis: the first point of
 * every loop after the first is the previous loop's last point, the shared
 * axis crossing. Stroking each run as its own path (`gradientCoil`) is what
 * makes the three arcs read as distinct primitives with flat ends instead of
 * one blending polyline.
 */
export function coilLoopPoints(a: Point, b: Point, loops: number, steps = 12): Point[][] {
  let px = b.y - a.y;
  let py = a.x - b.x;
  const len = Math.hypot(px, py);
  if (len === 0) return [[a, b]];
  px /= len;
  py /= len;
  const radius = len / (2 * loops);
  const runs: Point[][] = [];
  for (let k = 0; k < loops; k++) {
    const pts: Point[] = [];
    for (let s = 0; s <= steps; s++) {
      const theta = Math.PI * (s / steps);
      // The (1 - cos theta) / 2 mapping makes the loop a true semicircle: it
      // is at full radius at the midpoint and meets the axis vertically.
      const f = (k + (1 - Math.cos(theta)) / 2) / loops;
      const offset = Math.sin(theta) * radius;
      pts.push({
        x: a.x + f * (b.x - a.x) + offset * px,
        y: a.y + f * (b.y - a.y) + offset * py,
      });
    }
    runs.push(pts);
  }
  return runs;
}

/** Arrowhead at `tip`, pointing away from `from`. */
export function arrowHead(g: DrawContext, from: Point, tip: Point, size: number, color: string) {
  const [l, r] = interp2(
    from,
    tip,
    1 - size / Math.max(1, Math.hypot(tip.x - from.x, tip.y - from.y)),
    size / 2,
  );
  triangle(g, tip, l, r, color);
}

/** Colour of the current-flow dots and stream lines, flipping with the
 *  conventional-current toggle (upstream turns them cyan in electron-flow
 *  mode, UIManager.java:238). */
export function dotColor(g: DrawContext): string {
  return g.conventional ? g.theme.currentDot : g.theme.currentDotElectron;
}

/**
 * Animated dots showing current direction and magnitude along a segment, using
 * the element's own accumulated phase (`g.dotPhase`).
 */
export function currentDots(g: DrawContext, a: Point, b: Point, current: number): void {
  currentDotsFrom(g, a, b, current, g.dotPhase);
}

/**
 * Animated dots showing current direction and magnitude along a segment.
 *
 * `phase` is the accumulated phase for the start of this run; the caller wraps
 * it into `[0, DOT_SPACING)` each frame, except for `TOO_FAST`, which draws a
 * translucent flow line and then shimmering dots at a random offset, because
 * aliased dots read as motion in the wrong direction.
 */
export function currentDotsFrom(
  g: DrawContext,
  a: Point,
  b: Point,
  current: number,
  phase: number,
): void {
  if (!g.showCurrent || !Number.isFinite(current) || Math.abs(current) < MIN_CURRENT_FLOW) return;
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 1) return;

  let offset;
  if (phase === TOO_FAST) {
    // Too fast to follow, so underline the path with a bright translucent
    // stream; the random phase keeps the dots shimmering instead of crawling
    // along the line (CircuitElm.java:489-500).
    g.ctx.save();
    g.ctx.globalAlpha = 0.5;
    g.ctx.strokeStyle = dotColor(g);
    g.ctx.lineWidth = 4;
    g.ctx.beginPath();
    g.ctx.moveTo(a.x, a.y);
    g.ctx.lineTo(b.x, b.y);
    g.ctx.stroke();
    g.ctx.restore();
    offset = Math.random() * DOT_SPACING;
  } else {
    // Wrap the phase into one dot interval so the pattern is continuous.
    offset = phase % DOT_SPACING;
    if (offset < 0) offset += DOT_SPACING;
  }

  g.ctx.fillStyle = dotColor(g);
  for (let d = offset; d < len; d += DOT_SPACING) {
    const p = interpPrecise(a, b, d / len);
    // Fixed size, never derived from the stroke width: a 4x4 square, exactly
    // upstream's current dot (CircuitElm.java:510), so the dots stay visible
    // on the thicker 3-unit bodies without scaling with them.
    g.ctx.fillRect(p.x - 2, p.y - 2, 4, 4);
  }
}

/** One continuous dot run across a polyline, phase offset by segment length so
 *  dots stay exactly `DOT_SPACING` apart across segment joints (the routed
 *  wire's `addCurCount`, CircuitElm.java:514-518). */
export function currentDotsPath(g: DrawContext, pts: Point[], current: number): void {
  if (pts.length < 2) return;
  let phase = g.dotPhase;
  for (let i = 0; i < pts.length - 1; i++) {
    currentDotsFrom(g, pts[i], pts[i + 1], current, phase);
    phase = dotPhaseAfter(phase, Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y));
  }
}

/**
 * Handle rects for a control-point drag: a filled 7x7 selection-colour rect at
 * each stored endpoint of the dragged element, the grabbed one at 9x9,
 * upstream's `drawHandles` (`fillRect(pt-3, pt-3, 7, 7)` / `fillRect(pt-4,
 * pt-4, 9, 9)`, CircuitElm.java:747-761). Only the two stored endpoints get handles,
 * never the derived posts, so the caller passes exactly those; `grabbed` is the
 * index of the moving control point. Drawn from the dragpost frame branch as
 * one overlay call, never from inside an element draw.
 */
export function dragpostHandlesFrom(g: DrawContext, posts: Point[], grabbed: number): void {
  if (posts.length === 0) return;
  g.ctx.fillStyle = g.theme.selection;
  posts.forEach((p, i) => {
    const s = i === grabbed ? 9 : 7;
    // Half-anchor the rect so its centre lands on the post. Upstream uses the
    // integer offsets (UIManager.java:681-698); this half-pixel centring is a
    // deliberate aesthetic divergence the owner requested, so the handle sits
    // on the wire centreline like the grid dots.
    g.ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);
  });
}

/** A single terminal lead, post to body, with round caps so its ends read as
 *  a continuous conductor like the wires it meets (upstream's ambient round
 *  cap, UIManager.java:636). */
export function lead(g: DrawContext, a: Point, b: Point, color: string): void {
  line(g, a, b, color, 3, 'round');
}

/** Draws the two lead wires for a two-terminal element. The caller owns the
 *  dot run, so it can place it over the body for junction continuity. */
export function drawLeads(g: DrawContext, e: CircuitElement, lead1: Point, lead2: Point): void {
  const [p1, p2] = endpoints(e);
  lead(g, p1, lead1, voltageColor(g, g.voltages[0]));
  lead(g, lead2, p2, voltageColor(g, g.voltages[1]));
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

/** The edit-box prefix table: formatValue's, but with micro as ASCII `u`.
 *  A µ in a text field would never round-trip parseUnits, which accepts only
 *  `u`, so the input boxes must not render it. Canvas labels and scopes keep
 *  the µ glyph. Derived from PREFIXES so the two tables cannot drift. */
const PREFIXES_ASCII: typeof PREFIXES = PREFIXES.map((p) =>
  p.suffix === 'µ' ? { ...p, suffix: 'u' } : p,
);

/** The spaced-form body shared by the µ and ASCII formatters. `digits` is the
 *  fraction-digit count, upstream's `####.#` pattern (`getUnitText`,
 *  CircuitElm.java:157-186): round to that many digits after the prefix, then
 *  trim trailing zeroes. `toPrecision` cannot express the pattern, which is
 *  why 55.5 with one digit must be "55.5m" and not "6e+1m". */
function formatValueWith(v: number, unit: string, digits: number, prefixes: typeof PREFIXES): string {
  if (!Number.isFinite(v)) return '--';
  if (v === 0) return `0 ${unit}`.trim();
  return `${formatScaled(v, digits, prefixes)}${unit ? ` ${unit}` : ''}`.trim();
}

/** Formats a value with an engineering prefix, e.g. `4.7k`, `100µ`. This is
 *  the spaced form, used by the Properties panel, the scopes and the netlist
 *  edit box; the on-canvas labels use `formatValueShort`. */
export function formatValue(v: number, unit = '', digits = 3): string {
  return formatValueWith(v, unit, digits, PREFIXES);
}

/** formatValue with micro rendered as ASCII `u`: the edit-box formatter, whose
 *  output must round-trip parseUnits (which rejects the µ glyph). Everything
 *  on canvas or in a scope keeps the µ glyph via `formatValue`. */
export function formatValueAscii(v: number, unit = '', digits = 3): string {
  return formatValueWith(v, unit, digits, PREFIXES_ASCII);
}

/** The number with its engineering prefix, trailing zeroes trimmed: the
 *  `####.#` body the two formatters share. */
function formatScaled(v: number, digits: number, prefixes: typeof PREFIXES): string {
  const abs = Math.abs(v);
  const p = prefixes.find((x) => abs >= x.limit) ?? prefixes[prefixes.length - 1];
  const scaled = v / p.scale;
  const text = scaled.toFixed(digits);
  // Trim trailing zeroes left by toFixed, but keep integers intact.
  const trimmed = text.includes('.') ? text.replace(/\.?0+$/, '') : text;
  return `${trimmed}${p.suffix}`;
}

/** The on-canvas value-label formatter, `formatValue`'s no-space sibling
 *  (upstream's `getShortUnitText`, CircuitElm.java:1101-1127). A capacitor
 *  draws `1µF` and an inductor `10mH` instead of `1µ F` / `10m H`; ohms are
 *  dropped entirely, so a resistor draws `4.7k`, this port's deliberate
 *  divergence from upstream's `4.7kΩ`. Only the canvas labels use this; the
 *  panel and scopes keep `formatValue`'s spaced unit. */
export function formatValueShort(v: number, unit = '', digits = 3): string {
  if (!Number.isFinite(v)) return '--';
  if (v === 0) return unit === 'Ω' ? '0' : `0${unit}`;
  const body = formatScaled(v, digits, PREFIXES);
  return unit === 'Ω' ? body : `${body}${unit}`;
}

/** Value caption drawn alongside an element body, ported from upstream's
 *  `drawValues` (CircuitElm.java:914-943). `offset` is the `hs` argument, the
 *  perpendicular reach of the symbol the caption must clear. A near-horizontal
 *  body (`dpx == 0`, upstream's truncated perpendicular x) gets its caption
 *  centered above, its alphabetic baseline two units clear of that reach; a
 *  vertical or diagonal body gets left-aligned text beside the axis, offset
 *  plus two along the perpendicular and its baseline pulled back by half the
 *  font height so the caption centres on the axis. Voltage sources and
 *  up-right diagonals flip to the near side, so the caption never overruns
 *  the far one. */
export function label(g: DrawContext, e: CircuitElement, text: string, offset = 12): void {
  if (!g.showValues || !text) return;
  const [p1, p2] = endpoints(e);
  const dn = elementLength(e);
  const xc = Math.trunc((p1.x + p2.x) / 2);
  const yc = Math.trunc((p1.y + p2.y) / 2);
  // The perpendicular unit components times the offset, truncated like
  // upstream's `(int)(dpx1*hs)` (CircuitElm.java:932-933): an exactly
  // horizontal element gives dpx == 0 and a vertical one gives dpy == 0.
  const dpx = dn === 0 ? 0 : Math.trunc(((p2.y - p1.y) / dn) * offset);
  const dpy = dn === 0 ? 0 : Math.trunc((-(p2.x - p1.x) / dn) * offset);
  g.ctx.fillStyle = g.theme.text;
  g.ctx.font = canvasFont(g.valueFontSize);
  const w = g.ctx.measureText(text).width;
  // Upstream never sets a baseline here, so the canvas default applies: the
  // y coordinate is the glyph baseline, and only descenders hang below it.
  // That is what keeps the horizontal caption clear of the plate edge.
  g.ctx.textBaseline = 'alphabetic';
  if (dpx === 0) {
    g.ctx.textAlign = 'center';
    g.ctx.fillText(text, xc, yc - Math.abs(dpy) - 2);
  } else {
    // VoltageElm draws its value on the near side (CircuitElm.java:938-939);
    // so does an up-right diagonal, which would otherwise let the caption
    // overrun the top of the body.
    let x = xc + Math.abs(dpx) + 2;
    if (e.kind === 'voltage' || (p2.x > p1.x && p2.y < p1.y)) {
      x = xc - (w + Math.abs(dpx) + 2);
    }
    g.ctx.textAlign = 'left';
    g.ctx.fillText(text, x, yc + dpy + g.valueFontSize / 2);
  }
}

/** Value caption on one segment of a polyline, ported from upstream's
 *  `RoutedWireElm.drawValuesOnLongestSegment` (RoutedWireElm.java:318-347):
 *  centered above a horizontal segment and left-aligned to the right of a
 *  vertical one. The routed wire finds its longest segment and labels that,
 *  so the caption sits where the wire has the most room instead of crowding
 *  a corner. */
export function labelOnSegment(g: DrawContext, a: Point, b: Point, text: string): void {
  if (!g.showValues || !text) return;
  g.ctx.fillStyle = g.theme.text;
  g.ctx.font = canvasFont(g.valueFontSize);
  // Upstream never sets a baseline here either, so the canvas default applies
  // exactly as `label` relies on it.
  g.ctx.textBaseline = 'alphabetic';
  const mx = Math.trunc((a.x + b.x) / 2);
  const my = Math.trunc((a.y + b.y) / 2);
  if (a.y === b.y) {
    g.ctx.textAlign = 'center';
    g.ctx.fillText(text, mx, my - 6);
  } else {
    g.ctx.textAlign = 'left';
    g.ctx.fillText(text, mx + 4, my + g.valueFontSize / 2);
  }
}

/** Builds a theme, overlaying the five user-settable colours over the palette
 *  for `dark`. A null or absent entry keeps the palette's own value, so the
 *  argument shares the shape of the settings object and a plain `makeTheme(dark)`
 *  is still the stock palette. */
export function makeTheme(dark = true, colors?: Partial<ThemeColors>): Theme {
  const base = dark ? darkTheme() : lightTheme();
  return {
    ...base,
    selection: colors?.selectionColor ?? base.selection,
    negative: colors?.negativeColor ?? base.negative,
    neutral: colors?.neutralColor ?? base.neutral,
    positive: colors?.positiveColor ?? base.positive,
    currentDot: colors?.currentColor ?? base.currentDot,
  };
}

function lightTheme(): Theme {
  return {
    // White Background (upstream's printable mode): the schematic renders on
    // white with black wires and dark text, the palette of ImageExporter's
    // forced-printable export. Not byte-for-byte upstream's print palette;
    // that is a deliberate form difference. The darker #1a7f37 / #cf222e
    // positive and negative are a deliberate legibility divergence too, since
    // upstream's saturated primaries would wash out on white; the dark theme
    // below is the parity-exact palette.
    background: '#ffffff',
    grid: '#d0d7de',
    wire: '#000000',
    // Upstream's printable mode sets whiteColor to black (UIManager.java:578).
    whiteColor: '#000000',
    // Upstream's Color.darkGray, same constant both themes: the transmission
    // line's body fill behind its voltage strips.
    darkGray: '#404040',
    // Upstream's Color.lightGray, same constant both themes: the relay blade
    // and the analog switch bar.
    lightGray: '#c0c0c0',
    // Upstream's lightGrayColor flips to black when printable
    // (ImageExporter.java:192): the scope's drag-start cursor line has to stay
    // visible on white.
    lightGrayText: '#000000',
    // The scope grid in upstream's printable palette (Scope.java:800-806),
    // inverted against the dark theme so the minor lines stay the fainter pair.
    scopeGridMinor: '#d0d0d0',
    scopeGridMajor: '#808080',
    text: '#24292f',
    // Upstream's Color.dark_gray, the scope settings wheel's rest state
    // (Scope.java:536); same constant as darkGray.
    muted: '#404040',
    selection: '#54aeff',
    // The hover/net-highlight role is the port's own, deliberately outside
    // the upstream-pinned colour-scale roles. Selection and highlight are the
    // same GitHub accent, so a selected element and a hovered one read
    // identically: the owner's call that the hover blue is the correct one.
    highlight: '#54aeff',
    negative: '#cf222e',
    noConnect: '#ff0000',
    neutral: '#6e7781',
    positive: '#1a7f37',
    currentDot: '#9a6700',
    currentDotElectron: '#0b7285',
    panel: '#f6f8fa',
    border: '#d0d7de',
  };
}

function darkTheme(): Theme {
  return {
    // Four of the five colour-scale roles are upstream's exact constants
    // (CircuitElm.java:200-205, Color.java:26-37); draw.test.ts pins the
    // parity, so a future palette tweak has to argue with the claim. Selection
    // is the exception: it used to carry upstream's cyan but now matches the
    // hover blue, the owner's call that the hover colour was the right one.
    background: '#000000',
    grid: '#1b2230',
    wire: '#c9d1d9',
    // Upstream's normal theme sets whiteColor to white (UIManager.java:583).
    whiteColor: '#ffffff',
    // Upstream's Color.darkGray (Color.java:28), the exact constant the dark
    // theme carries: the transmission line's body fill.
    darkGray: '#404040',
    // Upstream's Color.lightGray (Color.java:31), the exact constant the dark
    // theme carries: the relay blade and the analog switch bar.
    lightGray: '#c0c0c0',
    // Upstream's lightGrayColor in the normal theme is Color.lightGray
    // (ImageExporter.java:196), the same value; it is a separate role only
    // because the printable theme flips it to black.
    lightGrayText: '#c0c0c0',
    // The scope grid, upstream's normal palette (Scope.java:799-800).
    scopeGridMinor: '#404040',
    scopeGridMajor: '#a0a0a0',
    text: '#8b949e',
    // Upstream's Color.dark_gray, the scope settings wheel's rest state
    // (Scope.java:536); same constant as darkGray.
    muted: '#404040',
    selection: '#58a6ff',
    // Same hover-family decision as the light theme: selection and highlight
    // are both the app's accent blue (styles.css --accent), so the selected
    // and hovered states share one hue.
    highlight: '#58a6ff',
    negative: '#ff0000',
    // Upstream's no-connect marker is plain red (UIManager.java:710).
    noConnect: '#ff0000',
    neutral: '#808080',
    positive: '#00ff00',
    currentDot: '#ffff00',
    // Upstream's electron-flow cyan (UIManager.java:238); the port has no
    // light theme yet, so a dark-cyan variant is not needed.
    currentDotElectron: '#00ffff',
    panel: '#161b22',
    border: '#30363d',
  };
}
