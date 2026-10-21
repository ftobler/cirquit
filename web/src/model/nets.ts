/** Net assignment: which terminal of which element lands on which node.
 *
 *  The engine owns this (`assign_nodes` in `engine/core/src/circuit.rs`), but
 *  the read side needs the same numbering to report a node per post. The
 *  `SimHost` surface exposes node voltages indexed by the engine's node number
 *  but not the post-to-node map, so this is the port's own mirror of the
 *  engine's union-find: terminals merge on coordinate plus bus bit, a labeled
 *  node merges by its text, wires and closed switches are ideal shorts, and
 *  every ground symbol pins its component to node 0. `queries.engine.test.ts`
 *  pins the mirror against the engine's own `elementNodes()` for a real build,
 *  which is what keeps the duplication honest.
 *
 *  Pure and wasm-free, so it runs headless. */

import { cachedBusWidths, postsForRender } from './busWidths';
import { normalizeBusSplitterBits } from './registry/elements/busSplitter';
import { storedBusWidth } from './registry/elements/wire';
import type { CircuitElement } from './types';

/** One-post voltage sources: a rail-family part suppresses the engine's
 *  "no ground symbol" fallback, because grounding its terminal would leave a
 *  degenerate ground-to-ground source row (SimulationManager.java:517-528). */
const ONE_POST_VOLTAGE_SOURCES: ReadonlySet<string> = new Set([
  'rail',
  'varRail',
  'extVoltage',
  'sweep',
  'antenna',
  'logicInput',
  'busLogicInput',
  'noise',
  'am',
  'fm',
  'audioInput',
  'dataInput',
]);

/** A terminal's bus bit at its coordinate, upstream's `Point.z`. */
function busZOf(e: CircuitElement, post: number, width: number): number {
  switch (e.kind) {
    case 'wire':
      return width === 1 ? 0 : post % width;
    case 'labeledNode':
      return post;
    case 'busSplitter':
      return post < normalizeBusSplitterBits(e.params.bits ?? 4)
        ? post
        : 0;
    default:
      return 0;
  }
}

/** The resolved width a kind's terminal list is laid out at. */
function widthOf(e: CircuitElement, widths: Map<number, number>): number {
  switch (e.kind) {
    case 'wire':
      return widths.get(e.id) ?? storedBusWidth(e);
    case 'labeledNode':
      return widths.get(e.id) ?? 1;
    case 'busSplitter':
      return normalizeBusSplitterBits(e.params.bits ?? 4);
    default:
      return 1;
  }
}

/** The post pairs an ideal short merges, the port's `removable_wire_pair`
 *  family: a wire merges its two ends per bit, a closed switch its two posts,
 *  a bus splitter one bus pin to one output pin per bit. */
function shortPairs(e: CircuitElement, width: number): [number, number][] {
  if (e.kind === 'wire') {
    const pairs: [number, number][] = [];
    for (let k = 0; k < width; k++) pairs.push([k, k + width]);
    return pairs;
  }
  if (e.kind === 'switch' && (e.state ?? 0) === 0) return [[0, 1]];
  if (e.kind === 'busSplitter') {
    const bits = normalizeBusSplitterBits(e.params.bits ?? 4);
    const pairs: [number, number][] = [];
    for (let k = 0; k < bits; k++) pairs.push([k, k + bits]);
    return pairs;
  }
  return [];
}

class UnionFind {
  private parent: number[];

  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }

  find(i: number): number {
    let r = i;
    while (this.parent[r] !== r) r = this.parent[r];
    // Path compression keeps a long wire chain from degrading the next find.
    while (this.parent[i] !== r) {
      const next = this.parent[i];
      this.parent[i] = r;
      i = next;
    }
    return r;
  }

  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[ra] = rb;
  }
}

export interface NetAssignment {
  /** Node number per `id:post`, the engine's numbering. */
  nodeOf: Map<string, number>;
  /** Node number per flattened post, in element order then post order, exactly
   *  the engine's `elementNodes()` layout. */
  nodes: number[];
  /** Total nodes, the reference included. */
  count: number;
}

/** Assigns the engine's node numbers to every post. `widths` defaults to the
 *  memoised bus resolution over `elements`, the same one the renderer and the
 *  engine build read. */
export function assignNodes(
  elements: readonly CircuitElement[],
  widths: Map<number, number> = cachedBusWidths(elements),
): NetAssignment {
  const offsets: number[] = [];
  const postLists: { x: number; y: number; bit: number }[][] = [];
  let total = 0;
  for (const e of elements) {
    offsets.push(total);
    const width = widthOf(e, widths);
    const posts = postsForRender(e, widths).map((p, i) => ({
      x: p.x,
      y: p.y,
      bit: busZOf(e, i, width),
    }));
    postLists.push(posts);
    total += posts.length;
  }

  const uf = new UnionFind(Math.max(total, 1));
  const byCoord = new Map<string, number>();
  const byLabel = new Map<string, number>();
  for (let ei = 0; ei < elements.length; ei++) {
    const e = elements[ei];
    const posts = postLists[ei];
    const width = widthOf(e, widths);
    for (let pi = 0; pi < posts.length; pi++) {
      const gi = offsets[ei] + pi;
      const key = `${posts[pi].x},${posts[pi].y},${posts[pi].bit}`;
      const seen = byCoord.get(key);
      if (seen === undefined) byCoord.set(key, gi);
      else uf.union(gi, seen);
      // A labeled node joins same-named labels rather than a coordinate: a
      // wide label keys per bit, a narrow one with no bit, upstream's two
      // closure-key forms (LabeledNodeElm.java:99, :137-140).
      if (e.kind === 'labeledNode' && (e.text ?? '') !== '') {
        const labelKey = `${e.text}\u0000${width > 1 ? pi : 'n'}`;
        const prior = byLabel.get(labelKey);
        if (prior === undefined) byLabel.set(labelKey, gi);
        else uf.union(gi, prior);
      }
    }
    for (const [a, b] of shortPairs(e, width)) {
      uf.union(offsets[ei] + a, offsets[ei] + b);
    }
  }

  const groundRoots: number[] = [];
  for (let ei = 0; ei < elements.length; ei++) {
    if (elements[ei].kind !== 'ground') continue;
    const r = uf.find(offsets[ei]);
    if (!groundRoots.includes(r)) groundRoots.push(r);
  }
  const hasRail = elements.some(
    (e, ei) =>
      ONE_POST_VOLTAGE_SOURCES.has(e.kind) && postLists[ei].length === 1,
  );
  if (groundRoots.length === 0 && total > 0 && !hasRail) {
    groundRoots.push(uf.find(0));
  }

  const idOfRoot = new Map<number, number>();
  for (const r of groundRoots) idOfRoot.set(r, 0);
  let next = 1;
  const nodes: number[] = new Array(total);
  for (let gi = 0; gi < total; gi++) {
    const r = uf.find(gi);
    let id = idOfRoot.get(r);
    if (id === undefined) {
      id = next++;
      idOfRoot.set(r, id);
    }
    nodes[gi] = id;
  }

  const nodeOf = new Map<string, number>();
  for (let ei = 0; ei < elements.length; ei++) {
    const posts = postLists[ei];
    for (let pi = 0; pi < posts.length; pi++) {
      nodeOf.set(`${elements[ei].id}:${pi}`, nodes[offsets[ei] + pi]);
    }
  }
  return { nodeOf, nodes, count: next };
}
