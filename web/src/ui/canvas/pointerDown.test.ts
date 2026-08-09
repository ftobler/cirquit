import { beforeEach, describe, expect, it } from 'vitest';
import { defFor } from '../../model/registry';
import { rectContains } from '../../model/registry/shared';
import { GRID_SIZE } from '../../model/types';
import type { CircuitElement } from '../../model/types';
import { snap, useStore } from '../../state/store';
import { fresh } from '../../state/store.test-helpers';
import {
  beginPointerGesture,
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
  it('a plain switch covers the body and the open handle, not the leads', () => {
    const rect = defFor('switch')!.switchRect!(baseEl('switch'));
    expect(rect).toEqual({ x: 64, y: -16, w: 32, h: 16 });
    expect(rectContains(rect, { x: 80, y: -5 })).toBe(true);
    expect(rectContains(rect, { x: 64, y: 0 })).toBe(true);
    expect(rectContains(rect, { x: 64, y: -16 })).toBe(true);
    expect(rectContains(rect, { x: 30, y: 0 })).toBe(false); // left lead
    expect(rectContains(rect, { x: 120, y: 0 })).toBe(false); // right lead
    expect(rectContains(rect, { x: 80, y: 4 })).toBe(false); // below the axis
  });

  it('an SPDT covers the fan between its first and last throw poles', () => {
    const rect = defFor('switch2')!.switchRect!(baseEl('switch2'));
    expect(rect).toEqual({ x: 64, y: -16, w: 32, h: 32 });
    expect(rectContains(rect, { x: 96, y: -16 })).toBe(true);
    expect(rectContains(rect, { x: 96, y: 16 })).toBe(true);
    expect(rectContains(rect, { x: 80, y: 0 })).toBe(true);
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
    expect(r.dragRef.current).toEqual({ mode: 'dragpost', id, post: 2, moved: false, gated: false });
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
    expect(r.dragRef.current).toEqual({ mode: 'dragpost', id, post: 1, moved: false, gated: false });
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

describe('edit mode', () => {
  it('a press inside the rect selects and arms move instead of toggling', () => {
    const id = addEl('switch');
    useStore.getState().setRunning(false);
    const r = refs();
    beginPointerGesture(down(), { x: 80, y: -5 }, useStore.getState(), hit(id), false, r);
    expect(useStore.getState().elements[0].state).toBe(0);
    expect(useStore.getState().selectedIds).toEqual([id]);
    expect(r.dragRef.current).toEqual({ mode: 'move', last: { x: 80, y: -5 }, moved: false, gated: false });
  });

  it('ctrl in edit mode still arms dragpost', () => {
    const id = addEl('switch2');
    useStore.getState().setRunning(false);
    const r = refs();
    beginPointerGesture(down({ ctrlKey: true }), { x: 100, y: -5 }, useStore.getState(), hit(id), false, r);
    expect(r.dragRef.current?.mode).toBe('dragpost');
  });
});
