/**
 * Orthogonal grid pathfinder for routed wires, a port of upstream's WireRouter
 * (WireRouter.java). Pure and headless: the obstacle grid, the fast L/Z
 * pattern pass and the A* over `(row, col, direction)` have no DOM, so the
 * shapes are unit-testable. Coordinates are circuit integers on the grid, so
 * the grid arithmetic is exact.
 *
 * `routeWire` is the whole entry point: it sizes a grid over the endpoints and
 * the obstacles, marks the cells, and returns the corner polyline. A failed
 * route returns `[]`, which the caller turns into a plain L-shape, exactly as
 * upstream does (RoutedWireElm.java:113-120).
 */

import { GRID_SIZE, type CircuitElement, type Point } from '../model/types';
import { postsOf } from '../model/registry';

const OBSTACLE = 1;
const HORIZONTAL = 2;
const VERTICAL = 4;

const NONE = 0;
const UP = 1;
const DOWN = 2;
const LEFT = 3;
const RIGHT = 4;

/** Cost of changing direction, so a route with fewer bends wins (WireRouter
 *  keeps this at 4.0, Java's grid distance per cell). */
const TURN_PENALTY = 4.0;
/** Negative reward for leaving a start cell whose neighbours are blocked, so a
 *  trapped endpoint is not routed through its own corner. */
const ESCAPE_BONUS = -0.4;
/** How far the pattern router detours to either side before giving up. */
const MAX_DETOUR = 5;
/** Upstream's `margin = 2` (WireRouter.java:113): the grid starts GRID_MARGIN
 *  cells before the bounds (via the origin offset) and extends 2*GRID_MARGIN
 *  past them, the exact `+ margin*2` term of upstream's row/col sizing. */
const GRID_MARGIN = 2;

/** One obstacle on the routing grid. The shapes mirror the marking calls
 *  upstream's `addRoutingObstacle` family makes: an element's body as a rect
 *  (plus its posts as points), and an existing routed wire's segments as
 *  direction cells so a new wire does not lie on top of them. */
export type WireObstacle =
  | { kind: 'rect'; x0: number; y0: number; x1: number; y1: number }
  | { kind: 'point'; x: number; y: number }
  | { kind: 'wire'; x0: number; y0: number; x1: number; y1: number };

function horizontal(d: number): boolean {
  return d === LEFT || d === RIGHT;
}

function opposite(d: number): number {
  switch (d) {
    case UP:
      return DOWN;
    case DOWN:
      return UP;
    case LEFT:
      return RIGHT;
    default:
      return LEFT;
  }
}

function manhattan(r1: number, c1: number, r2: number, c2: number): number {
  return Math.abs(r1 - r2) + Math.abs(c1 - c2);
}

/** The grid itself: obstacle and direction cells, the pattern pass and the A*.
 *  Created by `routeWire`, which owns the sizing and the obstacle marking. */
class RouterGrid {
  private readonly grid: Uint8Array;
  private readonly gridSize: number;
  private readonly originX: number;
  private readonly originY: number;

  constructor(
    private readonly rows: number,
    private readonly cols: number,
    gridSize: number,
    originX: number,
    originY: number,
  ) {
    this.grid = new Uint8Array(rows * cols);
    this.gridSize = gridSize;
    this.originX = originX;
    this.originY = originY;
  }

  valid(r: number, c: number): boolean {
    return r >= 0 && r < this.rows && c >= 0 && c < this.cols;
  }

  clearCell(r: number, c: number): void {
    if (this.valid(r, c)) this.grid[r * this.cols + c] = 0;
  }

