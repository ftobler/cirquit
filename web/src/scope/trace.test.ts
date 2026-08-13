import { describe, expect, it } from 'vitest';
import { tracePolyline, type TracePoint } from './trace';

/** A window over the first `count` snapshot slots, oldest first. */
function plainWindow(count: number, xOffset = 0) {
  return { count, xOffset, posOf: (k: number) => k };
}

/** The points of a polyline, dropping the null gaps. */
function solidPoints(points: (TracePoint | null)[]): TracePoint[] {
  return points.filter((p): p is TracePoint => p !== null);
}

describe('scope trace polyline', () => {
  it('every drawn column contributes one point at x = k + 0.5', () => {
    const data = new Float32Array([0, 1, 1, 3, -2, 2]);
    const points = tracePolyline(data, plainWindow(3), { gridMid: 0, gridMult: 10, positionOffset: 0 }, 50);
    expect(points).toHaveLength(3);
    expect(points[0]).toEqual({ x: 0.5, y: 45 });
    expect(points[1]).toEqual({ x: 1.5, y: 30 });
    expect(points[2]).toEqual({ x: 2.5, y: 50 });
  });

  it('x is strictly increasing, so the line never doubles back', () => {
    const data = new Float32Array([0, 1, 1, 3, -2, 2, 5, 5, -4, 0]);
    const points = tracePolyline(data, plainWindow(5), { gridMid: 0, gridMult: 10, positionOffset: 0 }, 50);
    const xs = solidPoints(points).map((p) => p.x);
    for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThan(xs[i - 1]);
  });

  it('a constant signal yields a horizontal line at the mapped value', () => {
    const data = new Float32Array([1.2, 1.2, 1.2, 1.2, 1.2, 1.2]);
    const points = tracePolyline(data, plainWindow(3), { gridMid: 0, gridMult: 10, positionOffset: 0 }, 50);
    // 50 - 10 * 1.2 = 38 for every column (within float32 storage noise).
    for (const p of solidPoints(points)) expect(p.y).toBeCloseTo(38, 6);
  });

  it('a column whose min/max straddles zero yields its midline, not an edge', () => {
    const data = new Float32Array([-2, 2]);
    const points = tracePolyline(data, plainWindow(1), { gridMid: 0, gridMult: 10, positionOffset: 0 }, 50);
    expect(points[0]).toEqual({ x: 0.5, y: 50 });
  });

  it('all-zero data sits on the mapped zero line, finite and on-canvas', () => {
    const data = new Float32Array([0, 0, 0, 0]);
    const points = tracePolyline(data, plainWindow(2), { gridMid: 0, gridMult: 10, positionOffset: 0 }, 50);
    for (const p of solidPoints(points)) {
      expect(p.y).toBe(50);
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });

  it('a column with no data yields a null gap, breaking the line', () => {
    const data = new Float32Array([0, 0, 1, 1]);
    const win = { count: 3, xOffset: 0, posOf: (k: number) => (k === 1 ? -1 : k < 2 ? k : 0) };
    const points = tracePolyline(data, win, { gridMid: 0, gridMult: 10, positionOffset: 0 }, 50);
    expect(points[0]).not.toBeNull();
    expect(points[1]).toBeNull();
    expect(points[2]).not.toBeNull();
  });

  it('a right-anchored pre-wrap window places the newest column at the right edge', () => {
    // 3 written columns on a 4 pixel canvas: the offset pushes drawn column k
    // to pixel xOffset + k, so the newest column (k = 2) sits at pixel 3.
    const data = new Float32Array([0, 1, 1, 3, -2, 2]);
    const win = { count: 3, xOffset: 1, posOf: (k: number) => k };
    const points = tracePolyline(data, win, { gridMid: 0, gridMult: 10, positionOffset: 0 }, 50);
    expect(points).toHaveLength(3);
    expect(points[0]).toEqual({ x: 1.5, y: 45 });
    expect(points[2]).toEqual({ x: 3.5, y: 50 });
  });
});
