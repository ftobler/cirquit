import { describe, expect, it } from 'vitest';
import {
  calcLeads,
  COIL_LOOPS,
  coilPoints,
  dsign,
  interp,
  interp2,
  interpPrecise,
  interp2Precise,
  rectCorners,
} from './draw';
import {
  postsOf,
  switchLever,
  switchLeverTip,
  switchIecPoints,
  switch2Poles,
  zenerMarks,
  railLead,
  railText,
  railLabelAnchor,
  railValueText,
  railValueAnchor,
  potWiperGeometry,
  transistorArrowTip,
  transistorBarContacts,
  groundBars,
} from '../model/registry';
import { capacitorPlateGeometry } from '../model/registry/elements/capacitor';
import { OPEN_HS } from '../model/registry/shared';
import { TRANSISTOR_FLIP } from '../model/registry/flags';
import { mirrorElement } from '../model/transform';
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

const part = (
  kind: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  flags = 0,
  params: Record<string, number> = {},
): CircuitElement => ({ id: 2, kind, x1, y1, x2, y2, flags, params });

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

describe('interp rounding', () => {
  it('rounds an exact half-fraction toward the integer below', () => {
    // Upstream floors x + .48 (CircuitElm.java:404-405), so a raw 1.5 lands
    // on 1, where Math.round would give 2.
    expect(interp({ x: 0, y: 0 }, { x: 3, y: 0 }, 0.5)).toEqual({ x: 1, y: 0 });
  });

  it('rounds a negative half-fraction down as well', () => {
    // floor(-1.5 + .48) = floor(-1.02) = -2.
    expect(interp({ x: 0, y: 0 }, { x: -3, y: 0 }, 0.5)).toEqual({ x: -2, y: 0 });
  });

  it('keeps the existing geometry exact under the new rounding mode', () => {
    expect(interp({ x: 0, y: 0 }, { x: 100, y: 0 }, 0.5, 10)).toEqual({ x: 50, y: -10 });
    const [l1, l2] = calcLeads(element(0, 0, 100, 0), 32);
    expect(l1).toEqual({ x: 34, y: 0 });
    expect(l2).toEqual({ x: 66, y: 0 });
  });
});

describe('interpPrecise', () => {
  it('returns the unrounded math along the segment', () => {
    // interp floors to grid pixels; the precise variant keeps the exact float
    // position, so dots glide along diagonals instead of snapping per pixel.
    const p = interpPrecise({ x: 0, y: 0 }, { x: 100, y: 100 }, 0.333);
    expect(p.x).toBeCloseTo(33.3, 10);
    expect(p.y).toBeCloseTo(33.3, 10);
    expect(p.x).not.toBe(33);
    expect(interpPrecise({ x: 0, y: 0 }, { x: 100, y: 0 }, 0.5)).toEqual({ x: 50, y: 0 });
  });

  it('keeps every point exactly on a diagonal segment', () => {
    // Rounded interp points bounce up to ~0.7 px off a 5:3 diagonal as the
    // phase creeps by sub-pixel amounts, which is the wiggle; the precise
    // variant stays at perpendicular distance 0 for the whole run.
    const a = { x: 0, y: 0 };
    const b = { x: 80, y: 48 };
    const dist = (p: Point) =>
      Math.abs((p.x - a.x) * (b.y - a.y) - (p.y - a.y) * (b.x - a.x)) /
      Math.hypot(b.y - a.y, b.x - a.x);
    let worst = 0;
    for (let i = 0; i <= 2000; i++) {
      const f = i / 2000;
      expect(dist(interpPrecise(a, b, f))).toBeCloseTo(0, 9);
      worst = Math.max(worst, dist(interp(a, b, f)));
    }
    // Sanity that this is the discriminating case: the rounded interp really
    // does leave the line, or the precise assertion above proves nothing.
    expect(worst).toBeGreaterThan(0.5);
  });

  it('never moves a dot backward along the segment', () => {
    // Rounding can stall consecutive dots on the same pixel, but a projection
    // that decreases with f would make dots reverse direction on the wire.
    const a = { x: 0, y: 0 };
    const b = { x: 80, y: 48 };
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    let prev = -Infinity;
    for (let i = 0; i <= 2000; i++) {
      const f = i / 2000;
      const p = interpPrecise(a, b, f);
      const along = ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / len;
      expect(along).toBeGreaterThanOrEqual(prev);
      prev = along;
    }
  });
});