  /** Element body rectangle, expanded half a cell like upstream's addObstacle
   *  (WireRouter.java:40-57), so a route hugs the body with a gap. */
  addObstacle(x0: number, y0: number, x1: number, y1: number): void {
    const half = Math.floor(this.gridSize / 2);
    const minR = Math.min(
      Math.floor((y0 + half - this.originY) / this.gridSize),
      Math.floor((y1 + half - this.originY) / this.gridSize),
    );
    const maxR = Math.max(
      Math.floor((y0 + half - this.originY) / this.gridSize),
      Math.floor((y1 + half - this.originY) / this.gridSize),
    );
    const minC = Math.min(
      Math.floor((x0 + half - this.originX) / this.gridSize),
      Math.floor((x1 + half - this.originX) / this.gridSize),
    );
    const maxC = Math.max(
      Math.floor((x0 + half - this.originX) / this.gridSize),
      Math.floor((x1 + half - this.originX) / this.gridSize),
    );
    for (let c = minC; c <= maxC; c++) {
      for (let r = minR; r <= maxR; r++) {
        if (this.valid(r, c)) this.grid[r * this.cols + c] |= OBSTACLE;
      }
    }
  }

  /** A single post coordinate, e.g. every other element's terminal. */
  addObstaclePoint(x: number, y: number): void {
    const r = Math.floor((y - this.originY) / this.gridSize);
    const c = Math.floor((x - this.originX) / this.gridSize);
    if (this.valid(r, c)) this.grid[r * this.cols + c] |= OBSTACLE;
  }

  /** An existing axis-aligned segment, which blocks a new wire from running
   *  parallel through the same cells (upstream's addWire, :77-95). */
  addWire(x0: number, y0: number, x1: number, y1: number): void {
    const r1 = Math.floor((y0 - this.originY) / this.gridSize);
    const c1 = Math.floor((x0 - this.originX) / this.gridSize);
    const r2 = Math.floor((y1 - this.originY) / this.gridSize);
    const c2 = Math.floor((x1 - this.originX) / this.gridSize);
    if (r1 === r2) {
      for (let c = Math.min(c1, c2); c <= Math.max(c1, c2); c++) {
        if (this.valid(r1, c)) this.grid[r1 * this.cols + c] |= HORIZONTAL;
      }
    } else {
      for (let r = Math.min(r1, r2); r <= Math.max(r1, r2); r++) {
        if (this.valid(r, c1)) this.grid[r * this.cols + c1] |= VERTICAL;
      }
    }
  }

  private canMoveTo(r: number, c: number, moveDir: number): boolean {
    if (!this.valid(r, c)) return false;
    const cell = this.grid[r * this.cols + c];
    if ((cell & OBSTACLE) !== 0) return false;
    const flag = horizontal(moveDir) ? HORIZONTAL : VERTICAL;
    return (cell & flag) === 0;
  }

  /** Preferred first directions from `(r, c)`: toward any blocked neighbour,
   *  so a trapped endpoint escapes away from its trap. */
  private getPreferredEscapeDirections(r: number, c: number): number[] {
    const prefs: number[] = [];
    if (!this.canMoveTo(r - 1, c, UP)) prefs.push(DOWN);
    if (!this.canMoveTo(r + 1, c, DOWN)) prefs.push(UP);
    if (!this.canMoveTo(r, c - 1, LEFT)) prefs.push(RIGHT);
    if (!this.canMoveTo(r, c + 1, RIGHT)) prefs.push(LEFT);
    return prefs;
  }

  /** Cost of a candidate path, or -1 when any cell is blocked. Every step
   *  costs 1, a bend costs the turn penalty, and a preferred escape direction
   *  earns the (negative) bonus (WireRouter.java:357-404). */
  private evaluatePath(
    corners: [number, number][],
    initialDir: number,
    startPrefs: number[],
  ): number {
    if (corners.length < 2) return -1;
    let cost = 0;
    let prevDir = NONE;
    let prev = corners[0];
    for (let i = 1; i < corners.length; i++) {
      const curr = corners[i];
      const dr = curr[0] - prev[0];
      const dc = curr[1] - prev[1];
      const steps = Math.max(Math.abs(dr), Math.abs(dc));
      if (steps === 0) continue;
      let moveDir: number;
      if (dr === 0 && dc > 0) moveDir = RIGHT;
      else if (dr === 0 && dc < 0) moveDir = LEFT;
      else if (dc === 0 && dr > 0) moveDir = DOWN;
      else if (dc === 0 && dr < 0) moveDir = UP;
      else return -1;  // a diagonal segment is never valid here
      let r = prev[0];
      let c = prev[1];
      for (let s = 0; s < steps; s++) {
        r += Math.sign(dr);
        c += Math.sign(dc);
        if (!this.canMoveTo(r, c, moveDir)) return -1;
      }
      cost += steps;
      if (prevDir !== NONE && moveDir !== prevDir && moveDir !== opposite(prevDir)) {
        cost += TURN_PENALTY;
      }
      prevDir = moveDir;
      prev = curr;
    }
    if (startPrefs.includes(initialDir)) cost += ESCAPE_BONUS;
    return cost;
  }

