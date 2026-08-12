import { describe, expect, it } from 'vitest';
import { GRID_SIZE, type CircuitElement } from '../model/types';
import { defFor, postsOf } from '../model/registry';
import { snap } from '../state/store';
import {
  distanceToBox,
  distanceToElement,
  distanceToSegment,
  invalidDropPoint,
  nearestPost,
  pointOnSegmentInterior,
  pointOnWireInterior,
  postAt,
  postPatch,
  splitWire,
  wirePoints,
} from './geometry';

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

/** Where a `dragpost` drag would land the pointer, per the canvas handler. */
const landOn = (x: number, y: number) => ({ x: snap(x), y: snap(y) });

describe('nearestPost', () => {
  it('picks the near end of a horizontal element', () => {
    const e = element(0, 0, 160, 0);
    expect(nearestPost({ x: 5, y: 3 }, e)).toBe(1);
    expect(nearestPost({ x: 155, y: 3 }, e)).toBe(2);
  });

  it('picks the near end of a vertical element', () => {
    const e = element(0, 0, 0, 160);
    expect(nearestPost({ x: 3, y: 5 }, e)).toBe(1);
    expect(nearestPost({ x: 3, y: 155 }, e)).toBe(2);
  });

  it('picks the near end of a diagonal element', () => {
    const e = element(0, 0, 160, 160);
    expect(nearestPost({ x: 5, y: 5 }, e)).toBe(1);
    expect(nearestPost({ x: 155, y: 155 }, e)).toBe(2);
  });

  it('sends an exact midpoint tie to post 1, deterministically', () => {
    const e = element(0, 0, 160, 0);
    expect(nearestPost({ x: 80, y: 0 }, e)).toBe(1);
    expect(nearestPost({ x: 80, y: 100 }, e)).toBe(1);
  });

  it('measures to the post, so a far off-axis point still picks the near end', () => {
    // 90 units off the axis; the along-axis position, not the perpendicular
    // distance, decides which post is nearer.
    const e = element(0, 0, 160, 0);
    expect(nearestPost({ x: 30, y: 90 }, e)).toBe(1);
    expect(nearestPost({ x: 130, y: 90 }, e)).toBe(2);
  });
});

describe('postAt', () => {
  it('reports whether the post already sits at the position', () => {
    const e = element(0, 0, 160, 0);
    expect(postAt(e, 1, 0, 0)).toBe(true);
    expect(postAt(e, 2, 160, 0)).toBe(true);
    expect(postAt(e, 1, 16, 0)).toBe(false);
    expect(postAt(e, 2, 0, 0)).toBe(false);
    expect(postAt(e, 2, 160, 16)).toBe(false);
  });

  it('reads a missing element as false so the caller skips the write', () => {
    expect(postAt(undefined, 1, 0, 0)).toBe(false);
    expect(postAt(undefined, 2, 160, 0)).toBe(false);
  });
});

describe('postPatch', () => {
  it('targets only x1/y1 for post 1', () => {
    const patch = postPatch(1, 32, 48);
    expect(patch).toEqual({ x1: 32, y1: 48 });
    expect('x2' in patch).toBe(false);
    expect('y2' in patch).toBe(false);
  });

  it('targets only x2/y2 for post 2', () => {
    const patch = postPatch(2, 32, 48);
    expect(patch).toEqual({ x2: 32, y2: 48 });
    expect('x1' in patch).toBe(false);
    expect('y1' in patch).toBe(false);
  });

  it('lands on a grid intersection', () => {
    const { x, y } = landOn(3.2, 17.7);
    expect(x % GRID_SIZE).toBe(0);
    expect(y % GRID_SIZE).toBe(0);
    expect(postPatch(1, x, y)).toEqual({ x1: x, y1: y });
  });

  it('leaves the other endpoint untouched across a drag sequence', () => {
    let current = element(0, 0, 160, 0);
    for (const [px, py] of [
      [16, 0],
      [32, 16],
      [48, 0],
      [64, 48],
      [80, 16],
    ]) {
      const { x, y } = landOn(px, py);
      current = { ...current, ...postPatch(2, x, y) };
    }
    // The fixed post is exact even after the length and angle moved.
    expect(current.x1).toBe(0);
    expect(current.y1).toBe(0);
    expect(current.x2).not.toBe(160);
    expect(current.y2).not.toBe(0);
  });
});

