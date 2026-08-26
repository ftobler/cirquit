import { describe, expect, it, beforeEach } from 'vitest';
import { postsOf } from './registry';
import {
  canMirror,
  canRotate,
  canSwap,
  mirrorElement,
  rotateElement,
  selectionMirrorCentre,
  selectionTurnPivot,
  swapTerminalOrder,
  turnPointAbout,
} from './transform';
import { SWITCH2_CENTER_OFF } from './registry/flags';
import {
  clearSessionModels,
  getModel,
  modelToEngineSpec,
  parseCompositeModelLine,
  registerSessionModel,
} from '../io/subcircuits';
import type { CircuitElement, Point } from './types';

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

  it('rotate leaves the throw position alone: upstream nets zero over both flips', () => {
    // Upstream's rotate is flipXY then flipY and DPDTSwitchElm overrides BOTH
    // with a throw reversal (DPDTSwitchElm.java:264-277), so a quarter turn
    // cancels out and each pole still throws where it did. Only the mirror,
    // one flip, reverses.
    const r = rotateElement(dpdt(0));
    expect(r.state).toBe(0);
    expect(r.params.position).toBe(0);
    // The body still rides the rigid quarter turn.
    expect(postsOf(r)).toHaveLength(6);
    const m = rotateElement(dpdt(1));
    expect(m.state).toBe(1);
    expect(m.params.position).toBe(1);
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

describe('switch2 transforms', () => {
  const switch2 = (
    position: number,
    flags = 0,
    throwCount = 2,
    flipParity = 0,
  ): CircuitElement => ({
    ...element('switch2', 0, 0, 160, 0, flags, { position, throwCount, flipParity }),
    state: position,
  });

  it('mirror reverses the lever and bumps the flip parity', () => {
    const m = mirrorElement(switch2(0));
    expect(m.state).toBe(1);
    expect(m.params.position).toBe(1);
    expect(m.params.flipParity).toBe(1);
    // The endpoints reflect about the midpoint like any mirror.
    expect([m.x1, m.y1, m.x2, m.y2]).toEqual([160, 0, 0, 0]);
  });

  it('four mirrors return the position and the parity to the start', () => {
    let e: CircuitElement = switch2(0);
    for (let i = 0; i < 4; i++) e = mirrorElement(e);
    expect(e.state).toBe(0);
    expect(e.params.position).toBe(0);
    expect(e.params.flipParity).toBe(0);
  });

  it('rotate of a settled selection leaves the lever and the parity alone', () => {
    // Upstream's rotate composes flipXY and flipY and Switch2Elm overrides
    // BOTH with a lever reversal (Switch2Elm.java:241-259), so the two
    // reversals cancel: a rigid quarter turn needs no compensation. The
    // mirror above is one reversal and keeps it.
    const r = rotateElement(switch2(0));
    expect(r.state).toBe(0);
    expect(r.params.position).toBe(0);
    expect(r.params.flipParity).toBe(0);
    const thrown = rotateElement(switch2(1));
    expect(thrown.state).toBe(1);
    expect(thrown.params.position).toBe(1);
    expect(thrown.params.flipParity).toBe(0);
  });

  it('four rotates return the position and the parity to the start', () => {
    let e: CircuitElement = switch2(0);
    for (let i = 0; i < 4; i++) e = rotateElement(e);
    expect(e.state).toBe(0);
    expect(e.params.position).toBe(0);
    expect(e.params.flipParity).toBe(0);
  });

  it('the placement ghost rotate does not invert the fresh lever', () => {
    // The ghost turns about its press anchor with no committed position
    // history, so the position and parity stay where a fresh part starts.
    const ghost = rotateElement(switch2(0), { x: 0, y: 0 });
    expect(ghost.state).toBe(0);
    expect(ghost.params.position).toBe(0);
    expect(ghost.params.flipParity).toBe(0);
  });

  it('a centre-off mirror honours the three stops', () => {
    const centreOff = switch2(0, SWITCH2_CENTER_OFF, 2);
    const m = mirrorElement(centreOff);
    expect(m.state).toBe(2);
    expect(m.params.flipParity).toBe(1);
    const back = mirrorElement(m);
    expect(back.state).toBe(0);
    expect(back.params.flipParity).toBe(0);
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

describe('opampReal transforms carry no flag', () => {
  // OpAmpRealElm overrides neither flipX, flipY nor flipXY: its canFlipX and
  // canFlipY (OpAmpRealElm.java:319-320) only gate which flips the menu
  // offers. The swap bit therefore never moves under a transform, and the
  // rails keep their plain-dsign geometry on both sides of one.

  it('mirrors a horizontal part through dsign alone, keeping the flag', () => {
    // Upstream flipX touches no flag (OpAmpRealElm.java:319-320 are only
    // canFlipX/canFlipY): the reflected endpoints reverse dsign, so the
    // swapped inputs land across the axis exactly as upstream leaves them,
    // while the rails keep their plain-hs geometry at (48,-32) and (48,32).
    const e = element('opampReal', 0, 0, 96, 0, 2);
    const m = mirrorElement(e);
    expect(m).toMatchObject({ x1: 96, y1: 0, x2: 0, y2: 0 });
    expect(m.flags).toBe(2);
    expect(postsOf(m)).toEqual([
      { x: 96, y: 16 },
      { x: 96, y: -16 },
      { x: 0, y: 0 },
      { x: 48, y: -32 },
      { x: 48, y: 32 },
    ]);
  });

  it('mirrors a vertical part without toggling anything', () => {
    const e = element('opampReal', 48, -48, 48, 48, 2);
    expect(mirrorElement(e).flags).toBe(2);
  });

  it('rotates without touching the swap bit, in either axis', () => {
    const horizontal = element('opampReal', 0, 0, 96, 0, 2);
    expect(rotateElement(horizontal).flags).toBe(2);
    const vertical = element('opampReal', 48, -48, 48, 48, 2);
    expect(rotateElement(vertical).flags).toBe(2);
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

describe('selection group pivot', () => {
  // The plan's stacked pair: two horizontal resistors sharing an x range one
  // grid row apart. Per-element pivots stack both onto x=132; upstream's one
  // bounding-box pivot turns them rigidly to x=116 and x=148.
  const r1 = element('resistor', 100, 100, 164, 100);
  const r2 = element('resistor', 100, 132, 164, 132);

  it('derives no shared pivot for an empty or single-element selection', () => {
    // The lone-element command stays `upstreamTurn`, whose grid-snapped axis
    // shift for odd-defaultLength kinds is documented deliberate behaviour.
    expect(selectionTurnPivot([])).toBeUndefined();
    expect(selectionTurnPivot([r1])).toBeUndefined();
    expect(selectionMirrorCentre([])).toBeUndefined();
    expect(selectionMirrorCentre([r1])).toBeUndefined();
  });

  it('walks the selection bounding box once, truncating like Java integer division', () => {
    // Upstream prepareFlip: min and max over both endpoints of every selected
    // element, then (min+max)/2 as an int. This pair spans x 0..163 and
    // y 0..33, so the centres are 81 and 16, not 81.5 and 16.5; rounding
    // instead of truncating would drift every odd-span selection by a square.
    const pair = [element('wire', 0, 0, 163, 0), element('wire', 0, 33, 160, 33)];
    expect(selectionMirrorCentre(pair)).toBe(81);
    // The turn pivot encodes the snapped axis (x - y = snapGrid(81 - 16) = 64)
    // and the doubled centre (x + y = 2*cy + xmy): (16 + 64, 16).
    expect(selectionTurnPivot(pair)).toEqual({ x: 80, y: 16 });
  });

  it('truncates a negative-span bounding box toward zero, as Java division does', () => {
    // The pair spans x -163..0 and y -133..0, so both centres divide an odd
    // negative sum: truncation gives -81 and -66, where a Math.floor
    // regression would answer -82 and -67.
    const pair = [element('wire', -163, 0, 0, 0), element('wire', 0, -133, 0, 0)];
    expect(selectionMirrorCentre(pair)).toBe(-81);
    // The snapped axis is snapGrid(-81 + 66) = -16, so the pivot is
    // (-66 - 16, -66); turning about it reproduces upstream's composed flips.
    expect(selectionTurnPivot(pair)).toEqual({ x: -82, y: -66 });
    const turned = rotateElement(pair[0], selectionTurnPivot(pair)!);
    // Cross-checked against CommandManager.rotate by hand: center2 = -132,
    // xmy = -16, so (x,y) lands on (y - 16, -148 - x).
    expect([turned.x1, turned.y1]).toEqual([-16, 15]);
    expect([turned.x2, turned.y2]).toEqual([-16, -148]);
  });

  it('turns the stacked pair rigidly to the upstream coordinates', () => {
    // CommandManager.rotate on this exact pair puts R1 at x=116 and R2 at
    // x=148; the invariant form is the 32-unit column gap with no coordinate
    // shared between the elements.
    const pivot = selectionTurnPivot([r1, r2])!;
    const t1 = rotateElement(r1, pivot);
    const t2 = rotateElement(r2, pivot);
    expect([t1.x1, t1.y1, t1.x2, t1.y2]).toEqual([116, 148, 116, 84]);
    expect([t2.x1, t2.y1, t2.x2, t2.y2]).toEqual([148, 148, 148, 84]);
    // The invariant: each element collapses to one column and the columns are
    // distinct, 32 apart. Endpoint coordinates may still coincide across the
    // elements (t1's top row is t2's column value here), so only the x axes
    // say "no overlap".
    expect(t1.x1).toBe(t1.x2);
    expect(t2.x1).toBe(t2.x2);
    expect(Math.abs(t1.x1 - t2.x1)).toBe(32);
  });

  it('turns a non-collinear three-element L rigidly, every pairwise distance kept', () => {
    // Rigidity in general, not an invariant tailored to one axis of the
    // stacked pair: two perpendicular bars and a diagonal brace turn about
    // the shared pivot, and all three centroid distances must survive
    // exactly. The squared distances are integers, so toBe is exact.
    const arms = [element('wire', 0, 0, 160, 0), element('wire', 0, 0, 0, 160), element('wire', 160, 0, 320, 160)];
    const pivot = selectionTurnPivot(arms)!;
    expect(pivot).toEqual({ x: 160, y: 80 });
    const centroid = (e: CircuitElement) => ({ x: (e.x1 + e.x2) / 2, y: (e.y1 + e.y2) / 2 });
    const sq = (p: Point, q: Point) => (p.x - q.x) ** 2 + (p.y - q.y) ** 2;
    const before = arms.map(centroid);
    const after = arms.map((e) => rotateElement(e, pivot)).map(centroid);
    for (const [i, j] of [[0, 1], [0, 2], [1, 2]] as const) {
      expect(sq(after[i], after[j])).toBe(sq(before[i], before[j]));
    }
  });

  it('keeps the SPDT throw where it was under a group pivot', () => {
    // The rotate rework's net-zero reversal is pivot-independent:
    // rotateElement never reaches the position logic from the pivot argument,
    // so a mixed-kind group turn must leave the lever exactly as it was.
    const sw = {
      ...element('switch2', 0, 160, 160, 160, 0, { position: 1, throwCount: 2 }),
      state: 1,
    };
    const pivot = selectionTurnPivot([element('resistor', 0, 0, 160, 0), sw])!;
    const turned = rotateElement(sw, pivot);
    expect(turned.state).toBe(1);
    expect(turned.params.position).toBe(1);
    expect(turned.params.flipParity ?? 0).toBe(0);
  });

  it('mirrors about the shared centre so neither element leaves its row', () => {
    // Different widths on different rows: each own centre differs from the
    // shared one (x 100..196 truncates to 148), which is what makes per-element
    // axes scramble the group while the shared axis mirrors it in place.
    const t = { ...element('transistor', 100, 100, 164, 100), params: { pnp: 1 } };
    const o = element('opamp', 100, 132, 196, 132);
    const centre = selectionMirrorCentre([t, o])!;
    expect(centre).toBe(148);
    const mt = mirrorElement(t, centre);
    const mo = mirrorElement(o, centre);
    expect([mt.x1, mt.y1, mt.x2, mt.y2]).toEqual([196, 100, 132, 100]);
    expect([mo.x1, mo.y1, mo.x2, mo.y2]).toEqual([196, 132, 100, 132]);
    // The rows stay 32 apart and inside the original span, 16 apart in centre
    // terms before and after.
    expect(Math.abs((mt.x1 + mt.x2) / 2 - (mo.x1 + mo.x2) / 2)).toBe(16);
  });

  it('reproduces the single-element mirror byte-for-byte when handed the own centre', () => {
    // Regression net for parameterising the mirror: every asymmetric kind,
    // given its own midpoint as the shared centre, must come out identical to
    // the default call, switches and their flip bookkeeping included.
    const cases = [
      ['transistor', 16, 32, 176, 32],
      ['opamp', 0, 0, 160, 0],
      ['mosfet', 80, -80, 80, 80],
      ['triode', 0, 0, 160, 0],
      ['triState', 0, 0, 96, 0],
      ['dpdtSwitch', 0, 0, 96, 0],  // horizontal: the fan shifts along y
      ['dpdtSwitch', 48, -48, 48, 48],  // vertical: the fan shifts along x
      ['switch2', 0, 0, 160, 0],
    ] as const;
    for (const [kind, x1, y1, x2, y2] of cases) {
      const e = { ...element(kind, x1, y1, x2, y2), state: 1, params: { position: 1 } };
      expect(mirrorElement(e, (e.x1 + e.x2) / 2)).toStrictEqual(mirrorElement(e));
    }
    // Both DPDT orientations spelled out: the fan shift rides the shared-axis
    // refactor unchanged, down to the throw reversal.
    const horizontal = { ...element('dpdtSwitch', 0, 0, 96, 0), state: 1, params: { position: 1 } };
    const mh = mirrorElement(horizontal, 48);
    expect([mh.x1, mh.y1, mh.x2, mh.y2]).toEqual([96, 48, 0, 48]);
    expect(mh.state).toBe(0);
    expect(mh.params.position).toBe(0);
    const vertical = {
      ...element('dpdtSwitch', 48, -48, 48, 48),
      state: 1,
      params: { position: 1 },
    };
    const mv = mirrorElement(vertical, 48);
    expect([mv.x1, mv.y1, mv.x2, mv.y2]).toEqual([96, -48, 96, 48]);
    expect(mv.state).toBe(0);
    expect(mv.params.position).toBe(0);
  });
});

describe('chip mirrors', () => {
  beforeEach(() => clearSessionModels());

  // The plan's worked example: a set-variant D flip-flop (D W0, Q E0, /Q E1,
  // CLK W1, R E2, S W2), sizeX 2, sizeY 3, cspc2 32, stored on its full
  // 3-cell span. Every coordinate below is derived by hand from the upstream
  // formulas: ChipElm.flipX writes x' = centre2-x-(flippedSizeX+1)*cspc2,
  // x2' = centre2-x2 (ChipElm.java:620-628), and setPoints lays the pins out
  // from the anchor plus the flags.
  const DFF_SET = 4;
  const CHIP_FLIP_X = 1 << 10;
  const CHIP_FLIP_XY = 1 << 12;
  const CHIP_SMALL = 1;

  it('a d flip flop mirrored in a group lands its pin banks on the reflected columns', () => {
    // Group mirror about cx=300: shift (2+1)*32 = 96 gives
    // x1' = 600-100-96 = 404 and x2' = 600-196 = 404, collapsed exactly as
    // upstream writes it. The banks reflect onto cols 500 and 404.
    const e = element('dFlipFlop', 100, 200, 196, 200, DFF_SET);
    const m = mirrorElement(e, 300);
    expect([m.x1, m.y1, m.x2, m.y2]).toEqual([404, 200, 404, 200]);
    expect(m.flags & CHIP_FLIP_X).toBe(CHIP_FLIP_X);
    expect(postsOf(m)).toEqual([
      { x: 500, y: 200 },  // D, west bank to the reflected far column
      { x: 404, y: 200 },  // Q
      { x: 404, y: 232 },  // /Q
      { x: 500, y: 232 },  // CLK
      { x: 404, y: 264 },  // R
      { x: 500, y: 264 },  // S
    ]);
  });

  it('a singly mirrored d flip flop reflects in place', () => {
    // No shared centre means no anchor shift (upstream's count == 1 quirk):
    // the fields swap and normalise back to the same rightward segment while
    // the flag alone exchanges the two banks.
    const e = element('dFlipFlop', 100, 200, 196, 200, DFF_SET);
    const m = mirrorElement(e);
    expect([m.x1, m.y1, m.x2, m.y2]).toEqual([100, 200, 196, 200]);
    expect(m.flags & CHIP_FLIP_X).toBe(CHIP_FLIP_X);
    expect(postsOf(m)).toEqual([
      { x: 196, y: 200 },
      { x: 100, y: 200 },
      { x: 100, y: 232 },
      { x: 196, y: 232 },
      { x: 100, y: 264 },
      { x: 196, y: 264 },
    ]);
  });

  it('double group mirror restores the stored element byte for byte', () => {
    const e = element('dFlipFlop', 100, 200, 196, 200, DFF_SET);
    expect(mirrorElement(mirrorElement(e, 300), 300)).toStrictEqual(e);
  });

  it('a small grid chip shifts by half spacing', () => {
    // CHIP_SMALL halves cspc2 to 16, so both the stored span (48) and the
    // shift ((fsx+1)*16 = 48) shrink; rows step 16 instead of 32.
    const e = element('dFlipFlop', 100, 200, 148, 200, DFF_SET | CHIP_SMALL);
    const m = mirrorElement(e, 300);
    expect([m.x1, m.x2]).toEqual([452, 452]);
    expect(postsOf(m)).toEqual([
      { x: 500, y: 200 },
      { x: 452, y: 200 },
      { x: 452, y: 216 },
      { x: 500, y: 216 },
      { x: 452, y: 232 },
      { x: 500, y: 232 },
    ]);
  });

  it('an xy flipped chip mirrors using the transposed span', () => {
    // FLAG_FLIP_XY transposes flippedSizeX to sizeY, so the shift is
    // (3+1)*32 = 128 and x1' collapses with x2' at 372. Under the transposed
    // sides the W/E-born pins run along the top and bottom rows; reflecting
    // every hand-derived pre-mirror post about 300 must land exactly on the
    // post-mirror layout.
    const e = element('dFlipFlop', 100, 200, 228, 200, DFF_SET | CHIP_FLIP_XY);
    const before = postsOf(e);
    expect(before).toEqual([
      { x: 132, y: 168 },  // D, north row pos 0
      { x: 132, y: 264 },  // Q, south row pos 0
      { x: 164, y: 264 },  // /Q
      { x: 164, y: 168 },  // CLK
      { x: 196, y: 264 },  // R
      { x: 196, y: 168 },  // S
    ]);
    const m = mirrorElement(e, 300);
    expect([m.x1, m.x2]).toEqual([372, 372]);
    expect(m.flags & (CHIP_FLIP_X | CHIP_FLIP_XY)).toBe(CHIP_FLIP_X | CHIP_FLIP_XY);
    expect(postsOf(m)).toEqual([
      { x: 468, y: 168 },
      { x: 468, y: 264 },
      { x: 436, y: 264 },
      { x: 436, y: 168 },
      { x: 404, y: 264 },
      { x: 404, y: 168 },
    ]);
  });

  it('a vertical chip refuses the mirror', () => {
    // A strictly vertical segment is the port's rotated representation;
    // upstream has no such elements, so there is no upstream answer to
    // reproduce and the command declines through the usual gate.
    const v = element('dFlipFlop', 100, 200, 100, 296, DFF_SET);
    expect(canMirror(v)).toBe(false);
    expect(mirrorElement(v)).toBe(v);
    // A collapsed segment (what a group mirror leaves behind) is not vertical
    // and stays mirrorable, which is what makes a second group mirror work.
    const collapsed = element('dFlipFlop', 404, 200, 404, 200, DFF_SET | CHIP_FLIP_X);
    expect(canMirror(collapsed)).toBe(true);
  });

  it('an optocoupler group mirror lands at the upstream 204', () => {
    // OptocouplerElm.flipX shifts by its fixed 3*cspc2 = 96
    // (OptocouplerElm.java:165-172): x' = 400-100-96 = 204. The body anchors
    // at raw x1 and ignores the segment, so the four corner posts land on the
    // reflected columns 300 and 204.
    const e = element('optocoupler', 100, 200, 164, 200);
    expect(postsOf(e)).toEqual([
      { x: 100, y: 200 },
      { x: 100, y: 232 },
      { x: 196, y: 200 },
      { x: 196, y: 232 },
    ]);
    const m = mirrorElement(e, 200);
    expect([m.x1, m.y1, m.x2, m.y2]).toEqual([204, 200, 236, 200]);
    expect(m.flags & CHIP_FLIP_X).toBe(CHIP_FLIP_X);
    expect(postsOf(m)).toEqual([
      { x: 300, y: 200 },
      { x: 300, y: 232 },
      { x: 204, y: 200 },
      { x: 204, y: 232 },
    ]);
  });

  it('a controlled source group mirror moves the body and toggles the bit', () => {
    // VCCSElm extends ChipElm, so the four controlled sources inherit the
    // same flip: sx 2, parametric sy from the input count.
    const e = element('vcvs', 100, 200, 196, 200);
    const m = mirrorElement(e, 300);
    expect([m.x1, m.y1, m.x2, m.y2]).toEqual([404, 200, 404, 200]);
    expect(m.flags & CHIP_FLIP_X).toBe(CHIP_FLIP_X);
    expect(postsOf(m)).toEqual([
      { x: 500, y: 200 },  // A
      { x: 500, y: 232 },  // B
      { x: 404, y: 200 },  // V+
      { x: 404, y: 232 },  // V-
    ]);
  });

  it('a custom composite mirror uses the model extents', () => {
    // A resolved sizeX 2 model spans (2+1)*cspc2 like any sizeX 2 chip; the
    // extents come off the model, not off a fixed table entry.
    registerSessionModel(
      parseCompositeModelLine(
        '. mir 0 2 1 2 in 1 0 2 out 3 0 3 ' +
          'ResistorElm\\s1\\s2\\rResistorElm\\s2\\s3 ' +
          '0\\\\s1000\\s0\\\\s1000',
      )!,
    );
    const spec = modelToEngineSpec(getModel('mir')!);
    const e = { ...element('customComposite', 100, 200, 196, 200, 1), text: 'mir', model: spec };
    expect(postsOf(e)).toEqual([
      { x: 100, y: 200 },
      { x: 196, y: 200 },
    ]);
    const m = mirrorElement(e, 300);
    expect([m.x1, m.y1, m.x2, m.y2]).toEqual([404, 200, 404, 200]);
    expect(m.flags & CHIP_FLIP_X).toBe(CHIP_FLIP_X);
    expect(postsOf(m)).toEqual([
      { x: 500, y: 200 },
      { x: 404, y: 200 },
    ]);
  });
});