describe('interp2Precise', () => {
  // Signed perpendicular distance of `p` from the a->b axis.
  const perpDist = (a: Point, b: Point, p: Point) =>
    Math.abs((p.x - a.x) * (b.y - a.y) - (p.y - a.y) * (b.x - a.x)) /
    Math.hypot(b.y - a.y, b.x - a.x);

  it('returns exact floats, equidistant from and perpendicular to the axis', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 96, y: 32 };  // 3:1 shallow diagonal, where the floors disagree most
    const [p, q] = interp2Precise(a, b, 0.5, 12);
    // The pair spans the perpendicular: dot with the axis is zero within float
    // epsilon, and both endpoints sit exactly 12 off the axis.
    const dot = (q.x - p.x) * (b.x - a.x) + (q.y - p.y) * (b.y - a.y);
    expect(dot).toBeCloseTo(0, 9);
    expect(perpDist(a, b, p)).toBeCloseTo(12, 9);
    expect(perpDist(a, b, q)).toBeCloseTo(12, 9);
    // Not integers: this is the exact position a floored helper would lose.
    expect(Number.isInteger(p.x)).toBe(false);
  });

  it('characterises the defect it fixes: interp2 leaves a nonzero dot', () => {
    // The two floored endpoints land on different pixel rows, tilting the bar
    // up to a pixel over its length. This pins that the rounded helper really
    // is the bug before the precise one asserts the fix.
    const a = { x: 0, y: 0 };
    const b = { x: 96, y: 32 };
    const [p, q] = interp2(a, b, 0.5, 12);
    const dot = (q.x - p.x) * (b.x - a.x) + (q.y - p.y) * (b.y - a.y);
    expect(dot).not.toBe(0);
    expect(Math.abs(dot)).toBeGreaterThan(50);
  });
});

describe('dsign', () => {
  it('is +1 for a part drawn right or down, -1 for left or up', () => {
    expect(dsign({ x: 0, y: 0 }, { x: 32, y: 0 })).toBe(1);
    expect(dsign({ x: 0, y: 0 }, { x: -32, y: 0 })).toBe(-1);
    expect(dsign({ x: 0, y: 0 }, { x: 0, y: 32 })).toBe(1);
    expect(dsign({ x: 0, y: 0 }, { x: 0, y: -32 })).toBe(-1);
  });
});

describe('rectangle', () => {
  it('squares a horizontal element at halfHeight', () => {
    const c = rectCorners({ x: 0, y: 0 }, { x: 32, y: 0 }, 6);
    expect(c.map((p) => p.x).sort((a, b) => a - b)).toEqual([0, 0, 32, 32]);
    expect(c.map((p) => p.y).sort((a, b) => a - b)).toEqual([-6, -6, 6, 6]);
    // One corner at each combination of the two x and two y values.
    expect(new Set(c.map((p) => `${p.x},${p.y}`))).toEqual(
      new Set(['0,-6', '32,-6', '32,6', '0,6']),
    );
  });

  it('swaps the perpendicular for a vertical element', () => {
    // A vertical axis displaces sideways, not vertically; this catches a
    // swapped perpendicular in the helper.
    const c = rectCorners({ x: 0, y: 0 }, { x: 0, y: 32 }, 6);
    expect(c.map((p) => p.x).sort((a, b) => a - b)).toEqual([-6, -6, 6, 6]);
    expect(c.map((p) => p.y).sort((a, b) => a - b)).toEqual([0, 0, 32, 32]);
  });

  it('keeps diagonal corners halfHeight from the axis', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 32, y: 32 };
    for (const p of rectCorners(a, b, 6)) {
      const d =
        Math.abs((p.x - a.x) * (b.y - a.y) - (p.y - a.y) * (b.x - a.x)) /
        Math.hypot(b.y - a.y, b.x - a.x);
      expect(d).toBeCloseTo(6, 9);
    }
  });

  it('has edges |b - a| long and 2*halfHeight short', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 32, y: 32 };
    const [a1, b1, b2, a2] = rectCorners(a, b, 6);
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const long = [Math.hypot(b1.x - a1.x, b1.y - a1.y), Math.hypot(a2.x - b2.x, a2.y - b2.y)];
    const short = [Math.hypot(b2.x - b1.x, b2.y - b1.y), Math.hypot(a1.x - a2.x, a1.y - a2.y)];
    for (const e of long) expect(e).toBeCloseTo(len, 9);
    for (const e of short) expect(e).toBeCloseTo(12, 9);
  });

  it("returns four corners; closing the loop is the caller's job", () => {
    expect(rectCorners({ x: 0, y: 0 }, { x: 32, y: 0 }, 6)).toHaveLength(4);
  });
});