describe('distanceToSegment', () => {
  it('measures perpendicular distance away from the line', () => {
    expect(distanceToSegment({ x: 80, y: 7 }, { x: 0, y: 0 }, { x: 160, y: 0 })).toBe(7);
  });

  it('clamps to the endpoints beyond them', () => {
    expect(distanceToSegment({ x: -10, y: 4 }, { x: 0, y: 0 }, { x: 160, y: 0 })).toBeCloseTo(
      Math.hypot(10, 4),
      9,
    );
  });

  it('treats a zero-length segment as a point', () => {
    expect(distanceToSegment({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toBe(5);
  });
});

describe('distanceToElement', () => {
  it('uses the single post distance for single-terminal elements', () => {
    const e = element(32, 16, 32, 16);
    e.kind = 'ground';
    expect(distanceToElement({ x: 35, y: 19 }, e)).toBeCloseTo(Math.hypot(3, 3), 9);
  });

  it('measures a ground along its stem, so the free end is hittable', () => {
    const g = element(0, 0, 32, 0);
    g.kind = 'ground';
    // The symbol end is 32 from the post but only 5 from the stem: without
    // the span distance the far end could never be clicked to ctrl-drag it.
    expect(distanceToElement({ x: 32, y: 5 }, g)).toBe(5);
    expect(distanceToElement({ x: 16, y: 3 }, g)).toBe(3);
  });

  it('ignores the stray far endpoint of other single-post elements', () => {
    const t = element(100, 200, 0, 0);
    t.kind = 'decoration';
    // A text's (100,200)->(0,0) span is a legacy position, not a drawn stem,
    // so it must not make the text hittable far from its anchor.
    expect(distanceToElement({ x: 60, y: 100 }, t)).toBeCloseTo(Math.hypot(40, 100), 9);
  });

  it('measures against the body line for two-terminal elements', () => {
    expect(distanceToElement({ x: 80, y: 5 }, element(0, 0, 160, 0))).toBe(5);
  });
});

describe('distanceToBox', () => {
  const box = { x0: 16, y0: -16, x1: 80, y1: 80 };

  it('is 0 anywhere inside the box, edges and corners included', () => {
    expect(distanceToBox({ x: 48, y: 32 }, box)).toBe(0);
    expect(distanceToBox({ x: 16, y: 0 }, box)).toBe(0);
    expect(distanceToBox({ x: 80, y: 80 }, box)).toBe(0);
  });

  it('measures to the nearest edge beyond it, and does not care about corner order', () => {
    expect(distanceToBox({ x: 48, y: 88 }, box)).toBe(8);
    expect(distanceToBox({ x: 96, y: 32 }, box)).toBe(16);
    expect(distanceToBox({ x: 48, y: 88 }, { x0: 80, y0: 80, x1: 16, y1: -16 })).toBe(8);
  });

  it('measures to the nearest corner outside the box diagonal', () => {
    expect(distanceToBox({ x: 96, y: 96 }, box)).toBeCloseTo(Math.hypot(16, 16), 9);
  });
});

describe('chip body hit-testing', () => {
  // A default D flip-flop drawn left to right: the anchor sits at (0,0), the
  // housing spans (16,-16)..(80,80), and the axis runs along y = 0.
  const dff = (): CircuitElement => {
    const e = element(0, 0, 96, 0);
    e.kind = 'dFlipFlop';
    return e;
  };

  it('hits a point inside the body but off the axis and off every pin', () => {
    const e = dff();
    // Both probes sit inside the housing and beyond the 8-unit hit tolerance
    // from the axis and every post, so only the body rect can give a distance
    // of 0. (48,32) is mid-body; (24,24) hugs the west edge above the D-pin
    // row. Without the rect the axis alone reads 32 and 24 respectively, so
    // the click misses and falls through to a box-select.
    expect(distanceToElement({ x: 48, y: 32 }, e)).toBe(0);
    expect(distanceToElement({ x: 24, y: 24 }, e)).toBe(0);
  });

  it('still measures the axis and posts outside the body', () => {
    const e = dff();
    // The east post hangs at (96,0), beyond the body's east edge (80,..); the
    // anchor axis keeps it grabbable at distance 0 as before.
    expect(distanceToElement({ x: 90, y: 0 }, e)).toBe(0);
    // 8 units south of the body mid-span the axis is 88 away and the near
    // post over 50, so the box edge distance decides.
    expect(distanceToElement({ x: 48, y: 88 }, e)).toBe(8);
  });

  it('covers every drawChip kind', () => {
    // Every chip housing must be grabbable. The probe is the mid-span of the
    // top body edge: it sits a full cell (16) off the axis and clear of every
    // post, so for each kind a missing or shrunken bodyRect leaves a distance
    // well past the 8-unit hit tolerance instead of the 0 the box must yield.
    const kinds = [
      'adc',
      'cc2',
      'cccs',
      'ccvs',
      'counter',
      'customLogic',
      'dac',
      'decimalDisplay',
      'deMultiplexer',
      'dFlipFlop',
      'jkFlipFlop',
      'latch',
      'ledArray',
      'multiplexer',
      'phaseComp',
      'ringCounter',
      'sevenSeg',
      'tFlipFlop',
      'timer',
      'vccs',
      'vco',
      'vcvs',
    ];
    for (const kind of kinds) {
      const e = { ...element(0, 0, 160, 0), kind };
      const rect = defFor(kind)?.bodyRect?.(e);
      expect(rect, `${kind} declares a bodyRect`).toBeDefined();
      const probe = { x: (rect!.x0 + rect!.x1) / 2, y: rect!.y0 };
      // Guard that the probe is genuinely box-only: on the bare axis and posts
      // it must read over the 8-unit tolerance, or the 0-hit assertion below
      // would pass without the rect and the loop would go soft.
      const bare = Math.min(
        distanceToSegment(probe, { x: e.x1, y: e.y1 }, { x: e.x2, y: e.y2 }),
        ...postsOf(e).map((p) => Math.hypot(probe.x - p.x, probe.y - p.y)),
      );
      expect(bare, `${kind} probe is off-axis and clear of every post`).toBeGreaterThan(8);
      expect(distanceToElement(probe, e), `${kind} body edge midpoint hits`).toBe(0);
    }
  });
});

describe('ground free-end drag', () => {
  it('nearestPost targets the far endpoint of a ground', () => {
    const g = element(0, 0, 32, 0);
    g.kind = 'ground';
    // Clicking near the symbol picks post 2, whose dragpost patch moves x2,y2
    // and leaves the connection post in place.
    expect(nearestPost({ x: 30, y: 2 }, g)).toBe(2);
    expect(nearestPost({ x: 2, y: 2 }, g)).toBe(1);
  });
});

describe('stem-bearing one-post family', () => {
  // The ten kinds whose (x2,y2) is a drawn stem end, ground already covered
  // above. Each must hit-test along the whole stem so the far end can be
  // ctrl-dragged, and the free end must never read as a connection point.
  const STEM = [
    'rail',
    'varRail',
    'extVoltage',
    'noise',
    'logicInput',
    'logicOutput',
    'antenna',
    'am',
    'fm',
    'audioOutput',
    'audioInput',
    'dataInput',
    'delayBuffer',
    'sweep',
  ];

  it.each(STEM)(
    '%s hit-tests a point on a diagonal stem, so the free end is clickable',
    (kind) => {
      const e = element(0, 0, 32, 32);
      e.kind = kind;
      // The midpoint lies on the stem: distance 0, far under the 8-unit hit
      // tolerance. A point near the far end is on the segment too.
      expect(distanceToElement({ x: 16, y: 16 }, e)).toBe(0);
      expect(distanceToElement({ x: 30, y: 30 }, e)).toBeCloseTo(0, 9);
    },
  );

  it('keeps a labeled node unhittable at its stray far point', () => {
    const n = element(0, 0, 32, 32);
    n.kind = 'labeledNode';
    // The box is drawn at (0,0); the midpoint of the stray (32,32) span is
    // 22.6 units away, past the hit tolerance, so it never intercepts.
    expect(distanceToElement({ x: 16, y: 16 }, n)).toBeCloseTo(Math.hypot(16, 16), 9);
  });

  it('nearestPost targets the far endpoint of a rail, like a ground', () => {
    const r = element(0, 0, 32, 0);
    r.kind = 'rail';
    // The ctrl-drag gate counts draggable endpoints, so a click near the label
    // end enters dragpost with post 2, whose patch moves only x2,y2.
    expect(nearestPost({ x: 30, y: 2 }, r)).toBe(2);
    expect(nearestPost({ x: 2, y: 2 }, r)).toBe(1);
  });

  it('never treats a rail free end as a connection point', () => {
    const dragged = { ...element(0, 0, 160, 32), id: 2, kind: 'wire' as const };
    const vertical = { ...element(160, 0, 160, 160), id: 3, kind: 'wire' as const };
    const rail = { ...element(0, 0, 160, 32), id: 4, kind: 'rail' as const };
    // The rail's free end sits on the vertical wire's interior at (160,32).
    // It is not a post, so it does not occupy the junction: the dragged wire
    // end still flags as no-connect there instead of connecting.
    expect(invalidDropPoint(dragged, 160, 32, [dragged, vertical, rail])).toEqual({ x: 160, y: 32 });
  });
});

describe('pointOnSegmentInterior', () => {
  const a = { x: 0, y: 0 };
  const b = { x: 160, y: 0 };

  it('is true strictly between the endpoints, axis-aligned and diagonal', () => {
    expect(pointOnSegmentInterior({ x: 80, y: 0 }, a, b)).toBe(true);
    expect(pointOnSegmentInterior({ x: 80, y: 80 }, { x: 0, y: 0 }, { x: 160, y: 160 })).toBe(true);
  });

  it('is false at either endpoint, which is an ordinary connection', () => {
    expect(pointOnSegmentInterior(a, a, b)).toBe(false);
    expect(pointOnSegmentInterior(b, a, b)).toBe(false);
  });

  it('is false off the line and beyond the segment', () => {
    expect(pointOnSegmentInterior({ x: 80, y: 20 }, a, b)).toBe(false);
    expect(pointOnSegmentInterior({ x: 200, y: 0 }, a, b)).toBe(false);
  });
});

describe('splitWire', () => {
  const wire = (x1: number, y1: number, x2: number, y2: number): CircuitElement => ({
    id: 7,
    kind: 'wire',
    x1,
    y1,
    x2,
    y2,
    flags: 4,
    params: {},
  });
  let next = 100;
  const nextId = () => next++;

  it('splits a horizontal wire at its interior into two, keeping kind and flags', () => {
    const [a, b] = splitWire(wire(0, 0, 160, 0), { x: 80, y: 0 }, nextId)!;
    expect([a.x1, a.y1, a.x2, a.y2]).toEqual([0, 0, 80, 0]);
    expect([b.x1, b.y1, b.x2, b.y2]).toEqual([80, 0, 160, 0]);
    expect(a.kind).toBe('wire');
    expect(b.kind).toBe('wire');
    expect(a.flags).toBe(4);
    expect(b.flags).toBe(4);
    // Fresh ids: neither half keeps the original id, and they differ from each
    // other, so the crossed element can be replaced wholesale.
    expect(a.id).not.toBe(7);
    expect(b.id).not.toBe(7);
    expect(a.id).not.toBe(b.id);
  });

  it('keeps both halves of a diagonal wire on the original line', () => {
    const [a, b] = splitWire(wire(0, 0, 160, 160), { x: 80, y: 80 }, nextId)!;
    expect([a.x1, a.y1, a.x2, a.y2]).toEqual([0, 0, 80, 80]);
    expect([b.x1, b.y1, b.x2, b.y2]).toEqual([80, 80, 160, 160]);
    // The shared end is the same point in both halves.
    expect(a.x2).toBe(b.x1);
    expect(a.y2).toBe(b.y1);
  });

  it('refuses to split at an endpoint', () => {
    expect(splitWire(wire(0, 0, 160, 0), { x: 0, y: 0 }, nextId)).toBeNull();
    expect(splitWire(wire(0, 0, 160, 0), { x: 160, y: 0 }, nextId)).toBeNull();
  });

  it('refuses to split a point off the wire', () => {
    expect(splitWire(wire(0, 0, 160, 0), { x: 80, y: 20 }, nextId)).toBeNull();
  });

  it('splits off-centre into two halves at the snapped coordinates', () => {
    const [a, b] = splitWire(wire(0, 0, 32, 0), { x: 8, y: 0 }, nextId)!;
    expect([a.x1, a.y1, a.x2, a.y2]).toEqual([0, 0, 8, 0]);
    expect([b.x1, b.y1, b.x2, b.y2]).toEqual([8, 0, 32, 0]);
  });

  it('refuses non-wire elements: they connect at posts, not interiors', () => {
    const r = { ...wire(0, 0, 160, 0), kind: 'resistor' };
    expect(splitWire(r, { x: 80, y: 0 }, nextId)).toBeNull();
  });
});

describe('invalidDropPoint', () => {
  const wire = (id: number, x1: number, y1: number, x2: number, y2: number): CircuitElement => ({
    id,
    kind: 'wire',
    x1,
    y1,
    x2,
    y2,
    flags: 0,
    params: {},
  });
  const resistor = (id: number, x1: number, x2: number): CircuitElement => ({
    id,
    kind: 'resistor',
    x1,
    y1: 0,
    x2,
    y2: 0,
    flags: 0,
    params: { resistance: 1000 },
  });

  it('flags a dragged end sitting on another wire interior', () => {
    const dragged = wire(1, 0, 32, 80, 0);
    const other = wire(2, 0, 0, 160, 0);
    expect(invalidDropPoint(dragged, 80, 0, [dragged, other])).toEqual({ x: 80, y: 0 });
  });

  it('is null over empty canvas', () => {
    const dragged = wire(1, 0, 32, 80, 0);
    expect(invalidDropPoint(dragged, 80, 0, [dragged])).toBeNull();
  });

  it('is null on another wire endpoint, a real connection', () => {
    const dragged = wire(1, 0, 32, 0, 0);
    const other = wire(2, 0, 0, 160, 0);
    expect(invalidDropPoint(dragged, 0, 0, [dragged, other])).toBeNull();
  });

  it('is null where a third element post already occupies the junction', () => {
    const dragged = wire(1, 0, 32, 80, 0);
    const other = wire(2, 0, 0, 160, 0);
    expect(invalidDropPoint(dragged, 80, 0, [dragged, other, resistor(3, 80, 240)])).toBeNull();
  });

  it('ignores the dragged wire itself even when its own span crosses', () => {
    const dragged = wire(1, 0, 0, 160, 0);
    const other = wire(2, 48, 0, 48, 160);
    // Post 2 of the dragged wire is well clear of the other wire, so no dot.
    expect(invalidDropPoint(dragged, 160, 0, [dragged, other])).toBeNull();
  });
});

describe('routed wires', () => {
  const wire = (id: number, x1: number, y1: number, x2: number, y2: number): CircuitElement => ({
    id,
    kind: 'wire',
    x1,
    y1,
    x2,
    y2,
    flags: 0,
    params: {},
  });
  const routedWire = (x1: number, y1: number, x2: number, y2: number, route: [number, number][]) => ({
    id: 9,
    kind: 'wire' as const,
    x1,
    y1,
    x2,
    y2,
    flags: 0,
    params: {},
    route,
  });

  it('wirePoints returns the route for a routed wire and the span for a plain one', () => {
    const routed = routedWire(0, 0, 160, 0, [
      [0, 0],
      [80, 80],
      [160, 0],
    ]);
    expect(wirePoints(routed)).toEqual([
      { x: 0, y: 0 },
      { x: 80, y: 80 },
      { x: 160, y: 0 },
    ]);
    expect(wirePoints({ ...routed, route: undefined })).toEqual([
      { x: 0, y: 0 },
      { x: 160, y: 0 },
    ]);
  });

  it('pointOnWireInterior hits every segment and an interior bend vertex', () => {
    const routed = routedWire(0, 0, 160, 0, [
      [0, 0],
      [80, 80],
      [160, 0],
    ]);
    expect(pointOnWireInterior({ x: 40, y: 40 }, routed)).toBe(true);
    expect(pointOnWireInterior({ x: 120, y: 40 }, routed)).toBe(true);
    // A bend vertex is a valid connection point even though it is not interior
    // to either adjacent segment (WireElm.java:219-224).
    expect(pointOnWireInterior({ x: 80, y: 80 }, routed)).toBe(true);
    // The wire's overall endpoints are ordinary connections, not interiors.
    expect(pointOnWireInterior({ x: 0, y: 0 }, routed)).toBe(false);
    expect(pointOnWireInterior({ x: 160, y: 0 }, routed)).toBe(false);
    // Off the polyline is a miss.
    expect(pointOnWireInterior({ x: 80, y: 0 }, routed)).toBe(false);
  });

  it('distanceToElement measures the nearest routed segment, not the straight span', () => {
    const routed = routedWire(0, 0, 160, 0, [
      [0, 0],
      [80, 80],
      [160, 0],
    ]);
    // A point over the detour vertex is 0 from the polyline but 80 from the
    // straight stored span.
    expect(distanceToElement({ x: 80, y: 80 }, routed)).toBe(0);
    // (80,60) projects onto the diagonal at (70,70), 10 away in each axis,
    // whereas the straight span would put it 60 away.
    expect(distanceToElement({ x: 80, y: 60 }, routed)).toBeCloseTo(Math.hypot(10, 10), 9);
  });

  it('splitWire splits a routed wire at a grid point into two routed halves', () => {
    const routed = routedWire(0, 0, 160, 0, [
      [0, 0],
      [80, 80],
      [160, 0],
    ]);
    let next = 100;
    const nextId = () => next++;

    // (64,64) is a grid point on the first (diagonal) segment; its projection
    // snaps to itself, so the split lands exactly there.
    const [a, b] = splitWire(routed, { x: 64, y: 64 }, nextId)!;
    expect(a.route).toEqual([
      [0, 0],
      [64, 64],
    ]);
    expect(a.x2).toBe(64);
    expect(a.y2).toBe(64);
    expect(b.route).toEqual([
      [64, 64],
      [80, 80],
      [160, 0],
    ]);
    expect(b.x1).toBe(64);
    expect(b.y1).toBe(64);
    // Fresh ids on both halves.
    expect(a.id).not.toBe(9);
    expect(b.id).not.toBe(9);
    expect(a.id).not.toBe(b.id);
  });

  it('splitWire refuses to split a routed wire at one of its own endpoints', () => {
    const routed = routedWire(0, 0, 160, 0, [
      [0, 0],
      [80, 80],
      [160, 0],
    ]);
    let next = 100;
    const nextId = () => next++;
    expect(splitWire(routed, { x: 0, y: 0 }, nextId)).toBeNull();
    expect(splitWire(routed, { x: 160, y: 0 }, nextId)).toBeNull();
  });

  it('invalidDropPoint flags a drag landing on a routed wire segment', () => {
    const dragged = wire(1, 0, 32, 80, 0);
    const other = routedWire(0, 0, 160, 0, [
      [0, 0],
      [80, 80],
      [160, 0],
    ]);
    expect(invalidDropPoint(dragged, 40, 40, [dragged, other])).toEqual({ x: 40, y: 40 });
  });

  it('invalidDropPoint flags a drop on a routed bend vertex like any interior point', () => {
    // A bend vertex is not a post of the wire, so a wire end dropped there
    // shows the red no-connect marker exactly like a drop on a segment
    // interior; placeWireEnd still splits there on release.
    const dragged = wire(1, 0, 32, 80, 0);
    const other = routedWire(0, 0, 160, 0, [
      [0, 0],
      [80, 80],
      [160, 0],
    ]);
    expect(invalidDropPoint(dragged, 80, 80, [dragged, other])).toEqual({ x: 80, y: 80 });
  });
});
