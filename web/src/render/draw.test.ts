import { describe, expect, it } from 'vitest';
import { calcLeads, formatValue, interp, interp2 } from './draw';
import type { CircuitElement } from '../model/types';

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
    // Displacing a horizontal line moves it vertically.
    const p = interp({ x: 0, y: 0 }, { x: 100, y: 0 }, 0.5, 10);
    expect(p.x).toBe(50);
    expect(Math.abs(p.y)).toBe(10);
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
