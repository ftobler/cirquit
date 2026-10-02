import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FLOAT_H,
  DEFAULT_FLOAT_W,
  FLOAT_TITLE_H,
  MIN_FLOAT_H,
  MIN_FLOAT_W,
  clampFloatRect,
  defaultFloatRect,
  movedRect,
  resizedRect,
} from './floatingScopes';

const AREA = { w: 1000, h: 600 };

describe('floating scope geometry', () => {
  it('enforces the minimum size', () => {
    const r = clampFloatRect({ x: 10, y: 10, w: 5, h: 5 }, AREA);
    expect(r.w).toBe(MIN_FLOAT_W);
    expect(r.h).toBe(MIN_FLOAT_H);
  });

  it('keeps the title bar reachable', () => {
    expect(clampFloatRect({ x: 10, y: -50, w: 300, h: 200 }, AREA).y).toBe(0);
    expect(clampFloatRect({ x: 10, y: 5000, w: 300, h: 200 }, AREA).y).toBe(600 - FLOAT_TITLE_H);
    // Mostly off either side is allowed, but a grabbable strip stays in.
    const left = clampFloatRect({ x: -1000, y: 0, w: 300, h: 200 }, AREA);
    expect(left.x + left.w).toBeGreaterThanOrEqual(80);
    const right = clampFloatRect({ x: 5000, y: 0, w: 300, h: 200 }, AREA);
    expect(right.x).toBeLessThanOrEqual(1000 - 80);
  });

  it('never grows larger than the area', () => {
    const r = clampFloatRect({ x: 0, y: 0, w: 5000, h: 5000 }, AREA);
    expect(r.w).toBe(1000);
    expect(r.h).toBe(600);
  });

  it('applies only the minimum before layout', () => {
    expect(clampFloatRect({ x: -5, y: -5, w: 900, h: 900 }, { w: 0, h: 0 })).toEqual({
      x: -5,
      y: 0,
      w: 900,
      h: 900,
    });
  });

  it('repairs a non-finite rect', () => {
    const r = clampFloatRect({ x: NaN, y: NaN, w: NaN, h: Infinity }, AREA);
    expect(Object.values(r).every(Number.isFinite)).toBe(true);
  });

  it('cascades new panels from the top-right corner', () => {
    const a = defaultFloatRect(0, AREA);
    const b = defaultFloatRect(1, AREA);
    expect(a.w).toBe(DEFAULT_FLOAT_W);
    expect(a.h).toBe(DEFAULT_FLOAT_H);
    expect(a.x + a.w).toBeLessThanOrEqual(AREA.w);
    expect(b.x).toBeLessThan(a.x);
    expect(b.y).toBeGreaterThan(a.y);
  });

  it('moves by the drag delta, clamped', () => {
    const start = { x: 100, y: 100, w: 300, h: 200 };
    expect(movedRect(start, 50, -20, AREA)).toEqual({ x: 150, y: 80, w: 300, h: 200 });
    expect(movedRect(start, 0, -500, AREA).y).toBe(0);
  });

  it('resizes from the bottom-right grip, stopping at the area edge', () => {
    const start = { x: 100, y: 100, w: 300, h: 200 };
    expect(resizedRect(start, 40, 30, AREA)).toEqual({ x: 100, y: 100, w: 340, h: 230 });
    expect(resizedRect(start, -1000, -1000, AREA)).toMatchObject({ w: MIN_FLOAT_W, h: MIN_FLOAT_H });
    expect(resizedRect(start, 5000, 5000, AREA)).toMatchObject({ w: 900, h: 500 });
  });
});
