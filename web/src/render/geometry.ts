/**
 * Pure geometry for hit-testing and post dragging, kept headless so it can be
 * unit tested without a canvas (AGENTS.md: deleting the canvas must not delete
 * the logic).
 */

import type { Box, CircuitElement, Point } from '../model/types';
import { defFor, postCountOf, postsOf } from '../model/registry';

/** Shortest distance from `p` to the segment `a`-`b`. */
export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * True when `p` lies strictly on the interior of the segment `a`-`b`: on the
 * line and not at either endpoint. This is upstream's `pointOnSegmentInterior`
 * (CircuitElm.java:353-363), generalised from axis-aligned to any direction so
 * a diagonal wire can be split too. `tolerance` is the on-line fuzz; grid
 * arithmetic is exact, so a small epsilon only guards against float drift.
 */
export function pointOnSegmentInterior(
  p: Point,
  a: Point,
  b: Point,
  tolerance = 1e-9,
): boolean {
  if ((p.x === a.x && p.y === a.y) || (p.x === b.x && p.y === b.y)) return false;
  return distanceToSegment(p, a, b) <= tolerance;
}

/** The corner polyline of a wire: its route when routed, else the straight
 *  span between the two stored endpoints. */
export function wirePoints(wire: CircuitElement): Point[] {
  if (wire.route && wire.route.length >= 2) {
    return wire.route.map(([x, y]) => ({ x, y }));
  }
  return [
    { x: wire.x1, y: wire.y1 },
    { x: wire.x2, y: wire.y2 },
  ];
}

/**
 * True when `p` lies on the interior of `wire`'s path: on a segment strictly
 * between its endpoints, or exactly on an interior bend vertex. Route-aware:
 * a routed wire hit-tests every segment and its bend vertices, the port of
 * `pointOnWireInteriorForPoints` (WireElm.java:213-226); a plain wire reduces
 * to the straight-span check.
 */
export function pointOnWireInterior(p: Point, wire: CircuitElement, tolerance = 1e-9): boolean {
  const pts = wirePoints(wire);
  for (let i = 0; i < pts.length - 1; i++) {
    if (pointOnSegmentInterior(p, pts[i], pts[i + 1], tolerance)) return true;
  }
  // An interior bend vertex is a valid connection and split point even though
  // it is not "interior" to either adjacent segment (WireElm.java:219-224).
  for (let i = 1; i < pts.length - 1; i++) {
    const q = pts[i];
    if (p.x === q.x && p.y === q.y) return true;
  }
  return false;
}

/**
 * Splits wire `[a, b]` at `p`, which lies on its interior, into two wires.
 * Returns the two replacement wires with fresh ids, or null when `p` is not
 * strictly between `a` and `b` (endpoints are an ordinary connection, off-line
 * points are not a split). `p` is snapped to the grid by the caller, so the
 * two halves stay grid-aligned and connectable. The first half is `[a, p]`,
 * the second `[p, b]`, mirroring upstream's `WireElm.split`
 * (WireElm.java:235-240).
 */
export function splitWire(
  wire: CircuitElement,
  p: Point,
  nextId: () => number,
): [CircuitElement, CircuitElement] | null {
  if (wire.kind !== 'wire') return null;
  if (wire.route && wire.route.length >= 2) {
    return splitRoutedWire(wire, p, nextId);
  }
  if (!pointOnSegmentInterior(p, { x: wire.x1, y: wire.y1 }, { x: wire.x2, y: wire.y2 })) {
    return null;
  }
  return [
    { ...wire, id: nextId(), x2: p.x, y2: p.y },
    { ...wire, id: nextId(), x1: p.x, y1: p.y },
  ];
}

/** Snaps `v` to a circuit half-grid for split points on a routed segment. The
 *  unit is 8, half the 16-unit grid: every grid-aligned coordinate is a
 *  multiple of 8, so a point the caller already snapped to the grid never
 *  moves, while a split can still land on a half-grid position between two
 *  grid-aligned bends. */
const SNAP_GRID = 8;

function snapGrid(v: number): number {
  return Math.round(v / SNAP_GRID) * SNAP_GRID;
}

/**
 * Splits a routed wire at the nearest point of `p` onto its polyline, into two
 * routed halves sharing the split point. The port of `RoutedWireElm.split`
 * (RoutedWireElm.java:136-197): the split point is snapped to the grid and
 * clamped onto the nearest segment, and a split that lands exactly on an
 * existing bend vertex adds no duplicate point to either half.
 */
