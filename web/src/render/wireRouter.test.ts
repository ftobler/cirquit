import { describe, expect, it } from 'vitest';
import type { CircuitElement, Point } from '../model/types';
import { lShapeRoute, routeWire, routingObstacles, type WireObstacle } from './wireRouter';

const pts = (route: Point[]) => route.map((p) => [p.x, p.y]);

/** Every segment of a Manhattan route is axis-aligned. */
const axisAligned = (route: Point[]) =>
  route.every((p, i) => i === 0 || route[i - 1].x === p.x || route[i - 1].y === p.y);

describe('routeWire', () => {
  it('routes two points on the same grid line as a single straight segment', () => {
    const route = routeWire({ x: 0, y: 0 }, { x: 160, y: 0 }, []);
    expect(pts(route)).toEqual([
      [0, 0],
      [160, 0],
    ]);
  });

  it('routes an unblocked corner as a two-segment L, never a diagonal', () => {
    const route = routeWire({ x: 0, y: 0 }, { x: 160, y: 160 }, []);
    // The horizontal-first L wins the tie over the vertical-first one, so the
    // shape is deterministic.
    expect(pts(route)).toEqual([
      [0, 0],
      [160, 0],
      [160, 160],
    ]);
  });

  it('detours around an obstacle body with a Z that stays on the grid', () => {
    const wall: WireObstacle = { kind: 'rect', x0: 64, y0: -16, x1: 96, y1: 16 };
    const route = routeWire({ x: 0, y: 0 }, { x: 160, y: 0 }, [wall]);
    // The obstacle, expanded half a cell, spans rows y=-16..16, so the two-cell
    // detour above it lands on y=-32 and every segment stays off the wall.
    expect(pts(route)).toEqual([
      [0, 0],
      [0, -32],
      [160, -32],
      [160, 0],
    ]);
    expect(axisAligned(route)).toBe(true);
  });

  it('is deterministic: the same input yields the identical polyline twice', () => {
    const wall: WireObstacle = { kind: 'rect', x0: 64, y0: -16, x1: 96, y1: 16 };
    const a = routeWire({ x: 0, y: 0 }, { x: 160, y: 0 }, [wall]);
    const b = routeWire({ x: 0, y: 0 }, { x: 160, y: 0 }, [wall]);
    expect(pts(a)).toEqual(pts(b));
    // The second call returns the same values, not the same array object.
    expect(a).not.toBe(b);
  });

  it('a tall wall defeats the pattern pass and falls back to A*, still Manhattan', () => {
    // The wall spans rows the pattern router's five-cell detours all stay
    // inside, so no L or Z fits; the A* has to go around one of the ends.
    const wall: WireObstacle = { kind: 'rect', x0: 32, y0: -80, x1: 128, y1: 80 };
    const route = routeWire({ x: 0, y: 0 }, { x: 160, y: 0 }, [wall]);
    expect(route.length).toBeGreaterThanOrEqual(4);
    expect(route[0]).toEqual({ x: 0, y: 0 });
    expect(route[route.length - 1]).toEqual({ x: 160, y: 0 });
    expect(axisAligned(route)).toBe(true);
    // Deterministic across runs.
    expect(pts(route)).toEqual(pts(routeWire({ x: 0, y: 0 }, { x: 160, y: 0 }, [wall])));
  });

  it('an existing wire on the same row forces a detour off its cells', () => {
    // The wire obstacle marks direction cells on y=0 from x=32..128, so the
    // straight run cannot pass; the route must step off the row and come back,
    // which only happens because the HORIZONTAL flags actually block.
    const other: WireObstacle = { kind: 'wire', x0: 32, y0: 0, x1: 128, y1: 0 };
    const route = routeWire({ x: 0, y: 0 }, { x: 160, y: 0 }, [other]);
    expect(pts(route)).toEqual([
      [0, 0],
      [0, -16],
      [160, -16],
      [160, 0],
    ]);
  });
});

describe('routingObstacles', () => {
  const element = (
    kind: string,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    extra: Partial<CircuitElement> = {},
  ): CircuitElement => ({ id: 10, kind, x1, y1, x2, y2, flags: 0, params: {}, ...extra });

  it('excludes the wire being re-routed entirely', () => {
    const dragged = element('wire', 0, 0, 160, 0, {
      route: [
        [0, 0],
        [0, 80],
        [160, 0],
      ],
    });
    const obstacles = routingObstacles([dragged], dragged.id);
    expect(obstacles).toEqual([]);
  });

  it('marks a routed wire by its segments and a resistor by its body and posts', () => {
    const routed = element('wire', 0, 0, 160, 0, {
      route: [
        [0, 0],
        [0, 80],
        [160, 0],
      ],
    });
    const resistor = element('resistor', 64, 0, 96, 0, { params: { resistance: 1000 } });
    const obstacles = routingObstacles([routed, resistor], 999);
    expect(obstacles).toContainEqual({ kind: 'wire', x0: 0, y0: 0, x1: 0, y1: 80 });
    expect(obstacles).toContainEqual({ kind: 'wire', x0: 0, y0: 80, x1: 160, y1: 0 });
    expect(obstacles).toContainEqual({ kind: 'rect', x0: 64, y0: 0, x1: 96, y1: 0 });
    expect(obstacles).toContainEqual({ kind: 'point', x: 64, y: 0 });
    expect(obstacles).toContainEqual({ kind: 'point', x: 96, y: 0 });
  });

  it('marks an axis-aligned plain wire as a parallel-run blocker', () => {
    const plain = element('wire', 32, 0, 128, 0);
    const obstacles = routingObstacles([plain], 999);
    expect(obstacles).toContainEqual({ kind: 'wire', x0: 32, y0: 0, x1: 128, y1: 0 });
  });
});

describe('lShapeRoute', () => {
  it('builds a horizontal-then-vertical L between the endpoints', () => {
    expect(lShapeRoute(0, 0, 160, 80)).toEqual([
      [0, 0],
      [160, 0],
      [160, 80],
    ]);
  });

  it('drops the zero-length leg of a vertical wire', () => {
    expect(lShapeRoute(0, 0, 0, 80)).toEqual([
      [0, 0],
      [0, 80],
    ]);
  });
});
