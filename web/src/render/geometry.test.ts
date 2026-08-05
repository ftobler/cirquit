import { describe, expect, it } from 'vitest';
import { GRID_SIZE, type CircuitElement } from '../model/types';
import { snap } from '../state/store';
import { distanceToElement, distanceToSegment, nearestPost, postAt, postPatch } from './geometry';

const element = (x1: number, y1: number, x2: number, y2: number): CircuitElement => ({
  id: 1,
  kind: 'resistor',
  x1,
  y1,
  x2,
  y2,
  flags: 0,
  params: {},
});

/** Where a `dragpost` drag would land the pointer, per the canvas handler. */
const landOn = (x: number, y: number, snapToGrid: boolean) =>
  snapToGrid ? { x: snap(x), y: snap(y) } : { x: Math.round(x), y: Math.round(y) };

describe('nearestPost', () => {
  it('picks the near end of a horizontal element', () => {
    const e = element(0, 0, 160, 0);
    expect(nearestPost({ x: 5, y: 3 }, e)).toBe(1);
    expect(nearestPost({ x: 155, y: 3 }, e)).toBe(2);
  });

  it('picks the near end of a vertical element', () => {
    const e = element(0, 0, 0, 160);
    expect(nearestPost({ x: 3, y: 5 }, e)).toBe(1);
    expect(nearestPost({ x: 3, y: 155 }, e)).toBe(2);
  });

  it('picks the near end of a diagonal element', () => {
    const e = element(0, 0, 160, 160);
    expect(nearestPost({ x: 5, y: 5 }, e)).toBe(1);
    expect(nearestPost({ x: 155, y: 155 }, e)).toBe(2);
  });

  it('sends an exact midpoint tie to post 1, deterministically', () => {
    const e = element(0, 0, 160, 0);
    expect(nearestPost({ x: 80, y: 0 }, e)).toBe(1);
    expect(nearestPost({ x: 80, y: 100 }, e)).toBe(1);
  });

  it('measures to the post, so a far off-axis point still picks the near end', () => {
    // 90 units off the axis; the along-axis position, not the perpendicular
    // distance, decides which post is nearer.
    const e = element(0, 0, 160, 0);
    expect(nearestPost({ x: 30, y: 90 }, e)).toBe(1);
    expect(nearestPost({ x: 130, y: 90 }, e)).toBe(2);
  });
});

describe('postAt', () => {
  it('reports whether the post already sits at the position', () => {
    const e = element(0, 0, 160, 0);
    expect(postAt(e, 1, 0, 0)).toBe(true);
    expect(postAt(e, 2, 160, 0)).toBe(true);
    expect(postAt(e, 1, 16, 0)).toBe(false);
    expect(postAt(e, 2, 0, 0)).toBe(false);
    expect(postAt(e, 2, 160, 16)).toBe(false);
  });

  it('reads a missing element as false so the caller skips the write', () => {
    expect(postAt(undefined, 1, 0, 0)).toBe(false);
    expect(postAt(undefined, 2, 160, 0)).toBe(false);
  });
});

describe('postPatch', () => {
  it('targets only x1/y1 for post 1', () => {
    const patch = postPatch(1, 32, 48);
    expect(patch).toEqual({ x1: 32, y1: 48 });
    expect('x2' in patch).toBe(false);
    expect('y2' in patch).toBe(false);
  });

  it('targets only x2/y2 for post 2', () => {
    const patch = postPatch(2, 32, 48);
    expect(patch).toEqual({ x2: 32, y2: 48 });
    expect('x1' in patch).toBe(false);
    expect('y1' in patch).toBe(false);
  });

  it('lands on a grid intersection with snap on', () => {
    const { x, y } = landOn(3.2, 17.7, true);
    expect(x % GRID_SIZE).toBe(0);
    expect(y % GRID_SIZE).toBe(0);
    expect(postPatch(1, x, y)).toEqual({ x1: x, y1: y });
  });

  it('lands on an integer coordinate with snap off', () => {
    const { x, y } = landOn(3.2, 17.7, false);
    expect(Number.isInteger(x)).toBe(true);
    expect(Number.isInteger(y)).toBe(true);
    expect(postPatch(2, x, y)).toEqual({ x2: x, y2: y });
  });

  it('leaves the other endpoint untouched across a drag sequence', () => {
    let current = element(0, 0, 160, 0);
    for (const [px, py] of [
      [16, 0],
      [32, 16],
      [48, 0],
      [64, 48],
      [80, 16],
    ]) {
      const { x, y } = landOn(px, py, true);
      current = { ...current, ...postPatch(2, x, y) };
    }
    // The fixed post is exact even after the length and angle moved.
    expect(current.x1).toBe(0);
    expect(current.y1).toBe(0);
    expect(current.x2).not.toBe(160);
    expect(current.y2).not.toBe(0);
  });
});

describe('distanceToSegment', () => {
  it('measures perpendicular distance away from the line', () => {
    expect(distanceToSegment({ x: 80, y: 7 }, { x: 0, y: 0 }, { x: 160, y: 0 })).toBe(7);
  });

  it('clamps to the endpoints beyond them', () => {
    expect(distanceToSegment({ x: -10, y: 4 }, { x: 0, y: 0 }, { x: 160, y: 0 })).toBeCloseTo(
      Math.hypot(10, 4),
      9,
    );
  });

  it('treats a zero-length segment as a point', () => {
    expect(distanceToSegment({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toBe(5);
  });
});

describe('distanceToElement', () => {
  it('uses the single post distance for single-terminal elements', () => {
    const e = element(32, 16, 32, 16);
    e.kind = 'ground';
    expect(distanceToElement({ x: 35, y: 19 }, e)).toBeCloseTo(Math.hypot(3, 3), 9);
  });

  it('measures against the body line for two-terminal elements', () => {
    expect(distanceToElement({ x: 80, y: 5 }, element(0, 0, 160, 0))).toBe(5);
  });
});
