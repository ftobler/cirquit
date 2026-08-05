/**
 * Pure geometry for hit-testing and post dragging, kept headless so it can be
 * unit tested without a canvas (AGENTS.md: deleting the canvas must not delete
 * the logic).
 */

import type { CircuitElement, Point } from '../model/types';
import { postsOf } from '../model/registry';

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

/** Distance from a point to an element, measured against all of its limbs. */
export function distanceToElement(p: Point, e: CircuitElement): number {
  const posts = postsOf(e);
  if (posts.length <= 1) {
    return Math.hypot(p.x - e.x1, p.y - e.y1);
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
