import { describe, expect, it } from 'vitest';
import type { CircuitElement, Point } from './types';
import {
  duplicatesColinearElement,
  interiorPostHits,
  wireDragAxis,
  wireSegments,
} from './wirePlacement';

const P = (x: number, y: number) => ({ x, y });

const el = (kind: string, x1: number, y1: number, x2: number, y2: number): CircuitElement => ({
  id: 1,
  kind,
  x1,
  y1,
  x2,
  y2,
  flags: 0,
  params: {},
});

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

describe('interiorPostHits', () => {
  it('collects the posts on a drawn wire interior, ordered from its start', () => {
    // Upstream sorts the split points by distance from the drag's anchor
    // (WireElm.draggingDone), so the pieces come out in span order whatever
    // order the post scan produced.
    const seg = { x1: 0, y1: 0, x2: 160, y2: 0 };
    expect(interiorPostHits(seg, [P(112, 0), P(48, 0)])).toEqual([P(48, 0), P(112, 0)]);
  });

  it('reads a wire drawn in either direction', () => {
    const seg = { x1: 160, y1: 0, x2: 0, y2: 0 };
    expect(interiorPostHits(seg, [P(112, 0)])).toEqual([P(112, 0)]);
  });

  it('drops endpoints and off-line points', () => {
    const seg = { x1: 0, y1: 0, x2: 160, y2: 0 };
    expect(interiorPostHits(seg, [P(0, 0), P(160, 0), P(80, 16), P(80, -16)])).toEqual([]);
  });

  it('dedups a repeated post and walks a vertical span', () => {
    const seg = { x1: 80, y1: 80, x2: 80, y2: -80 };
    expect(interiorPostHits(seg, [P(80, 0), P(80, 32)])).toEqual([P(80, 32), P(80, 0)]);
    expect(interiorPostHits(seg, [P(80, 0), P(80, 0)])).toEqual([P(80, 0)]);
  });

  it('finds nothing when there is nothing to find', () => {
    const seg = { x1: 0, y1: 0, x2: 64, y2: 0 };
    expect(interiorPostHits(seg, [])).toEqual([]);
  });
});

describe('duplicatesColinearElement', () => {
  it('sees an existing part already joining the two ends, in either order', () => {
    const pool = [el('wire', 0, 0, 80, 0)];
    expect(duplicatesColinearElement(pool, new Set(), P(0, 0), P(80, 0))).toBe(true);
    expect(duplicatesColinearElement(pool, new Set(), P(80, 0), P(0, 0))).toBe(true);
  });

  it('refuses near misses: one shared end is not a duplicate', () => {
    const pool = [el('wire', 0, 0, 80, 0)];
    expect(duplicatesColinearElement(pool, new Set(), P(80, 0), P(160, 0))).toBe(false);
    expect(duplicatesColinearElement(pool, new Set(), P(0, 0), P(40, 0))).toBe(false);
  });

  it('counts any two-terminal part, not only wires', () => {
    const pool = [
      el('resistor', 0, 0, 80, 0),
      el('ground', 160, 0, 160, 32),
      el('transistor', 240, 0, 240, 64),
    ];
    expect(duplicatesColinearElement(pool, new Set(), P(0, 0), P(80, 0))).toBe(true);
    // A ground has one post and a transistor three: neither can be the
    // colinear twin upstream's getPostCount() == 2 gate demands.
    expect(duplicatesColinearElement(pool, new Set(), P(160, 0), P(160, 32))).toBe(false);
    expect(duplicatesColinearElement(pool, new Set(), P(240, 0), P(240, 64))).toBe(false);
  });

  it('skips the ids the caller is replacing', () => {
    const mine = { ...el('wire', 0, 0, 80, 0), id: 7 };
    expect(duplicatesColinearElement([mine], new Set([7]), P(0, 0), P(80, 0))).toBe(false);
    expect(duplicatesColinearElement([mine], new Set(), P(0, 0), P(80, 0))).toBe(true);
  });
});