  private pixel(r: number, c: number): Point {
    return { x: c * this.gridSize + this.originX, y: r * this.gridSize + this.originY };
  }

  private pixelsFromGridPoints(pts: [number, number][]): Point[] {
    return pts.map(([r, c]) => this.pixel(r, c));
  }

  /** The fast pass: straight, L and Z patterns, cheapest first. Empty when
   *  none is clear (WireRouter.java:183-355). */
  private tryPatternRouting(sr: number, sc: number, gr: number, gc: number): Point[] {
    if (sr === gr && sc === gc) return [this.pixel(sr, sc)];

    const startPrefs = this.getPreferredEscapeDirections(sr, sc);
    let bestCost = Infinity;
    let bestCorners: [number, number][] | null = null;
    const consider = (corners: [number, number][], initialDir: number) => {
      const cost = this.evaluatePath(corners, initialDir, startPrefs);
      if (cost >= 0 && cost < bestCost) {
        bestCost = cost;
        bestCorners = corners;
      }
    };

    // L-shapes (one bend), and the straight runs.
    if (sr !== gr && sc !== gc) {
      consider(
        [
          [sr, sc],
          [sr, gc],
          [gr, gc],
        ],
        gc > sc ? RIGHT : LEFT,
      );
      consider(
        [
          [sr, sc],
          [gr, sc],
          [gr, gc],
        ],
        gr > sr ? DOWN : UP,
      );
    } else if (sr === gr) {
      consider(
        [
          [sr, sc],
          [gr, gc],
        ],
        gc > sc ? RIGHT : LEFT,
      );
    } else {
      consider(
        [
          [sr, sc],
          [gr, gc],
        ],
        gr > sr ? DOWN : UP,
      );
    }

    // Z-shapes (two bends), detouring up to MAX_DETOUR cells on both sides.
    if (sr !== gr) {
      for (let margin = 1; margin <= MAX_DETOUR; margin++) {
        for (const side of [-1, 1]) {
          for (const detourCol of [sc + side * margin, gc + side * margin]) {
            if (!this.valid(0, detourCol)) continue;
            const z: [number, number][] = [[sr, sc]];
            if (sc !== detourCol) z.push([sr, detourCol]);
            if (sr !== gr) z.push([gr, detourCol]);
            if (detourCol !== gc) z.push([gr, gc]);
            if (z.length >= 2) consider(z, detourCol > sc ? RIGHT : LEFT);
          }
        }
      }
    }
    if (sc !== gc) {
      for (let margin = 1; margin <= MAX_DETOUR; margin++) {
        for (const side of [-1, 1]) {
          for (const detourRow of [sr + side * margin, gr + side * margin]) {
            if (!this.valid(detourRow, 0)) continue;
            const z: [number, number][] = [[sr, sc]];
            if (sr !== detourRow) z.push([detourRow, sc]);
            if (sc !== gc) z.push([detourRow, gc]);
            if (detourRow !== gr) z.push([gr, gc]);
            if (z.length >= 2) consider(z, detourRow > sr ? DOWN : UP);
          }
        }
      }
    }

    return bestCorners === null ? [] : this.pixelsFromGridPoints(bestCorners);
  }

