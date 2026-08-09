/** Drawing primitives shared by every element renderer. */

import type { CircuitElement, DrawContext, Point, Theme, ThemeColors } from '../model/types';
import { DOT_SPACING, dotPhaseAfter, TOO_FAST } from './dots';

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
 *  their channels, for a blend that needs the numbers rather than the string. */
function parseRgb(color: string): [number, number, number] {
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
 *  (CircuitElm.java:1305-1313). */
export function limbColor(g: DrawContext, color: string): string {
  if (g.selected) return g.theme.selection;
  if (g.hovered || g.onHighlightedNet) return g.theme.highlight;
  return color;
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
  // Wires opt into round through the cap argument, so a routed corner or a
  // diagonal wire end reads as a continuous conductor (upstream's ambient
  // round cap, UIManager.java:636). Miter is upstream's join too: it never
  // sets lineJoin, so the canvas default is what the original renders. That
  // default is right for polygons, whose corners miter into crisp points, and
  // wrong for the coil: its loop junctions drop back to the axis and turn at
  // near-zero angles, where miter spikes and the canvas silently clamps at
  // miterLimit. The coil passes 'bevel' so those cusps flatten. The width
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
 * Strokes a polyline segment by segment, each with the axis colour at its own
 * midpoint fraction, so a two-terminal body shades along the voltage drop.
 * Colour per segment, never a CanvasGradient: the SVG recorder stores
 * strokeStyle as a string, so a gradient object would silently stringify into
 * the export. A long straight edge (an IEC box side) is cut into short
 * sub-segments so its ramp stays smooth instead of one band per side; every
 * cut shares its endpoints exactly, so butt caps leave no seam along a straight
 * run. Coils pass `cap: 'round'`, upstream's LineCap.ROUND in drawCoil, so
 * their angled joints stay covered, and `join: 'bevel'` so the near-zero-angle
 * cusps where the loops return to the axis flatten instead of spiking under
 * miter. The axis defaults to the first and last points; a closed polyline
 * (whose last point repeats the first) must pass `axis` explicitly.
 */
export function gradientPolyline(
  g: DrawContext,
  pts: Point[],
  opts: {
    /** Colour ramp endpoints, the element's posts 0/1 by default. */
    v0?: number;
    v1?: number;
    /** Cap for the per-segment strokes; coils pass 'round' (drawCoil's
     *  LineCap.ROUND). Defaults butt. */
    cap?: CanvasLineCap;
    /** Join for the per-segment strokes; coils pass 'bevel' so their loop
     *  junctions stay flat. Defaults miter. */
    join?: CanvasLineJoin;
    /** Body axis the fraction is measured along; defaults to `[pts[0],
     *  pts[pts.length - 1]]`, which is right for every open body. */
    axis?: [Point, Point];
  } = {},
): void {
  if (pts.length < 2) return;
  const axis = opts.axis ?? [pts[0], pts[pts.length - 1]];
  const ax = axis[1].x - axis[0].x;
  const ay = axis[1].y - axis[0].y;
  const len2 = ax * ax + ay * ay;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    // A long straight edge is cut into sub-segments so the colour ramp along
    // it stays smooth; short edges (coil loops, sine steps) pass through whole.
    const steps = Math.max(1, Math.round(Math.hypot(b.x - a.x, b.y - a.y) / 2));
    for (let s = 0; s < steps; s++) {
      const t0 = s / steps;
      const t1 = (s + 1) / steps;
      const p0 = { x: a.x + t0 * (b.x - a.x), y: a.y + t0 * (b.y - a.y) };
      const p1 = { x: a.x + t1 * (b.x - a.x), y: a.y + t1 * (b.y - a.y) };
      const mx = (p0.x + p1.x) / 2;
      const my = (p0.y + p1.y) / 2;
      const f = len2 > 0 ? ((mx - axis[0].x) * ax + (my - axis[0].y) * ay) / len2 : 0;
      line(g, p0, p1, axisColor(g, f, opts.v0, opts.v1), 3, opts.cap, opts.join);
    }
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
export function bodyRect(g: DrawContext, a: Point, b: Point, halfHeight: number, color: string): void {
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
  let px = b.y - a.y;
  let py = a.x - b.x;
  const len = Math.hypot(px, py);
  if (len === 0) return [a, b];
  px /= len;
  py /= len;
  const radius = len / (2 * loops);
  const pts: Point[] = [];
  for (let k = 0; k < loops; k++) {
    for (let s = 0; s <= steps; s++) {
      if (k > 0 && s === 0) continue;  // duplicates the previous loop's endpoint
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
  }
  return pts;
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
  if (!g.showCurrent || !Number.isFinite(current) || current === 0) return;
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
    // Fixed size, never derived from the stroke width: a radius of 2 matches
    // upstream's 4x4 fillRect (CircuitElm.java:510), so the dots stay visible
    // on the thicker 3-unit bodies without scaling with them.
    g.ctx.beginPath();
    g.ctx.arc(p.x, p.y, 2, 0, Math.PI * 2);
    g.ctx.fill();
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
    phase = dotPhaseAfter(
      phase,
      Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y),
    );
  }
}

/** Draws the two lead wires for a two-terminal element. The caller owns the
 *  dot run, so it can place it over the body for junction continuity. */
export function drawLeads(g: DrawContext, e: CircuitElement, lead1: Point, lead2: Point): void {
  const [p1, p2] = endpoints(e);
  line(g, p1, lead1, voltageColor(g, g.voltages[0]));
  line(g, lead2, p2, voltageColor(g, g.voltages[1]));
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

/** Formats a value with an engineering prefix, e.g. `4.7k`, `100µ`. `digits`
 *  is the fraction-digit count, upstream's `####.#` pattern (`getUnitText`,
 *  CircuitElm.java:157-186): round to that many digits after the prefix, then
 *  trim trailing zeroes. `toPrecision` cannot express the pattern, which is
 *  why 55.5 with one digit must be "55.5m" and not "6e+1m". */
export function formatValue(v: number, unit = '', digits = 3): string {
  if (!Number.isFinite(v)) return '--';
  if (v === 0) return `0 ${unit}`.trim();
  const abs = Math.abs(v);
  const p = PREFIXES.find((x) => abs >= x.limit) ?? PREFIXES[PREFIXES.length - 1];
  const scaled = v / p.scale;
  const text = scaled.toFixed(digits);
  // Trim trailing zeroes left by toFixed, but keep integers intact.
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
  g.ctx.font = canvasFont(g.valueFontSize);
  g.ctx.textAlign = horizontal ? 'center' : 'left';
  g.ctx.textBaseline = 'middle';
  g.ctx.fillText(text, p.x, p.y);
}

/** Builds a theme, overlaying the five user-settable colours over the palette
 *  for `dark`. A null entry keeps the palette's own value, so the argument
 *  shares the shape of the settings object and a plain `makeTheme(dark)` is
 *  still the stock palette. */
export function makeTheme(dark = true, colors?: ThemeColors): Theme {
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
    text: '#24292f',
    selection: '#0969da',
    highlight: '#d0782d',
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
    // The five colour-scale roles are upstream's exact constants
    // (CircuitElm.java:200-205, Color.java:26-37); draw.test.ts pins the
    // parity, so a future palette tweak has to argue with the claim.
    background: '#0d1117',
    grid: '#1b2230',
    wire: '#c9d1d9',
    // Upstream's normal theme sets whiteColor to white (UIManager.java:583).
    whiteColor: '#ffffff',
    text: '#8b949e',
    selection: '#00ffff',
    highlight: '#f0883e',
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
