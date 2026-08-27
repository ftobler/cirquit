import { afterEach, describe, expect, it } from 'vitest';
import { backingStoreSize } from '../ui/canvas/backingStoreSize';
import { clearXYPersistence, pruneXYPersistence, xyPersistenceFor } from './xyPersistence';

/** The tests run in a node env, so the offscreen canvas allocation gets a
 *  stub document: a canvas element with no 2d context is exactly what the
 *  draw path tolerates (it stores the entry and bails on the null ctx). */
const stubDocument = () => {
  (globalThis as { document?: unknown }).document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => null }),
  };
};

/** A richer stub that records the backing-store size and the transform the
 *  entry applies, so the dpr scaling can be asserted directly. */
const stubDocumentWithCtx = () => {
  const created: { width: number; height: number; transforms: number[] }[] = [];
  (globalThis as { document?: unknown }).document = {
    createElement: () => {
      const c = {
        width: 0,
        height: 0,
        transforms: [] as number[],
        getContext: () => ({
          setTransform: (a: number, _b: number, _c: number, d: number) => {
            c.transforms.push(a, d);
          },
        }),
      };
      created.push(c);
      return c;
    },
  };
  return created;
};

afterEach(() => {
  pruneXYPersistence([]);
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { window?: unknown }).window;
});

describe('X-Y persistence canvases', () => {
  it('creates one entry per scope id and reuses it at a constant size', () => {
    stubDocument();
    const a = xyPersistenceFor(1, 200, 100);
    expect(a.w).toBe(200);
    expect(a.h).toBe(100);
    expect(xyPersistenceFor(1, 200, 100)).toBe(a);
  });

  it('reallocates when the panel size changes', () => {
    stubDocument();
    const a = xyPersistenceFor(1, 200, 100);
    const b = xyPersistenceFor(1, 300, 100);
    expect(b).not.toBe(a);
    expect(b.w).toBe(300);
    expect(b.fadeCounter).toBe(0);  // a fresh trail, like the replaced canvas
  });

  it('prune drops dead ids and keeps live ones', () => {
    stubDocument();
    const live = xyPersistenceFor(1, 200, 100);
    const dead = xyPersistenceFor(2, 200, 100);
    // Ids are scope ids; an embedded window's is its element id, which is
    // why deletion or a document load must prune here: no docked panel ever
    // unmounts for it.
    pruneXYPersistence([1]);
    expect(xyPersistenceFor(1, 200, 100)).toBe(live);
    expect(xyPersistenceFor(2, 200, 100)).not.toBe(dead);
  });

  it('clearXYPersistence drops exactly one id', () => {
    stubDocument();
    const a = xyPersistenceFor(3, 200, 100);
    xyPersistenceFor(4, 200, 100);
    clearXYPersistence(4);
    expect(xyPersistenceFor(3, 200, 100)).toBe(a);
    expect(clearXYPersistence(3)).toBeUndefined();
  });

  it('sizes the backing store at device resolution and transforms to CSS px', () => {
    const created = stubDocumentWithCtx();
    (globalThis as { window?: unknown }).window = { devicePixelRatio: 2 };
    const a = xyPersistenceFor(5, 200, 100);
    expect(a.dpr).toBe(2);
    expect(created[0].width).toBe(400);
    expect(created[0].height).toBe(200);
    expect(created[0].transforms).toEqual([2, 2]);
  });

  it('reallocates when the device pixel ratio changes', () => {
    const created = stubDocumentWithCtx();
    (globalThis as { window?: unknown }).window = { devicePixelRatio: 1 };
    const a = xyPersistenceFor(6, 200, 100);
    expect(created[0].width).toBe(200);
    (globalThis as { window?: unknown }).window = { devicePixelRatio: 3 };
    const b = xyPersistenceFor(6, 200, 100);
    expect(b).not.toBe(a);
    expect(created[1].width).toBe(600);
  });

  it('pins the backing store to backingStoreSize at a fractional dpr', () => {
    // J6: the persistence canvas must match the scope's dpr-sized backing
    // store exactly, rounding like every other canvas (backingStoreSize), or
    // a 1.5 dpr with an odd CSS width reallocates and clears the trail each
    // frame. Asserting against the helper pins the formula, not just one case.
    const created = stubDocumentWithCtx();
    (globalThis as { window?: unknown }).window = { devicePixelRatio: 1.5 };
    const a = xyPersistenceFor(8, 201, 99);
    expect(a.dpr).toBe(1.5);
    expect(created[0].width).toBe(backingStoreSize(201, 99, 1.5).width);
    expect(created[0].height).toBe(backingStoreSize(201, 99, 1.5).height);
  });
});
