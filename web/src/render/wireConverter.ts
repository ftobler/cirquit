/**
 * Chain-merging for the Convert Wires to Routed Wires command, a port of
 * WireConverter.convertWires (WireConverter.java:11-106). Pure and headless:
 * it takes the element list and returns the replacement list.
 *
 * Plain wires whose interiors have exactly degree 2 merge into one routed wire
 * carrying the ordered polyline; a junction (3+ wires at one point) or a
 * non-wire element's post keeps the chain from crossing that point. A closed
 * loop, where every point has degree 2, is left alone (WireConverter.java:
 * 170-171). The merged wire keeps the first chain wire's id, so scopes and
 * order slots attached to it survive.
 */

import type { CircuitElement } from '../model/types';
import { postsOf } from '../model/registry';

const key = (x: number, y: number) => `${x},${y}`;

const parseKey = (k: string): [number, number] => {
  const parts = k.split(',');
  return [Number(parts[0]), Number(parts[1])];
};

function addToList(map: Map<string, CircuitElement[]>, k: string, w: CircuitElement): void {
  const list = map.get(k);
  if (list) list.push(w);
  else map.set(k, [w]);
}

/** Depth-first walk along wires whose shared points have degree 2. */
function buildChain(
  start: CircuitElement,
  pointCount: Map<string, number>,
  pointToWires: Map<string, CircuitElement[]>,
  visited: Set<number>,
): CircuitElement[] {
  const chain: CircuitElement[] = [];
  const stack = [start];
  while (stack.length > 0) {
    const w = stack.pop()!;
    if (visited.has(w.id)) continue;
    visited.add(w.id);
    chain.push(w);
    for (const k of [key(w.x1, w.y1), key(w.x2, w.y2)]) {
      // Only degree-2 points extend the chain; a junction or a non-wire post
      // stops it there.
      if (pointCount.get(k) === 2) {
        for (const n of pointToWires.get(k) ?? []) {
          if (!visited.has(n.id)) stack.push(n);
        }
      }
    }
  }
  return chain;
}

/** Orders a chain into the polyline from one chain endpoint to the other, or
 *  null for a closed loop with no degree-!=2 point to start from. */
function orderChain(
  chain: CircuitElement[],
  pointCount: Map<string, number>,
): [number, number][] | null {
  const local = new Map<string, CircuitElement[]>();
  for (const w of chain) {
    addToList(local, key(w.x1, w.y1), w);
    addToList(local, key(w.x2, w.y2), w);
  }

  let startWire: CircuitElement | null = null;
  let startKey = '';
  for (const w of chain) {
    for (const k of [key(w.x1, w.y1), key(w.x2, w.y2)]) {
      if (pointCount.get(k) !== 2) {
        startWire = w;
        startKey = k;
        break;
      }
    }
    if (startWire) break;
  }
  if (startWire === null) return null;  // closed loop, skip

  const points: [number, number][] = [parseKey(startKey)];
  const used = new Set<number>();
  let current: CircuitElement | null = startWire;
  let currentPt = startKey;
  while (current !== null) {
    used.add(current.id);
    const k1 = key(current.x1, current.y1);
    const k2 = key(current.x2, current.y2);
    const otherEnd = k1 === currentPt ? k2 : k1;
    points.push(parseKey(otherEnd));
    current = null;
    if (pointCount.get(otherEnd) === 2) {
      for (const n of local.get(otherEnd) ?? []) {
        if (!used.has(n.id)) {
          current = n;
          currentPt = otherEnd;
          break;
        }
      }
    }
  }
  return points;
}

/**
 * Converts plain wires into routed wires. When `selectedIds` holds at least one
 * plain wire, only those convert; otherwise every plain wire converts, the
 * same selection rule as upstream (WireConverter.java:15-21). Returns a new
 * element list; elements that neither participate in a chain nor sit on a
 * route keep their identity, so the store can diff cheaply.
 */
export function convertWires(
  elements: readonly CircuitElement[],
  selectedIds?: readonly number[],
): CircuitElement[] {
  const hasSelection =
    selectedIds !== undefined &&
    selectedIds.length > 0 &&
    elements.some((e) => e.kind === 'wire' && !e.route && selectedIds.includes(e.id));
  const wires = elements.filter(
    (e) => e.kind === 'wire' && !e.route && (!hasSelection || (selectedIds ?? []).includes(e.id)),
  );
  if (wires.length === 0) return elements.slice();

  const pointCount = new Map<string, number>();
  const inc = (k: string) => pointCount.set(k, (pointCount.get(k) ?? 0) + 1);
  for (const w of wires) {
    inc(key(w.x1, w.y1));
    inc(key(w.x2, w.y2));
  }

  // A non-wire element's post can never be a chain interior: bump the count by
  // 2 so it cannot read as exactly 2 (WireConverter.java:42-55).
  for (const e of elements) {
    if (e.kind === 'wire') continue;
    for (const p of postsOf(e)) {
      const k = key(p.x, p.y);
      if (pointCount.has(k)) {
        inc(k);
        inc(k);
      }
    }
  }

  const pointToWires = new Map<string, CircuitElement[]>();
  for (const w of wires) {
    addToList(pointToWires, key(w.x1, w.y1), w);
    addToList(pointToWires, key(w.x2, w.y2), w);
  }

  const visited = new Set<number>();
  const chains: CircuitElement[][] = [];
  for (const w of wires) {
    if (!visited.has(w.id)) chains.push(buildChain(w, pointCount, pointToWires, visited));
  }

  const removed = new Set<number>();
  const routed: CircuitElement[] = [];
  for (const chain of chains) {
    if (chain.length === 1) {
      // A single wire converts directly with its two-point route
      // (WireConverter.java:82-92).
      const w = chain[0];
      removed.add(w.id);
      routed.push({ ...w, route: [[w.x1, w.y1], [w.x2, w.y2]] });
      continue;
    }
    const orderedPoints = orderChain(chain, pointCount);
    if (orderedPoints === null || orderedPoints.length < 3) continue;  // closed loop, skip
    const first = chain[0];
    for (const w of chain) removed.add(w.id);
    const last = orderedPoints[orderedPoints.length - 1];
    routed.push({
      ...first,
      x1: orderedPoints[0][0],
      y1: orderedPoints[0][1],
      x2: last[0],
      y2: last[1],
      route: orderedPoints,
    });
  }
  if (removed.size === 0) return elements.slice();
  return elements.filter((e) => !removed.has(e.id)).concat(routed);
}
