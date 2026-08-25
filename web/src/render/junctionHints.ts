/** Drag-time intersection hints, kept headless like the junction-dot policy
 *  they extend. The static view hides a junction circle wherever exactly two
 *  element posts share a coordinate (a pass-through seam, even across kinds,
 *  shouldDrawDot in junction.ts), because in a settled schematic it carries
 *  no information. While an element gesture is live that hiding is a loss:
 *  coincidence is what the engine merges on, so the owner wants the meeting
 *  points legible before committing a drop. This module answers where to
 *  draw them, and how to orient each mark: every coordinate where two
 *  distinct elements meet, plus every moving post lying on a path the drop
 *  rules act on, each drawn as a short bar normal to the chain it marks. */

import type { CircuitElement, Point } from '../model/types';
import { postsOf } from '../model/registry';
import { leadPostAt, pointOnSegmentInterior, pointOnWireInterior, wirePoints } from './geometry';

/** The Drag mode names, mirrored structurally so render/ stays independent
 *  of the ui/ gesture types; any Drag discriminates against this union. */
type GestureMode =
  | 'none'
  | 'place'
  | 'wire'
  | 'move'
  | 'dragpost'
  | 'select'
  | 'rowcol'
  | 'pan';

/** One intersection mark. `vertical` is the bar's own direction: true draws
 *  the bar standing up, which is the normal of a horizontally running chain,
 *  and false lays it across a vertical chain. */
export interface DragHint {
  x: number;
  y: number;
  vertical: boolean;
}

/** True for the gestures whose moving parts can commit on release and whose
 *  posts therefore deserve the preview: whole-element or selection moves,
 *  placement drags and single-handle post drags. Select, rowcol, pan and the
 *  wire tool change nothing about where lines meet, and an idle cursor shows
 *  the plain static rendering. Whitelisted by name rather than excluding
 *  'none', so a future Drag mode stays quiet until it opts in. */
export function dragHintsActive(drag: { mode: GestureMode }): boolean {
  return drag.mode === 'move' || drag.mode === 'place' || drag.mode === 'dragpost';
}

/**
 * The direction of `e`'s drawn path through `p`. A wire answers from the
 * segment under the point, so a routed wire turning through a bend answers
 * per leg, a bend vertex following the arriving leg. Every other kind is
 * axis-aligned wherever its lead stubs exist (leadPostAt refuses diagonals),
 * and the stored span decides. The fallback covers seam coordinates that sit
 * on an endpoint, which no interior test reaches.
 */
function directionAt(p: Point, e: CircuitElement): { dx: number; dy: number } {
  if (e.kind === 'wire') {
    const pts = wirePoints(e);
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      if (pointOnSegmentInterior(p, a, b)) {
        return { dx: b.x - a.x, dy: b.y - a.y };
      }
    }
    for (let i = 1; i < pts.length - 1; i++) {
      const q = pts[i];
      if (p.x === q.x && p.y === q.y) {
        const prev = pts[i - 1];
        return { dx: q.x - prev.x, dy: q.y - prev.y };
      }
    }
  }
  return { dx: e.x2 - e.x1, dy: e.y2 - e.y1 };
}

/** Whether two directions run one line: parallel or antiparallel, decided by
 *  an exact integer cross product. A zero direction, a collapsed span,
 *  agrees with everything. */
function colinear(
  a: { dx: number; dy: number },
  b: { dx: number; dy: number },
): boolean {
  return a.dx * b.dy - a.dy * b.dx === 0;
}

/**
 * The hint marks for one gesture frame.
 *
 * Pass 1 finds meetings: coordinates carrying posts of exactly two distinct
 * elements whose paths run one line through the coordinate. Counting
 * contributors rather than raw posts matters, because the raw count the
 * junction dots use inflates on single elements that stack several terminals
 * on one coordinate: a dangling wide bus wire presents one post per bit per
 * endpoint, and a placed part collapsed to a point carries both its posts
 * there mid-gesture. Neither is a meeting, yet the raw count of 2 hides them
 * from the dot pass; a contributor count of 1 keeps them quiet here too. The
 * colinearity demand is what keeps the mark honest: an L corner or an angled
 * join shares a post without anything continuing through it, and that is not
 * a coincident segment, so it stays unmarked like the static view leaves it.
 * Dead ends (one element) and real junctions (three or more distinct
 * elements, whose circles already show) draw nothing either.
 *
 * Pass 2 tests moving positions against the static remainder with the exact
 * predicates the drop path consults, so the preview cannot promise what a
 * release would refuse: wires through `pointOnWireInterior` (route-aware,
 * bend vertices included, the predicate `autoSplitAt` splits by) and every
 * other kind's lead stubs through `leadPostAt` (the predicate `autoSplitAt`
 * pulls leads in by). `movingPosts` narrows the tested positions to exactly
 * what travels: under a single-handle post drag only the grabbed endpoint
 * splits on release, so its stationary twin must promise nothing. When it is
 * omitted, every post of every dragged element moves, which is what move and
 * placement drags mean. Post-for-post arrivals need no test: they push a
 * coordinate to two distinct contributors and pass 1 marks it, or the circle
 * already shows at three or more.
 *
 * Returns marks deduped by coordinate, first occurrence winning, so a seam
 * and a touch agreeing on a point produce one bar.
 */
