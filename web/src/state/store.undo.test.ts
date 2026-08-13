import { beforeEach, describe, expect, it } from 'vitest';
import { postPatch } from '../render/geometry';
import { hasUnsavedChanges, useStore } from './store';
import { addCapacitor, addResistor, fresh } from './store.test-helpers';

beforeEach(() => useStore.setState(fresh()));

describe('ctrl-drag post movement undo', () => {
  it('collapses a multi-move post drag into one undo step', () => {
    const id = addResistor();
    const original = useStore.getState().elements[0];
    const commitsBefore = useStore.getState().undoStack.length;
    useStore.getState().commit();
    // Simulate pointer-move events for the dragged post.
    for (const [x, y] of [
      [16, 0],
      [32, 16],
      [48, 0],
    ]) {
      useStore.getState().updateElement(id, postPatch(2, x, y));
    }
    const dragged = useStore.getState().elements[0];
    expect(dragged.x2).toBe(48);
    expect(dragged.y2).toBe(0);
    expect(dragged.x1).toBe(original.x1);
    expect(dragged.y1).toBe(original.y1);
    // updateElement never pushes undo entries, so the single commit is the
    // whole drag: one undo restores the original geometry.
    expect(useStore.getState().undoStack.length).toBe(commitsBefore + 1);
    useStore.getState().undo();
    expect(useStore.getState().elements[0]).toEqual(original);
  });

  it('rolls back a drag that collapsed the element to a point', () => {
    const id = addResistor();
    const original = useStore.getState().elements[0];
    useStore.getState().commit();
    // The pointer-up handler detects the zero-length result and undoes.
    useStore.getState().updateElement(id, postPatch(2, 0, 0));
    expect(useStore.getState().elements[0].x2).toBe(0);
    expect(useStore.getState().elements[0].y2).toBe(0);
    useStore.getState().undo();
    expect(useStore.getState().elements[0]).toEqual(original);
  });

  it('a rail free-end ctrl-drag moves only the control point, one undo step', () => {
    // The canvas handler enters dragpost with post 2 when ctrl-dragging the
    // far end (its draggablePosts is 2), so each move writes postPatch(2, ...)
    // and never touches the connection post.
    const id = useStore.getState().addElement({
      kind: 'rail',
      x1: 0,
      y1: 0,
      x2: 32,
      y2: 0,
      flags: 0,
      params: {},
    });
    const original = useStore.getState().elements[0];
    const commitsBefore = useStore.getState().undoStack.length;
    useStore.getState().commit();
    for (const [x, y] of [
      [48, 16],
      [64, 48],
    ]) {
      useStore.getState().updateElement(id, postPatch(2, x, y));
    }
    const dragged = useStore.getState().elements[0];
    expect(dragged.x2).toBe(64);
    expect(dragged.y2).toBe(48);
    expect(dragged.x1).toBe(original.x1);
    expect(dragged.y1).toBe(original.y1);
    expect(useStore.getState().undoStack.length).toBe(commitsBefore + 1);
    useStore.getState().undo();
    expect(useStore.getState().elements[0]).toEqual(original);
  });
});

describe('context menu state', () => {
  it('openContextMenu stores coordinates, the circuit point and an element target', () => {
    useStore.getState().openContextMenu(10, 20, 7, { x: 3, y: 4 });
    expect(useStore.getState().contextMenu).toEqual({ x: 10, y: 20, target: 7, circuit: { x: 3, y: 4 } });
  });

  it('openContextMenu over empty canvas stores a null target', () => {
    useStore.getState().openContextMenu(5, 6, null, { x: 0, y: 0 });
    expect(useStore.getState().contextMenu).toEqual({ x: 5, y: 6, target: null, circuit: { x: 0, y: 0 } });
  });

  it('closeContextMenu clears it', () => {
    useStore.getState().openContextMenu(10, 20, 7, { x: 3, y: 4 });
    useStore.getState().closeContextMenu();
    expect(useStore.getState().contextMenu).toBeNull();
  });

  it('opening twice replaces rather than stacks', () => {
    useStore.getState().openContextMenu(10, 20, 1, { x: 0, y: 0 });
    useStore.getState().openContextMenu(30, 40, null, { x: 9, y: 8 });
    expect(useStore.getState().contextMenu).toEqual({ x: 30, y: 40, target: null, circuit: { x: 9, y: 8 } });
  });

  it('right-clicking an element outside the selection selects it alone', () => {
    const a = addResistor();
    const b = addCapacitor();
    useStore.getState().select([b]);
    useStore.getState().openContextMenu(10, 20, a, { x: 0, y: 0 });
    expect(useStore.getState().selectedIds).toEqual([a]);
    expect(useStore.getState().contextMenu?.target).toBe(a);
  });

  it('right-clicking an element already selected keeps the whole selection', () => {
    const a = addResistor();
    const b = addCapacitor();
    useStore.getState().select([a, b]);
    useStore.getState().openContextMenu(10, 20, a, { x: 0, y: 0 });
    expect(useStore.getState().selectedIds).toEqual([a, b]);
  });

  it('right-clicking empty canvas leaves the selection untouched', () => {
    const a = addResistor();
    useStore.getState().select([a]);
    useStore.getState().openContextMenu(10, 20, null, { x: 0, y: 0 });
    expect(useStore.getState().selectedIds).toEqual([a]);
    expect(useStore.getState().contextMenu?.target).toBeNull();
  });

  it('selectAll selects every element', () => {
    addResistor();
    addCapacitor();
    useStore.getState().selectAll();
    expect(useStore.getState().selectedIds).toHaveLength(2);
  });
});

describe('unsaved-changes guard', () => {
  const SAMPLE = `$ 1 0.000005 10.2 50 5 43 5e-11
r 176 96 384 96 0 1000
`;

  const loadSample = () => useStore.getState().loadNetlist(SAMPLE);

  /** True when the current circuit differs from the last export baseline. */
  const dirty = () => {
    const s = useStore.getState();
    return hasUnsavedChanges(s.lastSaved, s.toNetlist());
  };

  it('a fresh load is clean', () => {
    loadSample();
    expect(dirty()).toBe(false);
  });

  it('save then edit dirties', () => {
    loadSample();
    useStore.getState().markSaved();
    addResistor();
    expect(dirty()).toBe(true);
  });

  it('save after editing cleans', () => {
    loadSample();
    addResistor();
    useStore.getState().markSaved();
    expect(dirty()).toBe(false);
  });

  it('undo to the saved state is clean', () => {
    loadSample();
    useStore.getState().markSaved();
    addResistor();
    expect(dirty()).toBe(true);
    useStore.getState().undo();
    expect(dirty()).toBe(false);
  });

  it('serialised settings dirty, display-only ones do not', () => {
    loadSample();
    useStore.getState().markSaved();
    useStore.getState().updateSettings({ timeStep: 1e-5 });
    expect(dirty()).toBe(true);
    useStore.getState().markSaved();
    useStore.getState().updateSettings({ showGrid: false });
    expect(dirty()).toBe(false);
  });

  it('newCircuit is clean', () => {
    loadSample();
    useStore.getState().newCircuit();
    expect(dirty()).toBe(false);
  });

  it('null baseline never warns', () => {
    expect(hasUnsavedChanges(null, 'anything')).toBe(false);
  });
});
