import { beforeEach, describe, expect, it } from 'vitest';
import { defFor } from '../../model/registry';
import { SWITCH_IEC } from '../../model/registry/flags';
import { rectContains } from '../../model/registry/shared';
import { GRID_SIZE } from '../../model/types';
import type { CircuitElement } from '../../model/types';
import { snap, useStore } from '../../state/store';
import { fresh } from '../../state/store.test-helpers';
import {
  beginPointerGesture,
  finishPlacement,
  finishPostDrag,
  releaseHeldMomentary,
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

describe('switchRect geometry', () => {
  it('a plain switch covers the body, the open tip and the closed lever', () => {
    const rect = defFor('switch')!.switchRect!(baseEl('switch'));
    // The union of the body and both lever positions, grown by one contact
    // stroke width. The closed lever rides 2 units on the lift side, so the
    // box must not hug the axis (SwitchElm.java:118-132).
    expect(rect).toEqual({ x: 60, y: -20, w: 40, h: 24 });
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
    // The fan of the pivot lead and the first and last throw poles, grown by
    // one contact stroke width (Switch2Elm.java:121-123).
    expect(rect).toEqual({ x: 60, y: -20, w: 40, h: 40 });
    expect(rectContains(rect, { x: 64, y: 0 })).toBe(true); // pivot lead1
    expect(rectContains(rect, { x: 96, y: -16 })).toBe(true); // throw pole 0
    expect(rectContains(rect, { x: 96, y: 16 })).toBe(true); // last throw pole
    expect(rectContains(rect, { x: 96, y: 0 })).toBe(true); // center-off rest, lead2
    expect(rectContains(rect, { x: 96, y: -15 })).toBe(true); // the lever on a throw
    expect(rectContains(rect, { x: 30, y: 0 })).toBe(false);
  });

  it('an SPDT click box is position-independent for center-off', () => {
    const rect = defFor('switch2')!.switchRect!(baseEl('switch2'));
    const centered = defFor('switch2')!.switchRect!(
      baseEl('switch2', { state: 2, params: { position: 2, momentary: 0, throwCount: 2 } }),
    );
    expect(centered).toEqual(rect);
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
    expect(r.dragRef.current).toEqual({ mode: 'move', last: { x: 30, y: 0 }, moved: false, gated: false });
  });

  it('a press outside the rect leads to a real move', () => {
    const id = addEl('switch');
    const r = refs();
    beginPointerGesture(down(), { x: 30, y: 0 }, useStore.getState(), hit(id), false, r);
    const drag = r.dragRef.current;
    if (drag.mode !== 'move') throw new Error('expected a move to be armed');
    // The move handler snap-deltas against the last point, then moves the
    // selected group (useCanvasInteractions.ts:529-542).
    const state = useStore.getState();
    const gx = snap(46, GRID_SIZE) - snap(drag.last.x, GRID_SIZE);
    const gy = snap(32, GRID_SIZE) - snap(drag.last.y, GRID_SIZE);
    state.moveElements(state.selectedIds, gx, gy);
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

  it('outside the fan selects and arms move, without toggling', () => {
    const id = addEl('switch2');
    const r = refs();
    beginPointerGesture(down(), { x: 30, y: 0 }, useStore.getState(), hit(id), false, r);
    expect(useStore.getState().elements[0].state).toBe(0);
    expect(useStore.getState().selectedIds).toEqual([id]);
    expect(r.dragRef.current).toEqual({ mode: 'move', last: { x: 30, y: 0 }, moved: false, gated: false });
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
    expect(r.dragRef.current).toEqual({ mode: 'move', last: { x: 30, y: 0 }, moved: false, gated: true });
  });
});

describe('finishPlacement cancelling a zero-length drop', () => {
  // The resistor tool has no defaultLength, so a pointer-down with no drag
  // already places it at zero length; the drop lands back on its own start
  // point with no move needed. Single-click and double-tap both funnel their
  // cancel through this one finishPlacement, so one test covers both triggers.
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
    expect(r.dragRef.current).toEqual({ mode: 'move', last: { x: 30, y: 0 }, moved: false, gated: false });
  });

  it('ctrl while paused still arms dragpost', () => {
    const id = addEl('switch2');
    useStore.getState().setRunning(false);
    const r = refs();
    beginPointerGesture(down({ ctrlKey: true }), { x: 100, y: -5 }, useStore.getState(), hit(id), false, r);
    expect(r.dragRef.current?.mode).toBe('dragpost');
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

    finishPostDrag({ mode: 'move', last: { x: 80, y: 0 }, moved: true }, useStore.getState());

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
