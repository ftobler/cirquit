import { beforeEach, describe, expect, it } from 'vitest';
import { LONG_PRESS_MS, TouchGesture } from '../gestures';
import { defFor } from '../../model/registry';
import { SWITCH_IEC } from '../../model/registry/flags';
import { rectContains } from '../../model/registry/shared';
import { GRID_SIZE } from '../../model/types';
import type { CircuitElement, Point } from '../../model/types';
import { HIT_TOLERANCE_PX } from '../../render/geometry';
import { boxFromPoints, selectByBox } from '../../render/selection';
import { makeGhostElement, snap, useStore } from '../../state/store';
import { DEFAULT_PLACEMENT_LENGTH } from '../../state/helpers';
import { fresh } from '../../state/store.test-helpers';
import {
  abandonForLongPress,
  armedHandle,
  beginPointerGesture,
  finishPlacement,
  finishPostDrag,
  finishWireDrag,
  openMenuAndAbandonForLongPress,
  placementPoint,
  releaseHeldMomentary,
  startRowCol,
  stepMoveDrag,
  type Drag,
  type PointerDownInput,
  type PointerDownRefs,
} from './pointerDown';

beforeEach(() => useStore.setState(fresh()));

/** A horizontal element across the middle of the canvas. */
const baseEl = (kind: string, patch: Partial<CircuitElement> = {}): CircuitElement => ({
  id: 0,
  kind,
  x1: 0,
  y1: 0,
  x2: 160,
  y2: 0,
  flags: 0,
  params: { position: 0, momentary: 0, throwCount: 2 },
  state: 0,
  ...patch,
});

const addEl = (kind: string, patch: Partial<CircuitElement> = {}) =>
  useStore.getState().addElement(baseEl(kind, patch));

const hit = (id: number): CircuitElement => {
  const e = useStore.getState().elements.find((q) => q.id === id);
  if (!e) throw new Error(`missing element ${id}`);
  return e;
};

const refs = (): PointerDownRefs => ({
  dragRef: { current: { mode: 'none' } as Drag },
  heldMomentaryRef: { current: null },
  heldMomentaryPointerRef: { current: null },
});

const down = (patch: Partial<PointerDownInput> = {}): PointerDownInput => ({
  button: 0,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  clientX: 0,
  clientY: 0,
  pointerId: 1,
  ...patch,
});

/** The finger position shared by the gesture-interrupt suites below: every
 *  recognizer event and both coordinate spaces use it, since their flat view
 *  makes client and circuit points coincide. */
const PRESS = { x: 100, y: 100 };
let t = 0;

/** A touch finger lands with `tool` armed, the way onPointerDown wires it:
 *  gated true, the recognizer fed the same coordinates as the gesture, the
 *  arm comes from the shared beginPointerGesture against a fake dragRef and
 *  the real store. */
const touchDownWithTool = (tool: string | null) => {
  const g = new TouchGesture(() => t);
  t = 0;
  useStore.getState().setTool(tool);
  expect(g.down(1, PRESS.x, PRESS.y).actions).toEqual([{ type: 'primaryDown' }]);
  const r = refs();
  beginPointerGesture(
    down({ pointerId: 1, clientX: PRESS.x, clientY: PRESS.y }),
    PRESS,
    useStore.getState(),
    null,
    true,
    r,
  );
  return { g, r };
};

describe('switchRect geometry', () => {
  it('a plain switch covers the body, the open tip and the closed lever', () => {
    const rect = defFor('switch')!.switchRect!(baseEl('switch'));
    // The tight union of the body and both lever centrelines, no margin: the
    // closed lever rides 2 units on the lift side, so the box must not hug the
    // axis (SwitchElm.java:118-132).
    expect(rect).toEqual({ x: 64, y: -16, w: 32, h: 16 });
    expect(rectContains(rect, { x: 64, y: 0 })).toBe(true); // open pivot
    expect(rectContains(rect, { x: 96, y: -16 })).toBe(true); // open tip
    expect(rectContains(rect, { x: 64, y: -2 })).toBe(true); // closed pivot
    expect(rectContains(rect, { x: 96, y: -2 })).toBe(true); // closed tip
    expect(rectContains(rect, { x: 80, y: -5 })).toBe(true);
    expect(rectContains(rect, { x: 30, y: 0 })).toBe(false); // left lead
    expect(rectContains(rect, { x: 120, y: 0 })).toBe(false); // right lead
    expect(rectContains(rect, { x: 80, y: 5 })).toBe(false); // past the margin
  });

  it('an SPDT covers the fan from the pivot to both throw poles', () => {
    const rect = defFor('switch2')!.switchRect!(baseEl('switch2'));
    // The tight union of the pivot lead and the first and last throw poles, no
    // margin (Switch2Elm.java:121-123).
    expect(rect).toEqual({ x: 64, y: -16, w: 32, h: 32 });
    expect(rectContains(rect, { x: 64, y: 0 })).toBe(true); // pivot lead1
    expect(rectContains(rect, { x: 96, y: -16 })).toBe(true); // throw pole 0
    expect(rectContains(rect, { x: 96, y: 16 })).toBe(true); // last throw pole
    expect(rectContains(rect, { x: 96, y: 0 })).toBe(true); // center-off rest, lead2
    expect(rectContains(rect, { x: 96, y: -15 })).toBe(true); // the lever on a throw
    expect(rectContains(rect, { x: 96, y: 20 })).toBe(false); // past the margin
    expect(rectContains(rect, { x: 30, y: 0 })).toBe(false);
  });

  it('an SPDT click box is position-independent for center-off', () => {
    const rect = defFor('switch2')!.switchRect!(baseEl('switch2'));
    const centered = defFor('switch2')!.switchRect!(
      baseEl('switch2', { state: 2, params: { position: 2, momentary: 0, throwCount: 2 } }),
    );
    expect(centered).toEqual(rect);
  });

  it('a DPDT covers the lever bank from the first pole to the last throw', () => {
    const rect = defFor('dpdtSwitch')!.switchRect!(baseEl('dpdtSwitch'));
    // The tight union of the first pole's lead and the extreme throws of the
    // fan, no margin (DPDTSwitchElm.java:162-164).
    expect(rect).toEqual({ x: 64, y: -16, w: 32, h: 80 });
    expect(rectContains(rect, { x: 64, y: 0 })).toBe(true); // first pole lead
    expect(rectContains(rect, { x: 96, y: -16 })).toBe(true); // first pole upper throw
    expect(rectContains(rect, { x: 96, y: 64 })).toBe(true); // last pole lower throw
    expect(rectContains(rect, { x: 64, y: 48 })).toBe(true); // last pole lead
    expect(rectContains(rect, { x: 96, y: 68 })).toBe(false); // past the margin
    expect(rectContains(rect, { x: 30, y: 0 })).toBe(false);
  });

  it('a logic input covers the glyph, not the lead', () => {
    const rect = defFor('logicInput')!.switchRect!(baseEl('logicInput'));
    expect(rect).toEqual({ x: 150, y: -10, w: 20, h: 20 });
    expect(rectContains(rect, { x: 160, y: 0 })).toBe(true);
    expect(rectContains(rect, { x: 151, y: 9 })).toBe(true);
    expect(rectContains(rect, { x: 120, y: 0 })).toBe(false); // on the lead
  });

  it('a cross switch covers its whole two-pole bank', () => {
    // throwLeads[4] is the second pole's throw at -3*openhs-openhs, so the
    // bank spans +16 down to +64 perpendicular (CrossSwitchElm.java:174-176).
    const rect = defFor('crossSwitch')!.switchRect!(baseEl('crossSwitch'));
    expect(rect).toEqual({ x: 64, y: -16, w: 32, h: 80 });
    expect(rectContains(rect, { x: 96, y: 32 })).toBe(true);
    expect(rectContains(rect, { x: 80, y: 40 })).toBe(true);
    expect(rectContains(rect, { x: 30, y: 0 })).toBe(false);
  });

  it('a cross switch click box reaches the second lever pivot and both tips', () => {
    // The second lever hangs 48 below the axis (poleLeads[1]) and its throw
    // tips sit at -32 and -64 perpendicular, so the pivot and both lever tip
    // positions must read as clickable, not just pole 0's lead and the extreme
    // throws (CrossSwitchElm.java:174-176). Under the IEC symbol the
    // position-0 tip extends to fraction 1.2, past the throws, which is the
    // case that actually widens the box.
    const rect = defFor('crossSwitch')!.switchRect!(baseEl('crossSwitch'));
    expect(rectContains(rect, { x: 64, y: 48 })).toBe(true); // poleLeads[1], the second lever's pivot
    expect(rectContains(rect, { x: 96, y: 64 })).toBe(true); // throwLeads[7], the position-0 tip
    expect(rectContains(rect, { x: 96, y: 32 })).toBe(true); // throwLeads[5], the position-1 tip
    const iec = defFor('crossSwitch')!.switchRect!(baseEl('crossSwitch', { flags: SWITCH_IEC }));
    expect(rectContains(iec, { x: 102, y: 53 })).toBe(true); // the IEC position-0 tip, fraction 1.2
  });

  it('a relay contact covers its three blade poles', () => {
    const rect = defFor('relayContact')!.switchRect!(baseEl('relayContact'));
    expect(rect).toEqual({ x: 64, y: -16, w: 32, h: 16 });
    expect(rectContains(rect, { x: 96, y: -16 })).toBe(true);
    expect(rectContains(rect, { x: 30, y: 0 })).toBe(false);
  });
});

