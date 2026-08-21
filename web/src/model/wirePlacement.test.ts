import { describe, expect, it } from 'vitest';
import type { Point } from './types';
import { wireDragAxis, wireSegments } from './wirePlacement';

const P = (x: number, y: number) => ({ x, y });

describe('wireDragAxis', () => {
  it('reports nothing while the pointer is still on the anchor', () => {
    expect(wireDragAxis(P(32, 32), P(32, 32))).toBeNull();
  });

  it('takes the axis the pointer moved furthest along', () => {
    expect(wireDragAxis(P(0, 0), P(48, 16))).toBe('h');
    expect(wireDragAxis(P(0, 0), P(16, 48))).toBe('v');
    expect(wireDragAxis(P(0, 0), P(-48, 16))).toBe('h');
    expect(wireDragAxis(P(0, 0), P(16, -48))).toBe('v');
  });

  it('breaks an exact diagonal towards horizontal', () => {
    expect(wireDragAxis(P(0, 0), P(32, 32))).toBe('h');
    expect(wireDragAxis(P(0, 0), P(-32, 32))).toBe('h');
  });

  it('reports an axis for a move along one axis only', () => {
    expect(wireDragAxis(P(0, 0), P(0, 16))).toBe('v');
    expect(wireDragAxis(P(0, 0), P(16, 0))).toBe('h');
  });
});

describe('wireSegments', () => {
  it('inserts nothing for a drag that never left the anchor', () => {
    expect(wireSegments(P(16, 16), P(16, 16), 'h')).toEqual([]);
    expect(wireSegments(P(16, 16), P(16, 16), 'v')).toEqual([]);
  });

  it('inserts one wire for an axis-aligned drag, whichever axis is latched', () => {
    expect(wireSegments(P(0, 0), P(64, 0), 'h')).toEqual([{ x1: 0, y1: 0, x2: 64, y2: 0 }]);
    // Latched vertical but dragged straight across: the first leg is empty and
    // only the second survives, so the result is still the single wire drawn.
    expect(wireSegments(P(0, 0), P(64, 0), 'v')).toEqual([{ x1: 0, y1: 0, x2: 64, y2: 0 }]);
    expect(wireSegments(P(0, 0), P(0, 64), 'v')).toEqual([{ x1: 0, y1: 0, x2: 0, y2: 64 }]);
    expect(wireSegments(P(0, 0), P(0, 64), 'h')).toEqual([{ x1: 0, y1: 0, x2: 0, y2: 64 }]);
  });

  it('bends across then down when the drag set off sideways', () => {
    expect(wireSegments(P(0, 0), P(64, 32), 'h')).toEqual([
      { x1: 0, y1: 0, x2: 64, y2: 0 },
      { x1: 64, y1: 0, x2: 64, y2: 32 },
    ]);
  });

  it('bends down then across when the drag set off downwards', () => {
    expect(wireSegments(P(0, 0), P(64, 32), 'v')).toEqual([
      { x1: 0, y1: 0, x2: 0, y2: 32 },
      { x1: 0, y1: 32, x2: 64, y2: 32 },
    ]);
  });

  it('never produces a diagonal or a zero-length segment', () => {
    const cases: [Point, Point, 'h' | 'v'][] = [
      [P(0, 0), P(64, 32), 'h'],
      [P(0, 0), P(64, 32), 'v'],
      [P(80, 96), P(-32, -48), 'h'],
      [P(80, 96), P(-32, -48), 'v'],
      [P(0, 0), P(0, 48), 'h'],
      [P(0, 0), P(48, 0), 'v'],
    ];
    for (const [a, b, axis] of cases) {
      for (const s of wireSegments(a, b, axis)) {
        const straight = s.x1 === s.x2 || s.y1 === s.y2;
        expect(straight, JSON.stringify(s)).toBe(true);
        expect(s.x1 !== s.x2 || s.y1 !== s.y2, JSON.stringify(s)).toBe(true);
      }
    }
  });

  it('joins the two segments at the corner and reaches both ends', () => {
    const segs = wireSegments(P(16, 16), P(112, 80), 'v');
    expect(segs).toHaveLength(2);
    expect({ x: segs[0].x1, y: segs[0].y1 }).toEqual(P(16, 16));
    expect({ x: segs[0].x2, y: segs[0].y2 }).toEqual({ x: segs[1].x1, y: segs[1].y1 });
    expect({ x: segs[1].x2, y: segs[1].y2 }).toEqual(P(112, 80));
  });
});