function splitRoutedWire(
  wire: CircuitElement,
  p: Point,
  nextId: () => number,
): [CircuitElement, CircuitElement] | null {
  const pts = wire.route!;
  if (pts.length < 2) return null;

  let bestSeg = -1;
  let bestDist = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const d = distanceToSegment(p, { x: pts[i][0], y: pts[i][1] }, { x: pts[i + 1][0], y: pts[i + 1][1] });
    if (d < bestDist) {
      bestDist = d;
      bestSeg = i;
    }
  }
  if (bestSeg < 0) return null;

  const [ax, ay] = pts[bestSeg];
  const [bx, by] = pts[bestSeg + 1];
  let sx: number;
  let sy: number;
  if (ax === bx) {
    sx = ax;
    sy = Math.min(Math.max(ay, by), Math.min(snapGrid(p.y), Math.max(ay, by)));
  } else if (ay === by) {
    sy = ay;
    sx = Math.min(Math.max(ax, bx), Math.min(snapGrid(p.x), Math.max(ax, bx)));
  } else {
    // A diagonal segment (a converted diagonal wire): project onto it, snap
    // both coordinates, and clamp back onto the segment.
    const dx = bx - ax;
    const dy = by - ay;
    const t = ((p.x - ax) * dx + (p.y - ay) * dy) / (dx * dx + dy * dy);
    sx = Math.min(Math.max(ax, bx), Math.min(snapGrid(ax + t * dx), Math.max(ax, bx)));
    sy = Math.min(Math.max(ay, by), Math.min(snapGrid(ay + t * dy), Math.max(ay, by)));
  }

  // Refuse to split at one of the wire's own endpoints, which is an ordinary
  // connection rather than a split (RoutedWireElm.java:169-170).
  if ((sx === wire.x1 && sy === wire.y1) || (sx === wire.x2 && sy === wire.y2)) return null;

  const atA = sx === ax && sy === ay;
  const atB = sx === bx && sy === by;

  const rp1: [number, number][] = [];
  for (let i = 0; i <= bestSeg; i++) rp1.push(pts[i]);
  if (!atA) rp1.push([sx, sy]);

  const rp2: [number, number][] = [[sx, sy]];
  for (let i = bestSeg + 1; i < pts.length; i++) {
    if (i === bestSeg + 1 && atB) continue;
    rp2.push(pts[i]);
  }

  return [
    { ...wire, id: nextId(), route: rp1, x2: sx, y2: sy },
    { ...wire, id: nextId(), route: rp2, x1: sx, y1: sy },
  ];
}

/**
 * One primitive the element hit test measures a pointer against. The picker
 * takes the smallest distance over an element's regions, so this list is the
 * whole truth about what a click is compared to: nothing outside it decides a
 * pick. Exported so the hitbox debug overlay can draw the very shapes the
 * picker consults instead of a second copy that would drift from them.
 */
export type HitRegion =
  /** A terminal, or the single anchor point of a one-post part. */
  | { type: 'post'; x: number; y: number }
  /** The body axis, the span between the two stored endpoints. */
  | { type: 'axis'; a: Point; b: Point }
  /** One segment of a routed wire's polyline. */
  | { type: 'wire'; a: Point; b: Point }
  /** A chip's housing rectangle, a solid pick zone. */
  | { type: 'body'; box: Box };

/**
 * The regions `distanceToElement` measures against, in one place so the hit
 * test and the debug overlay cannot disagree about what is grabbable. Pure:
 * no canvas, no store, geometry only.
 */
export function hitRegions(e: CircuitElement): HitRegion[] {
  if (e.kind === 'wire' && e.route && e.route.length >= 2) {
    // A routed wire hit-tests every segment: the stored span between the two
    // posts would miss a polyline that detours far off the straight line.
    const pts = wirePoints(e);
    const segments: HitRegion[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      segments.push({ type: 'wire', a: pts[i], b: pts[i + 1] });
    }
    return segments;
  }
  const posts = postsOf(e);
  if (posts.length <= 1) {
    // The stored start point, which for a one-post part is its terminal. A
    // kind this build does not draw has no posts at all and still anchors
    // here, so a click can reach it.
    const regions: HitRegion[] = [{ type: 'post', x: e.x1, y: e.y1 }];
    // A ground's free end is a draggable control point, not a post, so its
    // stem must be hittable along the whole span or the far end could never
    // be clicked to ctrl-drag it. Other single-post parts (text, readouts)
    // keep their stray `x2, y2` out of hit-testing.
    const def = defFor(e.kind);
    if ((def?.draggablePosts ?? postCountOf(e)) > 1) {
      regions.push({ type: 'axis', a: { x: e.x1, y: e.y1 }, b: { x: e.x2, y: e.y2 } });
    }
    return regions;
  }
  const regions: HitRegion[] = [
    { type: 'axis', a: { x: e.x1, y: e.y1 }, b: { x: e.x2, y: e.y2 } },
    // Multi-terminal parts have limbs off the main axis, so also test each
    // terminal by its own distance; the nearer of the body line and a post wins.
    ...posts.map((q): HitRegion => ({ type: 'post', x: q.x, y: q.y })),
  ];
  // A chip's body rect is a solid pick zone: upstream gates the pick on
  // `boundingBox.contains` (MouseManager.java:813), so the drawn housing must
  // grab a click anywhere on it, not just on the thin axis and the pins. The
  // box distance is 0 for an interior point, so it wins over the axis/post
  // measures there while leaving them to decide outside.
  const rect = defFor(e.kind)?.bodyRect?.(e);
  if (rect) regions.push({ type: 'body', box: rect });
  return regions;
}

