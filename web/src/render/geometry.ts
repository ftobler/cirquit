/**
 * Pure geometry for hit-testing and post dragging, kept headless so it can be
 * unit tested without a canvas (AGENTS.md: deleting the canvas must not delete
 * the logic).
 */

import type { CircuitElement, Point } from '../model/types';
import { defFor, postsOf } from '../model/registry';

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
  if (!pointOnSegmentInterior(p, { x: wire.x1, y: wire.y1 }, { x: wire.x2, y: wire.y2 })) {
    return null;
  }
  return [
    { ...wire, id: nextId(), x2: p.x, y2: p.y },
    { ...wire, id: nextId(), x1: p.x, y1: p.y },
  ];
}

/**
 * The grid point where a `dragpost` drag of `e`'s post lands, when that point
 * sits on another wire's interior and therefore cannot connect: the position
 * of upstream's red no-connect dot (its `badConnectionList`, drawn at
 * UIManager.java:708-712). Returns null when the drop would connect: over an
 * endpoint, off any wire, or on a coordinate some third element's post already
 * occupies (a real junction). Only `wire` interiors count; other element
 * bodies connect at posts, not interiors.
 */
export function invalidDropPoint(
  e: CircuitElement,
  x: number,
  y: number,
  elements: readonly CircuitElement[],
): Point | null {
  const p = { x, y };
  for (const other of elements) {
    if (other.id === e.id || other.kind !== 'wire') continue;
    if (!pointOnSegmentInterior(p, { x: other.x1, y: other.y1 }, { x: other.x2, y: other.y2 })) {
      continue;
    }
    const occupied = elements.some(
      (q) => q.id !== e.id && q.id !== other.id && postsOf(q).some((pp) => pp.x === p.x && pp.y === p.y),
    );
    if (occupied) return null;
    return p;
  }
  return null;
}

/** Distance from a point to an element, measured against all of its limbs. */
export function distanceToElement(p: Point, e: CircuitElement): number {
  const posts = postsOf(e);
  if (posts.length <= 1) {
    const near = Math.hypot(p.x - e.x1, p.y - e.y1);
    // A ground's free end is a draggable control point, not a post, so its
    // stem must be hittable along the whole span or the far end could never
    // be clicked to ctrl-drag it. Other single-post parts (text, readouts)
    // keep their stray `x2, y2` out of hit-testing.
    const def = defFor(e.kind);
    if ((def?.draggablePosts ?? def?.postCount ?? 0) > 1) {
      return Math.min(near, distanceToSegment(p, { x: e.x1, y: e.y1 }, { x: e.x2, y: e.y2 }));
    }
    return near;
  }
  const body = distanceToSegment(p, { x: e.x1, y: e.y1 }, { x: e.x2, y: e.y2 });
  // Multi-terminal parts have limbs off the main axis, so also test each
  // terminal by its own distance; the nearer of the body line and a post wins.
  const nearPost = Math.min(...posts.map((q) => Math.hypot(p.x - q.x, p.y - q.y)));
  return Math.min(body, nearPost);
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