  /** A* over `(row, col, direction)` with the same cost model as the pattern
   *  pass, so a route that pattern routing cannot fit still comes out with the
   *  minimum bend count (WireRouter.java:446-541). */
  private aStar(sr: number, sc: number, gr: number, gc: number): Point[] {
    const startPrefs = this.getPreferredEscapeDirections(sr, sc);
    const gScore = new Map<string, number>();
    const cameFrom = new Map<string, string>();
    const key = (r: number, c: number, d: number) => `${r},${c},${d}`;
    // A min-heap keyed on f-score, with a sequence tie-break so equal scores
    // pop in insertion order: the route is deterministic run to run.
    const heap: { r: number; c: number; d: number; g: number; f: number; seq: number }[] = [];
    let seq = 0;
    const heapPush = (n: (typeof heap)[number]) => {
      let i = heap.length;
      heap.push(n);
      while (i > 0) {
        const p = (i - 1) >> 1;
        const a = heap[p];
        if (a.f < n.f || (a.f === n.f && a.seq < n.seq)) break;
        heap[i] = a;
        i = p;
      }
      heap[i] = n;
    };
    const heapPop = () => {
      const top = heap[0];
      const last = heap.pop()!;
      if (heap.length > 0) {
        let i = 0;
        while (true) {
          const l = 2 * i + 1;
          const r = l + 1;
          let m = i;
          if (l < heap.length) {
            const a = heap[l];
            const b = heap[m];
            if (a.f < b.f || (a.f === b.f && a.seq < b.seq)) m = l;
          }
          if (r < heap.length) {
            const a = heap[r];
            const b = heap[m];
            if (a.f < b.f || (a.f === b.f && a.seq < b.seq)) m = r;
          }
          if (m === i) break;
          heap[i] = heap[m];
          i = m;
        }
        heap[i] = last;
      }
      return top;
    };

    for (const d of [UP, DOWN, LEFT, RIGHT]) {
      if (!this.canMoveTo(sr + (d === UP ? -1 : d === DOWN ? 1 : 0), sc + (d === LEFT ? -1 : d === RIGHT ? 1 : 0), d)) {
        continue;
      }
      const k = key(sr, sc, d);
      const initG = startPrefs.includes(d) ? ESCAPE_BONUS : 0;
      gScore.set(k, initG);
      heapPush({ r: sr, c: sc, d, g: initG, f: initG + manhattan(sr, sc, gr, gc), seq: seq++ });
    }

    let bestGoal: (typeof heap)[number] | null = null;
    while (heap.length > 0) {
      const cur = heapPop();
      const curKey = key(cur.r, cur.c, cur.d);
      if (cur.g > (gScore.get(curKey) ?? Infinity)) continue;
      if (cur.r === gr && cur.c === gc && (bestGoal === null || cur.g < bestGoal.g)) {
        bestGoal = cur;
      }
      const neighbors: [number, number, number][] = [];
      if (cur.r > 0) neighbors.push([cur.r - 1, cur.c, UP]);
      if (cur.r < this.rows - 1) neighbors.push([cur.r + 1, cur.c, DOWN]);
      if (cur.c > 0) neighbors.push([cur.r, cur.c - 1, LEFT]);
      if (cur.c < this.cols - 1) neighbors.push([cur.r, cur.c + 1, RIGHT]);
      for (const [nr, nc, moveDir] of neighbors) {
        if (!this.canMoveTo(nr, nc, moveDir)) continue;
        let moveCost = 1;
        if (moveDir !== cur.d && moveDir !== opposite(cur.d)) moveCost += TURN_PENALTY;
        const nKey = key(nr, nc, moveDir);
        const tentG = cur.g + moveCost;
        if (tentG < (gScore.get(nKey) ?? Infinity)) {
          cameFrom.set(nKey, curKey);
          gScore.set(nKey, tentG);
          heapPush({
            r: nr,
            c: nc,
            d: moveDir,
            g: tentG,
            f: tentG + manhattan(nr, nc, gr, gc),
            seq: seq++,
          });
        }
      }
    }

    if (bestGoal === null) return [];
    const fullPath: [number, number][] = [];
    let curKey: string | undefined = key(bestGoal.r, bestGoal.c, bestGoal.d);
    while (curKey !== undefined) {
      const parts = curKey.split(',');
      fullPath.unshift([Number(parts[0]), Number(parts[1])]);
      curKey = cameFrom.get(curKey);
    }
    return this.pixelsFromGridPoints(this.compressPath(fullPath));
  }

