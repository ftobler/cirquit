import { describe, expect, it, beforeEach } from 'vitest';
import { postsOf } from './registry';
import {
  canMirror,
  canRotate,
  canSwap,
  mirrorElement,
  rotateElement,
  swapTerminalOrder,
  turnPointAbout,
} from './transform';
import {
  clearSessionModels,
  modelToEngineSpec,
  parseCompositeModelLine,
  registerSessionModel,
} from '../io/subcircuits';
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
  it('rotates any part with an axis, but not post-only annotations', () => {
    expect(canRotate(element('resistor', 0, 0, 160, 0))).toBe(true);
    expect(canRotate(element('opamp', 0, 0, 160, 0))).toBe(true);
    expect(canRotate(element('decoration', 0, 0, 0, 0))).toBe(false);
  });

  it('rotates the stem-bearing one-post family, but not the post-only one', () => {
    // A stem-bearing part's free end is a draggable control point, so it has a
    // real second endpoint to turn about its midpoint like any two-point part.
    for (const kind of [
      'ground',
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
      'output',
      'testPoint',
      'dataRecorder',
      'stopTrigger',
    ]) {
      expect(canRotate(element(kind, 0, 0, 32, 0))).toBe(true);
    }
    // The post-only annotations keep their stray x2,y2 out of the turn.
    for (const kind of ['labeledNode', 'decoration']) {
      expect(canRotate(element(kind, 0, 0, 32, 0))).toBe(false);
    }
  });

  it('mirrors only the asymmetric three-post bodies', () => {
    for (const kind of ['transistor', 'opamp', 'mosfet', 'potentiometer', 'dpdtSwitch']) {
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

describe('custom composite capability gates follow the resolved model', () => {
  beforeEach(() => clearSessionModels());

  /** A two-pin model: `in` on node 1 (west), `out` on node 3 (east). */
  const MODEL_LINE =
    '. myCirc 0 1 2 2 in 1 0 2 out 3 0 3 ' +
    'ResistorElm\\s1\\s2\\rResistorElm\\s2\\s3 ' +
    '0\\\\s1000\\s0\\\\s1000';

  const resolved = () => {
    const model = parseCompositeModelLine(MODEL_LINE)!;
    registerSessionModel(model);
    return {
      ...element('customComposite', 0, 0, 64, 0),
      text: 'myCirc',
      model: modelToEngineSpec(model),
    };
  };

  it('a resolved multi-pin composite rotates; the fallback stub stays put', () => {
    const r = resolved();
    expect(postsOf(r)).toHaveLength(2);
    expect(canRotate(r)).toBe(true);
    // The chip is a rigid body: a quarter turn about the midpoint stays a
    // quarter turn, and the two posts ride it.
    const turned = rotateElement(r);
    expect(Math.abs(turned.y2 - turned.y1)).toBe(64);
    expect(postsOf(turned)).toHaveLength(2);

    const stub = element('customComposite', 0, 0, 64, 0);
    expect(postsOf(stub)).toHaveLength(1);
    expect(canRotate(stub)).toBe(false);
    expect(rotateElement(stub)).toEqual(stub);
  });

  it('a resolved two-pin composite swaps terminals; a stub cannot', () => {
    const r = resolved();
    expect(canSwap(r)).toBe(true);
    expect(canSwap(element('customComposite', 0, 0, 64, 0))).toBe(false);
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

  it('snaps an odd-span element to integers instead of emitting half coordinates', () => {
    // x1: 10 and x2: 171 share no parity, so the quarter turn about the
    // midpoint lands on .5 values; the store invariant demands integers.
    const r = rotateElement(element('resistor', 10, 20, 171, 20));
    for (const v of [r.x1, r.y1, r.x2, r.y2]) expect(Number.isInteger(v)).toBe(true);
    // Still a clean quarter turn: vertical, midpoint 0.5 off the integer grid.
    expect(r.x1).toBe(r.x2);
    expect(Math.abs(r.y2 - r.y1)).toBe(161);
  });

  it('keeps the midpoint fixed and the result on the grid', () => {
    const e = element('resistor', 0, 0, 160, 0);
    const r = rotateElement(e);
    expect((r.x1 + r.x2) / 2).toBe(80);
    expect((r.y1 + r.y2) / 2).toBe(0);
    for (const v of [r.x1, r.y1, r.x2, r.y2]) expect(Math.abs(v % 16)).toBe(0);
  });

  it('keeps an odd-length part on the grid by snapping the turn axis', () => {
    // A 3-grid chip (bus splitter, half adder, ROM and the rest of the
    // odd-`defaultLength` kinds) has its midpoint half a square off the grid.
    // Turning about that exact point put both endpoints between grid lines,
    // where no wire can reach them; upstream snaps the flip axis first, which
    // shifts the turned part by up to one square and keeps it on the grid.
    const chip = element('busSplitter', 80, 112, 128, 112);
    // The explicit first turn is upstream's own arithmetic: cx 104, cy 112,
    // xmy = snapGrid(-8) = -16, then flipXY followed by flipY about 2*cy.
    expect(rotateElement(chip)).toMatchObject({ x1: 96, y1: 128, x2: 96, y2: 80 });

    let e: CircuitElement = chip;
    for (let turn = 1; turn <= 4; turn++) {
      e = rotateElement(e);
      for (const v of [e.x1, e.y1, e.x2, e.y2]) {
        expect(Math.abs(v % 16), `turn ${turn}: ${e.x1},${e.y1} ${e.x2},${e.y2}`).toBe(0);
      }
      // A rigid turn: the span keeps its length, whatever the axis snap did to
      // the part's position.
      expect(Math.hypot(e.x2 - e.x1, e.y2 - e.y1)).toBe(48);
    }
  });

  it('leaves an even-length part exactly where the midpoint turn put it', () => {
    // The axis snap is identity when the midpoint is already on the grid, so
    // every even-length kind (which is every other kind) turns bit-for-bit as
    // it did before the odd-length fix.
    expect(rotateElement(element('resistor', 80, 112, 240, 112))).toMatchObject({
      x1: 160,
      y1: 192,
      x2: 160,
      y2: 32,
    });
  });

  it('rotates an op-amp as a rigid body, matching upstream orientation', () => {
    const a = element('opamp', 0, 0, 160, 0);
    const r = rotateElement(a);
    expect(r).toMatchObject({ x1: 80, y1: 80, x2: 80, y2: -80, flags: 1 });
    // Inverting input lead rides the rigid quarter turn to the left flank, 16
    // off the axis at the default size 2.
    expect(postsOf(r)[0]).toEqual({ x: 64, y: 80 });
  });

  it('keeps the collector and emitter on the same side of a rotated transistor', () => {
    const t = element('transistor', 0, 0, 160, 0, 0, { pnp: 1 });
    const r = rotateElement(t);
    expect(postsOf(r)[0]).toEqual({ x: 80, y: 80 });  // base end
    expect(postsOf(r)[1]).toEqual({ x: 64, y: -80 });  // collector, rigid turn
    expect(postsOf(r)[2]).toEqual({ x: 96, y: -80 });  // emitter
  });

  it('is a no-op on a post-only one-post element', () => {
    const d = element('decoration', 0, 0, 16, 0);
    expect(rotateElement(d)).toEqual(d);
  });

  it('rotates a diagonal rail about its midpoint, keeping the stem length', () => {
    const r = element('rail', 0, 0, 32, 32);
    const turned = rotateElement(r);
    expect([turned.x1, turned.y1, turned.x2, turned.y2]).toEqual([0, 32, 32, 0]);
    // The store invariant "stored endpoints are integers" survives the turn.
    for (const v of [turned.x1, turned.y1, turned.x2, turned.y2]) expect(Number.isInteger(v)).toBe(true);
    // The post-to-free-end distance is unchanged, so the symbol still hangs
    // the same distance off the connection post.
    const stem = Math.hypot(r.x2 - r.x1, r.y2 - r.y1);
    expect(Math.hypot(turned.x2 - turned.x1, turned.y2 - turned.y1)).toBe(stem);
  });

  it('rotates an output about its midpoint, keeping the stem length', () => {
    const o = element('output', 0, 0, 64, 0);
    expect(canRotate(o)).toBe(true);
    const turned = rotateElement(o);
    // The post rides the rigid quarter turn to (32,32) and the free end to
    // (32,-32), so the stored span turns about (32,0) unchanged in length.
    expect([turned.x1, turned.y1, turned.x2, turned.y2]).toEqual([32, 32, 32, -32]);
    expect(Math.hypot(turned.x2 - turned.x1, turned.y2 - turned.y1)).toBe(64);
  });
});

describe('dpdt switch transforms', () => {
  const dpdt = (position: number, x1 = 0, y1 = 0, x2 = 96, y2 = 0): CircuitElement => ({
    ...element('dpdtSwitch', x1, y1, x2, y2, 0, { position, poleCount: 2 }),
    state: position,
  });

  it('rotate flips the throw position, keeping both params in step', () => {
    const r = rotateElement(dpdt(0));
    expect(r.state).toBe(1);
    expect(r.params.position).toBe(1);
    // The throw pairing inverts with the position, so a position-1 turn throws
    // to the other throw of every pole.
    expect(postsOf(r).length).toBe(6);
    const m = rotateElement(dpdt(1));
    expect(m.state).toBe(0);
    expect(m.params.position).toBe(0);
  });

  it('mirror flips the throw position', () => {
    const m = mirrorElement(dpdt(0));
    expect(m.state).toBe(1);
    expect(m.params.position).toBe(1);
  });

  it('mirror shifts the pole fan so it stays on the same physical side', () => {
    // A horizontal left-to-right DPDT hangs its fan below the axis (pole 1 at
    // (0, 48)). Upstream flipX shifts the body one pole gap along the
    // perpendicular before the reflection (DPDTSwitchElm.java:256-267), so
    // the fan still hangs below the mirrored body instead of crossing over.
    const m = mirrorElement(dpdt(0));
    expect([m.x1, m.y1, m.x2, m.y2]).toEqual([96, 48, 0, 48]);
    expect(postsOf(m)).toEqual([
      { x: 96, y: 48 },
      { x: 0, y: 32 },
      { x: 0, y: 64 },
      { x: 96, y: 0 },
      { x: 0, y: -16 },
      { x: 0, y: 16 },
    ]);
  });

  it('mirror of a vertical DPDT shifts along the perpendicular too', () => {
    const m = mirrorElement(dpdt(0, 48, -48, 48, 48));
    expect([m.x1, m.y1, m.x2, m.y2]).toEqual([96, -48, 96, 48]);
    expect(m.state).toBe(1);
  });

  it('four turns return the original element', () => {
    const original = dpdt(0);
    let e: CircuitElement = original;
    for (let i = 0; i < 4; i++) e = rotateElement(e);
    expect(e).toEqual(original);
  });
});

describe('mosfet transforms', () => {
  it('rotates the source and drain through a rigid quarter turn', () => {
    const m = element('mosfet', 0, 0, 160, 0);
    const r = rotateElement(m);
    // FLAG_FLIP (bit 8) toggles once on a horizontal part, keeping the source
    // post on the rigid-turn side.
    expect(r.flags & 8).toBe(8);
    expect(postsOf(r)).toEqual([
      { x: 80, y: 80 },
      { x: 96, y: -80 },
      { x: 64, y: -80 },
    ]);
  });

  it('never touches the pnp bit on rotate', () => {
    // Bit 1 is the P-channel flag for a mosfet, not an orientation flag, so a
    // turn must leave it alone.
    const m = element('mosfet', 0, 0, 160, 0, 1, { pnp: -1 });
    const r = rotateElement(m);
    expect(r.flags & 1).toBe(1);
    expect(r.flags & 8).toBe(8);
  });

  it('flips the flag on a vertical mirror only', () => {
    const vertical = element('mosfet', 80, -80, 80, 80);
    expect(mirrorElement(vertical).flags & 8).toBe(8);
    const horizontal = element('mosfet', 0, 0, 160, 0);
    expect(mirrorElement(horizontal).flags & 8).toBe(0);
  });
});

describe('triode transforms', () => {
  // The triode's FLAG_FLIP is bit 1 and its FLAG_DSIGN_FIX bit 2
  // (TriodeElm.java:26-27). Upstream's rotate (flipXY then flipY) toggles
  // FLAG_FLIP unconditionally, and the trailing flipY toggles it again for a
  // part that is horizontal after the turn and for a legacy (no DSIGN_FIX)
  // part that was horizontal before it (TriodeElm.java:251-268). A fresh part
  // is flags 2 (DSIGN_FIX), the load form for the corpus's flagless lines is 0.

  it('rotates a fresh horizontal part, toggling the flip bit once', () => {
    const t = element('triode', 0, 0, 160, 0, 2);
    const r = rotateElement(t);
    expect(r.flags).toBe(3);
    // The plate and cathode ride the rigid quarter turn to the far flank,
    // exactly like the transistor's collector and emitter.
    expect(postsOf(r)).toEqual([
      { x: 48, y: -80 },
      { x: 80, y: 80 },
      { x: 112, y: -64 },
    ]);
  });

  it('rotates a vertical part twice, so the flip bit cancels', () => {
    const t = element('triode', 80, 80, 80, -80, 2);
    expect(rotateElement(t).flags).toBe(2);
  });

  it('rotates a legacy flagless horizontal part twice, so the flip bit cancels', () => {
    const t = element('triode', 0, 0, 160, 0, 0);
    expect(rotateElement(t).flags).toBe(0);
  });

  it('mirrors a fresh horizontal part through dsign alone, keeping the bit', () => {
    const t = element('triode', 0, 0, 160, 0, 2);
    const m = mirrorElement(t);
    expect(m).toMatchObject({ x1: 160, y1: 0, x2: 0, y2: 0 });
    expect(m.flags).toBe(2);
    expect(postsOf(m)).toEqual([
      { x: 0, y: -32 },
      { x: 160, y: 0 },
      { x: 16, y: 32 },
    ]);
  });

  it('mirrors a fresh vertical part, toggling the flip bit', () => {
    const t = element('triode', 80, -80, 80, 80, 2);
    expect(mirrorElement(t).flags).toBe(3);
  });

  it('mirrors a legacy flagless horizontal part, toggling the flip bit', () => {
    // Without DSIGN_FIX the electrode side is a fixed 1 rather than dsign, so
    // the mirror must flip the bit to move the hanging posts across.
    const t = element('triode', 0, 0, 160, 0, 0);
    expect(mirrorElement(t).flags).toBe(1);
  });
});

describe('mirrorElement', () => {
  it('keeps the bounding box and flips the order of posts on a transistor', () => {
    const t = element('transistor', 0, 0, 160, 0, 0, { pnp: 1 });
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
    // Rigid mirror of the leads: inverting was above the axis, stays above,
    // at the default size 2 half separation of 16.
    expect(postsOf(m)[0]).toEqual({ x: 160, y: -16 });
    expect(postsOf(m)[1]).toEqual({ x: 160, y: 16 });
  });

  it('is a no-op on a part without a mirror', () => {
    const d = element('diode', 0, 0, 160, 0);
    expect(mirrorElement(d)).toEqual(d);
  });
});

describe('unijunction FLAG_FLIP', () => {
  it('mirrors a horizontal part across the vertical axis without the flag', () => {
    // A horizontal part's mirror reverses dsign, which alone moves the E/B1/B2
    // posts across; upstream's flipX leaves FLAG_FLIP alone when dx != 0
    // (UnijunctionElm.java:141-145).
    const u = element('unijunction', 0, 0, 32, 0);
    const before = postsOf(u);
    const m = mirrorElement(u);
    expect(m).toMatchObject({ x1: 32, y1: 0, x2: 0, y2: 0 });
    expect(m.flags & 2).toBe(0);
    const after = postsOf(m);
    // Rigid mirror about x = 16: the emitter lands on the old B2 column.
    expect(after[0]).toEqual({ x: 32, y: 0 });
    expect(after[1]).toEqual({ x: 0, y: 32 });
    expect(after[2]).toEqual({ x: 0, y: 0 });
    expect(before).not.toEqual(after);
  });

  it('mirrors a vertical part by toggling FLAG_FLIP', () => {
    // A vertical part's dsign is unchanged by the mirror, so the flag flips
    // and the hanging B1/B2 posts cross over (UnijunctionElm.java:141-145,
    // dx == 0).
    const u = element('unijunction', 16, 0, 16, 32, 1);
    const m = mirrorElement(u);
    expect(m.flags & 2).toBe(2);
    expect(postsOf(m)).toEqual([
      { x: 16, y: 0 },
      { x: 48, y: 32 },
      { x: 16, y: 32 },
    ]);
  });

  it('rotates a horizontal part with a single flag toggle', () => {
    // flipXY toggles FLAG_FLIP, flipY toggles it back only for a part that was
    // vertical before the turn (UnijunctionElm.java:141-156), so a horizontal
    // part ends toggled once.
    const u = element('unijunction', 0, 0, 32, 0);
    const r = rotateElement(u);
    expect(r.flags & 2).toBe(2);
    expect(postsOf(r)).toEqual([
      { x: 16, y: 16 },
      { x: 48, y: -16 },
      { x: 16, y: -16 },
    ]);
  });

  it('four turns return the original element', () => {
    const original = element('unijunction', 0, 0, 32, 0);
    let e = original;
    for (let i = 0; i < 4; i++) e = rotateElement(e);
    expect(e).toEqual(original);
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

describe('routed wire transforms drop the route', () => {
  const routedWire = () => {
    const w = element('wire', 0, 0, 160, 0);
    w.route = [
      [0, 0],
      [0, 80],
      [160, 0],
    ];
    return w;
  };

  it('rotate clears the route, whose geometry no longer matches the endpoints', () => {
    const r = rotateElement(routedWire());
    expect(r.x1).toBe(r.x2);
    expect(r.route).toBeUndefined();
  });

  it('swap clears the route', () => {
    const s = swapTerminalOrder(routedWire());
    expect([s.x1, s.y1, s.x2, s.y2]).toEqual([160, 0, 0, 0]);
    expect(s.route).toBeUndefined();
  });

  it('mirror cannot apply to a wire, so its route survives as a no-op', () => {
    // canMirror is false for a two-post part, so mirrorElement returns the wire
    // untouched: there is no mirror path that could leave a stale route.
    const m = mirrorElement(routedWire());
    expect(m.route).toEqual([
      [0, 0],
      [0, 80],
      [160, 0],
    ]);
  });
});

describe('turnPointAbout', () => {
  it('turns a quarter per unit and closes the circle on the fourth', () => {
    const pivot = { x: 0, y: 0 };
    const p = { x: 32, y: 0 };
    // The same sense as rotateElement: relative to the pivot, (dx,dy) goes to
    // (dy,-dx), which on a y-down canvas walks the point anticlockwise.
    expect(turnPointAbout(p, pivot, 0)).toEqual({ x: 32, y: 0 });
    expect(turnPointAbout(p, pivot, 1)).toEqual({ x: 0, y: -32 });
    expect(turnPointAbout(p, pivot, 2)).toEqual({ x: -32, y: 0 });
    expect(turnPointAbout(p, pivot, 3)).toEqual({ x: 0, y: 32 });
    expect(turnPointAbout(p, pivot, 4)).toEqual({ x: 32, y: 0 });
  });

  it('takes the turn count mod 4, in both directions', () => {
    const pivot = { x: 0, y: 0 };
    const p = { x: 32, y: 0 };
    // The placement's banked turns are already reduced mod 4, but a negative
    // or oversized count must still land somewhere sane rather than loop.
    expect(turnPointAbout(p, pivot, 5)).toEqual(turnPointAbout(p, pivot, 1));
    expect(turnPointAbout(p, pivot, -1)).toEqual(turnPointAbout(p, pivot, 3));
    expect(turnPointAbout(p, pivot, -4)).toEqual({ x: 32, y: 0 });
  });

  it('holds the pivot itself still, wherever it is', () => {
    for (const pivot of [
      { x: 0, y: 0 },
      { x: -48, y: -112 },
      { x: 96, y: -16 },
    ]) {
      for (let t = 0; t < 4; t++) expect(turnPointAbout(pivot, pivot, t)).toEqual(pivot);
    }
  });

  it('turns about a negative-coordinate pivot without drifting', () => {
    const pivot = { x: -32, y: -64 };
    const p = { x: 0, y: -64 };  // 32 to the pivot's right
    expect(turnPointAbout(p, pivot, 1)).toEqual({ x: -32, y: -96 });  // straight above
    expect(turnPointAbout(p, pivot, 2)).toEqual({ x: -64, y: -64 });
    expect(turnPointAbout(p, pivot, 4)).toEqual(p);
  });

  it('rounds once at the end, so a half-coordinate pivot cannot compound', () => {
    // An element midpoint is a half coordinate whenever the span is odd; four
    // turns about it must still be the identity, which per-turn rounding would
    // break.
    const pivot = { x: 90.5, y: 10 };
    const p = { x: 10, y: 20 };
    expect(turnPointAbout(p, pivot, 4)).toEqual(p);
    expect(Number.isInteger(turnPointAbout(p, pivot, 1).x)).toBe(true);
    expect(Number.isInteger(turnPointAbout(p, pivot, 1).y)).toBe(true);
  });
});

describe('rotate about an explicit pivot', () => {
  it('holds the anchor still and drops a horizontal part below it', () => {
    // The placement path: (x1,y1) is the point the user pressed, so it must not
    // move, and the free end swings to the perpendicular.
    const e = element('resistor', 0, 0, 160, 0);
    const r = rotateElement(e, { x: e.x1, y: e.y1 });
    expect([r.x1, r.y1]).toEqual([0, 0]);
    expect([r.x2, r.y2]).toEqual([0, -160]);
  });

  it('is the identity after four turns about the anchor', () => {
    let r = element('resistor', 16, 32, 176, 32);
    const original = r;
    for (let i = 0; i < 4; i++) r = rotateElement(r, { x: r.x1, y: r.y1 });
    expect(r).toEqual(original);
  });

  it('walks the free end round all four quadrants of the anchor', () => {
    const e = element('wire', 48, 48, 48 + 64, 48);
    let r = rotateElement(e, { x: 48, y: 48 });
    expect([r.x2, r.y2]).toEqual([48, 48 - 64]);
    r = rotateElement(r, { x: 48, y: 48 });
    expect([r.x2, r.y2]).toEqual([48 - 64, 48]);
    r = rotateElement(r, { x: 48, y: 48 });
    expect([r.x2, r.y2]).toEqual([48, 48 + 64]);
    r = rotateElement(r, { x: 48, y: 48 });
    expect([r.x2, r.y2]).toEqual([48 + 64, 48]);
  });

  it('leaves the default-pivot result byte-identical, flags included', () => {
    // The pivot parameter must not have moved the settled-selection path a
    // single unit: these are the pre-pivot outputs for a plain two-post part,
    // a horizontal op-amp (flag toggles) and a vertical mosfet (flag cancels).
    expect(rotateElement(element('resistor', 0, 0, 160, 0))).toMatchObject({
      x1: 80,
      y1: 80,
      x2: 80,
      y2: -80,
      flags: 0,
    });
    const opamp = rotateElement(element('opamp', 0, 0, 160, 0, 0));
    expect([opamp.x1, opamp.y1, opamp.x2, opamp.y2]).toEqual([80, 80, 80, -80]);
    expect(opamp.flags & 1).toBe(1);  // horizontal: flipXY toggles, flipY does not
    const mosfet = rotateElement(element('mosfet', 0, 0, 0, 160, 8));
    expect([mosfet.x1, mosfet.y1, mosfet.x2, mosfet.y2]).toEqual([-80, 80, 80, 80]);
    expect(mosfet.flags).toBe(8);  // vertical: the two flips cancel
  });

  it('applies the same orientation flag whichever pivot is used', () => {
    // rotateFlags reads the pre-turn endpoints, so the pivot cannot reach it.
    const opamp = element('opamp', 0, 0, 160, 0, 0);
    expect(rotateElement(opamp, { x: 0, y: 0 }).flags).toBe(rotateElement(opamp).flags);
    const vertical = element('opamp', 0, 0, 0, 160, 1);
    expect(rotateElement(vertical, { x: 0, y: 0 }).flags).toBe(rotateElement(vertical).flags);
  });

  it('refuses a post-only annotation whatever the pivot', () => {
    const text = element('decoration', 8, 8, 8, 8);
    expect(rotateElement(text, { x: 0, y: 0 })).toBe(text);
  });
});
