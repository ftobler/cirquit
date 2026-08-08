import { describe, expect, it } from 'vitest';
import type { CircuitElement } from '../model/types';
import { postDotPoints, shouldDrawDot } from './junction';

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

describe('junction dots', () => {
  it('hides a pass-through connection and draws the two dead ends', () => {
    // A resistor and a wire share one post: the shared coordinate counts 2 and
    // draws no dot, the two free endpoints count 1 and draw.
    const wire = el('wire', 0, 0, 80, 0);
    const resistor = el('resistor', 80, 0, 160, 0);
    const counts = postDotPoints([wire, resistor]);

    expect(counts.get('80,0')).toBe(2);
    expect(shouldDrawDot(counts.get('80,0')!)).toBe(false);
    expect(shouldDrawDot(counts.get('0,0')!)).toBe(true);
    expect(shouldDrawDot(counts.get('160,0')!)).toBe(true);
  });

  it('draws a dot at a three-wire junction and at a floating end', () => {
    const a = el('wire', 0, 0, 80, 0);
    const b = el('wire', 80, 0, 80, 80);
    const c = el('wire', 80, 0, 160, 0);
    const counts = postDotPoints([a, b, c]);

    // The T-junction counts three posts, so it draws; the dangling ends count 1.
    expect(counts.get('80,0')).toBe(3);
    expect(shouldDrawDot(counts.get('80,0')!)).toBe(true);
    expect(counts.get('0,0')).toBe(1);
    expect(shouldDrawDot(counts.get('0,0')!)).toBe(true);
  });

  it('ignores a routed wire bend vertices: only the two endpoints count', () => {
    const routed = el('wire', 0, 0, 160, 0);
    routed.route = [
      [0, 0],
      [80, 80],
      [160, 0],
    ];
    const counts = postDotPoints([routed]);

    expect(counts.has('80,80')).toBe(false);
    expect(counts.get('0,0')).toBe(1);
    expect(counts.get('160,0')).toBe(1);
  });

  it('a junction where four wires meet counts 4 and draws one dot', () => {
    const wires = [
      el('wire', 0, 0, 80, 0),
      el('wire', 80, 0, 160, 0),
      el('wire', 80, 0, 80, 80),
      el('wire', 80, 0, 80, -80),
    ];
    const counts = postDotPoints(wires);
    expect(counts.get('80,0')).toBe(4);
    expect(shouldDrawDot(counts.get('80,0')!)).toBe(true);
  });
});