  /** Drops intermediate collinear points, leaving only the bends and ends. */
  private compressPath(fullPath: [number, number][]): [number, number][] {
    if (fullPath.length <= 2) return fullPath.slice();
    const minimal: [number, number][] = [fullPath[0]];
    for (let i = 1; i < fullPath.length - 1; i++) {
      const a = fullPath[i - 1];
      const b = fullPath[i];
      const c = fullPath[i + 1];
      const dx1 = b[1] - a[1];
      const dy1 = b[0] - a[0];
      const dx2 = c[1] - b[1];
      const dy2 = c[0] - b[0];
      // Not collinear when the cross product is nonzero, or the direction
      // reverses on itself (WireRouter.java:600-603).
      const collinear = dx1 * dy2 - dy1 * dx2 === 0 && dx1 * dx2 + dy1 * dy2 > 0;
      if (!collinear) minimal.push(b);
    }
    const last = fullPath[fullPath.length - 1];
    const prev = minimal[minimal.length - 1];
    if (prev[0] !== last[0] || prev[1] !== last[1]) minimal.push(last);
    return minimal;
  }

  route(sr: number, sc: number, gr: number, gc: number): Point[] {
    // A blocked-in endpoint can never leave its cell: refuse up front.
    if (
      !this.canMoveTo(gr, gc, UP) &&
      !this.canMoveTo(gr, gc, DOWN) &&
      !this.canMoveTo(gr, gc, LEFT) &&
      !this.canMoveTo(gr, gc, RIGHT)
    ) {
      return [];
    }
    const pattern = this.tryPatternRouting(sr, sc, gr, gc);
    if (pattern.length > 0) return pattern;
    return this.aStar(sr, sc, gr, gc);
  }
}

/**
 * Routes an orthogonal polyline from `a` to `b` on the grid, avoiding the
 * obstacles. Returns the corner polyline (endpoints included), or `[]` when no
 * path exists and the caller falls back to an L-shape. The grid covers the
 * endpoints plus the obstacle extents with upstream's margin: `GRID_MARGIN`
 * cells before the bounds and `2 * GRID_MARGIN` past them (WireRouter.java:
 * 113-121), the origin offset doing the min-side margin and the trailing
 * `+ 2 * GRID_MARGIN` term the max-side one.
 */
export function routeWire(
  a: Point,
  b: Point,
  obstacles: readonly WireObstacle[],
  grid: number = GRID_SIZE,
): Point[] {
  if (a.x === b.x && a.y === b.y) return [{ ...a }, { ...b }];

  let minX = Math.min(a.x, b.x);
  let minY = Math.min(a.y, b.y);
  let maxX = Math.max(a.x, b.x);
  let maxY = Math.max(a.y, b.y);
  for (const o of obstacles) {
    if (o.kind === 'rect') {
      minX = Math.min(minX, o.x0);
      minY = Math.min(minY, o.y0);
      maxX = Math.max(maxX, o.x1);
      maxY = Math.max(maxY, o.y1);
    } else if (o.kind === 'point') {
      minX = Math.min(minX, o.x);
      minY = Math.min(minY, o.y);
      maxX = Math.max(maxX, o.x);
      maxY = Math.max(maxY, o.y);
    } else {
      minX = Math.min(minX, o.x0, o.x1);
      minY = Math.min(minY, o.y0, o.y1);
      maxX = Math.max(maxX, o.x0, o.x1);
      maxY = Math.max(maxY, o.y0, o.y1);
    }
  }

  const originX = Math.floor(minX / grid) * grid - GRID_MARGIN * grid;
  const originY = Math.floor(minY / grid) * grid - GRID_MARGIN * grid;
  const rows = Math.floor((maxY - originY) / grid) + 1 + 2 * GRID_MARGIN;
  const cols = Math.floor((maxX - originX) / grid) + 1 + 2 * GRID_MARGIN;

  const router = new RouterGrid(rows, cols, grid, originX, originY);
  for (const o of obstacles) {
    if (o.kind === 'rect') router.addObstacle(o.x0, o.y0, o.x1, o.y1);
    else if (o.kind === 'point') router.addObstaclePoint(o.x, o.y);
    else router.addWire(o.x0, o.y0, o.x1, o.y1);
  }

  const sr = Math.floor((a.y - originY) / grid);
  const sc = Math.floor((a.x - originX) / grid);
  const gr = Math.floor((b.y - originY) / grid);
  const gc = Math.floor((b.x - originX) / grid);
  // The wire's own endpoints are always reachable.
  router.clearCell(sr, sc);
  router.clearCell(gr, gc);
  return router.route(sr, sc, gr, gc);
}

