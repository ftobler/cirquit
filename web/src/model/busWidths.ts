/**
 * Bus-width resolution: which plain wires are really N-bit buses.
 *
 * Upstream re-derives every wire's `busWidth` from topology on each analysis
 * pass (`detectBusWidths`, SimulationManager.java:140-225): wide pins seed a
 * per-coordinate width map, then widths flood through wire chains AND
 * same-named labels until stable, so a plain wire drawn onto a splitter's bus
 * side becomes part of that bus and a label carries its width to every
 * same-named label in the schematic. This module is the same pass, kept
 * headless and memoised on the element array's identity like the junction-dot
 * scan.
 *
 * A wire's effective width is the maximum of its own saved token and the
 * propagated one, which is friendlier than upstream's overwrite (an isolated
 * wire with an explicit token keeps its width) and agrees with it for every
 * file that comes from real use.
 *
 * Where two different widths claim one coordinate, both are recorded: the
 * larger still wins electrically, but the coordinate joins the mismatch set
 * that draws as red bad-connection dots (upstream's `busMismatchList`, folded
 * into `badConnectionList`, SimulationManager.java:1109).
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

/** Everything one resolve pass produces: the widths the engine and renderer
 *  build against, plus the coordinates where declared widths disagree with
 *  what propagation settled on. */
export interface BusResolution {
  /** Effective width per element id (wires always; labeled nodes once wide).
   *  Widths of one are absent from the map. */
  widths: Map<number, number>;
  /** Coordinates where two different widths claim one connection, keyed
   *  "x,y". Upstream paints these as red bad-connection dots. */
  mismatches: Set<string>;
}

/**
 * Resolves widths over the whole element list, mirroring upstream's
 * detectBusWidths phase by phase: non-wire wide pins seed a per-coordinate
 * map, wires and labeled nodes flood widths until stable (labels through a
 * by-text map, SimulationManager.java:184-199), then every wide pin is
 * rechecked against the propagated map so direct and wire-mediated
 * disagreements both surface.
 *
 * Mismatch detection deliberately stays out of the flood itself: seeding a
 * coordinate twice during propagation is an artefact of element order, not a
 * wiring mistake, and only the declared-pin checks upstream performs are
 * order-stable.
 */
export function resolveBusWidths(elements: readonly CircuitElement[]): BusResolution {
  const widthAt = new Map<string, number>();
  const mismatches = new Set<string>();
  /** Flood feedback: upgrade a coordinate's width silently, since two passes
   *  disagreeing mid-flood is an artefact of element order, not wiring. */
  const raise = (p: Point, w: number): boolean => {
    const k = keyOf(p);
    const cur = widthAt.get(k);
    if (cur !== undefined && cur >= w) return false;
    widthAt.set(k, w);
    return true;
  };

  // Seeding pass: a coordinate claimed by two different declared widths is a
  // genuine disagreement (SimulationManager.java:150-155).
  for (const e of elements) {
    for (const g of wideGroupsOf(e)) {
      const k = keyOf(g.at);
      const cur = widthAt.get(k);
      if (cur !== undefined && cur !== g.width) mismatches.add(k);
      if (cur === undefined || g.width > cur) widthAt.set(k, g.width);
    }
  }

  const result = new Map<number, number>();
  // Widest width seen per label text, upstream's labelWidthMap: it is how a
  // label carries its width to every same-named label in the schematic.
  const labelWidthBy = new Map<string, number>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const e of elements) {
      if (e.kind === 'wire') {
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
          if (raise(p1, w)) changed = true;
          if (raise(p2, w)) changed = true;
        }
        if ((result.get(e.id) ?? 1) !== w) {
          result.set(e.id, w);
          changed = true;
        }
        continue;
      }
      // Labels join the flood like wires do: a labeled node resolves to the
      // larger of its own coordinate's width and the widest same-named
      // label, then feeds both back (SimulationManager.java:184-199). It
      // declares no width of its own, so it can never disagree.
      if (e.kind !== 'labeledNode') continue;
      const text = e.text ?? '';
      if (!text) continue;
      const p = { x: e.x1, y: e.y1 };
      const k = keyOf(p);
      const wCoord = widthAt.get(k);
      const wLabel = labelWidthBy.get(text);
      let w = wCoord ?? 1;
      if (wLabel !== undefined && wLabel > w) w = wLabel;
      if ((result.get(e.id) ?? 1) !== w) {
        result.set(e.id, w);
        changed = true;
      }
      if (w > 1) {
        // Seed both back so the coordinate and every same-named label
        // converge on the widest claim, upstream's two map writes.
        if (raise(p, w)) changed = true;
        if (wLabel === undefined || wLabel < w) {
          labelWidthBy.set(text, w);
          changed = true;
        }
      }
    }
  }

  // Final recheck: a wide pin whose declared width disagrees with what
  // propagation settled on its coordinate is a real wiring mistake, direct
  // or down a wire chain (SimulationManager.java:212-228). Splitter bus sides
  // participate like any pin.
  for (const e of elements) {
    for (const g of wideGroupsOf(e)) {
      const k = keyOf(g.at);
      const propagated = widthAt.get(k);
      if (propagated !== undefined && propagated !== g.width) mismatches.add(k);
    }
  }

  return { widths: result, mismatches };
}

/** Terminal coordinates for rendering: a bus wire expands to N copies of
 *  each endpoint at its resolved width, and a wide labeled node to N copies
 *  of its anchor, matching exactly what `setCircuit` hands the engine, so
 *  per-bit reads (the bus-value caption, per-lead dots) see every bit even
 *  when no token was saved. Every other element defers to its definition. */
export function postsForRender(e: CircuitElement, widths: Map<number, number>): Point[] {
  if (e.kind === 'wire') {
    const width = widths.get(e.id) ?? storedBusWidth(e);
    if (width === 1) return postsOf(e);
    const posts: Point[] = [];
    for (let i = 0; i < width; i++) posts.push({ x: e.x1, y: e.y1 });
    for (let i = 0; i < width; i++) posts.push({ x: e.x2, y: e.y2 });
    return posts;
  }
  if (e.kind === 'labeledNode') {
    const width = widths.get(e.id) ?? 1;
    if (width === 1) return postsOf(e);
    return Array.from({ length: width }, () => ({ x: e.x1, y: e.y1 }));
  }
  return postsOf(e);
}

/** Memoised [`resolveBusWidths`] keyed on the element array's identity, the
 *  same cache shape the bad-connection scan uses: edits hand the store a
 *  fresh array, so identity is enough to know the results are stale. Both
 *  accessors share one resolve. */
let lastResolve: {
  elements: readonly CircuitElement[];
  widths: Map<number, number>;
  mismatches: Set<string>;
} | null = null;

function resolveOnce(elements: readonly CircuitElement[]): void {
  if (lastResolve === null || lastResolve.elements !== elements) {
    const r = resolveBusWidths(elements);
    lastResolve = { elements, widths: r.widths, mismatches: r.mismatches };
  }
}

export function cachedBusWidths(elements: readonly CircuitElement[]): Map<number, number> {
  resolveOnce(elements);
  return lastResolve!.widths;
}

export function cachedBusMismatches(elements: readonly CircuitElement[]): Set<string> {
  resolveOnce(elements);
  return lastResolve!.mismatches;
}