describe('pointer-down on a switch while running', () => {
  it('inside the rect toggles, arms no drag and pushes one undo entry', () => {
    const id = addEl('switch');
    const r = refs();
    const before = useStore.getState().undoStack.length;
    beginPointerGesture(down(), { x: 80, y: -5 }, useStore.getState(), hit(id), false, r);
    expect(useStore.getState().elements[0].state).toBe(1);
    expect(r.dragRef.current).toEqual({ mode: 'none' });
    expect(useStore.getState().undoStack.length).toBe(before + 1);
  });

  it('outside the rect on a lead selects and arms move, without toggling', () => {
    const id = addEl('switch');
    const r = refs();
    beginPointerGesture(down(), { x: 30, y: 0 }, useStore.getState(), hit(id), false, r);
    expect(useStore.getState().elements[0].state).toBe(0);
    expect(useStore.getState().selectedIds).toEqual([id]);
    expect(r.dragRef.current).toEqual({ mode: 'move', ids: [id], last: { x: 30, y: 0 }, moved: false, gated: false });
  });

  it('a press outside the rect leads to a real move', () => {
    const id = addEl('switch');
    const r = refs();
    beginPointerGesture(down(), { x: 30, y: 0 }, useStore.getState(), hit(id), false, r);
    const drag = r.dragRef.current;
    if (drag.mode !== 'move') throw new Error('expected a move to be armed');
    // The move handler steps the frozen group by the grid-snapped delta
    // (stepMoveDrag, the canvas hook's move case).
    stepMoveDrag(drag, { x: 46, y: 32 }, useStore.getState());
    const moved = useStore.getState().elements[0];
    expect(moved.x1).toBe(16);
    expect(moved.y1).toBe(32);
  });

  it('ctrl inside the rect grabs the nearer endpoint without toggling', () => {
    const id = addEl('switch');
    const r = refs();
    beginPointerGesture(down({ ctrlKey: true }), { x: 100, y: -5 }, useStore.getState(), hit(id), false, r);
    expect(useStore.getState().elements[0].state).toBe(0);
    expect(r.dragRef.current).toEqual({
      mode: 'dragpost',
      id,
      post: 2,
      moved: false,
      gated: false,
      start: { x: 0, y: 0 },
    });
  });

  it('alt still pans instead of toggling', () => {
    const id = addEl('switch');
    const r = refs();
    beginPointerGesture(down({ altKey: true }), { x: 80, y: -5 }, useStore.getState(), hit(id), false, r);
    expect(useStore.getState().elements[0].state).toBe(0);
    expect(r.dragRef.current.mode).toBe('pan');
  });
});

describe('pointer-down on an SPDT while running', () => {
  it('inside the fan toggles through its throws', () => {
    const id = addEl('switch2');
    const r = refs();
    beginPointerGesture(down(), { x: 96, y: -15 }, useStore.getState(), hit(id), false, r);
    expect(useStore.getState().elements[0].state).toBe(1);
    expect(r.dragRef.current).toEqual({ mode: 'none' });
    beginPointerGesture(down(), { x: 96, y: -15 }, useStore.getState(), hit(id), false, r);
    expect(useStore.getState().elements[0].state).toBe(0);
  });

  it('a linked SPDT fans its throw out to its group from the canvas', () => {
    const a = addEl('switch2', { params: { position: 0, momentary: 0, throwCount: 2, link: 6 } });
    const b = addEl('switch2', { params: { position: 0, momentary: 0, throwCount: 2, link: 6 } });
    const r = refs();
    beginPointerGesture(down(), { x: 96, y: -15 }, useStore.getState(), hit(a), false, r);
    expect(hit(a).state).toBe(1);
    expect(hit(b).state).toBe(1);
    expect(r.dragRef.current).toEqual({ mode: 'none' });
  });

  it('outside the fan selects and arms move, without toggling', () => {
    const id = addEl('switch2');
    const r = refs();
    beginPointerGesture(down(), { x: 30, y: 0 }, useStore.getState(), hit(id), false, r);
    expect(useStore.getState().elements[0].state).toBe(0);
    expect(useStore.getState().selectedIds).toEqual([id]);
    expect(r.dragRef.current).toEqual({ mode: 'move', ids: [id], last: { x: 30, y: 0 }, moved: false, gated: false });
  });

  it('ctrl inside the fan arms dragpost without toggling', () => {
    const id = addEl('switch2');
    const r = refs();
    beginPointerGesture(down({ ctrlKey: true }), { x: 80, y: 0 }, useStore.getState(), hit(id), false, r);
    expect(useStore.getState().elements[0].state).toBe(0);
    expect(r.dragRef.current).toEqual({
      mode: 'dragpost',
      id,
      post: 1,
      moved: false,
      gated: false,
      start: { x: 160, y: 0 },
    });
  });
});

describe('pointer-down on a logic input while running', () => {
  it('the glyph toggles through both positions', () => {
    const id = addEl('logicInput');
    const r = refs();
    beginPointerGesture(down(), { x: 160, y: 0 }, useStore.getState(), hit(id), false, r);
    expect(useStore.getState().elements[0].state).toBe(1);
    beginPointerGesture(down(), { x: 160, y: 0 }, useStore.getState(), hit(id), false, r);
    expect(useStore.getState().elements[0].state).toBe(0);
  });

  it('a ternary logic input cycles all three positions from the glyph', () => {
    const id = addEl('logicInput', { flags: 1 }); // FLAG_TERNARY
    const r = refs();
    for (const expected of [1, 2, 0]) {
      beginPointerGesture(down(), { x: 160, y: 0 }, useStore.getState(), hit(id), false, r);
      expect(useStore.getState().elements[0].state).toBe(expected);
    }
  });

  it('the lead near the post selects instead of toggling', () => {
    const id = addEl('logicInput');
    const r = refs();
    beginPointerGesture(down(), { x: 60, y: 0 }, useStore.getState(), hit(id), false, r);
    expect(useStore.getState().elements[0].state).toBe(0);
    expect(useStore.getState().selectedIds).toEqual([id]);
    expect(r.dragRef.current?.mode).toBe('move');
  });
});

describe('momentary switches', () => {
  it('a lever press closes, holds, and the pointer-up reopens', () => {
    const id = addEl('switch', { params: { position: 1, momentary: 1 }, state: 1 });
    const r = refs();
    beginPointerGesture(down(), { x: 80, y: -5 }, useStore.getState(), hit(id), false, r);
    expect(useStore.getState().elements[0].state).toBe(0); // closed while held
    expect(r.heldMomentaryRef.current).toBe(id);
    expect(r.heldMomentaryPointerRef.current).toBe(1);
    expect(r.dragRef.current).toEqual({ mode: 'none' });
    releaseHeldMomentary(1, r);
    expect(useStore.getState().elements[0].state).toBe(1); // back to rest
    expect(r.heldMomentaryRef.current).toBeNull();
  });

  it('a press outside the rect never latches the momentary hold', () => {
    const id = addEl('switch', { params: { position: 1, momentary: 1 }, state: 1 });
    const r = refs();
    beginPointerGesture(down(), { x: 30, y: 0 }, useStore.getState(), hit(id), false, r);
    expect(useStore.getState().elements[0].state).toBe(1);
    expect(r.heldMomentaryRef.current).toBeNull();
    expect(r.dragRef.current?.mode).toBe('move');
  });

  it('a different finger cannot release a momentary the holding finger keeps down', () => {
    const id = addEl('switch', { params: { position: 1, momentary: 1 }, state: 1 });
    const r = refs();
    beginPointerGesture(down({ pointerId: 5 }), { x: 80, y: -5 }, useStore.getState(), hit(id), false, r);
    expect(useStore.getState().elements[0].state).toBe(0);
    releaseHeldMomentary(9, r);
    expect(useStore.getState().elements[0].state).toBe(0); // still held
    releaseHeldMomentary(5, r);
    expect(useStore.getState().elements[0].state).toBe(1);
  });

  it('the release kills a redo future staged by an undo mid-hold', () => {
    // The press's commit is the hold's undo baseline, but a Ctrl+Z landing
    // while the finger is still down builds a fresh redo future over which
    // the entry-free release throw would ride: Ctrl+Shift+Z after the release
    // would silently rewind it along with everything else.
    const id = addEl('switch', { params: { position: 1, momentary: 1 }, state: 1 });
    const r = refs();
    beginPointerGesture(down(), { x: 80, y: -5 }, useStore.getState(), hit(id), false, r);
    expect(hit(id).state).toBe(0); // closed while held
    useStore.getState().updateElement(id, { x2: 320 });
    useStore.getState().undo();
    expect(useStore.getState().redoStack.length).toBe(1);
    // The revert also restored the rested throw (the snapshot predates the
    // press), and upstream's one-toggle-per-event mouseUp still runs against
    // whatever state now stands.
    releaseHeldMomentary(1, r);
    expect(hit(id).state).toBe(0);
    expect(useStore.getState().redoStack).toEqual([]);
  });
});