/**
 * The obstacle set for re-routing one wire against the rest of the circuit,
 * the marking upstream's `initGrid` performs (WireRouter.java:124-135): every
 * other element's body as a rect, its posts as points, its axis-aligned span
 * as a direction cell (so a new wire cannot lie on top of it), and every other
 * routed wire's segments. The wire being re-routed is excluded; its own start
 * and end cells are cleared by `routeWire`.
 */
export function routingObstacles(
  elements: readonly CircuitElement[],
  excludedId: number,
): WireObstacle[] {
  const obstacles: WireObstacle[] = [];
  for (const e of elements) {
    if (e.id === excludedId) continue;
    if (e.kind === 'wire' && e.route && e.route.length >= 2) {
      for (let i = 0; i < e.route.length - 1; i++) {
        obstacles.push({
          kind: 'wire',
          x0: e.route[i][0],
          y0: e.route[i][1],
          x1: e.route[i + 1][0],
          y1: e.route[i + 1][1],
        });
      }
      continue;
    }
    const posts = postsOf(e);
    const pts = posts.length > 0 ? posts : [
      { x: e.x1, y: e.y1 },
      { x: e.x2, y: e.y2 },
    ];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of pts) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    const axisAligned = e.x1 === e.x2 || e.y1 === e.y2;
    if (e.kind === 'wire') {
      // A plain wire blocks parallel runs through its cells like a routed
      // segment (CircuitElm.addRoutingObstacle, CircuitElm.java:290-296); a
      // diagonal one is only a body box, since upstream's addWire assumes
      // axis alignment.
      if (axisAligned) {
        obstacles.push({ kind: 'wire', x0: e.x1, y0: e.y1, x1: e.x2, y1: e.y2 });
      } else {
        obstacles.push({ kind: 'rect', x0: minX, y0: minY, x1: maxX, y1: maxY });
      }
    } else {
      obstacles.push({ kind: 'rect', x0: minX, y0: minY, x1: maxX, y1: maxY });
      // An axis-aligned two-post body also blocks a parallel run along its own
      // cells, the `addWire` half of addRoutingObstacleWithLeads.
      if (axisAligned) {
        obstacles.push({ kind: 'wire', x0: e.x1, y0: e.y1, x1: e.x2, y1: e.y2 });
      }
    }
    for (const p of posts) obstacles.push({ kind: 'point', x: p.x, y: p.y });
  }
  return obstacles;
}

/** The L-shape a failed re-route falls back to, horizontal to the goal column
 *  then vertical, upstream's setPoints fallback (RoutedWireElm.java:113-120).
 *  Zero-length legs are dropped, so a vertical wire comes out a straight
 *  two-point route. */
export function lShapeRoute(x1: number, y1: number, x2: number, y2: number): [number, number][] {
  const out: [number, number][] = [];
  for (const p of [
    [x1, y1],
    [x2, y1],
    [x2, y2],
  ] as [number, number][]) {
    const last = out[out.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  return out;
}
