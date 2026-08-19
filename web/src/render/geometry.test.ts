import { describe, expect, it } from 'vitest';
import { GRID_SIZE, type CircuitElement } from '../model/types';
import { defFor, postsOf, switchLeverTip } from '../model/registry';
import { OPAMP_SMALL } from '../model/registry/flags';
import { snap } from '../state/store';
import {
  HIT_TOLERANCE_PX,
  distanceToBox,
  distanceToElement,
  distanceToHitRegion,
  distanceToSegment,
  grabbedHandle,
  handlePoints,
  hitRegions,
  hitTestElement,
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

  it('grabs the ground symbol as a solid body, keeping the free end hittable', () => {
    const g = element(0, 0, 32, 0);
    g.kind = 'ground';
    // The bars box is a solid pick zone: a click on the drawn symbol, which
    // includes the free-end control point, reads 0 where the bare stem alone
    // used to read 5 and 3.
    expect(distanceToElement({ x: 32, y: 5 }, g)).toBe(0);
    expect(distanceToElement({ x: 16, y: 3 }, g)).toBe(0);
  });

  it('ignores the stray far endpoint of other single-post elements', () => {
    const t = element(100, 200, 0, 0);
    t.kind = 'decoration';
    // A text's (100,200)->(0,0) span is a legacy position, not a drawn stem,
    // so it must not make the text hittable far from its anchor.
    expect(distanceToElement({ x: 60, y: 100 }, t)).toBeCloseTo(Math.hypot(40, 100), 9);
  });

  it('measures against the body line for two-terminal elements', () => {
    // A point on the lead, outside the resistor's solid body box (64..96
    // across, -8..8 off the axis), is still grabbed by the axis band.
    expect(distanceToElement({ x: 32, y: 5 }, element(0, 0, 160, 0))).toBe(5);
  });
});