describe('momentary SPDT switches', () => {
  it('a linked pair sees both toggles: press throws the gang, release returns it to rest', () => {
    // The release must run the same link-aware toggle the press ran, so every
    // twin gets the second throw; otherwise one click leaves the whole group
    // one stop over permanently (Switch2Elm.toggle via SwitchElm.mouseUp,
    // SwitchElm.java:180-182).
    const a = addEl('switch2', { params: { position: 0, momentary: 1, throwCount: 2, link: 6 } });
    const b = addEl('switch2', { params: { position: 0, momentary: 1, throwCount: 2, link: 6 } });
    const r = refs();
    beginPointerGesture(down(), { x: 96, y: -15 }, useStore.getState(), hit(a), false, r);
    expect(hit(a).state).toBe(1);
    expect(hit(b).state).toBe(1);
    expect(r.heldMomentaryRef.current).toBe(a);
    expect(r.heldMomentaryPointerRef.current).toBe(1);
    expect(r.dragRef.current).toEqual({ mode: 'none' });
    releaseHeldMomentary(1, r);
    expect(hit(a).state).toBe(0);
    expect(hit(b).state).toBe(0);  // the gang returned to rest together
    expect(r.heldMomentaryRef.current).toBeNull();
  });

  it('an unlinked momentary SPDT toggles on press and back on release', () => {
    const id = addEl('switch2', { params: { position: 0, momentary: 1, throwCount: 2, link: 0 } });
    const r = refs();
    beginPointerGesture(down(), { x: 96, y: -15 }, useStore.getState(), hit(id), false, r);
    expect(hit(id).state).toBe(1);
    expect(r.heldMomentaryRef.current).toBe(id);
    releaseHeldMomentary(1, r);
    expect(hit(id).state).toBe(0);
  });

  it('a non-momentary SPDT single-toggles and arms no hold at all', () => {
    const id = addEl('switch2');
    const r = refs();
    beginPointerGesture(down(), { x: 96, y: -15 }, useStore.getState(), hit(id), false, r);
    expect(hit(id).state).toBe(1);
    expect(r.heldMomentaryRef.current).toBeNull();
    // Nothing held, so a pointer-up must not move it off the new throw.
    releaseHeldMomentary(1, r);
    expect(hit(id).state).toBe(1);
  });
});

describe('momentary logic inputs', () => {
  it('a glyph press drives high, holds, and the pointer-up returns to low', () => {
    const id = addEl('logicInput', { params: { position: 0, momentary: 1 }, state: 0 });
    const r = refs();
    beginPointerGesture(down(), { x: 160, y: 0 }, useStore.getState(), hit(id), false, r);
    expect(useStore.getState().elements[0].state).toBe(1); // high while held
    expect(r.heldMomentaryRef.current).toBe(id);
    expect(r.dragRef.current).toEqual({ mode: 'none' });
    releaseHeldMomentary(1, r);
    expect(useStore.getState().elements[0].state).toBe(0); // back to low
    expect(r.heldMomentaryRef.current).toBeNull();
  });

  it('the same gesture on a latching logic input stays high until the next click', () => {
    const id = addEl('logicInput', { params: { position: 0, momentary: 0 }, state: 0 });
    const r = refs();
    beginPointerGesture(down(), { x: 160, y: 0 }, useStore.getState(), hit(id), false, r);
    expect(useStore.getState().elements[0].state).toBe(1);
    expect(r.heldMomentaryRef.current).toBeNull();
    releaseHeldMomentary(1, r);
    expect(useStore.getState().elements[0].state).toBe(1); // no hold to release
  });
});

describe('momentary MBB, DPDT and cross switches', () => {
  it('a momentary DPDT throws on press and returns to rest on release', () => {
    // Upstream releases through the inherited mouseUp, one toggle per event
    // (SwitchElm.mouseUp via MouseManager.java:1261-1263), and a DPDT has
    // posCount 2 (DPDTSwitchElm.java:63), so the release step lands back on
    // the rest position.
    const id = addEl('dpdtSwitch', { params: { position: 0, momentary: 1 } });
    const r = refs();
    beginPointerGesture(down(), { x: 80, y: 0 }, useStore.getState(), hit(id), false, r);
    expect(hit(id).state).toBe(1);
    expect(r.heldMomentaryRef.current).toBe(id);
    expect(r.dragRef.current).toEqual({ mode: 'none' });
    releaseHeldMomentary(1, r);
    expect(hit(id).state).toBe(0);
    expect(r.heldMomentaryRef.current).toBeNull();
  });

  it('a momentary cross switch throws on press and returns to rest on release', () => {
    // The cross switch is a SwitchElm subclass too (CrossSwitchElm.java:22)
    // and its file format carries the same momentary token, so upstream's
    // doSwitch arms a hold for it exactly as for the others; leaving it off
    // the arming list would strand a loaded `430 ... true` in its thrown
    // state after one click.
    const id = addEl('crossSwitch', { params: { position: 0, momentary: 1 } });
    const r = refs();
    beginPointerGesture(down(), { x: 80, y: 24 }, useStore.getState(), hit(id), false, r);
    expect(hit(id).state).toBe(1);
    expect(r.heldMomentaryRef.current).toBe(id);
    releaseHeldMomentary(1, r);
    expect(hit(id).state).toBe(0);
    expect(r.heldMomentaryRef.current).toBeNull();
  });

  it('a momentary MBB advances one stop per event, wrapping over its four stops', () => {
    // Upstream's mouseUp is one toggle(), not a rewind (SwitchElm.java:
    // 180-183): with the MBB's four stops (MBBSwitchElm.java:80) a click
    // cycle walks 0 -> 1 -> 2, holding the make-before-break "both" stop
    // while pressed and resting on the second pole after. The release must
    // run the same toggle as every other event rather than a %2 flip.
    const id = addEl('mbbSwitch', { params: { position: 0, momentary: 1, link: 0 } });
    const r = refs();
    beginPointerGesture(down(), { x: 96, y: -15 }, useStore.getState(), hit(id), false, r);
    expect(hit(id).state).toBe(1); // both poles held while pressed
    expect(r.heldMomentaryRef.current).toBe(id);
    releaseHeldMomentary(1, r);
    expect(hit(id).state).toBe(2); // rests on the second pole
    releaseHeldMomentary(1, r); // no hold left: a no-op
    expect(hit(id).state).toBe(2);
  });

  it('a linked MBB gang sees both toggles: press throws it, release fans again', () => {
    // The press reaches the gang through the link-aware toggleSwitch, so the
    // release must take the same path or the group splits in half
    // (MBBSwitchElm.toggle fans on every event, MBBSwitchElm.java:182-195).
    const a = addEl('mbbSwitch', { params: { position: 0, momentary: 1, link: 6 } });
    const b = addEl('mbbSwitch', { params: { position: 0, momentary: 1, link: 6 } });
    const r = refs();
    beginPointerGesture(down(), { x: 96, y: -15 }, useStore.getState(), hit(a), false, r);
    expect(hit(a).state).toBe(1);
    expect(hit(b).state).toBe(1);
    releaseHeldMomentary(1, r);
    expect(hit(a).state).toBe(2);
    expect(hit(b).state).toBe(2); // the gang stepped together
  });

  it('non-momentary MBB, DPDT and cross switches single-toggle and arm no hold', () => {
    const mbb = addEl('mbbSwitch');
    const dpdt = addEl('dpdtSwitch');
    const cross = addEl('crossSwitch');
    const r = refs();
    beginPointerGesture(down(), { x: 96, y: -15 }, useStore.getState(), hit(mbb), false, r);
    beginPointerGesture(down(), { x: 80, y: 0 }, useStore.getState(), hit(dpdt), false, r);
    beginPointerGesture(down(), { x: 80, y: 24 }, useStore.getState(), hit(cross), false, r);
    expect(hit(mbb).state).toBe(1);
    expect(hit(dpdt).state).toBe(1);
    expect(hit(cross).state).toBe(1);
    expect(r.heldMomentaryRef.current).toBeNull();
    releaseHeldMomentary(1, r);
    expect(hit(mbb).state).toBe(1);
    expect(hit(dpdt).state).toBe(1);
    expect(hit(cross).state).toBe(1);
  });
});

