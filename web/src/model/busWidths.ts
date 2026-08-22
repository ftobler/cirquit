/**
 * Bus-width resolution: which plain wires are really N-bit buses.
 *
 * Upstream re-derives every wire's `busWidth` from topology on each analysis
 * pass (`detectBusWidths`, SimulationManager.java:140-225): wide pins seed a
 * per-coordinate width map, then widths flood through wire chains until
 * stable, so a plain wire drawn onto a splitter's bus side becomes part of
 * that bus. This module is the same pass, kept headless and memoised on the
 * element array's identity like the junction-dot scan.
 *
 * A wire's effective width is the maximum of its own saved token and the
 * propagated one, which is friendlier than upstream's overwrite (an isolated
 * wire with an explicit token keeps its width) and agrees with it for every
 * file that comes from real use.
 */

import { postsOf } from './registry';
import { normalizeBusSplitterBits } from './registry/elements/busSplitter';
import { instructionDisplayBits } from './registry/elements/instructionDisplay';
import { storedBusWidth } from './registry/elements/wire';
import { counter2Pins } from './registry/elements/counter2';
import { fullAdderPins } from './registry/elements/fullAdder';
import { memoryPins } from './registry/elements/sram';
import type { ChipPinDef } from './registry/elements/dFlipFlop';
import type { CircuitElement, Point } from './types';

/** The bus-width clamp the bus-logic-input engine constructor applies. */
function normalizeBusInputWidth(value: number): number {
  if (!Number.isFinite(value)) return 4;
  return Math.min(32, Math.max(2, Math.trunc(value)));
}

interface WidePinGroup {
  /** One coordinate all of the group's posts share. */
  at: Point;
  width: number;
}

/** The wide pin groups a chip's pin table presents: one entry per collapsed
 *  bank, keyed on the coordinate the bank's first pin sits on. This is the
 *  `getPostWidth(j) > 1` half of detectBusWidths' seeding loop for the chips
 *  that support upstream's BIT_ORDER_BUS. */
function chipWideGroups(e: CircuitElement, pins: ChipPinDef[]): WidePinGroup[] {
  const posts = postsOf(e);
  const groups: WidePinGroup[] = [];
  pins.forEach((p, i) => {
    if ((p.busWidth ?? 1) <= 1 || (p.busZ ?? 0) > 0) return;
    groups.push({ at: posts[i], width: p.busWidth! });
  });
  return groups;
}

/** The wide pin groups an element presents: one entry per shared coordinate,
 *  mirroring `getPostWidth(j) > 1` in detectBusWidths' seeding loop. */
function wideGroupsOf(e: CircuitElement): WidePinGroup[] {
  const posts = postsOf(e);
  if (posts.length === 0) return [];
  if (e.kind === 'busSplitter') {
    // Every bus-side pin hangs off west position 0, so post 0's coordinate
    // is the group's; its width is the bit count.
    return [{ at: posts[0], width: normalizeBusSplitterBits(e.params.bits ?? 4) }];
  }
  if (e.kind === 'busLogicInput') {
    return [{ at: posts[0], width: normalizeBusInputWidth(e.params.busWidth ?? 4) }];
  }
  if (e.kind === 'instructionDisplay') {
    return [{ at: posts[0], width: instructionDisplayBits(e.params.busWidth ?? 4) }];
  }
  // The bus-mode chips: their collapsed banks seed the widths exactly like
  // any other wide pin, so plain wires drawn against them become buses.
  if (e.kind === 'counter2') return chipWideGroups(e, counter2Pins(e));
  if (e.kind === 'fullAdder') return chipWideGroups(e, fullAdderPins(e));
  if (e.kind === 'sram') return chipWideGroups(e, memoryPins(e, true));
  if (e.kind === 'rom') return chipWideGroups(e, memoryPins(e, false));
  return [];
}

const keyOf = (p: Point): string => `${p.x},${p.y}`;

/**
 * Effective width per wire id, resolved over the whole element list. Wires
 * whose width stays 1 are absent from the map.
 *
 * Where two different widths claim one coordinate, the larger wins silently:
 * upstream collects those into `busMismatchList` for a warning banner, which
 * this port does not surface yet.
 */
export function resolveBusWidths(elements: readonly CircuitElement[]): Map<number, number> {
  const widthAt = new Map<string, number>();
  const seed = (p: Point, w: number): boolean => {
    const k = keyOf(p);
    const cur = widthAt.get(k);
    if (cur !== undefined && cur >= w) return false;
    widthAt.set(k, w);
    return true;
  };

  for (const e of elements) {
    for (const g of wideGroupsOf(e)) seed(g.at, g.width);
  }

  const result = new Map<number, number>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const e of elements) {
      if (e.kind !== 'wire') continue;
      const p1 = { x: e.x1, y: e.y1 };
      const p2 = { x: e.x2, y: e.y2 };
      let w = storedBusWidth(e);
      const w1 = widthAt.get(keyOf(p1));
      if (w1 !== undefined && w1 > w) w = w1;
      const w2 = widthAt.get(keyOf(p2));
      if (w2 !== undefined && w2 > w) w = w2;
      if (w > 1) {
        // Feed both endpoints back so widths flood down chains and across
        // junctions until stable, exactly as the upstream loop does.
        if (seed(p1, w)) changed = true;
        if (seed(p2, w)) changed = true;
      }
      if ((result.get(e.id) ?? 1) !== w) {
        result.set(e.id, w);
        changed = true;
      }
    }
  }
  return result;
}

/** Terminal coordinates for rendering: a bus wire expands to N copies of
 *  each endpoint at its resolved width, matching exactly what `setCircuit`
 *  hands the engine, so per-bit reads (the bus-value caption, per-lead dots)
 *  see every bit even when no token was saved. Every other element defers to
 *  its definition. */
export function postsForRender(e: CircuitElement, widths: Map<number, number>): Point[] {
  if (e.kind !== 'wire') return postsOf(e);
  const width = widths.get(e.id) ?? storedBusWidth(e);
  if (width === 1) return postsOf(e);
  const posts: Point[] = [];
  for (let i = 0; i < width; i++) posts.push({ x: e.x1, y: e.y1 });
  for (let i = 0; i < width; i++) posts.push({ x: e.x2, y: e.y2 });
  return posts;
}

/** Memoised [`resolveBusWidths`] keyed on the element array's identity, the
 *  same cache shape the bad-connection scan uses: edits hand the store a
 *  fresh array, so identity is enough to know the map is stale. */
let lastResolve: { elements: readonly CircuitElement[]; widths: Map<number, number> } | null =
  null;

export function cachedBusWidths(elements: readonly CircuitElement[]): Map<number, number> {
  if (lastResolve === null || lastResolve.elements !== elements) {
    lastResolve = { elements, widths: resolveBusWidths(elements) };
  }
  return lastResolve.widths;
}
