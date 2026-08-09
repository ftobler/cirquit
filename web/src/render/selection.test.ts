import { describe, expect, it } from 'vitest';
import type { CircuitElement } from '../model/types';
import { boxFromPoints, boxesIntersect, elementBox, selectByBox } from './selection';

const element = (
  id: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  kind = 'resistor',
): CircuitElement => ({ id, kind, x1, y1, x2, y2, flags: 0, params: {} });

describe('elementBox', () => {
  it('covers exactly the stored endpoints of a horizontal element', () => {
    expect(elementBox(element(1, 0, 0, 160, 0))).toEqual({ x0: 0, y0: 0, x1: 160, y1: 0 });
  });

  it('normalises an element dragged in reverse', () => {
    expect(elementBox(element(1, 160, 0, 0, 0))).toEqual({ x0: 0, y0: 0, x1: 160, y1: 0 });
  });

  it('gives a zero-length element a 1-unit box so it stays selectable', () => {
    // A collapsed element is a single point; upstream's setBbox +1 widens it
    // to a unit (CircuitElm.java:857-861).
    expect(elementBox(element(1, 0, 0, 0, 0))).toEqual({ x0: 0, y0: 0, x1: 1, y1: 1 });
    expect(elementBox(element(1, 32, 48, 32, 48))).toEqual({ x0: 32, y0: 48, x1: 33, y1: 49 });
  });

  it('falls back to the stored endpoints for a kind with no posts', () => {
    const e = element(1, 8, 16, 24, 16, 'unknown-kind');
    expect(elementBox(e)).toEqual({ x0: 8, y0: 16, x1: 24, y1: 16 });
  });

  it('spans the stored endpoints of a stem-bearing one-post part', () => {
    // A rail's waveform circle sits on the free end, which is a control point,
    // not a post: the box must span the whole stem like upstream's
    // getBoundingBox, or the circle would fall outside its own selection box.
    expect(elementBox(element(1, 0, 0, 32, 32, 'rail'))).toEqual({ x0: 0, y0: 0, x1: 32, y1: 32 });
    expect(elementBox(element(1, 0, 0, 32, 0, 'ground'))).toEqual({ x0: 0, y0: 0, x1: 32, y1: 0 });
  });

  it('spans the off-axis posts of a multi-terminal part', () => {
    // A transistor's collector and emitter hang 16 units perpendicular to the
    // axis (transistorPosts at interp2(..., 1, OPEN_HS*d)), so a box over the
    // bare endpoints (0,0)-(160,0) would miss them. Regression: the old
    // `postCount` fallback collapsed the box to the axis and these terminals
    // fell outside their own selection box.
    expect(elementBox(element(1, 0, 0, 160, 0, 'transistor'))).toEqual({
      x0: 0,
      y0: -16,
      x1: 160,
      y1: 16,
    });
  });

  it('keeps a post-only annotation boxed on its single post', () => {
    // A labeled node draws at (x1,y1) only; its stray x2,y2 must stay out of
    // the selection box just as it stays out of hit-testing.
    expect(elementBox(element(1, 0, 0, 320, 240, 'labeledNode'))).toEqual({ x0: 0, y0: 0, x1: 1, y1: 1 });
  });
});

describe('boxesIntersect', () => {
  const body = { x0: 0, y0: 0, x1: 160, y1: 0 };

  it('counts a shared edge as a hit, matching Rectangle.intersects inclusivity', () => {
    expect(boxesIntersect(body, { x0: 160, y0: 0, x1: 176, y1: 16 })).toBe(true);
  });

  it('counts a shared corner as a hit', () => {
    expect(boxesIntersect(body, { x0: 160, y0: -16, x1: 176, y1: 0 })).toBe(true);
  });

  it('misses a box that clears the span entirely', () => {
    expect(boxesIntersect(body, { x0: 176, y0: -16, x1: 192, y1: 0 })).toBe(false);
  });
});

describe('selectByBox', () => {
  const resistor = (id: number, x1: number) => element(id, x1, 0, x1 + 160, 0);
  const elements = [resistor(1, 0), resistor(2, 176)];

  it('selects on overlap where strict containment of every post failed', () => {
    // Regression: box (0,-16)-(32,16) only straddles the first resistor's
    // span. The old postsOf(e).every(post strictly inside) rule missed it
    // because post 2 at (160,0) lies outside.
    const box = boxFromPoints({ x: 0, y: -16 }, { x: 32, y: 16 });
    expect(selectByBox(elements, box, false, [])).toEqual([1]);
  });

  it('replaces the selection when add is false', () => {
    const box = boxFromPoints({ x: 0, y: -16 }, { x: 32, y: 16 });
    expect(selectByBox(elements, box, false, [1, 2])).toEqual([1]);
  });

  it('keeps the previous selection and unions the hits when add is true', () => {
    const box = boxFromPoints({ x: 0, y: -16 }, { x: 32, y: 16 });
    expect(selectByBox(elements, box, true, [2])).toEqual([2, 1]);
    // An element outside the box survives the additive drag.
    const wide = boxFromPoints({ x: -16, y: -16 }, { x: 400, y: 16 });
    expect(selectByBox(elements, wide, true, [2])).toEqual([2, 1]);
  });

  it('dedupes when an already-selected element is hit again', () => {
    const box = boxFromPoints({ x: -16, y: -16 }, { x: 400, y: 16 });
    expect(selectByBox(elements, box, true, [1, 2])).toEqual([1, 2]);
  });
});