describe('touch gating', () => {
  it('a tap inside the rect still toggles immediately, drag never armed', () => {
    const id = addEl('switch');
    const r = refs();
    beginPointerGesture(down(), { x: 80, y: -5 }, useStore.getState(), hit(id), true, r);
    expect(useStore.getState().elements[0].state).toBe(1);
    expect(r.dragRef.current).toEqual({ mode: 'none' });
  });

  it('a tap outside the rect arms a gated move that waits for dragArmed', () => {
    const id = addEl('switch');
    const r = refs();
    beginPointerGesture(down(), { x: 30, y: 0 }, useStore.getState(), hit(id), true, r);
    expect(useStore.getState().elements[0].state).toBe(0);
    expect(r.dragRef.current).toEqual({ mode: 'move', ids: [id], last: { x: 30, y: 0 }, moved: false, gated: true });
  });
});

describe('click-place: a press with no drag', () => {
  // Every kind now gets a length from `makeGhostElement`, so a press that
  // never moves leaves a real part standing instead of the zero-length stray
  // finishPlacement used to have to delete. The resistor is the case that
  // changed: it declares no defaultLength, so before the ghost this press
  // produced a point and the click looked like it did nothing.
  it('keeps the placed element and returns to select mode', () => {
    useStore.getState().setTool('resistor');
    const r = refs();
    beginPointerGesture(down(), { x: 100, y: 100 }, useStore.getState(), null, false, r);
    const drag = r.dragRef.current;
    if (drag.mode !== 'place') throw new Error('expected a placement to be armed');

    finishPlacement(drag, useStore.getState());

    const placed = useStore.getState().elements;
    expect(placed).toHaveLength(1);
    expect(placed[0].x1 === placed[0].x2 && placed[0].y1 === placed[0].y2).toBe(false);
    // The tool clears after one placement, so the ghost goes with it.
    expect(useStore.getState().tool).toBeNull();
    expect(useStore.getState().selectedIds).toEqual([placed[0].id]);
  });

  it('places exactly the element the ghost drew, turns and all', () => {
    // The "must not jump on click" guarantee: the ghost the user aimed with
    // and the part the press creates come from the same builder.
    useStore.getState().setTool('opAmp');
    useStore.getState().turnTool();
    const r = refs();
    beginPointerGesture(down(), { x: 100, y: 100 }, useStore.getState(), null, false, r);

    const placed = useStore.getState().elements[0];
    const snapped = { x: snap(100, GRID_SIZE), y: snap(100, GRID_SIZE) };
    const { id: _id, ...stored } = placed;
    expect(stored).toEqual(makeGhostElement('opAmp', snapped.x, snapped.y, 1));
  });

  it('places the pre-ghost geometry when nothing has been turned', () => {
    useStore.getState().setTool('inductor');
    const r = refs();
    beginPointerGesture(down(), { x: 100, y: 100 }, useStore.getState(), null, false, r);

    const placed = useStore.getState().elements[0];
    const len = (defFor('inductor')?.defaultLength ?? DEFAULT_PLACEMENT_LENGTH) * GRID_SIZE;
    expect([placed.x1, placed.y1, placed.x2, placed.y2]).toEqual([96, 96, 96 + len, 96]);
  });
});

describe('the wire tool draws a run instead of placing a part', () => {
  // A wire is placed by its own rule: nothing lands on press, the run is 0, 1
  // or 2 wires, and it is never diagonal (model/wirePlacement.ts).
  const wireDrag = (from: { x: number; y: number }) => {
    useStore.getState().setTool('wire');
    const r = refs();
    beginPointerGesture(down(), from, useStore.getState(), null, false, r);
    return r;
  };

  it('arms a wire drag and adds nothing on press', () => {
    const r = wireDrag({ x: 100, y: 100 });
    expect(r.dragRef.current).toEqual({
      mode: 'wire',
      start: { x: 96, y: 96 },
      current: { x: 96, y: 96 },
      axis: null,
    });
    expect(useStore.getState().elements).toHaveLength(0);
  });

  it('inserts nothing for a press that never moved', () => {
    const r = wireDrag({ x: 100, y: 100 });
    finishWireDrag(r.dragRef.current, useStore.getState());
    expect(useStore.getState().elements).toHaveLength(0);
    // The tool still stands down, so a stray click does not leave it armed.
    expect(useStore.getState().tool).toBeNull();
  });

  it('inserts one wire for a straight drag', () => {
    const r = wireDrag({ x: 100, y: 100 });
    const drag = r.dragRef.current;
    if (drag.mode !== 'wire') throw new Error('expected a wire drag');
    finishWireDrag(
      { ...drag, current: { x: 224, y: 96 }, axis: 'h' },
      useStore.getState(),
    );
    const wires = useStore.getState().elements;
    expect(wires).toHaveLength(1);
    expect([wires[0].x1, wires[0].y1, wires[0].x2, wires[0].y2]).toEqual([96, 96, 224, 96]);
  });

  it('inserts an L of two wires for a diagonal drag, bending along the latched axis', () => {
    const r = wireDrag({ x: 100, y: 100 });
    const drag = r.dragRef.current;
    if (drag.mode !== 'wire') throw new Error('expected a wire drag');
    finishWireDrag(
      { ...drag, current: { x: 224, y: 160 }, axis: 'h' },
      useStore.getState(),
    );
    const wires = useStore.getState().elements;
    expect(wires).toHaveLength(2);
    expect(wires.every((w) => w.kind === 'wire')).toBe(true);
    // Across first, then down: the corner is on the latched axis.
    expect([wires[0].x1, wires[0].y1, wires[0].x2, wires[0].y2]).toEqual([96, 96, 224, 96]);
    expect([wires[1].x1, wires[1].y1, wires[1].x2, wires[1].y2]).toEqual([224, 96, 224, 160]);
    expect(useStore.getState().selectedIds).toEqual(wires.map((w) => w.id));
  });

  it('takes the whole L back in one undo', () => {
    const r = wireDrag({ x: 100, y: 100 });
    const drag = r.dragRef.current;
    if (drag.mode !== 'wire') throw new Error('expected a wire drag');
    finishWireDrag({ ...drag, current: { x: 224, y: 160 }, axis: 'v' }, useStore.getState());
    expect(useStore.getState().elements).toHaveLength(2);
    useStore.getState().undo();
    expect(useStore.getState().elements).toHaveLength(0);
  });

  it('splits a wire the run ends on, so the drop connects', () => {
    const crossed = useStore
      .getState()
      .addElement({ kind: 'wire', x1: 224, y1: 0, x2: 224, y2: 320, flags: 0, params: {} });
    const r = wireDrag({ x: 100, y: 100 });
    const drag = r.dragRef.current;
    if (drag.mode !== 'wire') throw new Error('expected a wire drag');
    finishWireDrag({ ...drag, current: { x: 224, y: 96 }, axis: 'h' }, useStore.getState());
    const elements = useStore.getState().elements;
    // The crossed wire is gone, replaced by its two halves, plus the new run.
    expect(elements.some((e) => e.id === crossed)).toBe(false);
    expect(elements).toHaveLength(3);
  });

  it('a run fully duplicated by existing wires leaves the old selection standing', () => {
    // Redrawing an existing connection across its junction drops every piece
    // as a parallel duplicate (upstream's hasDirectConnection), so the
    // gesture has no live id to select and must not clobber what was held.
    const st = useStore.getState();
    st.addElement({ kind: 'wire', x1: 0, y1: 0, x2: 80, y2: 0, flags: 0, params: {} });
    st.addElement({ kind: 'wire', x1: 80, y1: 0, x2: 160, y2: 0, flags: 0, params: {} });
    const stub = st.addElement({
      kind: 'wire',
      x1: 80,
      y1: 0,
      x2: 80,
      y2: -64,
      flags: 0,
      params: {},
    });
    useStore.getState().select([stub]);

    const r = wireDrag({ x: 4, y: 4 });
    const drag = r.dragRef.current;
    if (drag.mode !== 'wire') throw new Error('expected a wire drag');
    finishWireDrag({ ...drag, current: { x: 160, y: 0 }, axis: 'h' }, useStore.getState());

    const s = useStore.getState();
    expect(s.elements.filter((e) => e.kind === 'wire')).toHaveLength(3);
    expect(s.selectedIds).toEqual([stub]);
    for (const id of s.selectedIds) {
      expect(s.elements.some((e) => e.id === id)).toBe(true);
    }
  });
});

