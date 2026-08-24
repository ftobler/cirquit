/** Junction-dot and bad-connection policy, kept headless so it can be unit
 *  tested: upstream draws a post dot only where the post count at a coordinate
 *  is not exactly 2, so a plain two-element pass-through connection hides while
 *  dead ends and real junctions keep theirs, and paints the lone posts that
 *  merely touch another element red (makePostDrawList, SimulationManager.java:
 *  1056-1108). */

import type { CircuitElement, Point } from '../model/types';
import { postsOf } from '../model/registry';
import { chipPinsOf } from '../model/registry/chips';
import type { ChipPinDef } from '../model/registry/elements/dFlipFlop';
import { busSplitterPins } from '../model/registry/elements/busSplitter';
import { counter2Pins } from '../model/registry/elements/counter2';
import { fullAdderPins } from '../model/registry/elements/fullAdder';
import { memoryPins } from '../model/registry/elements/sram';
import { cachedBusMismatches } from '../model/busWidths';
import { pointOnWireInterior } from './geometry';
import { boxesIntersect, elementBox } from './selection';

/**
 * The pin table behind an element's posts when its kind carries one. The
 * plain chips come through `chipPinsOf`; the splitter, parallel-load counter,
 * bit-serial adder and memory families keep their tables in their own def
 * files and are the kinds whose bus modes collapse banks, which is what the
 * scan needs their `busZ` tags for.
 */
function bankedPinsOf(e: CircuitElement): ChipPinDef[] | undefined {
  switch (e.kind) {
    case 'busSplitter':
      return busSplitterPins(e);
    case 'counter2':
      return counter2Pins(e);
    case 'fullAdder':
      return fullAdderPins(e);
    case 'sram':
      return memoryPins(e, true);
    case 'rom':
      return memoryPins(e, false);
    default:
      return chipPinsOf(e);
  }
}

/**
 * The posts the dot scan counts. A collapsed bus bank declares one pin per
 * bit on a single coordinate (`busZ` 0..N-1) while drawing paints only that
 * coordinate's one lead, skipping the z > 0 duplicates (drawChip,
 * dFlipFlop.ts), so counting all N pins would keep every bank coordinate
 * looking like a busy junction forever: a label or wire anchored there can
 * never reach the quiet count of 2. Upstream avoids it by keying
 * makePostDrawList on whole Points including the bit axis; this port keeps
 * flat "x,y" keys and skips each element's z > 0 pins instead, so a bank
 * contributes 1 like the one lead it paints.
 */
function countedPosts(e: CircuitElement): Point[] {
  const posts = postsOf(e);
  // The two anchor-bank drivers have no pin table: every post is one bit
  // parked on the anchor (upstream getPost(n) = new Point(x, y, n)
  // BusLogicInputElm.java:61-63, InstructionDisplayElm.java:53-55), so the
  // anchor counts once.
  if (e.kind === 'busLogicInput' || e.kind === 'instructionDisplay') {
    return posts.slice(0, 1);
  }
  const pins = bankedPinsOf(e);
  if (!pins) return posts;
  return posts.filter((_, i) => (pins[i]?.busZ ?? 0) === 0);
}

/** Count of element posts per `x,y` coordinate, keyed `"x,y"`. A routed wire's
 *  bend vertices are not posts and contribute nothing; only the two endpoints
 *  count. A chip's collapsed bus bank counts once, per `countedPosts`. */
export function postDotPoints(elements: readonly CircuitElement[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const e of elements) {
    for (const p of countedPosts(e)) {
      const key = `${p.x},${p.y}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

/** A dot belongs at a coordinate when the post count is not exactly 2: a dead
 *  end (1) or a junction (3+), never a pass-through. */
export function shouldDrawDot(count: number): boolean {
  return count !== 2;
}

/**
 * Posts that sit on another element without connecting to it: upstream's
 * `badConnectionList`, drawn as a red dot (makePostDrawList,
 * SimulationManager.java:1075-1108, UIManager.java:708-712). A post qualifies
 * when it is the only post at its coordinate (count 1, so nothing shares it)
 * and it still lands on some other element. That is the case a move creates:
 * dropping a wire end on another wire's middle splits nothing, so the end only
 * looks connected, and the red dot is what says otherwise.
 *
 * Bus-width mismatches join the same list: upstream folds its
 * `busMismatchList` into `badConnectionList` (SimulationManager.java:1109),
 * so a coordinate where two different widths claim one net paints red and
 * tallies exactly like a dropped end. The counts arrive already collapsed per
 * bank (`postDotPoints`), so a bank coordinate qualifies as a lonely post only
 * when nothing shares it, like upstream's z-keyed list.
 *
 * A wire is tested against its drawn path rather than its bounding box, which
 * for a diagonal wire would paint a whole rectangle of false positives; every
 * other element is tested against `elementBox`, this port's `boundingBox`.
 * Parts with no posts (box, line, scope) are upstream's `GraphicElm` and are
 * skipped: they are drawing, not circuit.
 *
 * `counts` is the `postDotPoints` map, taken as a parameter so a caller that
 * already built it for the junction dots does not build it twice.
 */
export function badConnectionPoints(
  elements: readonly CircuitElement[],
  counts: Map<string, number> = postDotPoints(elements),
): Point[] {
  const bad: Point[] = [];
  const seen = new Set<string>();
  const push = (p: Point): void => {
    const k = `${p.x},${p.y}`;
    if (seen.has(k)) return;
    seen.add(k);
    bad.push(p);
  };
  for (const [key, count] of counts) {
    if (count !== 1) continue;
    const [x, y] = key.split(',').map(Number);
    const p = { x, y };
    for (const other of elements) {
      const posts = postsOf(other);
      if (posts.length === 0) continue;
      // The post's own element. With a count of 1 nothing else has a post
      // here, so this skips exactly the owner, like upstream's "does this post
      // belong to the elm" loop.
      if (posts.some((q) => q.x === x && q.y === y)) continue;
      const touches =
        other.kind === 'wire'
          ? pointOnWireInterior(p, other)
          : boxesIntersect(elementBox(other), { x0: x, y0: y, x1: x, y1: y });
      if (touches) {
        push(p);
        break;
      }
    }
  }
  for (const key of cachedBusMismatches(elements)) {
    const [x, y] = key.split(',').map(Number);
    push({ x, y });
  }
  return bad;
}

/** Last bad-connection scan, keyed by the element array it ran on. Every edit
 *  hands the store a fresh array, so an identity check is enough to know the
 *  cached points still describe what is on screen.
 *
 *  The memo is shared rather than one ref per caller: the frame loop paints the
 *  red dots and the info area counts them in the same frame, and the scan is a
 *  post count times the element list, which a running simulation should not pay
 *  twice, let alone sixty times a second. */
let lastScan: { elements: readonly CircuitElement[]; points: Point[] } = {
  elements: [],
  points: [],
};

/** `badConnectionPoints`, memoised on the element array's identity. `counts`
 *  is only consulted on a miss, so a caller that already built the post map
 *  can hand it over without forcing a rescan. */
export function cachedBadConnectionPoints(
  elements: readonly CircuitElement[],
  counts?: Map<string, number>,
): Point[] {
  if (lastScan.elements !== elements) {
    lastScan = { elements, points: badConnectionPoints(elements, counts) };
  }
  return lastScan.points;
}