describe('inductor coil', () => {
  // Signed perpendicular offset of `p` from the a->b axis, positive on the
  // side a positive interp `g` lands on: the 2D cross product of (b - a) and
  // (p - a), normalised by |b - a|.
  const side = (a: Point, b: Point, p: Point) =>
    ((p.x - a.x) * (b.y - a.y) - (p.y - a.y) * (b.x - a.x)) /
    Math.hypot(b.y - a.y, b.x - a.x);

  // Along-axis position of `p`, the projection onto the unit a->b direction.
  const along = (a: Point, b: Point, p: Point) =>
    ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) /
    Math.hypot(b.y - a.y, b.x - a.x);

  function assertSameSide(a: Point, b: Point): void {
    for (const p of coilPoints(a, b, COIL_LOOPS)) {
      expect(side(a, b, p)).toBeGreaterThanOrEqual(-1e-9);
    }
  }

  function assertPeakRadius(a: Point, b: Point): void {
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const offsets = coilPoints(a, b, COIL_LOOPS).map((p) => side(a, b, p));
    expect(Math.max(...offsets)).toBeCloseTo(len / (2 * COIL_LOOPS), 9);
    expect(Math.min(...offsets)).toBeCloseTo(0, 9);
  }

  function assertEndpoints(a: Point, b: Point): void {
    const pts = coilPoints(a, b, COIL_LOOPS);
    expect(pts[0].x).toBeCloseTo(a.x, 9);
    expect(pts[0].y).toBeCloseTo(a.y, 9);
    expect(pts[pts.length - 1].x).toBeCloseTo(b.x, 9);
    expect(pts[pts.length - 1].y).toBeCloseTo(b.y, 9);
  }

  function assertEvenCentres(a: Point, b: Point): void {
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const r = len / (2 * COIL_LOOPS);
    // Each loop apex sits at full radius, and there is one per loop.
    const maxima = coilPoints(a, b, COIL_LOOPS).filter(
      (p) => Math.abs(side(a, b, p) - r) <= 1e-9,
    );
    expect(maxima).toHaveLength(COIL_LOOPS);
    for (let k = 0; k < COIL_LOOPS; k++) {
      expect(along(a, b, maxima[k])).toBeCloseTo(len * ((2 * k + 1) / (2 * COIL_LOOPS)), 9);
    }
  }

  it('crosses the axis exactly twice between the endpoints', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 32, y: 0 };
    const interior = coilPoints(a, b, COIL_LOOPS).slice(1, -1);
    const crossings = interior.filter((p) => Math.abs(side(a, b, p)) <= 1e-9);
    expect(crossings).toHaveLength(2);
  });

  it('bulges every loop to the same side', () => {
    assertSameSide({ x: 0, y: 0 }, { x: 32, y: 0 });
  });

  it('peaks at |b-a|/(2*loops) and returns to the axis', () => {
    assertPeakRadius({ x: 0, y: 0 }, { x: 32, y: 0 });
  });

  it('lands the first and last points on the leads', () => {
    assertEndpoints({ x: 0, y: 0 }, { x: 32, y: 0 });
  });

  it('spaces the loop centres evenly at 1/6, 3/6, 5/6', () => {
    assertEvenCentres({ x: 0, y: 0 }, { x: 32, y: 0 });
  });

  it('keeps side, radius, endpoints and spacing when vertical', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 0, y: 32 };
    assertSameSide(a, b);
    assertPeakRadius(a, b);
    assertEndpoints(a, b);
    assertEvenCentres(a, b);
  });

  it('keeps side, radius, endpoints and spacing at 45 degrees', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 32, y: 32 };
    assertSameSide(a, b);
    assertPeakRadius(a, b);
    assertEndpoints(a, b);
    assertEvenCentres(a, b);
  });

  it('draws true semicircles, not sine humps', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 32, y: 0 };
    const len = 32;
    const r = len / (2 * COIL_LOOPS);
    // Quarter point of the first loop: theta = PI/4, step 3 of 12.
    const p = coilPoints(a, b, COIL_LOOPS)[3];
    expect(side(a, b, p)).toBeCloseTo(r * Math.sin(Math.PI / 4), 9);
    expect(along(a, b, p)).toBeCloseTo(r * (1 - Math.cos(Math.PI / 4)), 9);
  });
});