describe('finishPlacement splitting what the new part landed on', () => {
  // Upstream splits at both endpoints of the element it is about to add
  // (endDrag, MouseManager.java:1276-1280), so a part dropped across a wire or
  // onto another part's lead comes out connected instead of merely touching.
  const addWire = (x1: number, y1: number, x2: number, y2: number) =>
    useStore.getState().addElement({ kind: 'wire', x1, y1, x2, y2, flags: 0, params: {} });

  it('splits a wire a placed resistor ends on', () => {
    const crossed = addWire(96, 0, 96, 160);
    useStore.getState().setTool('resistor');
    const r = refs();
    beginPointerGesture(down(), { x: 100, y: 100 }, useStore.getState(), null, false, r);
    const drag = r.dragRef.current;
    if (drag.mode !== 'place') throw new Error('expected a placement to be armed');

    finishPlacement(drag, useStore.getState());

    const s = useStore.getState();
    expect(s.elements.some((e) => e.id === crossed)).toBe(false);
    const spans = s.elements.filter((e) => e.kind === 'wire').map((e) => [e.x1, e.y1, e.x2, e.y2]);
    expect(spans).toContainEqual([96, 0, 96, 96]);
    expect(spans).toContainEqual([96, 96, 96, 160]);
  });

  it('leaves a ground alone when only its free end lands on a wire', () => {
    // A ground's second point is a control point, not a terminal, so a drop
    // there connects nothing and must not split the wire under it.
    const crossed = addWire(0, 128, 192, 128);
    useStore.getState().setTool('ground');
    const r = refs();
    beginPointerGesture(down(), { x: 100, y: 100 }, useStore.getState(), null, false, r);
    const drag = r.dragRef.current;
    if (drag.mode !== 'place') throw new Error('expected a placement to be armed');

    finishPlacement(drag, useStore.getState());

    expect(useStore.getState().elements.some((e) => e.id === crossed)).toBe(true);
  });
});

describe('a long-press while a placement is armed', () => {
  // The hook drives exactly these pieces: the recognizer owns the clock and
  // validates its own timers, and the component's long-press timer callback
  // (scheduleTouchTimers in useCanvasInteractions.ts) runs its reaction through
  // the same exported openMenuAndAbandonForLongPress this suite calls, against
  // a fake dragRef and the real store.

  /** Fires the long-press timer at LONG_PRESS_MS and runs the component's
   *  reaction: the menu opens at the finger, then the armed drag is abandoned.
   *  The flat test view makes client and circuit points coincide. */
  const fireLongPress = ({ g, r }: ReturnType<typeof touchDownWithTool>) => {
    t = LONG_PRESS_MS;
    expect(g.timerFired('longPress')).toEqual([{ type: 'longPress' }]);
    openMenuAndAbandonForLongPress(
      r.dragRef,
      useStore.getState(),
      { client: PRESS, circuit: PRESS },
      null,
    );
  };

  it('stands the tool down, keeps the tap-placed part and spends no extra undo', () => {
    const h = touchDownWithTool('resistor');
    expect(useStore.getState().elements).toHaveLength(1);
    const baseline = useStore.getState().undoStack.length;

    fireLongPress(h);

    const s = useStore.getState();
    expect(s.tool).toBeNull();
    expect(s.elements).toHaveLength(1);
    expect(s.undoStack.length).toBe(baseline);
    expect(s.elementGesture).toBeNull();
    expect(h.r.dragRef.current).toEqual({ mode: 'none' });
  });

  it('deletes a placement dragged back to its anchor instead of stranding it', () => {
    const h = touchDownWithTool('resistor');
    const drag = h.r.dragRef.current;
    if (drag.mode !== 'place') throw new Error('expected a placement to be armed');
    useStore.getState().updateElement(drag.id, { x2: drag.start.x, y2: drag.start.y });
    const baseline = useStore.getState().undoStack.length;

    fireLongPress(h);

    const s = useStore.getState();
    expect(s.elements).toHaveLength(0);
    expect(s.tool).toBeNull();
    expect(s.undoStack.length).toBe(baseline);
  });

  it('disarms the wire tool and inserts no run', () => {
    const h = touchDownWithTool('wire');
    expect(h.r.dragRef.current.mode).toBe('wire');
    const baseline = useStore.getState().undoStack.length;

    fireLongPress(h);

    const s = useStore.getState();
    expect(s.tool).toBeNull();
    expect(s.elements).toHaveLength(0);
    expect(s.undoStack.length).toBe(baseline);
    expect(h.r.dragRef.current).toEqual({ mode: 'none' });
  });

  it('still opens the menu when no tool is armed', () => {
    const h = touchDownWithTool(null);

    fireLongPress(h);

    const s = useStore.getState();
    expect(s.contextMenu?.x).toBe(PRESS.x);
    expect(s.contextMenu?.y).toBe(PRESS.y);
    expect(s.contextMenu?.target).toBeNull();
    expect(s.elements).toHaveLength(0);
    expect(h.r.dragRef.current).toEqual({ mode: 'none' });
  });
});

describe('a second finger landing on an armed gesture', () => {
  // The twoFingerStart branch in useCanvasInteractions.ts: a placement in
  // flight owes its up-time cleanup, and (newer) a wire drag the first finger
  // armed must stand down, or the pinch ends silently armed.
  const landSecondFinger = ({ g, r }: ReturnType<typeof touchDownWithTool>) => {
    t = 100;
    expect(g.down(2, PRESS.x + 48, PRESS.y).actions).toEqual([{ type: 'twoFingerStart' }]);
    const drag = r.dragRef.current;
    if (drag.mode === 'place') finishPlacement(drag, useStore.getState());
    if (drag.mode === 'wire') finishWireDrag(drag, useStore.getState());
    r.dragRef.current = { mode: 'none' };
    useStore.getState().endElementGesture();
  };

  it('disarms a wire drag the first finger armed and inserts no run', () => {
    const h = touchDownWithTool('wire');
    expect(h.r.dragRef.current.mode).toBe('wire');
    const baseline = useStore.getState().undoStack.length;

    landSecondFinger(h);

    const s = useStore.getState();
    expect(s.tool).toBeNull();
    expect(s.elements).toHaveLength(0);
    expect(s.undoStack.length).toBe(baseline);
    expect(s.elementGesture).toBeNull();
    expect(h.r.dragRef.current).toEqual({ mode: 'none' });
    // The recognizer dropped the single-finger state with the pinch, so no
    // stale timer can fire into the abandoned gesture later.
    t = LONG_PRESS_MS + 100;
    expect(h.g.timerFired('longPress')).toEqual([]);
    expect(h.g.timerFired('dragDelay')).toEqual([]);
  });

  it('still finishes a placement dragged back to its anchor', () => {
    const h = touchDownWithTool('resistor');
    const drag = h.r.dragRef.current;
    if (drag.mode !== 'place') throw new Error('expected a placement to be armed');
    useStore.getState().updateElement(drag.id, { x2: drag.start.x, y2: drag.start.y });
    const baseline = useStore.getState().undoStack.length;

    landSecondFinger(h);

    const s = useStore.getState();
    expect(s.elements).toHaveLength(0);
    expect(s.tool).toBeNull();
    expect(s.undoStack.length).toBe(baseline);
  });
});

describe('a cancelled pointer on an armed gesture', () => {
  // The onPointerCancel branch in useCanvasInteractions.ts: the system took
  // the pointer away mid-gesture, the same early exit as a second finger, so
  // an armed placement or wire tool owes the same abandonment the long-press
  // runs (abandonForLongPress, minus its menu). A cancel is never a menu
  // trigger.
  const cancelWhileArmed = ({ g, r }: ReturnType<typeof touchDownWithTool>) => {
    expect(g.cancel()).toEqual([{ type: 'cancel' }]);
    abandonForLongPress(r.dragRef, useStore.getState());
  };

  it('deletes a placement dragged back to its anchor and stands the tool down', () => {
    const h = touchDownWithTool('resistor');
    const drag = h.r.dragRef.current;
    if (drag.mode !== 'place') throw new Error('expected a placement to be armed');
    useStore.getState().updateElement(drag.id, { x2: drag.start.x, y2: drag.start.y });
    const baseline = useStore.getState().undoStack.length;

    cancelWhileArmed(h);

    const s = useStore.getState();
    expect(s.elements).toHaveLength(0);
    expect(s.tool).toBeNull();
    expect(s.contextMenu).toBeNull();
    expect(s.undoStack.length).toBe(baseline);
  });

  it('disarms a wire drag and inserts no run', () => {
    const h = touchDownWithTool('wire');
    expect(h.r.dragRef.current.mode).toBe('wire');

    cancelWhileArmed(h);

    const s = useStore.getState();
    expect(s.tool).toBeNull();
    expect(s.elements).toHaveLength(0);
    expect(s.contextMenu).toBeNull();
    expect(h.r.dragRef.current).toEqual({ mode: 'none' });
  });

  it('with nothing armed is harmless and opens no menu', () => {
    const h = touchDownWithTool(null);
    expect(h.r.dragRef.current).toMatchObject({ mode: 'select' });

    cancelWhileArmed(h);

    const s = useStore.getState();
    expect(s.contextMenu).toBeNull();
    expect(h.r.dragRef.current).toEqual({ mode: 'none' });
    expect(s.elements).toHaveLength(0);
  });
});