export function dragHintPoints(
  elements: readonly CircuitElement[],
  draggedIds: readonly number[] = [],
  movingPosts?: readonly Point[],
): DragHint[] {
  const hints = new Map<string, DragHint>();
  const push = (x: number, y: number, vertical: boolean): void => {
    const key = `${x},${y}`;
    if (!hints.has(key)) hints.set(key, { x, y, vertical });
  };

  // One element contributes at most once per coordinate: a meeting needs two
  // distinct owners, whatever the raw post count says. Ids keep insertion
  // order, which is document order, so the normal's tie-break is stable.
  const contributors = new Map<string, number[]>();
  for (const e of elements) {
    for (const p of postsOf(e)) {
      const key = `${p.x},${p.y}`;
      const owners = contributors.get(key);
      if (owners) {
        if (!owners.includes(e.id)) owners.push(e.id);
      } else {
        contributors.set(key, [e.id]);
      }
    }
  }
  const byId = new Map(elements.map((e) => [e.id, e]));
  for (const [key, owners] of contributors) {
    if (owners.length !== 2) continue;
    const first = byId.get(owners[0]);
    const second = byId.get(owners[1]);
    if (!first || !second) continue;
    const [x, y] = key.split(',').map(Number);
    const d1 = directionAt({ x, y }, first);
    if (!colinear(d1, directionAt({ x, y }, second))) continue;
    push(x, y, Math.abs(d1.dx) >= Math.abs(d1.dy));
  }

  if (draggedIds.length > 0) {
    const excluded = new Set(draggedIds);
    const statics = elements.filter((e) => !excluded.has(e.id));
    let movers: Point[];
    if (movingPosts) {
      movers = [...movingPosts];
    } else {
      movers = [];
      for (const d of elements) {
        if (excluded.has(d.id)) movers.push(...postsOf(d));
      }
    }
    for (const p of movers) {
      for (const s of statics) {
        const touches =
          s.kind === 'wire' ? pointOnWireInterior(p, s) : leadPostAt(p, s) !== null;
        if (touches) {
          // The bar marks the static chain the post lands on, so its normal
          // follows that chain, not the dragged part.
          const d = directionAt(p, s);
          push(p.x, p.y, Math.abs(d.dx) >= Math.abs(d.dy));
          break;
        }
      }
    }
  }
  return [...hints.values()];
}

/** Last hint scan, keyed by everything the answer depends on: the scene
 *  array, the dragged id list and the moving positions. Every edit hands the
 *  store a fresh array, so an identity check covers the scene; the lists
 *  cover the gesture, since the same scene under a post drag answers
 *  differently from the same scene under a move. The comment on
 *  `cachedBadConnectionPoints` explains why this layer shares one
 *  module-level cache instead of per-caller refs. */
let lastHints: {
  elements: readonly CircuitElement[];
  dragged: string;
  movers: string;
  points: DragHint[];
} = { elements: [], dragged: '', movers: '', points: [] };

/** `dragHintPoints`, memoised for the frame loop, which recomputes once per
 *  invalidation (each grid step of a move drag bumps the store array) and
 *  otherwise reuses the scan across its draw passes. */
export function cachedDragHints(
  elements: readonly CircuitElement[],
  draggedIds: readonly number[],
  movingPosts?: readonly Point[],
): DragHint[] {
  const dragged = draggedIds.join(',');
  const movers = movingPosts ? JSON.stringify(movingPosts) : '';
  if (
    lastHints.elements !== elements ||
    lastHints.dragged !== dragged ||
    lastHints.movers !== movers
  ) {
    lastHints = {
      elements,
      dragged,
      movers,
      points: dragHintPoints(elements, draggedIds, movingPosts),
    };
  }
  return lastHints.points;
}