describe('switch lever', () => {
  const lead1: Point = { x: 34, y: 0 };
  const lead2: Point = { x: 66, y: 0 };

  it('lifts the open tip OPEN_HS units up from the contact', () => {
    // The whole signed offset, not just its magnitude: a sign flip would put
    // the open lever below the axis.
    expect(switchLeverTip(lead1, lead2, false)).toEqual({ x: 66, y: -16 });
  });

  it('rides the closed lever 2 units up from the axis', () => {
    // Upstream draws the closed lever at hs1 = hs2 = 2, not on the axis
    // (SwitchElm.java:118-120).
    const [pivot, tip] = switchLever(lead1, lead2, true);
    expect(pivot).toEqual({ x: 34, y: -2 });
    expect(tip).toEqual({ x: 66, y: -2 });
  });

  it('lifts by OPEN_HS units', () => {
    const tip = switchLeverTip(lead1, lead2, false);
    const d =
      Math.abs((tip.x - lead1.x) * (lead2.y - lead1.y) - (tip.y - lead1.y) * (lead2.x - lead1.x)) /
      Math.hypot(lead2.x - lead1.x, lead2.y - lead1.y);
    expect(d).toBeCloseTo(16, 9);
  });

  it('keeps the lift side and magnitude when vertical', () => {
    const a: Point = { x: 0, y: 0 };
    const b: Point = { x: 0, y: 100 };
    expect(switchLeverTip(a, b, false)).toEqual({ x: 16, y: 100 });
    expect(switchLeverTip(a, b, true)).toEqual({ x: 2, y: 100 });
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

describe('switch IEC armature', () => {
  const lead1: Point = { x: 34, y: 0 };
  const lead2: Point = { x: 66, y: 0 };

  it('spreads the top bar and mark across the lift side', () => {
    // The armature sits entirely on the +perpendicular (up) side of the axis
    // (SwitchElm.java:105-112).
    for (const p of switchIecPoints(lead1, lead2, true)) {
      expect(p.y).toBeLessThan(0);
    }
  });

  it('recomputes the toggle end from the lever position', () => {
    const [open0] = switchIecPoints(lead1, lead2, false);
    const [closed0] = switchIecPoints(lead1, lead2, true);
    // Open: half the lift (openhs/2). Closed: the lever's own 2-unit offset.
    expect(open0).toEqual({ x: 50, y: -8 });
    expect(closed0).toEqual({ x: 50, y: -2 });
  });

  it('lays the dashed link between the centre and the top bar', () => {
    // x6 (centre, 13 up) and x1 (top bar, 24 up) sit on the axis line.
    const pts = switchIecPoints(lead1, lead2, true);
    expect(pts[6].x).toBe(50);
    expect(pts[1].x).toBe(50);
    expect(pts[1].y).toBeLessThan(pts[6].y);
  });
});

describe('ground symbol bars', () => {
  const p1: Point = { x: 0, y: 0 };
  const p2: Point = { x: 32, y: 0 };

  it('hangs the earth bars off the far end, not the post', () => {
    // Three bars at fractions 1, 1+5/32 and 1+10/32 past the free end, with
    // half-widths 10, 6, 2 (GroundElm.java:68-73). The first sits on the far
    // endpoint itself, the last 10 units past it; the post end sees nothing.
    expect(groundBars(p1, p2, 0)).toEqual([
      [{ x: 32, y: -10 }, { x: 32, y: 10 }],
      [{ x: 37, y: -6 }, { x: 37, y: 6 }],
      [{ x: 42, y: -2 }, { x: 42, y: 2 }],
    ]);
  });

  it('lays the bars across a vertical stem', () => {
    // A vertical stem draws the bars horizontal, at the far end, not stacked
    // below the post like the old hardcoded symbol.
    expect(groundBars({ x: 0, y: 0 }, { x: 0, y: 32 }, 0)[0]).toEqual([
      { x: 10, y: 32 },
      { x: -10, y: 32 },
    ]);
  });

  it('keeps the bars perpendicular to a diagonal stem', () => {
    // The signed-perpendicular check the switch tests use: the bar delta
    // dotted against the stem axis is exactly zero, surviving interp rounding.
    const b: Point = { x: 32, y: 32 };
    for (const [q, r] of groundBars(p1, b, 0)) {
      const dot = (r.x - q.x) * (b.x - p1.x) + (r.y - q.y) * (b.y - p1.y);
      expect(dot).toBe(0);
    }
  });

  it('chassis draws three parallel stubs down the base bar', () => {
    const bars = groundBars(p1, p2, 1);
    expect(bars).toHaveLength(4);
    expect(bars[0]).toEqual([{ x: 32, y: -10 }, { x: 32, y: 10 }]);
    // Each stub runs 8 along the stem and 5 across the perpendicular, the
    // direction upstream's dpx1/dpy1 terms produce (GroundElm.java:80).
    for (const [q, r] of bars.slice(1)) {
      expect(r.x - q.x).toBe(8);
      expect(r.y - q.y).toBe(5);
    }
  });

  it('signal draws a V from the base bar to a tip past the far end', () => {
    expect(groundBars(p1, p2, 2)).toEqual([
      [{ x: 32, y: -10 }, { x: 32, y: 10 }],
      [{ x: 32, y: -10 }, { x: 42, y: 0 }],
      [{ x: 32, y: 10 }, { x: 42, y: 0 }],
    ]);
  });

  it('common is just the base bar', () => {
    expect(groundBars(p1, p2, 3)).toEqual([[{ x: 32, y: -10 }, { x: 32, y: 10 }]]);
  });

  it('places every symbolType on a vertical stem at the exact upstream endpoints', () => {
    // The fixed 32-unit vertical ground the plan pins: earth bars at fractions
    // 1, 1+5/32 and 1+10/32 past the far end with half-widths 10, 6 and 2
    // (GroundElm.java:68-73), the chassis base bar plus three stubs each
    // running 8 down the stem and 5 back across it (:74-81), the signal V to a
    // point 10 past the far end (:82-88), and the common base bar alone (:90).
    const v1: Point = { x: 0, y: 0 };
    const v2: Point = { x: 0, y: 32 };
    expect(groundBars(v1, v2, 0)).toEqual([
      [{ x: 10, y: 32 }, { x: -10, y: 32 }],
      [{ x: 6, y: 37 }, { x: -6, y: 37 }],
      [{ x: 2, y: 42 }, { x: -2, y: 42 }],
    ]);
    expect(groundBars(v1, v2, 1)).toEqual([
      [{ x: 10, y: 32 }, { x: -10, y: 32 }],
      [{ x: 10, y: 32 }, { x: 5, y: 40 }],
      [{ x: 0, y: 32 }, { x: -5, y: 40 }],
      [{ x: -10, y: 32 }, { x: -15, y: 40 }],
    ]);
    expect(groundBars(v1, v2, 2)).toEqual([
      [{ x: 10, y: 32 }, { x: -10, y: 32 }],
      [{ x: 10, y: 32 }, { x: 0, y: 42 }],
      [{ x: -10, y: 32 }, { x: 0, y: 42 }],
    ]);
    expect(groundBars(v1, v2, 3)).toEqual([[{ x: 10, y: 32 }, { x: -10, y: 32 }]]);
  });

  it('a zero-length stem collapses onto the point instead of going NaN', () => {
    // A ground dragged onto itself keeps a legal degenerate symbol.
    const collapsed = groundBars({ x: 8, y: 8 }, { x: 8, y: 8 }, 0);
    expect(collapsed).toEqual([
      [{ x: 8, y: 8 }, { x: 8, y: 8 }],
      [{ x: 8, y: 8 }, { x: 8, y: 8 }],
      [{ x: 8, y: 8 }, { x: 8, y: 8 }],
    ]);
    expect(groundBars({ x: 8, y: 8 }, { x: 8, y: 8 }, 2)).toEqual([
      [{ x: 8, y: 8 }, { x: 8, y: 8 }],
      [{ x: 8, y: 8 }, { x: 8, y: 8 }],
      [{ x: 8, y: 8 }, { x: 8, y: 8 }],
    ]);
  });
});

describe('SPDT poles', () => {
  it('fans the poles off the body, at the throws offsets', () => {
    // The poles sit at fraction 1 of the body leads, not of the whole span:
    // for a 100-long element that is x 66, while the throw posts sit at x 100
    // (Switch2Elm.java:79-80).
    const poles = switch2Poles(part('switch2', 0, 0, 100, 0, 0, { throwCount: 2 }));
    expect(poles).toEqual([
      { x: 66, y: -16 },
      { x: 66, y: 16 },
    ]);
  });

  it('uses the same integer-division spacing as the posts', () => {
    expect(switch2Poles(part('switch2', 0, 0, 100, 0, 0, { throwCount: 4 }))).toEqual([
      { x: 66, y: -16 },
      { x: 66, y: 0 },
      { x: 66, y: 16 },
      { x: 66, y: 32 },
    ]);
  });
});

describe('zener cathode marks', () => {
  it('spreads the swept wings past both bar ends', () => {
    // The wings start a fifth of the way back along the bar and step 8 across
    // the perpendicular, so they exit past the bar (ZenerElm.java:58-59). The
    // marks are body geometry, so the wing tips sit at the exact floats rather
    // than the grid-floored positions `interp` would give (diagonal-body-
    // rounding); on this horizontal bar the difference is -11.2 vs -11.
    const { bar, wing0, wing1 } = zenerMarks({ x: 16, y: 0 }, { x: 48, y: 0 });
    expect(bar).toEqual([
      { x: 48, y: -8 },
      { x: 48, y: 8 },
    ]);
    expect(wing0.x).toBe(40);
    expect(wing0.y).toBeCloseTo(-11.2, 9);
    expect(wing1.x).toBe(56);
    expect(wing1.y).toBeCloseTo(11.2, 9);
    expect(wing0.x).toBeLessThan(bar[0].x);
    expect(wing1.x).toBeGreaterThan(bar[1].x);
  });
});

describe('voltage rail geometry', () => {
  it('ends the stem one circle radius short of the far end', () => {
    expect(railLead({ x: 0, y: 0 }, { x: 100, y: 0 })).toEqual({ x: 83, y: 0 });
    expect(railLead({ x: 0, y: 0 }, { x: 100, y: 0 })).not.toEqual({ x: 60, y: 0 });
  });

  it('labels positive rails with a plus and the short form', () => {
    expect(railText(5)).toBe('+5V');
    expect(railText(-5)).toBe('-5V');
    expect(railText(0.5)).toBe('+0.5 V');
    expect(railText(-0.5)).toBe('-0.5 V');
    expect(railText(0)).toBe('0 V');
  });

  it('places the DC label clear of the stem end', () => {
    // Left-to-right: 4 past the end (CircuitElm.java:961-962).
    expect(railLabelAnchor({ x: 0, y: 0 }, { x: 83, y: 0 }, 20)).toEqual({ x: 87, y: 0 });
    // Right-to-left: 4 plus the text width before the end.
    expect(railLabelAnchor({ x: 100, y: 0 }, { x: 17, y: 0 }, 20)).toEqual({ x: -7, y: 0 });
    // Vertical: centred on the stem end, stepped one font height along the
    // travel direction, which for an upward rail is above it.
    expect(railLabelAnchor({ x: 0, y: 100 }, { x: 0, y: 17 }, 10)).toEqual({ x: -5, y: 5 });
  });

  it('labels an AC rail with voltage and frequency', () => {
    const rail = part('rail', 0, 0, 0, -100, 0, { waveform: 1, maxVoltage: 5, frequency: 40 });
    expect(railValueText(rail, true)).toBe('5V 40Hz');
    expect(railValueText(rail, false)).toBe('5V');
  });

  it('anchors the AC value label beside the waveform circle', () => {
    // Vertical rail: left of point2 by the circle radius (CircuitElm.java:938).
    const rail = part('rail', 0, 100, 0, 0);
    expect(railValueAnchor(rail, 20)).toEqual({ x: -39, y: 6 });
  });
});

describe('pot wiper arrow', () => {
  it('swings the arrow from the wiper corner toward the axis', () => {
    const { corner, arrowPoint, arrowBase } = potWiperGeometry(
      part('potentiometer', 0, 0, 32, 0, 0, { position: 0.5 }),
    );
    expect(corner).toEqual({ x: 16, y: -16 });
    // The tip is 8 toward the axis from the corner, the base is 8 wide and a
    // full clen back from it (PotElm.java:211-216).
    expect(arrowPoint).toEqual({ x: 16, y: -8 });
    expect(arrowBase).toEqual([
      { x: 24, y: -16 },
      { x: 8, y: -16 },
    ]);
  });

  it('tracks the wiper position along the body', () => {
    const { corner, arrowPoint } = potWiperGeometry(
      part('potentiometer', 0, 0, 32, 0, 0, { position: 1 }),
    );
    expect(corner).toEqual({ x: 32, y: -16 });
    expect(arrowPoint).toEqual({ x: 32, y: -8 });
  });

  it('flips the arrow below with FLAG_FLIP_OFFSET', () => {
    const { corner, arrowPoint, arrowBase } = potWiperGeometry(
      part('potentiometer', 0, 0, 32, 0, 4, { position: 0.5 }),
    );
    expect(corner).toEqual({ x: 16, y: 16 });
    expect(arrowPoint).toEqual({ x: 16, y: 8 });
    expect(arrowBase).toEqual([
      { x: 8, y: 16 },
      { x: 24, y: 16 },
    ]);
  });
});

describe('transistor drawing geometry', () => {
  it('contacts the base bar near the axis, inside the posts', () => {
    // The leads attach at 1-13/dn with a 6-unit half separation, so the bar
    // contact sits well inside the ±16 posts (TransistorElm.java:230).
    const [c1, e1] = transistorBarContacts(part('transistor', 0, 0, 64, 0, 0, { pnp: 1 }));
    expect(c1).toEqual({ x: 51, y: -6 });
    expect(e1).toEqual({ x: 51, y: 6 });
  });

  it('keeps the NPN arrow pointing at the emitter post', () => {
    expect(transistorArrowTip(part('transistor', 0, 0, 64, 0, 0, { pnp: 1 }))).toBeNull();
  });

  it('lands the PNP arrow tip on the emitter bar contact', () => {
    // The PNP arrow is the mirror of the NPN one: drawn from the emitter post
    // to the bar contact, so it lies on the emitter lead by construction
    // instead of floating beside it as upstream's does (TransistorElm.java:
    // 241-242).
    const t = part('transistor', 0, 0, 64, 0, 0, { pnp: -1 });
    expect(transistorArrowTip(t)).toEqual({ x: 51, y: -6 });
    expect(transistorArrowTip(t)).toEqual(transistorBarContacts(t)[1]);
  });

  it('keeps the PNP arrow collinear with the emitter lead', () => {
    // The arrow is drawn from the emitter post to the bar contact, so the
    // cross product of (tip - post) and (barContact - post) is zero: the
    // arrow axis lies exactly on the lead at any orientation, polarity and
    // flip. Upstream's floating tip tilts the arrow 7 degrees off the lead
    // (TransistorElm.java:241-242).
    const cross = (post: Point, tip: Point, contact: Point) =>
      (tip.x - post.x) * (contact.y - post.y) - (tip.y - post.y) * (contact.x - post.x);
    const variants = [
      part('transistor', 0, 0, 64, 0, 0, { pnp: -1 }),
      part('transistor', 0, 0, 0, 64, 0, { pnp: -1 }),
      part('transistor', 0, 0, 64, 0, TRANSISTOR_FLIP, { pnp: -1 }),
    ];
    for (const v of variants) {
      const tip = transistorArrowTip(v);
      const contact = transistorBarContacts(v)[1];
      const post = postsOf(v)[2];
      expect(tip).not.toBeNull();
      expect(cross(post, tip as Point, contact)).toBe(0);
    }
  });

  it('keeps the PNP arrow tip on the emitter side of the axis', () => {
    // The tip is the bar contact, and it must stay on the emitter's side of
    // the axis (the side the emitter post is on) under a mirror and under
    // TRANSISTOR_FLIP, or the arrow points at the wrong terminal. Same
    // signed-distance formula as the registry tests' axisSide helper.
    const side = (e: CircuitElement, p: Point): number =>
      (e.x2 - e.x1) * (p.y - e.y1) - (e.y2 - e.y1) * (p.x - e.x1);
    const t = part('transistor', 0, 0, 64, 0, 0, { pnp: -1 });
    const variants = [t, mirrorElement(t), part('transistor', 0, 0, 64, 0, TRANSISTOR_FLIP, { pnp: -1 })];
    for (const v of variants) {
      const tip = transistorArrowTip(v);
      expect(tip).not.toBeNull();
      expect(side(v, tip as Point) * side(v, postsOf(v)[2])).toBeGreaterThan(0);
    }
  });

  it('starts the C/E leads on the bar front face', () => {
    // The contact shares the front edge's axial coordinate and its
    // perpendicular offset is inside the bar's half height, so the leads
    // begin on the face rather than short of it or on the far side. States
    // the property rather than the numbers, so a change to the 1-13/dn or ±6
    // fractions that splits the junction fails here.
    const cases = [
      part('transistor', 0, 0, 64, 0, 0, { pnp: 1 }),
      part('transistor', 0, 0, 0, 64, 0, { pnp: 1 }),
    ];
    for (const t of cases) {
      const p1 = { x: t.x1, y: t.y1 };
      const p2 = { x: t.x2, y: t.y2 };
      const dn = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      const front = interp2(p1, p2, 1 - 13 / dn, OPEN_HS);
      const axial = (p: Point): number => (p.x - p1.x) * (p2.x - p1.x) + (p.y - p1.y) * (p2.y - p1.y);
      const perp = (p: Point): number =>
        Math.abs((p.x - p1.x) * (p2.y - p1.y) - (p.y - p1.y) * (p2.x - p1.x));
      for (const contact of transistorBarContacts(t)) {
        expect(axial(contact)).toBe(axial(front[0]));
        expect(perp(contact)).toBeLessThanOrEqual(perp(front[0]));
      }
    }
  });
});

describe('capacitor plates', () => {
  // Signed perpendicular distance of `p` from the a->b axis.
  const perpDist = (a: Point, b: Point, p: Point) =>
    Math.abs((p.x - a.x) * (b.y - a.y) - (p.y - a.y) * (b.x - a.x)) /
    Math.hypot(b.y - a.y, b.x - a.x);

  it('sits 12 either side of the axis, each plate 24 long', () => {
    const cap = part('capacitor', 0, 0, 160, 0);
    const { plate1, plate2 } = capacitorPlateGeometry(cap);
    // Horizontal axis: the plate endpoints straddle y = 0 at ±12, upstream's
    // `interpPoint2(..., f, 12)` half-width (CapacitorElm.java:107-108).
    expect(plate1.map((p) => p.y).sort((a, b) => a - b)).toEqual([-12, 12]);
    expect(plate2.map((p) => p.y).sort((a, b) => a - b)).toEqual([-12, 12]);
    // Assert the geometry, not the pixels: each plate is 24 long, and the two
    // plates' half-widths together span 24 from the axis.
    expect(Math.abs(plate1[1].y - plate1[0].y)).toBe(24);
    expect(plate2[0].y).toBe(-12);
    expect(plate2[1].y).toBe(12);
  });

  it('leaves an 8-unit gap between the plates for a long capacitor', () => {
    const cap = part('capacitor', 0, 0, 160, 0);
    const { plate1, plate2 } = capacitorPlateGeometry(cap);
    // Plate centres at fractions f and 1-f of the axis, f = (dn/2-4)/dn
    // (CapacitorElm.java:100), so the gap is exactly 8 on any length.
    const centreX = (plate: [Point, Point]) => (plate[0].x + plate[1].x) / 2;
    expect(centreX(plate2) - centreX(plate1)).toBe(8);
  });

  it('keeps the plates perpendicular to the axis at several angles', () => {
    // The shallow 3:1 and 5:3 slopes are where the floored lead axis diverges
    // most from the true axis; 45 degrees happens to land the floors in step.
    const slopes: [number, number][] = [
      [96, 32],
      [80, 48],
      [32, 96],
      [64, 64],
      [112, 16],
    ];
    for (const [dx, dy] of slopes) {
      const cap = part('capacitor', 0, 0, dx, dy);
      const { plate1, plate2 } = capacitorPlateGeometry(cap);
      // Each plate is perpendicular to the true element axis: dot with the
      // axis is zero within float epsilon.
      for (const [a, b] of [plate1, plate2]) {
        const dot = (b.x - a.x) * dx + (b.y - a.y) * dy;
        expect(dot).toBeCloseTo(0, 9);
      }
      // The two plates are parallel to each other: cross product zero.
      const d1 = { x: plate1[1].x - plate1[0].x, y: plate1[1].y - plate1[0].y };
      const d2 = { x: plate2[1].x - plate2[0].x, y: plate2[1].y - plate2[0].y };
      expect(d1.x * d2.y - d1.y * d2.x).toBeCloseTo(0, 9);
      // And each endpoint really does sit 12 off the true axis.
      for (const p of [...plate1, ...plate2]) {
        expect(perpDist({ x: 0, y: 0 }, { x: dx, y: dy }, p)).toBeCloseTo(12, 9);
      }
    }
  });

  it('changes nothing for axis-aligned capacitors', () => {
    // The rounding is invisible on-axis: the precise true-axis plates equal
    // the floored-lead computation the fix replaced, which is what keeps the
    // change safe to apply across a dozen elements.
    for (const cap of [
      part('capacitor', 0, 0, 160, 0),
      part('capacitor', 0, 0, 0, 160),
    ]) {
      const { lead1, lead2, plate1, plate2 } = capacitorPlateGeometry(cap);
      expect(plate1).toEqual(interp2(lead1, lead2, 0, 12));
      expect(plate2).toEqual(interp2(lead1, lead2, 1, 12));
    }
  });

  it('keeps posts and lead ends on integers, axis-aligned and diagonal', () => {
    for (const cap of [
      part('capacitor', 0, 0, 160, 0),
      part('capacitor', 0, 0, 96, 32),
    ]) {
      const { lead1, lead2 } = capacitorPlateGeometry(cap);
      for (const p of [lead1, lead2]) {
        expect(Number.isInteger(p.x)).toBe(true);
        expect(Number.isInteger(p.y)).toBe(true);
      }
    }
    const diag = part('capacitor', 0, 0, 96, 32);
    expect(Number.isInteger(diag.x1) && Number.isInteger(diag.y1)).toBe(true);
    expect(Number.isInteger(diag.x2) && Number.isInteger(diag.y2)).toBe(true);
  });

  it('falls back to the posts on a short element without crossing the plates', () => {
    const cap = part('capacitor', 0, 0, 6, 0);
    const { lead1, lead2, plate1, plate2 } = capacitorPlateGeometry(cap);
    // calcLeads' short-element fallback returns the posts (dn < bodyLength);
    // the plates follow to fractions 0 and 1 of the axis, still ±12 and never
    // crossed.
    expect(lead1).toEqual({ x: 0, y: 0 });
    expect(lead2).toEqual({ x: 6, y: 0 });
    expect(plate1.map((p) => p.x).sort((a, b) => a - b)).toEqual([0, 0]);
    expect(plate2.map((p) => p.x).sort((a, b) => a - b)).toEqual([6, 6]);
    expect(plate1[1].y - plate1[0].y).toBe(24);
  });

  it('draws identical plate geometry for capacitor and polarizedCapacitor', () => {
    // Both share drawCapacitorBody (polarizedCapacitor.ts:10), so one test
    // covers both kinds; a future edit that draws only one its own body
    // breaks this.
    const cap = part('capacitor', 0, 0, 160, 0);
    const pol = part('polarizedCapacitor', 0, 0, 160, 0);
    const a = capacitorPlateGeometry(cap);
    const b = capacitorPlateGeometry(pol);
    expect(b.lead1).toEqual(a.lead1);
    expect(b.lead2).toEqual(a.lead2);
    expect(b.plate1).toEqual(a.plate1);
    expect(b.plate2).toEqual(a.plate2);
  });
});