describe('finishPlacement cancelling a collapsed drop', () => {
  // A drag that returns to its own anchor still collapses the part to a point,
  // which is the case this cancel exists for.
  it('one Ctrl+Z after the cancel restores the pre-placement circuit, not the stray element', () => {
    useStore.getState().setTool('resistor');
    const r = refs();
    const before = useStore.getState().undoStack.length;
    beginPointerGesture(down(), { x: 100, y: 100 }, useStore.getState(), null, false, r);
    const drag = r.dragRef.current;
    if (drag.mode !== 'place') throw new Error('expected a placement to be armed');
    expect(useStore.getState().elements).toHaveLength(1);
    // addElement's own commit is the gesture's only undo baseline so far.
    expect(useStore.getState().undoStack.length).toBe(before + 1);
    // The drag dragged the free end back onto the press anchor, exactly what
    // the place branch's pointer-move would have written.
    useStore.getState().updateElement(drag.id, { x2: drag.start.x, y2: drag.start.y });

    finishPlacement(drag, useStore.getState());

    // The cancel deleted the stray zero-length element...
    expect(useStore.getState().elements).toHaveLength(0);
    // ...without pushing a second undo entry on top of addElement's.
    expect(useStore.getState().undoStack.length).toBe(before + 1);

    useStore.getState().undo();
    // The one undo entry restores the pre-placement circuit; it must not
    // resurrect the just-deleted element.
    expect(useStore.getState().elements).toHaveLength(0);
  });

  it('rejects a single-post element collapsed to a point, not only multi-post', () => {
    // A ground is a single-post part (postCount 1), so the old guard that
    // checked postCount > 1 let it serialize at length 0. Dragging its free
    // end back onto the press anchor must still delete it.
    useStore.getState().setTool('ground');
    const r = refs();
    beginPointerGesture(down(), { x: 100, y: 100 }, useStore.getState(), null, false, r);
    const drag = r.dragRef.current;
    if (drag.mode !== 'place') throw new Error('expected a placement to be armed');
    useStore.getState().updateElement(drag.id, { x2: drag.start.x, y2: drag.start.y });

    finishPlacement(drag, useStore.getState());

    expect(useStore.getState().elements).toHaveLength(0);
  });

  it('keeps a point decoration placed at length 0', () => {
    // A drawn box has no terminals (postCount 0) and is drawn at a single
    // coordinate by design, so a zero-length placement is legal and must
    // survive finishPlacement.
    useStore.getState().setTool('box');
    const r = refs();
    beginPointerGesture(down(), { x: 100, y: 100 }, useStore.getState(), null, false, r);
    const drag = r.dragRef.current;
    if (drag.mode !== 'place') throw new Error('expected a placement to be armed');
    useStore.getState().updateElement(drag.id, { x2: drag.start.x, y2: drag.start.y });

    finishPlacement(drag, useStore.getState());

    const placed = useStore.getState().elements;
    expect(placed).toHaveLength(1);
    expect(placed[0].x1).toBe(placed[0].x2);
    expect(placed[0].y1).toBe(placed[0].y2);
  });
});

describe('pointer-down on a switch while paused', () => {
  it('inside the rect toggles, matching the keyboard path', () => {
    const id = addEl('switch');
    useStore.getState().setRunning(false);
    const r = refs();
    const before = useStore.getState().undoStack.length;
    beginPointerGesture(down(), { x: 80, y: -5 }, useStore.getState(), hit(id), false, r);
    expect(useStore.getState().elements[0].state).toBe(1);
    expect(r.dragRef.current).toEqual({ mode: 'none' });
    expect(useStore.getState().undoStack.length).toBe(before + 1);
    beginPointerGesture(down(), { x: 80, y: -5 }, useStore.getState(), hit(id), false, r);
    expect(useStore.getState().elements[0].state).toBe(0);
  });

  it('outside the rect on a lead still selects and arms move, without toggling', () => {
    const id = addEl('switch');
    useStore.getState().setRunning(false);
    const r = refs();
    beginPointerGesture(down(), { x: 30, y: 0 }, useStore.getState(), hit(id), false, r);
    expect(useStore.getState().elements[0].state).toBe(0);
    expect(useStore.getState().selectedIds).toEqual([id]);
    expect(r.dragRef.current).toEqual({ mode: 'move', ids: [id], last: { x: 30, y: 0 }, moved: false, gated: false });
  });

  it('ctrl while paused still arms dragpost', () => {
    const id = addEl('switch2');
    useStore.getState().setRunning(false);
    const r = refs();
    beginPointerGesture(down({ ctrlKey: true }), { x: 100, y: -5 }, useStore.getState(), hit(id), false, r);
    expect(r.dragRef.current?.mode).toBe('dragpost');
  });
});

describe('endpoint handle auto-grab', () => {
  // The default test view sits at scale 1, so the screen-pixel grab radius is
  // HIT_TOLERANCE_PX circuit units, and the test element spans (0,0)-(160,0).
  const reach = HIT_TOLERANCE_PX;

  it('a press inside the grab radius of an endpoint arms the post drag', () => {
    const id = addEl('resistor');
    const r = refs();
    beginPointerGesture(down(), { x: reach - 2, y: 0 }, useStore.getState(), hit(id), false, r);
    expect(r.dragRef.current).toMatchObject({ mode: 'dragpost', id, post: 1 });
    // The fixed end is the other one, the anchor drag-derived params measure from.
    expect(r.dragRef.current).toMatchObject({ start: { x: 160, y: 0 } });
  });

  it('a press near the far endpoint arms that end', () => {
    const id = addEl('resistor');
    const r = refs();
    beginPointerGesture(down(), { x: 160, y: reach - 2 }, useStore.getState(), hit(id), false, r);
    expect(r.dragRef.current).toMatchObject({ mode: 'dragpost', id, post: 2, start: { x: 0, y: 0 } });
  });

  it('a press on the body away from the endpoints still moves the whole element', () => {
    const id = addEl('resistor');
    const r = refs();
    beginPointerGesture(down(), { x: 80, y: 0 }, useStore.getState(), hit(id), false, r);
    expect(r.dragRef.current).toEqual({ mode: 'move', ids: [id], last: { x: 80, y: 0 }, moved: false, gated: false });
  });

  it('the grab is inclusive right at the radius and gives way to a move just past it', () => {
    const id = addEl('resistor');
    const at = refs();
    beginPointerGesture(down(), { x: reach, y: 0 }, useStore.getState(), hit(id), false, at);
    expect(at.dragRef.current).toMatchObject({ mode: 'dragpost', post: 1 });
    const past = refs();
    beginPointerGesture(down(), { x: reach + 0.001, y: 0 }, useStore.getState(), hit(id), false, past);
    expect(past.dragRef.current.mode).toBe('move');
  });

  it('the radius is a screen distance, so zooming in shrinks its reach in circuit units', () => {
    const id = addEl('resistor');
    const s = useStore.getState();
    s.setView({ ...s.view, scale: 2 });
    const r = refs();
    // Half the circuit-space reach at twice the zoom: what was a grab at scale
    // 1 is a body press now.
    beginPointerGesture(down(), { x: reach - 2, y: 0 }, useStore.getState(), hit(id), false, r);
    expect(r.dragRef.current.mode).toBe('move');
    const near = refs();
    beginPointerGesture(down(), { x: reach / 2, y: 0 }, useStore.getState(), hit(id), false, near);
    expect(near.dragRef.current).toMatchObject({ mode: 'dragpost', post: 1 });
  });

  it('ctrl still forces the post drag from the middle of the body', () => {
    const id = addEl('resistor');
    const r = refs();
    beginPointerGesture(down({ ctrlKey: true }), { x: 100, y: 0 }, useStore.getState(), hit(id), false, r);
    expect(r.dragRef.current).toMatchObject({ mode: 'dragpost', id, post: 2 });
  });

  it('a press inside a multi-element selection drags the group, not one endpoint', () => {
    const id = addEl('resistor');
    const other = addEl('resistor', { y1: 64, y2: 64 });
    useStore.getState().select([id, other]);
    const r = refs();
    beginPointerGesture(down(), { x: 0, y: 0 }, useStore.getState(), hit(id), false, r);
    expect(r.dragRef.current.mode).toBe('move');
    expect(useStore.getState().selectedIds).toEqual([id, other]);
  });

  it('a symbol too short to leave body between the grab zones is only ever moved whole', () => {
    // Both zones would swallow a 12-unit symbol, so it could never be picked
    // up; upstream's MINPOSTGRABSIZE guards the same case.
    const id = addEl('resistor', { x2: 12, y2: 0 });
    const r = refs();
    beginPointerGesture(down(), { x: 0, y: 0 }, useStore.getState(), hit(id), false, r);
    expect(r.dragRef.current.mode).toBe('move');
  });

  it('a part with a single draggable end never arms a handle', () => {
    const id = addEl('labeledNode', { x2: 32, y2: 0 });
    const r = refs();
    beginPointerGesture(down(), { x: 0, y: 0 }, useStore.getState(), hit(id), false, r);
    expect(r.dragRef.current.mode).toBe('move');
  });

  it('no handle is armed while a tool is armed or editing is off', () => {
    const id = addEl('resistor');
    useStore.getState().setTool('wire');
    expect(armedHandle({ x: 0, y: 0 }, hit(id), useStore.getState())).toBeNull();
    useStore.getState().setTool(null);
    expect(armedHandle({ x: 0, y: 0 }, hit(id), useStore.getState())).toBe(1);
    useStore.getState().updateSettings({ editable: false });
    expect(armedHandle({ x: 0, y: 0 }, hit(id), useStore.getState())).toBeNull();
  });
});