describe('hitTestElement', () => {
  it('hits an element at a fixed screen-pixel distance at any zoom', () => {
    const e = element(0, 0, 160, 0);
    // 8 screen px at zoom 0.15 is 8/0.15 ~= 53 circuit units from the body,
    // and at zoom 6 the same 8 screen px is only 8/6 ~= 1.3 units away.
    for (const scale of [0.15, 6]) {
      const d = HIT_TOLERANCE_PX / scale;
      expect(hitTestElement({ x: 0, y: d }, [e], scale)).toBe(e);
      expect(hitTestElement({ x: 0, y: d + 1e-9 }, [e], scale)).toBeNull();
    }
  });

  it('scales the circuit-space reach with 1/scale', () => {
    // The reach in circuit units at zoom 6 is 6/0.15 = 40x the reach at zoom
    // 0.15, mirroring the scale ratio: same on-screen slop, different reach.
    const reach = (scale: number) => HIT_TOLERANCE_PX / scale;
    expect(reach(6)).toBeCloseTo(reach(0.15) * (0.15 / 6), 12);
  });

  it('prefers the topmost element, drawn last', () => {
    const behind = element(0, 0, 160, 0);
    const top = element(0, 0, 160, 0);
    top.id = 2;
    // Both are within reach, so the later one wins.
    expect(hitTestElement({ x: 80, y: 1 }, [behind, top], 1)).toBe(top);
  });

  it('prefers the hovered element over the topmost at a shared junction', () => {
    const resistor = element(0, 0, 160, 0);
    const wire = element(0, 0, 160, 0);
    wire.id = 2;
    // Both share the (0,0) node; the wire is drawn last and is the strict
    // topmost, so without a preference it would win. A press one pixel off the
    // node still reaches both, so the hovered resistor must win when it is
    // passed as the preference.
    expect(hitTestElement({ x: 1, y: 1 }, [resistor, wire], 1, HIT_TOLERANCE_PX, resistor.id)).toBe(
      resistor,
    );
  });

  it('a sticky hover keeps the previously highlighted element at a junction', () => {
    const wire = element(0, 0, 160, 0);
    const resistor = element(0, 0, 160, 0);
    resistor.id = 2;
    // First hover (no preference) lands on the resistor as topmost...
    const first = hitTestElement({ x: 1, y: 1 }, [wire, resistor], 1, HIT_TOLERANCE_PX, null);
    expect(first).toBe(resistor);
    // ...then the cursor settles a hair toward the wire but both stay in reach;
    // the hook re-passes the previously highlighted resistor as the preference,
    // so the highlight (and the grab) stays on the resistor instead of flipping
    // to the topmost wire.
    const second = hitTestElement(
      { x: 2, y: 2 },
      [wire, resistor],
      1,
      HIT_TOLERANCE_PX,
      first?.id ?? null,
    );
    expect(second).toBe(resistor);
  });

  it('ignores the hovered preference when it is out of reach', () => {
    const wire = element(0, 0, 160, 0);
    const resistor = element(1000, 1000, 1160, 1000);
    resistor.id = 2;
    // The hovered resistor sits far from the pointer, so it is out of reach and
    // the strict topmost within reach (the wire) wins.
    expect(
      hitTestElement({ x: 0, y: 0 }, [wire, resistor], 1, HIT_TOLERANCE_PX, resistor.id),
    ).toBe(wire);
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

  it('gives a solid pick body to the capacitor, voltage source, lamp, op-amp and tall 2-pole bodies', () => {
    // These draw a disc, plates, a triangle or a tall symbol far off the axis,
    // so a click on the drawn body must grab the element even where the axis
    // band cannot reach. The probe is the mid-span of the top body edge, a full
    // reach past the axis and clear of every post.
    for (const kind of [
      'capacitor',
      'voltage',
      'lamp',
      'opamp',
      'diac',
      'led',
      'thermistor',
      'ldr',
      'memristor',
    ]) {
      const e = { ...element(0, 0, 64, 0), kind };
      const rect = defFor(kind)!.bodyRect!(e);
      expect(rect, `${kind} declares a bodyRect`).toBeDefined();
      const probe = { x: (rect!.x0 + rect!.x1) / 2, y: rect!.y0 };
      const bare = Math.min(
        distanceToSegment(probe, { x: e.x1, y: e.y1 }, { x: e.x2, y: e.y2 }),
        ...postsOf(e).map((p) => Math.hypot(probe.x - p.x, probe.y - p.y)),
      );
      expect(bare, `${kind} probe is off-axis and clear of every post`).toBeGreaterThan(8);
      expect(distanceToElement(probe, e), `${kind} body edge midpoint hits`).toBe(0);
    }
  });

  it('gives the diode-family and shallow 2-pole bodies a solid pick zone', () => {
    // The diode, resistor, fuse and their kin draw a body only 6-8 units off
    // the axis, so their top edge is still within the axis band's reach and
    // the bare-guard above would be soft; here the assertion is that the
    // bodyRect exists and the body edge really is a 0-distance pick.
    for (const kind of [
      'resistor',
      'diode',
      'zener',
      'varactor',
      'tunnelDiode',
      'fuse',
      'scr',
      'triac',
      'polarizedCapacitor',
      'unijunction',
      'triode',
    ]) {
      const e = { ...element(0, 0, 64, 0), kind };
      const rect = defFor(kind)!.bodyRect!(e);
      expect(rect, `${kind} declares a bodyRect`).toBeDefined();
      const probe = { x: (rect!.x0 + rect!.x1) / 2, y: rect!.y0 };
      expect(distanceToElement(probe, e), `${kind} body edge midpoint hits`).toBe(0);
    }
  });

  it('covers every other drawn body with a solid pick zone', () => {
    // The remaining pass over the element set: every body the port draws that
    // was not already grabbable via the axis, a post or a lever gets a
    // bodyRect. The probe is the mid-span of the top body edge; a missing or
    // shrunken rect leaves a distance well past the hit tolerance, so the
    // 0-hit assertion is the whole check.
    const kinds = [
      // two-pole passives and motors
      'inductor',
      'crystal',
      'sparkGap',
      'transmissionLine',
      'potentiometer',
      'dcMotor',
      'threePhaseMotor',
      'motorProtectionSwitch',
      // sources and stems
      'current',
      'rail',
      'varRail',
      'extVoltage',
      'noise',
      'antenna',
      'am',
      'fm',
      'sweep',
      'audioInput',
      'audioOutput',
      'dataInput',
      'output',
      'testPoint',
      'dataRecorder',
      'stopTrigger',
      'logicOutput',
      // displays
      'ammeter',
      'ohmmeter',
      'probe',
      'wattmeter',
      'scope',
      // semiconductors and logic
      'transistor',
      'mosfet',
      'jfet',
      'darlington',
      'comparator',
      'ota',
      'opampReal',
      'triState',
      'optocoupler',
      'inverter',
      'schmitt',
      'invertingSchmitt',
      'delayBuffer',
      'andGate',
      'nandGate',
      'orGate',
      'norGate',
      'xorGate',
      'xnorGate',
      // transformers and relays
      'transformer',
      'tappedTransformer',
      'customTransformer',
      'relay',
      'relayCoil',
      // switches and annotations
      'analogSwitch',
      'analogSwitch2',
      'ground',
      'labeledNode',
      'box',
    ];
    for (const kind of kinds) {
      const e = { ...element(0, 0, 64, 0), kind };
      const rect = defFor(kind)?.bodyRect?.(e);
      expect(rect, `${kind} declares a bodyRect`).toBeDefined();
      const probe = { x: (rect!.x0 + rect!.x1) / 2, y: rect!.y0 };
      expect(distanceToElement(probe, e), `${kind} body edge midpoint hits`).toBe(0);
    }
  });

  it('the op-amp hit box covers only the triangle body', () => {
    // The box wraps the drawn triangle alone: the base at lead1 grown
    // perpendicular by the base width (opheight*2, 32 for size 2) and the apex
    // at lead2. It must not span the bare input leads to the posts, so a click
    // out on a lead falls through to the axis/post instead of grabbing the
    // whole span.
    const e = { ...element(0, 0, 64, 0), kind: 'opamp' };
    const rect = defFor('opamp')!.bodyRect!(e);
    expect(rect.x0).toBe(6);   // lead1, the triangle base
    expect(rect.x1).toBe(58);  // lead2, the apex
    expect(rect.y0).toBe(-32);
    expect(rect.y1).toBe(32);
    // A point in the middle of the body, opheight off the axis and clear of
    // every post and the axis band, is a solid pick.
    expect(distanceToElement({ x: 32, y: -16 }, e)).toBe(0);
    // The small variant halves the perpendicular extent (opheight 8 -> *2 = 16).
    const small = { ...e, flags: OPAMP_SMALL };
    const smallRect = defFor('opamp')!.bodyRect!(small);
    expect(smallRect.y0).toBe(-16);
    expect(smallRect.y1).toBe(16);
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
    'testPoint',
    'dataRecorder',
    'stopTrigger',
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
    // The label box is drawn at (0,0) and is only 20 wide, so the stray
    // (32,32) midpoint is far past it and never a 0-distance pick.
    expect(distanceToElement({ x: 32, y: 32 }, n)).toBeCloseTo(Math.hypot(12, 24), 9);
  });

  it('nearestPost targets the far endpoint of a rail, like a ground', () => {
    const r = element(0, 0, 32, 0);
    r.kind = 'rail';
    // The ctrl-drag gate counts draggable endpoints, so a click near the label
    // end enters dragpost with post 2, whose patch moves only x2,y2.
    expect(nearestPost({ x: 30, y: 2 }, r)).toBe(2);
    expect(nearestPost({ x: 2, y: 2 }, r)).toBe(1);
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

describe('routed wires', () => {
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
});

describe('handlePoints and grabbedHandle', () => {
  const e = element(0, 0, 160, 0);

  it('a two-ended part offers both stored endpoints as handles', () => {
    expect(handlePoints(e)).toEqual([
      { x: 0, y: 0 },
      { x: 160, y: 0 },
    ]);
    // A ground's free end carries no terminal and is still a handle, which is
    // why the handle set is the stored endpoints and not `postsOf`.
    expect(handlePoints({ ...element(0, 0, 32, 0), kind: 'ground' })).toHaveLength(2);
    expect(handlePoints({ ...element(0, 0, 32, 32), kind: 'labeledNode' })).toEqual([]);
  });

  it('grabs the endpoint the pointer is within the pixel reach of', () => {
    expect(grabbedHandle({ x: 3, y: 3 }, e, 1)).toBe(1);
    expect(grabbedHandle({ x: 158, y: 2 }, e, 1)).toBe(2);
    expect(grabbedHandle({ x: 80, y: 0 }, e, 1)).toBeNull();
  });

  it('is inclusive exactly at the radius', () => {
    expect(grabbedHandle({ x: HIT_TOLERANCE_PX, y: 0 }, e, 1)).toBe(1);
    expect(grabbedHandle({ x: HIT_TOLERANCE_PX + 0.001, y: 0 }, e, 1)).toBeNull();
  });

  it('keeps the reach a screen distance across the zoom range', () => {
    // Zoomed in to 2 the same on-screen radius covers half the circuit units,
    // zoomed out to 0.5 it covers twice as many.
    expect(grabbedHandle({ x: HIT_TOLERANCE_PX / 2, y: 0 }, e, 2)).toBe(1);
    expect(grabbedHandle({ x: HIT_TOLERANCE_PX / 2 + 0.001, y: 0 }, e, 2)).toBeNull();
    expect(grabbedHandle({ x: HIT_TOLERANCE_PX * 2, y: 0 }, e, 0.5)).toBe(1);
    expect(grabbedHandle({ x: 0, y: 0 }, e, 0)).toBeNull();
  });

  it('arms nothing on a symbol with no body left between the two grab zones', () => {
    // Shorter than one grid, upstream's MINPOSTGRABSIZE floor.
    expect(grabbedHandle({ x: 0, y: 0 }, element(0, 0, 12, 0), 1)).toBeNull();
    // One grid long clears that floor, but at zoom 1 the two 8-unit zones
    // still meet, so the whole symbol must stay movable.
    expect(grabbedHandle({ x: 0, y: 0 }, element(0, 0, GRID_SIZE, 0), 1)).toBeNull();
    // Zoomed in, the zones separate and the handles arm.
    expect(grabbedHandle({ x: 0, y: 0 }, element(0, 0, GRID_SIZE, 0), 2)).toBe(1);
  });
});

describe('hitRegions', () => {
  const routed = (): CircuitElement => ({
    id: 9,
    kind: 'wire',
    x1: 0,
    y1: 0,
    x2: 160,
    y2: 0,
    flags: 0,
    params: {},
    route: [
      [0, 0],
      [80, 80],
      [160, 0],
    ],
  });

  it('gives a two-terminal part its axis band, a circle per terminal and its body', () => {
    expect(hitRegions(element(0, 0, 160, 0))).toEqual([
      { type: 'axis', a: { x: 0, y: 0 }, b: { x: 160, y: 0 } },
      { type: 'post', x: 0, y: 0 },
      { type: 'post', x: 160, y: 0 },
      { type: 'body', box: defFor('resistor')!.bodyRect!(element(0, 0, 160, 0)) },
    ]);
  });

  it('gives a chip its axis, one circle per pin and its housing rect', () => {
    const e = { ...element(0, 0, 96, 0), kind: 'dFlipFlop' };
    const regions = hitRegions(e);
    expect(regions.filter((r) => r.type === 'axis')).toHaveLength(1);
    expect(regions.filter((r) => r.type === 'post')).toHaveLength(postsOf(e).length);
    // The overlay must draw the def's own rect, not a redrawn guess at it.
    expect(regions.filter((r) => r.type === 'body')).toEqual([
      { type: 'body', box: defFor('dFlipFlop')!.bodyRect!(e) },
    ]);
  });

  it('gives a stem-bearing one-post part its terminal and its stem, and no free-end post', () => {
    // A ground connects only at (x1,y1); (x2,y2) is a drag handle, grabbable
    // along the stem but never a terminal circle of its own. Its bars off the
    // stem are a body pick zone too, so the click can grab the symbol.
    const e = { ...element(0, 0, 32, 0), kind: 'ground' };
    expect(hitRegions(e)).toEqual([
      { type: 'post', x: 0, y: 0 },
      { type: 'axis', a: { x: 0, y: 0 }, b: { x: 32, y: 0 } },
      { type: 'body', box: defFor('ground')!.bodyRect!(e) },
    ]);
  });

  it('gives a post-only one-post part just its terminal circle and its label box', () => {
    // A labeled node's stray (x2,y2) is not drawn and not grabbable, so no
    // axis band may appear for it; the label box it draws is a body pick zone.
    const e = { ...element(0, 0, 32, 32), kind: 'labeledNode' };
    expect(hitRegions(e)).toEqual([
      { type: 'post', x: 0, y: 0 },
      { type: 'body', box: defFor('labeledNode')!.bodyRect!(e) },
    ]);
  });

  it('gives a routed wire one band per polyline segment and nothing else', () => {
    expect(hitRegions(routed())).toEqual([
      { type: 'wire', a: { x: 0, y: 0 }, b: { x: 80, y: 80 } },
      { type: 'wire', a: { x: 80, y: 80 }, b: { x: 160, y: 0 } },
    ]);
  });

  it('gives a plain wire the same axis-and-posts treatment as any two-post part', () => {
    expect(hitRegions({ ...element(0, 0, 160, 0), kind: 'wire' })).toEqual([
      { type: 'axis', a: { x: 0, y: 0 }, b: { x: 160, y: 0 } },
      { type: 'post', x: 0, y: 0 },
      { type: 'post', x: 160, y: 0 },
    ]);
  });

  it('reaches the lifted lever of an interactive switch, so its handle is pickable', () => {
    // The open lever tip rides 16 units off the axis, far beyond the 8 px
    // reach of the axis band. The switchRect must be a pick zone or a click on
    // the handle hits nothing and the switch can never be thrown there.
    const e = { ...element(0, 0, 64, 0), kind: 'switch' };
    const lever = defFor('switch')!.switchRect!(e);
    const regions = hitRegions(e);
    const sw = regions.find((r) => r.type === 'switch');
    expect(sw).toEqual({
      type: 'switch',
      box: { x0: lever.x, y0: lever.y, x1: lever.x + lever.w, y1: lever.y + lever.h },
    });
    // The open lever tip (48,-16), 16 units above the lead, is inside the rect,
    // so the pick reaches it where the axis band (8 px reach) could not.
    expect(distanceToElement(switchLeverTip({ x: 16, y: 0 }, { x: 48, y: 0 }, false), e)).toBe(0);
  });

  it('is the whole of what distanceToElement measures', () => {
    // The debug overlay draws these regions and nothing else, so a pick the
    // overlay cannot explain would be a lie. Sweep a grid of probes across a
    // sample of shapes and pin the two to the same number.
    const samples: CircuitElement[] = [
      element(0, 0, 160, 0),
      element(0, 0, 96, 96),
      { ...element(0, 0, 96, 0), kind: 'dFlipFlop' },
      { ...element(0, 0, 64, 0), kind: 'transistor' },
      { ...element(0, 0, 64, 0), kind: 'switch' },
      { ...element(0, 0, 32, 0), kind: 'ground' },
      { ...element(0, 0, 32, 32), kind: 'labeledNode' },
      routed(),
    ];
    for (const e of samples) {
      for (let x = -48; x <= 208; x += 16) {
        for (let y = -48; y <= 128; y += 16) {
          const p = { x, y };
          const viaRegions = Math.min(
            ...hitRegions(e).map((r) => distanceToHitRegion(p, r)),
          );
          expect(distanceToElement(p, e), `${e.kind} at ${x},${y}`).toBeCloseTo(viaRegions, 12);
        }
      }
    }
  });
});
