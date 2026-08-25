import { afterEach, describe, expect, it } from 'vitest';
import { clearXYPersistence, pruneXYPersistence, xyPersistenceFor } from './xyPersistence';

/** The tests run in a node env, so the offscreen canvas allocation gets a
 *  stub document: a canvas element with no 2d context is exactly what the
 *  draw path tolerates (it stores the entry and bails on the null ctx). */
const stubDocument = () => {
  (globalThis as { document?: unknown }).document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => null }),
  };
};

afterEach(() => {
  pruneXYPersistence([]);
  delete (globalThis as { document?: unknown }).document;
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
});
