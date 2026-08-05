import { describe, expect, it } from 'vitest';
import { postsOf } from './registry';
import { canMirror, canRotate, canSwap, mirrorElement, rotateElement, swapTerminalOrder } from './transform';
import type { CircuitElement } from './types';

const element = (
  kind: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  flags = 0,
  params: Record<string, number> = {},
): CircuitElement => ({ id: 1, kind, x1, y1, x2, y2, flags, params });

describe('capability gates', () => {
  it('rotates any part with an axis, but not one-post annotations', () => {
    expect(canRotate(element('resistor', 0, 0, 160, 0))).toBe(true);
    expect(canRotate(element('opamp', 0, 0, 160, 0))).toBe(true);
    expect(canRotate(element('ground', 0, 0, 0, 0))).toBe(false);
  });

  it('mirrors only the asymmetric three-post bodies', () => {
    for (const kind of ['transistor', 'opamp', 'potentiometer']) {
      expect(canMirror(element(kind, 0, 0, 160, 0))).toBe(true);
    }
    expect(canMirror(element('resistor', 0, 0, 160, 0))).toBe(false);
    expect(canMirror(element('diode', 0, 0, 160, 0))).toBe(false);
  });

  it('swaps only two-terminal parts', () => {
    expect(canSwap(element('diode', 0, 0, 160, 0))).toBe(true);
    expect(canSwap(element('resistor', 0, 0, 160, 0))).toBe(true);
    expect(canSwap(element('transistor', 0, 0, 160, 0))).toBe(false);
    expect(canSwap(element('ground', 0, 0, 0, 0))).toBe(false);
  });
});

describe('rotateElement', () => {
  it('turns a horizontal resistor into a vertical one, swapping length and breadth', () => {
    const r = rotateElement(element('resistor', 0, 0, 160, 0));
    expect(Math.abs(r.x2 - r.x1)).toBe(0);
    expect(Math.abs(r.y2 - r.y1)).toBe(160);
  });

  it('returns the original after four turns', () => {
    const original = element('resistor', 0, 0, 160, 0);
    let e = original;
    for (let i = 0; i < 4; i++) e = rotateElement(e);
    expect(e).toEqual(original);
  });

  it('keeps the midpoint fixed and the result on the grid', () => {
    const e = element('resistor', 0, 0, 160, 0);
    const r = rotateElement(e);
    expect((r.x1 + r.x2) / 2).toBe(80);
    expect((r.y1 + r.y2) / 2).toBe(0);
    for (const v of [r.x1, r.y1, r.x2, r.y2]) expect(Math.abs(v % 16)).toBe(0);
  });

  it('rotates an op-amp as a rigid body, matching upstream orientation', () => {
    const a = element('opamp', 0, 0, 160, 0);
    const r = rotateElement(a);
    expect(r).toMatchObject({ x1: 80, y1: 80, x2: 80, y2: -80, flags: 1 });
    // Inverting input lead rides the rigid quarter turn to the left flank.
    expect(postsOf(r)[0]).toEqual({ x: 72, y: 80 });
  });

  it('keeps the collector and emitter on the same side of a rotated transistor', () => {
    const t = element('transistor', 0, 0, 160, 0, 0, { pnp: 0 });
    const r = rotateElement(t);
    expect(postsOf(r)[0]).toEqual({ x: 80, y: 80 });  // base end
    expect(postsOf(r)[1]).toEqual({ x: 64, y: -80 });  // collector, rigid turn
    expect(postsOf(r)[2]).toEqual({ x: 96, y: -80 });  // emitter
  });

  it('is a no-op on a one-post element', () => {
    const g = element('ground', 0, 0, 16, 0);
    expect(rotateElement(g)).toEqual(g);
  });
});

describe('mirrorElement', () => {
  it('keeps the bounding box and flips the order of posts on a transistor', () => {
    const t = element('transistor', 0, 0, 160, 0, 0, { pnp: 0 });
    const before = postsOf(t);
    const m = mirrorElement(t);
    expect(m).toMatchObject({ x1: 160, y1: 0, x2: 0, y2: 0 });
    // A horizontal mirror reverses the axis direction, so the dsign term moves
    // the collector and emitter across and the orientation flag is untouched.
    expect(m.flags & 1).toBe(0);
    const after = postsOf(m);
    const box = (pts: { x: number; y: number }[]) => ({
      minX: Math.min(...pts.map((p) => p.x)),
      maxX: Math.max(...pts.map((p) => p.x)),
      minY: Math.min(...pts.map((p) => p.y)),
      maxY: Math.max(...pts.map((p) => p.y)),
    });
    expect(box(after)).toEqual(box(before));
    // Base and output swapped ends; collector and emitter crossed flanks.
    expect(after[0]).toEqual({ x: 160, y: 0 });
    expect(after[1]).toEqual({ x: 0, y: -16 });
    expect(after[2]).toEqual({ x: 0, y: 16 });
  });

  it('swaps the op-amp input leads onto the true mirror side', () => {
    const a = element('opamp', 0, 0, 160, 0);
    const m = mirrorElement(a);
    expect(m).toMatchObject({ x1: 160, y1: 0, x2: 0, y2: 0 });
    // Rigid mirror of the leads: inverting was above the axis, stays above.
    expect(postsOf(m)[0]).toEqual({ x: 160, y: -8 });
    expect(postsOf(m)[1]).toEqual({ x: 160, y: 8 });
  });

  it('is a no-op on a part without a mirror', () => {
    const d = element('diode', 0, 0, 160, 0);
    expect(mirrorElement(d)).toEqual(d);
  });
});

describe('swapTerminalOrder', () => {
  it('reverses post order and keeps the body centre on a diode', () => {
    const d = element('diode', 0, 0, 160, 0);
    const s = swapTerminalOrder(d);
    expect(s).toMatchObject({ x1: 160, y1: 0, x2: 0, y2: 0 });
    expect(postsOf(s)[0]).toEqual({ x: 160, y: 0 });
    expect(postsOf(s)[1]).toEqual({ x: 0, y: 0 });
    expect((s.x1 + s.x2) / 2).toBe(80);
  });

  it('is a no-op on a part with more than two posts', () => {
    const t = element('transistor', 0, 0, 160, 0);
    expect(swapTerminalOrder(t)).toEqual(t);
  });
});
