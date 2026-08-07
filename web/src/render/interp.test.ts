import { describe, expect, it } from 'vitest';
import {
  calcLeads,
  COIL_LOOPS,
  coilPoints,
  dsign,
  interp,
  interp2,
  interpPrecise,
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
    // the perpendicular, so they exit past the bar (ZenerElm.java:58-59).
    const { bar, wing0, wing1 } = zenerMarks({ x: 16, y: 0 }, { x: 48, y: 0 });
    expect(bar).toEqual([
      { x: 48, y: -8 },
      { x: 48, y: 8 },
    ]);
    expect(wing0).toEqual({ x: 40, y: -11 });
    expect(wing1).toEqual({ x: 56, y: 11 });
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

  it('points the NPN arrow at the emitter post and the PNP one inward', () => {
    expect(transistorArrowTip(part('transistor', 0, 0, 64, 0, 0, { pnp: 1 }))).toBeNull();
    // PNP: the tip is a third of the bar back from the emitter post, between
    // the bar and the post (TransistorElm.java:241-242).
    const tip = transistorArrowTip(part('transistor', 0, 0, 64, 0, 0, { pnp: -1 }));
    expect(tip).toEqual({ x: 53, y: -5 });
  });
});
