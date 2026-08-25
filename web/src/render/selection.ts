/** Pure rubber-band selection policy, kept headless so it is unit-testable
 *  without a canvas: the box, the overlap test and the add/replace semantics
 *  (CircuitElm.selectRect, CircuitElm.java:1326-1331). */

import type { Box, CircuitElement, Point } from '../model/types';
import { defFor, postsOf } from '../model/registry';

/** Normalised box spanning two drag corners, whatever direction the user drew. */
export function boxFromPoints(a: Point, b: Point): Box {
  return {
    x0: Math.min(a.x, b.x),
    y0: Math.min(a.y, b.y),
    x1: Math.max(a.x, b.x),
    y1: Math.max(a.y, b.y),
  };
}

/**
 * Union of an element's posts, the port's `boundingBox` equivalent: exactly
 * the endpoint rectangle for a two-terminal part, the union of the drawn posts
 * for a multi-terminal one. A stem-bearing one-post part (whose free end is a
 * draggable control point, not a post) spans its stored endpoints instead,
 * matching upstream's getBoundingBox. A fully collapsed element gets a 1-unit
 * box, so it stays selectable (upstream setBbox's `x2-x1+1`, CircuitElm.java:
 * 857-861).
 */
export function elementBox(e: CircuitElement): Box {
  let posts = postsOf(e);
  if (posts.length === 0) {
    // A kind this build does not draw has no posts; fall back to the stored
    // endpoints so it can still be box-selected.
    posts = [
      { x: e.x1, y: e.y1 },
      { x: e.x2, y: e.y2 },
    ];
  }
  // A stem-bearing one-post part (ground, rails, logic inputs) hangs its symbol
  // off a draggable free end that is not a post. Its box must span the stored
  // endpoints like upstream's getBoundingBox (CircuitElm.java:854-861), or a
  // rail's circle would sit outside its own selection box. A one-post part
  // without a draggable end (a labeled node) keeps its single-post box. For
  // the zero-post annotations (text, box, line) the stored endpoints are the
  // whole geometry, and for an upstream-saved text they carry the drawn
  // extent (TextElm.draw updates x2,y2 from the bbox), so the span is the
  // closest thing to upstream's bounding box.
  // The key is `draggablePosts` being SET, never the `postCount` fallback: a
  // transistor or op-amp has many posts hanging off its axis, and collapsing
  // its box to the two stored endpoints would drop them from selection.
  const def = defFor(e.kind);
  if ((def?.draggablePosts ?? 0) > 1) {
    posts = [
      { x: e.x1, y: e.y1 },
      { x: e.x2, y: e.y2 },
    ];
  }
  const xs = posts.map((p) => p.x);
  const ys = posts.map((p) => p.y);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  const x1 = Math.max(...xs);
  const y1 = Math.max(...ys);
  if (x0 === x1 && y0 === y1) return { x0, y0, x1: x0 + 1, y1: y0 + 1 };
  return { x0, y0, x1, y1 };
}

/** Inclusive overlap: sharing an edge or a corner counts as a hit, matching
 *  Java's `Rectangle.intersects`. */
export function boxesIntersect(a: Box, b: Box): boolean {
  return a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;
}

/** Ids of elements whose box overlaps `box`. With add, keeps the previous
 *  selection and unions the hits; without, replaces it. Pure selection policy,
 *  the canvas and any tests call this. */
export function selectByBox(
  elements: CircuitElement[],
  box: Box,
  add: boolean,
  prevSelected: number[],
): number[] {
  const hits = elements.filter((e) => boxesIntersect(box, elementBox(e))).map((e) => e.id);
  if (add) return [...new Set([...prevSelected, ...hits])];
  return hits;
}
