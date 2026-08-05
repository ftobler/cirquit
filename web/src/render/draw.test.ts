import { describe, expect, it } from 'vitest';
import { calcLeads, formatValue, interp, interp2 } from './draw';
import { postsOf, switchLeverTip } from '../model/registry';
import type { CircuitElement, Point } from '../model/types';

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

describe('geometry', () => {
  it('interpolates along a segment', () => {
    expect(interp({ x: 0, y: 0 }, { x: 100, y: 0 }, 0.5)).toEqual({ x: 50, y: 0 });
  });

  it('offsets perpendicular to the segment', () => {
    // Displacing a horizontal line moves it vertically, and positive g is up
    // on screen (canvas y grows downward).
    const p = interp({ x: 0, y: 0 }, { x: 100, y: 0 }, 0.5, 10);
    expect(p.x).toBe(50);
    expect(p.y).toBe(-10);
  });

  it('rotates the perpendicular with the segment', () => {
    // A vertical line displaces sideways instead.
    const p = interp({ x: 0, y: 0 }, { x: 0, y: 100 }, 0.5, 10);
    expect(p.x).toBe(10);
    expect(p.y).toBe(50);
  });

  it('returns mirrored pairs', () => {
    const [a, b] = interp2({ x: 0, y: 0 }, { x: 100, y: 0 }, 0.5, 8);
    expect(a.x).toBe(50);
    expect(b.x).toBe(50);
    expect(a.y).toBe(-b.y);
  });

  it('splits an element into leads and a centred body', () => {
    const [l1, l2] = calcLeads(element(0, 0, 100, 0), 32);
    expect(l1).toEqual({ x: 34, y: 0 });
    expect(l2).toEqual({ x: 66, y: 0 });
  });

  it('collapses the leads when the element is shorter than its body', () => {
    const [l1, l2] = calcLeads(element(0, 0, 10, 0), 32);
    expect(l1).toEqual({ x: 0, y: 0 });
    expect(l2).toEqual({ x: 10, y: 0 });
  });
});

describe('switch lever', () => {
  const lead1: Point = { x: 34, y: 0 };
  const lead2: Point = { x: 66, y: 0 };

  it('lifts upward when open on a left-to-right switch', () => {
    const tip = switchLeverTip(lead1, lead2, false);
    expect(tip.y).toBeLessThan(lead2.y);
  });

  it('sits on the contact when closed', () => {
    expect(switchLeverTip(lead1, lead2, true)).toBe(lead2);
  });

  it('lifts by OPEN_HS units', () => {
    const tip = switchLeverTip(lead1, lead2, false);
    const d =
      Math.abs((tip.x - lead1.x) * (lead2.y - lead1.y) - (tip.y - lead1.y) * (lead2.x - lead1.x)) /
      Math.hypot(lead2.x - lead1.x, lead2.y - lead1.y);
    expect(d).toBeCloseTo(16, 9);
  });

  it('opens to the same side as the SPDT throws', () => {
    const spdt: CircuitElement = {
      id: 2,
      kind: 'switch2',
      x1: 0,
      y1: 0,
      x2: 100,
      y2: 0,
      flags: 0,
      params: { throwCount: 2 },
    };
    const openThrow = postsOf(spdt)[1];
    const leverTip = switchLeverTip({ x: 0, y: 0 }, { x: 100, y: 0 }, false);
    const a: Point = { x: 0, y: 0 };
    const b: Point = { x: 100, y: 0 };
    // Signed perpendicular offset from the a->b axis, positive for a positive g.
    const side = (p: Point) =>
      ((p.x - a.x) * (b.y - a.y) + (p.y - a.y) * (a.x - b.x)) / Math.hypot(b.y - a.y, a.x - b.x);
    expect(side(openThrow)).toBeGreaterThan(0);
    expect(Math.sign(side(leverTip))).toBe(Math.sign(side(openThrow)));
  });

  it('keeps the lever rigid when rotated', () => {
    const a: Point = { x: 0, y: 0 };
    const b: Point = { x: 0, y: 100 };
    const tip = switchLeverTip(a, b, false);
    expect(tip.x - a.x).toBe(16);
    expect(Math.hypot(tip.x - b.x, tip.y - b.y)).toBe(16);
  });
});

describe('value formatting', () => {
  it('uses engineering prefixes', () => {
    expect(formatValue(4700, 'Ω')).toBe('4.7k Ω');
    expect(formatValue(0.000001, 'F')).toBe('1µ F');
    expect(formatValue(1e6, 'Ω')).toBe('1M Ω');
    expect(formatValue(0.05, 'A')).toBe('50m A');
  });

  it('handles zero and non-finite values', () => {
    expect(formatValue(0, 'V')).toBe('0 V');
    expect(formatValue(NaN)).toBe('--');
  });

  it('keeps the sign', () => {
    expect(formatValue(-2.5, 'V')).toBe('-2.5 V');
  });
});
