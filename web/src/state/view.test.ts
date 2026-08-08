import { describe, expect, it } from 'vitest';
import type { CircuitElement } from '../model/types';
import { CENTER_MARGIN_H, CENTER_MARGIN_W, circuitBounds, fitView } from './view';

/** Minimal two-endpoint element: circuitBounds only reads the stored endpoints. */
const el = (x1: number, y1: number, x2: number, y2: number): CircuitElement => ({
  id: 0,
  kind: 'wire',
  x1,
  y1,
  x2,
  y2,
  flags: 0,
  params: {},
});

describe('circuitBounds', () => {
  it('walks element endpoints for the exact min/max box', () => {
    expect(circuitBounds([el(0, 0, 160, 0), el(-16, 48, 144, 48)])).toEqual({
      minX: -16,
      minY: 0,
      width: 176,
      height: 48,
    });
  });

  it('returns null for an empty circuit', () => {
    expect(circuitBounds([])).toBeNull();
  });

  it('includes a routed wire route corners beyond its two posts', () => {
    const routed = el(0, 0, 160, 0);
    routed.route = [
      [0, 0],
      [0, -48],
      [208, -48],
      [160, 0],
    ];
    // The detour reaches up to y=-48 and x=208, well outside the stored span.
    expect(circuitBounds([routed])).toEqual({
      minX: 0,
      minY: -48,
      width: 208,
      height: 48,
    });
  });
});

describe('fitView', () => {
  it('centres the bounds in the viewport at the fitted scale', () => {
    // scale = min(800/540, 600/300) = 1.4815, not capped by the 1.5 limit.
    const view = fitView({ minX: 100, minY: 50, width: 400, height: 200 }, 800, 600);
    expect(view.scale).toBeCloseTo(800 / (400 + CENTER_MARGIN_W), 10);
    expect(view.scale).toBeCloseTo(1.4815, 4);
    // The bounds centre (300, 150) lands on the viewport centre (400, 300).
    expect((300 - view.x) * view.scale).toBeCloseTo(400, 10);
    expect((150 - view.y) * view.scale).toBeCloseTo(300, 10);
  });

  it('caps the scale at 1.5 like upstream', () => {
    expect(fitView({ minX: 0, minY: 0, width: 10, height: 10 }, 800, 600).scale).toBe(1.5);
  });

  it('uses the 140/100 margins in the fit, not the bare element box', () => {
    // The width constraint binds: scale = min(800/(500+140), 600/(200+100)) =
    // min(1.25, 2) = 1.25, under the 1.5 cap, so the margin arithmetic is what
    // pins the value.
    const view = fitView({ minX: 0, minY: 0, width: 500, height: 200 }, 800, 600);
    expect(view.scale).toBeCloseTo(800 / (500 + CENTER_MARGIN_W), 10);
    expect(view.scale).toBeCloseTo(1.25, 10);
  });

  it('lets the height constraint bind the fit', () => {
    // A tall narrow circuit: min(800/(160+140), 600/(2000+100)) = 600/2100, so
    // the height term and its 100 margin are what pin the value.
    const view = fitView({ minX: 0, minY: 0, width: 160, height: 2000 }, 800, 600);
    expect(view.scale).toBeCloseTo(600 / (2000 + CENTER_MARGIN_H), 10);
    expect(view.scale).toBeCloseTo(0.2857, 4);
    // The bounds centre (80, 1000) still lands on the viewport centre.
    expect((80 - view.x) * view.scale).toBeCloseTo(400, 10);
    expect((1000 - view.y) * view.scale).toBeCloseTo(300, 10);
  });
});