describe('finishPostDrag', () => {
  const addWire = (x1: number, y1: number, x2: number, y2: number) =>
    useStore.getState().addElement({ kind: 'wire', x1, y1, x2, y2, flags: 0, params: {} });

  const postDrag = (id: number, post: 1 | 2, moved = true): Drag => ({
    mode: 'dragpost',
    id,
    post,
    moved,
    start: { x: 0, y: 0 },
  });

  it('splits the wire the dropped post landed on, as one undo step with the drag', () => {
    const crossed = addWire(0, 0, 160, 0);
    const dragged = addWire(80, 80, 80, 80);
    // What the drag did: commit the baseline at pointer-down, then move post 2
    // onto the crossed wire's interior.
    useStore.getState().commit();
    useStore.getState().updateElement(dragged, { x2: 80, y2: 0 });
    const baseline = useStore.getState().undoStack.length;

    finishPostDrag(postDrag(dragged, 2), useStore.getState());

    const spans = useStore
      .getState()
      .elements.filter((e) => e.kind === 'wire')
      .map((e) => [e.x1, e.y1, e.x2, e.y2]);
    expect(spans).toContainEqual([0, 0, 80, 0]);
    expect(spans).toContainEqual([80, 0, 160, 0]);
    expect(useStore.getState().undoStack.length).toBe(baseline);

    useStore.getState().undo();
    const s = useStore.getState();
    expect(s.elements).toHaveLength(2);
    expect(s.elements.find((e) => e.id === crossed)).toMatchObject({ x2: 160, y2: 0 });
    expect(s.elements.find((e) => e.id === dragged)).toMatchObject({ x2: 80, y2: 80 });
  });

  it('splits nothing when the post never moved', () => {
    addWire(0, 0, 160, 0);
    const dragged = addWire(80, 80, 80, 0);

    finishPostDrag(postDrag(dragged, 2, false), useStore.getState());

    expect(useStore.getState().elements).toHaveLength(2);
  });

  it('splits nothing for a whole-element move or a sweep', () => {
    addWire(0, 0, 160, 0);
    addWire(80, 80, 80, 0);

    finishPostDrag({ mode: 'move', ids: [], last: { x: 80, y: 0 }, moved: true }, useStore.getState());

    expect(useStore.getState().elements).toHaveLength(2);
  });

  it('ignores a rail free end, which is a control point and not a post', () => {
    // A rail's post is its (x1,y1) end; the far end carries the symbol and no
    // terminal, so dropping it on a wire connects nothing to split.
    addWire(160, -80, 160, 80);
    const rail = useStore.getState().addElement({
      kind: 'rail',
      x1: 0,
      y1: 0,
      x2: 160,
      y2: 0,
      flags: 0,
      params: {},
    });

    finishPostDrag(postDrag(rail, 2), useStore.getState());

    expect(useStore.getState().elements).toHaveLength(2);
  });

  it('reverts a drag that collapsed the element instead of splitting', () => {
    addWire(0, 0, 160, 0);
    const dragged = addWire(80, 80, 80, 80);
    useStore.getState().commit();
    useStore.getState().updateElement(dragged, { x1: 80, y1: 0, x2: 80, y2: 0 });

    finishPostDrag(postDrag(dragged, 2), useStore.getState());

    const s = useStore.getState();
    // The collapse is undone whole, and the crossed wire is left unsplit.
    expect(s.elements.filter((e) => e.kind === 'wire')).toHaveLength(2);
    expect(s.elements.find((e) => e.id === dragged)).toMatchObject({ y1: 80, y2: 80 });
    expect(s.status).toMatch(/collapsed/);
  });
});

describe('selection semantics on pointer-down', () => {
  /** Two parts on separate rows, so a box can cover one without the other. */
  const twoParts = () => ({
    top: addEl('resistor'),
    bottom: addEl('resistor', { y1: 64, y2: 64 }),
  });

  it('a plain click selects only the element under the pointer', () => {
    const { top, bottom } = twoParts();
    useStore.getState().select([bottom]);
    beginPointerGesture(down(), { x: 80, y: 0 }, useStore.getState(), hit(top), false, refs());
    expect(useStore.getState().selectedIds).toEqual([top]);
  });

  it('shift+click does not add the element to the selection', () => {
    const { top, bottom } = twoParts();
    useStore.getState().select([bottom]);
    // Upstream has no shift+click multi-select; shift only makes the rubber
    // band additive, so a shift+click is just a click.
    beginPointerGesture(
      down({ shiftKey: true }),
      { x: 80, y: 0 },
      useStore.getState(),
      hit(top),
      false,
      refs(),
    );
    expect(useStore.getState().selectedIds).toEqual([top]);
  });

  it('shift+click on an already selected element leaves the group intact', () => {
    const { top, bottom } = twoParts();
    useStore.getState().select([top, bottom]);
    // No toggle: clicking a member of the group must not drop it, or a
    // shift-dragged group would lose the part you grabbed it by.
    beginPointerGesture(
      down({ shiftKey: true }),
      { x: 80, y: 0 },
      useStore.getState(),
      hit(top),
      false,
      refs(),
    );
    expect(useStore.getState().selectedIds).toEqual([top, bottom]);
  });

  it('ctrl+click still adds, the port gesture that also arms a post drag', () => {
    const { top, bottom } = twoParts();
    useStore.getState().select([bottom]);
    const r = refs();
    beginPointerGesture(
      down({ ctrlKey: true }),
      { x: 20, y: 0 },
      useStore.getState(),
      hit(top),
      false,
      r,
    );
    expect(useStore.getState().selectedIds).toEqual([bottom, top]);
    expect(r.dragRef.current.mode).toBe('dragpost');
  });

  it('a press on empty canvas clears the selection and arms a replacing box', () => {
    const { top } = twoParts();
    useStore.getState().select([top]);
    const r = refs();
    beginPointerGesture(down(), { x: 400, y: 400 }, useStore.getState(), null, false, r);
    expect(useStore.getState().selectedIds).toEqual([]);
    expect(r.dragRef.current).toMatchObject({ mode: 'select', shift: false });
  });

  it('a shift press on empty canvas keeps the selection and arms an additive box', () => {
    const { top } = twoParts();
    useStore.getState().select([top]);
    const r = refs();
    beginPointerGesture(
      down({ shiftKey: true }),
      { x: 400, y: 400 },
      useStore.getState(),
      null,
      false,
      r,
    );
    expect(useStore.getState().selectedIds).toEqual([top]);
    expect(r.dragRef.current).toMatchObject({ mode: 'select', shift: true });
  });

  it('the additive box unions the earlier selection with what it covers', () => {
    const { top, bottom } = twoParts();
    useStore.getState().select([top]);
    const r = refs();
    beginPointerGesture(
      down({ shiftKey: true }),
      { x: -8, y: 48 },
      useStore.getState(),
      null,
      false,
      r,
    );
    const drag = r.dragRef.current;
    if (drag.mode !== 'select') throw new Error('expected a box drag');
    // What the pointer-up does with the armed box: the same call the canvas
    // hook makes, so the shift flag is checked end to end (selectArea's `add`).
    const state = useStore.getState();
    const inside = selectByBox(
      state.elements,
      boxFromPoints(drag.start, { x: 200, y: 80 }),
      drag.shift,
      state.selectedIds,
    );
    expect(inside).toEqual([top, bottom]);
  });

  it('a plain box replaces the earlier selection', () => {
    const { top, bottom } = twoParts();
    useStore.getState().select([top]);
    const r = refs();
    beginPointerGesture(down(), { x: -8, y: 48 }, useStore.getState(), null, false, r);
    const drag = r.dragRef.current;
    if (drag.mode !== 'select') throw new Error('expected a box drag');
    const state = useStore.getState();
    const inside = selectByBox(
      state.elements,
      boxFromPoints(drag.start, { x: 200, y: 80 }),
      drag.shift,
      state.selectedIds,
    );
    expect(inside).toEqual([bottom]);
  });
});