/** Distance from `p` to one hit region, in circuit units. */
export function distanceToHitRegion(p: Point, region: HitRegion): number {
  switch (region.type) {
    case 'post':
      return Math.hypot(p.x - region.x, p.y - region.y);
    case 'axis':
    case 'wire':
      return distanceToSegment(p, region.a, region.b);
    case 'body':
      return distanceToBox(p, region.box);
  }
}

/** Distance from a point to an element, measured against all of its limbs. */
export function distanceToElement(p: Point, e: CircuitElement): number {
  let best = Infinity;
  for (const region of hitRegions(e)) {
    best = Math.min(best, distanceToHitRegion(p, region));
  }
  return best;
}

/** Screen-pixel radius within which a pointer hits an element, at any zoom.
 *  Upstream's grab tolerances are grid units: 5 for a post (POSTGRABSQ,
 *  MouseManager.java:70) and the resistor's 6-unit half-height for a body
 *  (ResistorElm.java:67); at the initial fit zoom of at most 1.5
 *  (UIManager.java:469) those are about 8 px on screen. */
export const HIT_TOLERANCE_PX = 8;

/** The element a pointer at circuit point `p` hits: the topmost element (the
 *  last in `elements`, drawn last) whose distance is within `tolerancePx`
 *  screen pixels at `scale`. `distanceToElement` measures circuit units, so the
 *  reach is the pixel tolerance divided by the scale: a fixed on-screen reach
 *  grabs the same elements zoomed out to 0.15 or in to 6 (the port's analogue
 *  of upstream's `boundingBox.contains` gate, MouseManager.java:812-821). A
 *  non-positive scale hits nothing. */
export function hitTestElement(
  p: Point,
  elements: readonly CircuitElement[],
  scale: number,
  tolerancePx = HIT_TOLERANCE_PX,
): CircuitElement | null {
  if (!Number.isFinite(scale) || scale <= 0) return null;
  const reach = tolerancePx / scale;
  // The topmost element (last in `elements`) within reach wins, so walk back
  // to front and return the first hit.
  for (let i = elements.length - 1; i >= 0; i--) {
    if (distanceToElement(p, elements[i]) <= reach) {
      return elements[i];
    }
  }
  return null;
}

/** Shortest distance from `p` to the axis-aligned box `box`: 0 when `p` is
 *  inside, else the distance to the nearest edge or corner. The body hit-test
 *  of a chip, whose whole rectangle is grabbable; normalises so a def can hand
 *  out corners in any order. */
export function distanceToBox(p: Point, box: Box): number {
  const x0 = Math.min(box.x0, box.x1);
  const x1 = Math.max(box.x0, box.x1);
  const y0 = Math.min(box.y0, box.y1);
  const y1 = Math.max(box.y0, box.y1);
  const dx = Math.max(x0 - p.x, 0, p.x - x1);
  const dy = Math.max(y0 - p.y, 0, p.y - y1);
  return Math.hypot(dx, dy);
}

/**
 * Which stored endpoint of `e` is nearer to `p`: 1 for `(x1, y1)`, 2 for
 * `(x2, y2)`. A tie at the exact midpoint goes to post 1, deterministically,
 * so a drag from the centre does not flicker between ends.
 */
export function nearestPost(p: Point, e: CircuitElement): 1 | 2 {
  const d1 = Math.hypot(p.x - e.x1, p.y - e.y1);
  const d2 = Math.hypot(p.x - e.x2, p.y - e.y2);
  return d1 <= d2 ? 1 : 2;
}

/**
 * True if `post` on `e` is already at `x`, `y`. A missing element reads as
 * false, so the caller can treat the result as "do not write".
 */
export function postAt(e: CircuitElement | undefined, post: 1 | 2, x: number, y: number): boolean {
  if (e === undefined) return false;
  return post === 1 ? e.x1 === x && e.y1 === y : e.x2 === x && e.y2 === y;
}

/** The endpoint fields a `dragpost` drag of `post` should patch. */
export function postPatch(
  post: 1 | 2,
  x: number,
  y: number,
): { x1: number; y1: number } | { x2: number; y2: number } {
  return post === 1 ? { x1: x, y1: y } : { x2: x, y2: y };
}
