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

describe('scope raw snapshot isolation', () => {
  const NETLIST = [
    '$ 1 0.000005 10 50 5 50 5e-11',
    'r 0 0 16 0 0 100',
    'o 0 64 0 266244 20 0.05 0 1 1 Ac\\sCoupled',
    '',
  ].join('\n');

  it('an in-place push to a live scope raw after a commit does not corrupt the undo snapshot', () => {
    useStore.getState().loadNetlist(NETLIST);
    const scope = useStore.getState().scopes[0];
    const original = [...scope.raw!];
    useStore.getState().commit();
    // The hypothetical future mutator writes raw in place, so the snapshot's
    // clone must not share the array.
    scope.raw!.push('extra');
    useStore.getState().undo();
    expect(useStore.getState().scopes[0].raw).toEqual(original);
  });
});

describe('scope family undo-restore', () => {
  // The five structural mutators commit() themselves (addScope store.ts:1386,
  // removeScope store.ts:1445, togglePlot store.ts:1568, combineScopes
  // store.ts:1601, separateScope store.ts:1618) and so do the six fast-path
  // setters (setScopeSpeed/Trigger/Flags, setPlotCoupling/ManScale/ManPosition):
  // item 21 decided they are ordinary property edits and must be undoable as
  // their own step. One undo after each restores the exact pre-mutation
  // snapshot, so the tests below call the setter without an explicit commit.

  const scoped = () => {
    const a = addResistor();
    const b = addResistor();
    useStore.getState().addScope(a, 'voltage');
    return { a, b };
  };

  it('addScope: undo restores the pre-add scope list', () => {
    const { b } = scoped();
    const pre = useStore.getState().scopes;
    const preElements = useStore.getState().elements;

    useStore.getState().addScope(b, 'current');
    expect(useStore.getState().scopes).toHaveLength(2);

    useStore.getState().undo();
    const s = useStore.getState();
    expect(s.scopes).toEqual(pre);
    expect(s.elements).toEqual(preElements);
  });

  it('removeScope: undo restores the removed scope', () => {
    scoped();
    const pre = useStore.getState().scopes;
    const preElements = useStore.getState().elements;

    useStore.getState().removeScope(useStore.getState().scopes[0].id);
    expect(useStore.getState().scopes).toHaveLength(0);

    useStore.getState().undo();
    const s = useStore.getState();
    expect(s.scopes).toEqual(pre);
    expect(s.elements).toEqual(preElements);
  });

  it('togglePlot: undo restores the toggled companion plot', () => {
    scoped();
    const scopeId = useStore.getState().scopes[0].id;
    const pre = useStore.getState().scopes;

    useStore.getState().togglePlot(scopeId, 'current');
    expect(useStore.getState().scopes[0].plots).toHaveLength(1);

    useStore.getState().undo();
    expect(useStore.getState().scopes).toEqual(pre);
    expect(useStore.getState().scopes[0].plots).toHaveLength(2);
  });

  it('combineScopes: undo restores both scopes', () => {
    const { b } = scoped();
    useStore.getState().addScope(b, 'current');
    const [sa, sb] = useStore.getState().scopes;
    const pre = useStore.getState().scopes;

    useStore.getState().combineScopes(sa.id, sb.id);
    expect(useStore.getState().scopes).toHaveLength(1);

    useStore.getState().undo();
    expect(useStore.getState().scopes).toEqual(pre);
  });

  it('separateScope: undo restores the combined scope', () => {
    const { b } = scoped();
    useStore.getState().addScope(b, 'current');
    const [sa, sb] = useStore.getState().scopes;
    useStore.getState().combineScopes(sa.id, sb.id);
    const pre = useStore.getState().scopes;
    expect(pre).toHaveLength(1);
    expect(pre[0].plots).toHaveLength(3); // a V, a I, b I

    useStore.getState().separateScope(useStore.getState().scopes[0].id);
    expect(useStore.getState().scopes).toHaveLength(2);

    useStore.getState().undo();
    expect(useStore.getState().scopes).toEqual(pre);
  });

  const fastPath = () => {
    scoped();
    const scopeId = useStore.getState().scopes[0].id;
    const plotId = useStore.getState().scopes[0].plots[0].id;
    // The pre-set snapshot the setter is expected to commit itself. No
    // explicit commit: each setter pushes one entry holding this state, so
    // the undo below restores it and not some earlier commit.
    const pre = useStore.getState().scopes;
    return { scopeId, plotId, pre };
  };

  it('setScopeSpeed commits itself; undo restores the pre-set speed', () => {
    const { scopeId, pre } = fastPath();
    const baseline = useStore.getState().undoStack.length;
    expect(useStore.getState().scopes[0].speed).toBe(64);

    useStore.getState().setScopeSpeed(scopeId, 128);
    expect(useStore.getState().scopes[0].speed).toBe(128);
    expect(useStore.getState().undoStack.length).toBe(baseline + 1);

    useStore.getState().undo();
    expect(useStore.getState().scopes).toEqual(pre);

    useStore.getState().redo();
    expect(useStore.getState().scopes[0].speed).toBe(128);
  });

  it('setScopeTrigger commits itself; undo restores the pre-set trigger', () => {
    const { scopeId, pre } = fastPath();
    const baseline = useStore.getState().undoStack.length;

    useStore.getState().setScopeTrigger(scopeId, { mode: 'normal', edge: 'falling', level: 2.5 });
    expect(useStore.getState().scopes[0].trigger).toEqual({
      mode: 'normal',
      edge: 'falling',
      level: 2.5,
    });
    expect(useStore.getState().undoStack.length).toBe(baseline + 1);

    useStore.getState().undo();
    expect(useStore.getState().scopes).toEqual(pre);

    useStore.getState().redo();
    expect(useStore.getState().scopes[0].trigger).toEqual({
      mode: 'normal',
      edge: 'falling',
      level: 2.5,
    });
  });

  it('setScopeFlags commits itself; undo restores the pre-set flags', () => {
    const { scopeId, pre } = fastPath();
    const baseline = useStore.getState().undoStack.length;

    useStore.getState().setScopeFlags(scopeId, {
      label: 'Renamed',
      manualScale: true,
      showMax: false,
    });
    const after = useStore.getState();
    expect(after.scopes[0].label).toBe('Renamed');
    expect(after.scopes[0].manualScale).toBe(true);
    expect(after.scopes[0].showMax).toBe(false);
    expect(after.undoStack.length).toBe(baseline + 1);

    useStore.getState().undo();
    expect(useStore.getState().scopes).toEqual(pre);

    useStore.getState().redo();
    expect(useStore.getState().scopes[0].label).toBe('Renamed');
  });

  it('setPlotCoupling commits itself; undo restores the pre-set coupling', () => {
    const { scopeId, plotId, pre } = fastPath();
    const baseline = useStore.getState().undoStack.length;

    useStore.getState().setPlotCoupling(scopeId, plotId, true);
    expect(useStore.getState().scopes[0].plots[0].acCoupled).toBe(true);
    expect(useStore.getState().undoStack.length).toBe(baseline + 1);

    useStore.getState().undo();
    expect(useStore.getState().scopes).toEqual(pre);

    useStore.getState().redo();
    expect(useStore.getState().scopes[0].plots[0].acCoupled).toBe(true);
  });

  it('setPlotManScale commits itself; undo restores the pre-set man scale', () => {
    const { plotId, pre } = fastPath();
    const baseline = useStore.getState().undoStack.length;

    useStore.getState().setPlotManScale(plotId, 2);
    expect(useStore.getState().scopes[0].plots[0].manScale).toBe(2);
    expect(useStore.getState().undoStack.length).toBe(baseline + 1);

    useStore.getState().undo();
    expect(useStore.getState().scopes).toEqual(pre);

    useStore.getState().redo();
    expect(useStore.getState().scopes[0].plots[0].manScale).toBe(2);
  });

  it('setPlotManPosition commits itself; undo restores the pre-set position', () => {
    const { plotId, pre } = fastPath();
    const baseline = useStore.getState().undoStack.length;

    useStore.getState().setPlotManPosition(plotId, 100);
    expect(useStore.getState().scopes[0].plots[0].manVPosition).toBe(100);
    expect(useStore.getState().undoStack.length).toBe(baseline + 1);

    useStore.getState().undo();
    expect(useStore.getState().scopes).toEqual(pre);

    useStore.getState().redo();
    expect(useStore.getState().scopes[0].plots[0].manVPosition).toBe(100);
  });

  it('a no-op setter call commits nothing', () => {
    const { scopeId, plotId } = fastPath();
    const baseline = useStore.getState().undoStack.length;

    // Every value below already equals the scope's state, so each setter must
    // bail before its commit: a drag frame or wheel tick that changes nothing
    // must not grow the undo stack.
    useStore.getState().setScopeSpeed(scopeId, 64);
    useStore.getState().setScopeTrigger(scopeId, { mode: 'freeRun', edge: 'rising', level: 0 });
    useStore.getState().setScopeFlags(scopeId, { showMax: true, label: '' });
    useStore.getState().setPlotCoupling(scopeId, plotId, false);
    useStore.getState().setPlotManScale(plotId, null);
    useStore.getState().setPlotManPosition(plotId, 0);

    expect(useStore.getState().undoStack.length).toBe(baseline);
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