describe('arming the store gesture flag', () => {
  // The flag is what lets a Space rotate mid-drag fold into the gesture's own
  // undo entry, and what tells the placement's pointer-move to re-apply the
  // banked turns. Only the two modes that hold a real element raise it.
  it('a placement arm raises a place gesture with no turns banked yet', () => {
    useStore.getState().setTool('resistor');
    const r = refs();
    beginPointerGesture(down(), { x: 100, y: 100 }, useStore.getState(), null, false, r);
    expect(r.dragRef.current.mode).toBe('place');
    expect(useStore.getState().elementGesture).toEqual({ kind: 'place', placeTurns: 0 });
  });

  it('a move arm raises a move gesture', () => {
    const id = addEl('resistor');
    const r = refs();
    beginPointerGesture(down(), { x: 80, y: 0 }, useStore.getState(), hit(id), false, r);
    expect(r.dragRef.current.mode).toBe('move');
    expect(useStore.getState().elementGesture).toEqual({ kind: 'move', placeTurns: 0 });
  });

  it('an endpoint drag leaves it null, because a turn there has no meaning', () => {
    // The next pointer-move drags that post straight back to the cursor, so a
    // rotate would be erased; Space falls through to the settled path instead.
    const id = addEl('resistor');
    const r = refs();
    beginPointerGesture(down({ ctrlKey: true }), { x: 80, y: 0 }, useStore.getState(), hit(id), false, r);
    expect(r.dragRef.current.mode).toBe('dragpost');
    expect(useStore.getState().elementGesture).toBeNull();
  });

  it('a rubber band, a pan and a row sweep all leave it null', () => {
    const id = addEl('resistor');
    const band = refs();
    beginPointerGesture(down(), { x: 400, y: 400 }, useStore.getState(), null, false, band);
    expect(band.dragRef.current.mode).toBe('select');
    expect(useStore.getState().elementGesture).toBeNull();

    const pan = refs();
    beginPointerGesture(down({ altKey: true }), { x: 400, y: 400 }, useStore.getState(), null, false, pan);
    expect(pan.dragRef.current.mode).toBe('pan');
    expect(useStore.getState().elementGesture).toBeNull();

    const row = refs();
    beginPointerGesture(
      down({ altKey: true, shiftKey: true }),
      { x: 0, y: 0 },
      useStore.getState(),
      hit(id),
      false,
      row,
    );
    expect(row.dragRef.current.mode).toBe('rowcol');
    expect(useStore.getState().elementGesture).toBeNull();
  });
});

describe('a right-click while a move drag is armed', () => {
  /** Three parts on separate rows, so a click can land on one without the
   *  other two. */
  const threeParts = () => ({
    a: addEl('resistor'),
    b: addEl('resistor', { y1: 64, y2: 64 }),
    c: addEl('resistor', { y1: 128, y2: 128 }),
  });

  /** The pointer-move body for a move drag: the same helper the canvas hook's
   *  move case runs, fed the drag the pointer-down armed. */
  const feedMove = (drag: Drag, p: Point) => {
    if (drag.mode !== 'move') throw new Error('expected a move to be armed');
    stepMoveDrag(drag, p, useStore.getState());
  };

  it('moves translate the frozen group and the clicked target does not join', () => {
    // Rubber-band A+B, press A and drag, then barrel-click C without
    // releasing: upstream never re-selects on a non-left button mid-drag
    // (MouseManager.java:1071-1075), so C must ride along as nothing.
    const { a, b, c } = threeParts();
    useStore.getState().select([a, b]);
    const r = refs();
    beginPointerGesture(down(), { x: 80, y: 0 }, useStore.getState(), hit(a), false, r);
    useStore.getState().openContextMenu(10, 20, c, { x: 0, y: 0 });

    // The menu opens for C but the group the drag armed with stays selected,
    // and the frozen list carries the move.
    expect(useStore.getState().contextMenu?.target).toBe(c);
    expect(useStore.getState().selectedIds).toEqual([a, b]);
    feedMove(r.dragRef.current, { x: 96, y: 0 }); // one grid cell right

    expect(hit(a)).toMatchObject({ x1: 16, y1: 0, x2: 176, y2: 0 });
    expect(hit(b)).toMatchObject({ x1: 16, y1: 64, x2: 176, y2: 64 });
    expect(hit(c)).toMatchObject({ x1: 0, y1: 128, x2: 160, y2: 128 });
  });

  it('keeps dragging the group the press froze even if a command re-selects mid-gesture', () => {
    // The freeze is not only about right-clicks: any programmatic selection
    // change while the hand is down must not steal an in-flight group drag.
    const { a, b, c } = threeParts();
    useStore.getState().select([a, b]);
    const r = refs();
    beginPointerGesture(down(), { x: 80, y: 0 }, useStore.getState(), hit(a), false, r);
    useStore.getState().select([c]);

    feedMove(r.dragRef.current, { x: 96, y: 0 });

    expect(hit(a)).toMatchObject({ x1: 16, x2: 176 });
    expect(hit(b)).toMatchObject({ x1: 16, x2: 176 });
    expect(hit(c)).toMatchObject({ x1: 0, x2: 160 });
  });

  it('a rowcol sweep still rides its captured endpoints when the menu re-selects', () => {
    // rowcol freezes its captured posts at pointer-down and raises no gesture
    // flag, so today's select-alone rule applies and must not disturb the
    // sweep: the captured list, not the live selection, drives the moves.
    const a = addEl('resistor');
    const b = addEl('resistor', { y1: 64, y2: 64 });
    const c = addEl('resistor', { x1: 32, y1: 128, x2: 192, y2: 128 });
    const r = refs();
    startRowCol('col', { x: 0, y: 0 }, useStore.getState(), r.dragRef);
    const drag = r.dragRef.current;
    if (drag.mode !== 'rowcol') throw new Error('expected a col sweep');

    useStore.getState().openContextMenu(10, 20, c, { x: 0, y: 0 });
    // No gesture flag here, so the rewrite happens exactly as before.
    expect(useStore.getState().selectedIds).toEqual([c]);

    // The hook's rowcol consumption: along-axis delta per captured endpoint.
    for (const cap of drag.captured) useStore.getState().movePoint(cap.id, cap.post, 16, 0);

    expect(hit(a)).toMatchObject({ x1: 16, x2: 160 });
    expect(hit(b)).toMatchObject({ x1: 16, x2: 160 });
    expect(hit(c)).toMatchObject({ x1: 32, x2: 192 });
  });
});

describe('placementPoint', () => {
  const start = { x: 0, y: 0 };

  it('follows the cursor untouched when no turn is banked', () => {
    expect(placementPoint(start, { x: 160, y: 0 }, 0, baseEl('resistor'))).toEqual({
      x2: 160,
      y2: 0,
    });
  });

  it('turns the cursor-derived end about the anchor, a quarter per banked turn', () => {
    const e = baseEl('resistor');
    expect(placementPoint(start, { x: 160, y: 0 }, 1, e)).toEqual({ x2: 0, y2: -160 });
    expect(placementPoint(start, { x: 160, y: 0 }, 2, e)).toEqual({ x2: -160, y2: 0 });
    expect(placementPoint(start, { x: 160, y: 0 }, 3, e)).toEqual({ x2: 0, y2: 160 });
    // The cursor sets the length and the drag axis; the banked turns set the
    // orientation on top of it, so the part points away from the cursor.
    expect(placementPoint(start, { x: 160, y: 0 }, 4, e)).toEqual({ x2: 160, y2: 0 });
  });

  it('snaps the turned point to the dominant axis, not the raw cursor', () => {
    // A multi-post part must never land diagonal. Turning after the snap would
    // reintroduce the diagonal, so the order is asserted here: the cursor is
    // 160 across and 48 down, and one turn makes the strong component vertical.
    const opamp = baseEl('opamp');
    expect(placementPoint(start, { x: 160, y: 48 }, 0, opamp)).toEqual({ x2: 160, y2: 0 });
    expect(placementPoint(start, { x: 160, y: 48 }, 1, opamp)).toEqual({ x2: 0, y2: -160 });
  });

  it('takes a drag-derived width from the turned point, not the unturned cursor', () => {
    // The wattmeter's width is the weaker drag component (WattmeterElm.java:
    // 75-89). With one turn banked the weak component has changed axis, so a
    // width read before the turn would be the length instead.
    const w = baseEl('wattmeter');
    expect(placementPoint(start, { x: 160, y: 32 }, 0, w).extra).toEqual({ width: 32 });
    // One turn maps (160,32) to (32,-160): the weak component is now x, and
    // its magnitude is unchanged, which is exactly the invariance a rotation
    // owes. Reading dragParams after the axis snap would report 16 instead.
    expect(placementPoint(start, { x: 160, y: 32 }, 1, w).extra).toEqual({ width: 32 });
  });

  it('omits extra entirely for a part with no drag-derived params', () => {
    // The caller keys "did anything change" off `extra === undefined`, so a
    // plain part must not hand back an empty object.
    expect(placementPoint(start, { x: 160, y: 0 }, 1, baseEl('resistor')).extra).toBeUndefined();
  });
});
