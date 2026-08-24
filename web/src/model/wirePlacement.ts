/**
 * Wire placement geometry.
 *
 * A wire is placed differently from every other element. The rest of the
 * palette drops exactly one part spanning the drag, diagonal included; a wire
 * is never diagonal, and a drag that goes both across and down inserts an
 * L of two wires instead of one sloping one. So a wire drag produces 0, 1 or
 * 2 elements rather than the fixed 1 a part placement produces.
 *
 * Which way round the L bends is decided by the direction the drag first
 * moved, not by where it ends up: the corner sits on the axis the hand
 * started along, so a drag that sets off sideways runs across first and then
 * down, and one that sets off downwards runs down first and then across.
 * Deciding it from the final offset instead would flip the corner under the
 * cursor mid-drag whenever the pointer crossed the diagonal.
 *
 * Both functions are pure and take grid-snapped points; the caller owns the
 * snapping, as it does for every other placement.
 */

import type { CircuitElement, Point } from './types';
import { postsOf } from './registry';

/** The axis a wire drag runs along first. 'h' bends across then down, 'v'
 *  down then across. */
export type WireAxis = 'h' | 'v';

/** One segment of the inserted run, in the store's endpoint form. */
export interface WireSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * The axis a drag has committed to, or null while the pointer has not left
 * the anchor cell and there is nothing to commit to yet. The larger of the
 * two offsets wins; a perfectly diagonal first move takes the horizontal, the
 * same tie-break `dominantAxisSnap` uses for the multi-post parts.
 *
 * The caller latches the first non-null answer for the rest of the gesture.
 */
export function wireDragAxis(start: Point, p: Point): WireAxis | null {
  const dx = Math.abs(p.x - start.x);
  const dy = Math.abs(p.y - start.y);
  if (dx === 0 && dy === 0) return null;
  return dx >= dy ? 'h' : 'v';
}

/**
 * The wires a drag from `start` to `end` inserts, in drag order: the segment
 * leaving the anchor first, then the one arriving at the cursor.
 *
 * Empty when the drag never left the anchor, one segment when it stayed on a
 * single axis, two when it did both. No segment is ever diagonal and no
 * segment is ever zero length, so the caller never has to filter the result.
 */
export function wireSegments(start: Point, end: Point, axis: WireAxis): WireSegment[] {
  // The corner is where the run turns: along the committed axis from the
  // anchor, then square to the cursor.
  const corner = axis === 'h' ? { x: end.x, y: start.y } : { x: start.x, y: end.y };
  const legs: [Point, Point][] = [
    [start, corner],
    [corner, end],
  ];
  return legs
    .filter(([a, b]) => a.x !== b.x || a.y !== b.y)
    .map(([a, b]) => ({ x1: a.x, y1: a.y, x2: b.x, y2: b.y }));
}

/**
 * The junction posts lying strictly inside a freshly drawn wire, ordered from
 * (x1, y1) so the caller can walk the span end to end. Upstream collects its
 * split points from the post-draw list and sorts them by squared distance
 * from the drag's anchor (WireElm.draggingDone). Coordinates are grid
 * integers, so collinearity is an exact cross product and needs no tolerance;
 * repeated points collapse so the boundary walk never makes a zero-length
 * piece.
 */
export function interiorPostHits(seg: WireSegment, posts: readonly Point[]): Point[] {
  const x0 = Math.min(seg.x1, seg.x2);
  const x1 = Math.max(seg.x1, seg.x2);
  const y0 = Math.min(seg.y1, seg.y2);
  const y1 = Math.max(seg.y1, seg.y2);
  const dx = seg.x2 - seg.x1;
  const dy = seg.y2 - seg.y1;
  const hits = posts.filter((p) => {
    if ((p.x === seg.x1 && p.y === seg.y1) || (p.x === seg.x2 && p.y === seg.y2)) return false;
    if (p.x < x0 || p.x > x1 || p.y < y0 || p.y > y1) return false;
    return (p.x - seg.x1) * dy - (p.y - seg.y1) * dx === 0;
  });
  hits.sort(
    (a, b) =>
      (a.x - seg.x1) * (a.x - seg.x1) +
      (a.y - seg.y1) * (a.y - seg.y1) -
      ((b.x - seg.x1) * (b.x - seg.x1) + (b.y - seg.y1) * (b.y - seg.y1)),
  );
  const out: Point[] = [];
  for (const p of hits) {
    const last = out[out.length - 1];
    if (last && last.x === p.x && last.y === p.y) continue;
    out.push(p);
  }
  return out;
}

/**
 * Whether some other two-terminal element already joins `a` to `b` directly,
 * upstream's hasDirectConnection (WireElm.java:245-256): both of its posts sit
 * exactly on those two coordinates. A sub-segment with such a twin would lie
 * parallel on top of the existing part, an electrical loop over an already
 * made connection, so the splitter drops it instead of adding it. `skip` is
 * the caller's exclusion set: the store hands in every id its gesture is
 * replacing, the port's wider form of upstream's single `ce == this` check.
 */
export function duplicatesColinearElement(
  elements: readonly CircuitElement[],
  skip: ReadonlySet<number>,
  a: Point,
  b: Point,
): boolean {
  return elements.some((e) => {
    if (skip.has(e.id)) return false;
    const posts = postsOf(e);
    if (posts.length !== 2) return false;
    const [p, q] = posts;
    return (
      (p.x === a.x && p.y === a.y && q.x === b.x && q.y === b.y) ||
      (p.x === b.x && p.y === b.y && q.x === a.x && q.y === a.y)
    );
  });
}
