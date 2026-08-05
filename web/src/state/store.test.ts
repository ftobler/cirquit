import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, GRID_SIZE, type CircuitElement, type SimSettings } from '../model/types';
import { postsOf } from '../model/registry';
import { parseCircuit } from '../io/netlist';
import { postPatch } from '../render/geometry';
import { hasUnsavedChanges, makeElement, useStore } from './store';

/** A pristine store, matching the initialiser in store.ts. */
const fresh = () => ({
  elements: [],
  selectedIds: [],
  scopes: [],
  settings: { ...DEFAULT_SETTINGS },
  passthrough: [],
  running: true,
  tool: null,
  view: { x: 0, y: 0, scale: 1 },
  status: '',
  problem: null,
  undoStack: [],
  redoStack: [],
  revision: 0,
  paramRevision: 0,
  pendingParams: new Map(),
  pendingStates: new Map(),
  contextMenu: null,
  clipboard: null,
  lastSaved: null,
});

beforeEach(() => useStore.setState(fresh()));

const addResistor = () =>
  useStore.getState().addElement({
    kind: 'resistor',
    x1: 0,
    y1: 0,
    x2: 160,
    y2: 0,
    flags: 0,
    params: { resistance: 1000 },
  });

const addCapacitor = () =>
  useStore.getState().addElement({
    kind: 'capacitor',
    x1: 160,
    y1: 0,
    x2: 320,
    y2: 0,
    flags: 0,
    params: { capacitance: 1e-5 },
  });

const dropId = (e: CircuitElement) => {
  const { id, ...rest } = e;
  void id;
  return rest;
};

describe('creation defaults', () => {
  it('new elements save the upstream default flags', () => {
    // A new part must round-trip to upstream with its features on: without
    // these, upstream loads the file with FLAG_SHOW_VOLTAGE, FLAG_SHOW_VALUES,
    // FLAG_SHOWVOLTAGE|FLAG_CIRCLE and FLAG_GAIN all off.
    expect(makeElement('voltage', 0, 0, 0, 64).flags).toBe(16);
    expect(makeElement('rail', 0, 0, 0, 64).flags).toBe(16);
    expect(makeElement('potentiometer', 0, 0, 32, 0).flags).toBe(1);
    expect(makeElement('probe', 0, 0, 32, 0).flags).toBe(3);
    expect(makeElement('opamp', 0, 0, 26, 0).flags).toBe(8);
    // Everything else creates with flags 0.
    expect(makeElement('resistor', 0, 0, 32, 0).flags).toBe(0);
    expect(makeElement('transistor', 0, 0, 32, 0).flags).toBe(0);
    expect(makeElement('switch2', 0, 0, 32, 0).flags).toBe(0);
  });

  it('creates text at the upstream size of 24', () => {
    expect(makeElement('decoration', 0, 0, 0, 0).params.size).toBe(24);
  });
});

describe('value edits go through the fast path', () => {
  it('setParam bumps paramRevision and not revision', () => {
    const id = addResistor();
    const before = useStore.getState();

    useStore.getState().setParam(id, 'resistance', 2000);

    const after = useStore.getState();
    expect(after.revision).toBe(before.revision);
    expect(after.paramRevision).toBe(before.paramRevision + 1);
    expect(after.pendingParams.get(`${id}:resistance`)).toEqual({
      id,
      name: 'resistance',
      value: 2000,
    });
    // The value still lands in the element, so a later topology reload
    // serialises it.
    expect(after.elements[0].params.resistance).toBe(2000);
  });

  it('setElementState bumps paramRevision and not revision', () => {
    const id = addResistor();
    const before = useStore.getState();

    useStore.getState().setElementState(id, 1);

    const after = useStore.getState();
    expect(after.revision).toBe(before.revision);
    expect(after.paramRevision).toBe(before.paramRevision + 1);
    expect(after.pendingStates.get(id)).toBe(1);
    expect(after.elements[0].state).toBe(1);
  });

  it('coalesces repeated edits to one pending entry holding the last value', () => {
    const id = addResistor();

    for (let i = 0; i < 10; i++) {
      useStore.getState().setParam(id, 'resistance', i * 100);
    }

    const after = useStore.getState();
    expect(after.pendingParams.size).toBe(1);
    expect(after.pendingParams.get(`${id}:resistance`)?.value).toBe(900);
  });

  it('keeps different params on one element separate', () => {
    const id = useStore.getState().addElement({
      kind: 'capacitor',
      x1: 0,
      y1: 0,
      x2: 160,
      y2: 0,
      flags: 0,
      params: { capacitance: 1e-6, initialVoltage: 0 },
    });

    useStore.getState().setParam(id, 'capacitance', 2e-6);
    useStore.getState().setParam(id, 'initialVoltage', 1);

    const after = useStore.getState();
    expect(after.pendingParams.size).toBe(2);
    expect(after.pendingParams.get(`${id}:capacitance`)?.value).toBe(2e-6);
    expect(after.pendingParams.get(`${id}:initialVoltage`)?.value).toBe(1);
  });
});

describe('setText edits free text through the fast path', () => {
  const addDecoration = (text?: string) =>
    useStore.getState().addElement({
      kind: 'decoration',
      x1: 0,
      y1: 0,
      x2: 0,
      y2: 0,
      flags: 0,
      params: { size: 12 },
      ...(text !== undefined ? { text } : {}),
    });

  it('updates only that element text and leaves params and other elements alone', () => {
    const resistor = addResistor();
    const deco = addDecoration('old');

    useStore.getState().setText(deco, 'new text');

    const after = useStore.getState();
    const edited = after.elements.find((e) => e.id === deco);
    const other = after.elements.find((e) => e.id === resistor);
    expect(edited?.text).toBe('new text');
    expect(edited?.params).toEqual({ size: 12 });
    expect(other?.params).toEqual({ resistance: 1000 });
    expect(other?.text).toBeUndefined();
  });

  it('bumps paramRevision and not revision', () => {
    const id = addDecoration();
    const before = useStore.getState();

    useStore.getState().setText(id, 'hello');

    const after = useStore.getState();
    expect(after.revision).toBe(before.revision);
    expect(after.paramRevision).toBe(before.paramRevision + 1);
    expect(after.pendingParams.size).toBe(0);
  });

  it('bumps revision on a labeled node, whose text is structural', () => {
    const id = useStore.getState().addElement({
      kind: 'labeledNode',
      x1: 0,
      y1: 0,
      x2: 0,
      y2: 0,
      flags: 0,
      params: {},
      text: 'A',
    });
    const before = useStore.getState();

    useStore.getState().setText(id, 'B');

    const after = useStore.getState();
    expect(after.revision).toBe(before.revision + 1);
    expect(after.paramRevision).toBe(before.paramRevision);
    expect(after.elements[0].text).toBe('B');
  });

  it('strips newlines so a save never splits the element line', () => {
    const id = addDecoration();
    useStore.getState().setText(id, 'line1\nline2\r');
    expect(useStore.getState().elements[0].text).toBe('line1line2');
  });

  it('is a no-op on an unknown id', () => {
    const before = useStore.getState();
    useStore.getState().setText(999, 'nope');
    const after = useStore.getState();
    expect(after.elements).toEqual(before.elements);
    expect(after.revision).toBe(before.revision);
    expect(after.paramRevision).toBe(before.paramRevision);
  });
});

describe('topology mutators force a reload', () => {
  it.each([
    [
      'addElement',
      () =>
        useStore.getState().addElement({
          kind: 'wire',
          x1: 0,
          y1: 160,
          x2: 160,
          y2: 160,
          flags: 0,
          params: {},
        }),
    ],
    ['moveElements', (id: number) => useStore.getState().moveElements([id], 16, 0)],
    ['updateElement', (id: number) => useStore.getState().updateElement(id, { x2: 320 })],
    [
      'deleteSelected',
      (id: number) => {
        useStore.getState().select([id]);
        useStore.getState().deleteSelected();
      },
    ],
  ] as const)('%s bumps revision', (_name, mutate) => {
    const id = addResistor();
    const before = useStore.getState().revision;
    mutate(id);
    expect(useStore.getState().revision).toBe(before + 1);
  });
});

describe('updateSettings reload classification', () => {
  it.each([
    ['timeStep', 1e-5, true],
    ['stepsPerFrame', 160, false],
    ['voltageRange', 5, false],
    ['currentSpeed', 50, false],
    ['showCurrent', true, false],
    ['showValues', true, false],
    ['showVoltageColor', true, false],
    ['showGrid', true, false],
  ] as const)('%s reloads=%s', (key, value, reload) => {
    const before = useStore.getState().revision;
    useStore.getState().updateSettings({ [key]: value } as Partial<SimSettings>);
    expect(useStore.getState().revision - before).toBe(reload ? 1 : 0);
  });
});

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
});

describe('copy, paste and duplicate', () => {
  it('copy then paste round-trips with fresh ids and preserved geometry', () => {
    const a = addResistor();
    const b = addCapacitor();
    const original = useStore.getState().elements;
    useStore.getState().select([a, b]);

    useStore.getState().copySelection();
    useStore.getState().pasteFromClipboard();

    const s = useStore.getState();
    expect(s.elements).toHaveLength(4);
    const pasted = s.elements.slice(2);
    expect(pasted.map((e) => e.kind)).toEqual(['resistor', 'capacitor']);
    // Params survive the netlist round-trip; the capacitor picks up the
    // format's zero-valued fields, as any file load does.
    expect(pasted[0].params).toEqual({ resistance: 1000 });
    expect(pasted[1].params.capacitance).toBe(1e-5);
    // Relative geometry preserved, offset by one grid step.
    expect(pasted[0].x1 - original[0].x1).toBe(GRID_SIZE);
    expect(pasted[0].y1 - original[0].y1).toBe(GRID_SIZE);
    expect(pasted[1].x1 - pasted[0].x1).toBe(original[1].x1 - original[0].x1);
    // Fresh ids: a collision here corrupts the circuit silently.
    expect(pasted[0].id).not.toBe(a);
    expect(pasted[1].id).not.toBe(b);
  });

  it('paste offsets every pasted element by one GRID_SIZE', () => {
    const a = addResistor();
    useStore.getState().select([a]);
    useStore.getState().copySelection();
    useStore.getState().pasteFromClipboard();
    const [old, copy] = useStore.getState().elements;
    expect(copy.x1).toBe(old.x1 + GRID_SIZE);
    expect(copy.y1).toBe(old.y1 + GRID_SIZE);
    expect(copy.x2).toBe(old.x2 + GRID_SIZE);
    expect(copy.y2).toBe(old.y2 + GRID_SIZE);
  });

  it('paste selects the pasted elements so an immediate drag moves them', () => {
    const a = addResistor();
    useStore.getState().select([a]);
    useStore.getState().copySelection();
    useStore.getState().pasteFromClipboard();
    const pasted = useStore.getState().elements[1];
    expect(useStore.getState().selectedIds).toEqual([pasted.id]);
  });

  it('cut removes the selection and paste restores equivalents', () => {
    const a = addResistor();
    const b = addCapacitor();
    useStore.getState().select([a, b]);

    useStore.getState().cutSelection();
    const afterCut = useStore.getState();
    expect(afterCut.elements).toHaveLength(0);
    expect(afterCut.clipboard).not.toBeNull();

    useStore.getState().pasteFromClipboard();
    const pasted = useStore.getState().elements;
    expect(pasted).toHaveLength(2);
    expect(pasted.map((e) => e.kind)).toEqual(['resistor', 'capacitor']);
    expect(pasted[0].id).not.toBe(a);
  });

  it('duplicate equals copy-then-paste and leaves the clipboard alone', () => {
    const a = addResistor();
    const b = addCapacitor();
    useStore.getState().select([a, b]);
    useStore.getState().copySelection();
    useStore.getState().pasteFromClipboard();
    const copied = useStore.getState().elements.slice(2).map(dropId);

    useStore.setState(fresh());
    const a2 = addResistor();
    const b2 = addCapacitor();
    useStore.getState().select([a2, b2]);
    useStore.setState({ clipboard: 'sentinel' });
    useStore.getState().duplicateSelection();
    const duplicated = useStore.getState().elements.slice(2).map(dropId);

    expect(duplicated).toEqual(copied);
    // Ctrl+D must not clobber whatever the user copied before.
    expect(useStore.getState().clipboard).toBe('sentinel');
  });

  it('delete removes attached scopes and paste does not resurrect them', () => {
    const a = addResistor();
    useStore.getState().addScope(a, 'voltage');
    useStore.getState().select([a]);
    useStore.getState().copySelection();
    useStore.getState().deleteSelected();
    expect(useStore.getState().scopes).toHaveLength(0);

    useStore.getState().pasteFromClipboard();
    const s = useStore.getState();
    expect(s.elements).toHaveLength(1);
    // A dead scope must not come back pointing at the pasted element.
    expect(s.scopes).toHaveLength(0);
  });

  it.each([
    [
      'cut',
      (id: number) => {
        useStore.getState().select([id]);
        useStore.getState().cutSelection();
      },
    ],
    [
      'paste',
      (id: number) => {
        useStore.getState().select([id]);
        useStore.getState().copySelection();
        useStore.getState().pasteFromClipboard();
      },
    ],
    [
      'duplicate',
      (id: number) => {
        useStore.getState().select([id]);
        useStore.getState().duplicateSelection();
      },
    ],
  ] as const)('%s is one undo step', (_name, run) => {
    addResistor();
    const before = useStore.getState().undoStack.length;
    run(useStore.getState().elements[0].id);
    expect(useStore.getState().undoStack.length).toBe(before + 1);
    useStore.getState().undo();
    expect(useStore.getState().elements).toHaveLength(1);
  });

  it('clipboard holds parseable netlist text of the selection', () => {
    const a = addResistor();
    const b = addCapacitor();
    useStore.getState().select([a, b]);
    useStore.getState().copySelection();

    const text = useStore.getState().clipboard;
    expect(text).not.toBeNull();
    const parsed = parseCircuit(text as string);
    expect(parsed.elements).toHaveLength(2);
    expect(parsed.elements.map((e) => e.kind)).toEqual(['resistor', 'capacitor']);
  });

  it('paste of unparsable text is a no-op', () => {
    const a = addResistor();
    useStore.getState().select([a]);
    useStore.setState({ clipboard: 'this is not a netlist' });
    const undoBefore = useStore.getState().undoStack.length;
    useStore.getState().pasteFromClipboard();
    const s = useStore.getState();
    expect(s.elements).toHaveLength(1);
    expect(s.selectedIds).toEqual([a]);
    expect(s.revision).toBe(1);
    // No insert means no commit: the undo stack must not grow either.
    expect(s.undoStack).toHaveLength(undoBefore);
  });

  it('paste with no clipboard is a no-op', () => {
    const a = addResistor();
    useStore.getState().select([a]);
    useStore.getState().pasteFromClipboard();
    expect(useStore.getState().elements).toHaveLength(1);
  });
});

describe('rotate, mirror and swap terminals', () => {
  const addDiode = () =>
    useStore.getState().addElement({
      kind: 'diode',
      x1: 0,
      y1: 0,
      x2: 160,
      y2: 0,
      flags: 0,
      params: {},
    });

  const addTransistor = () =>
    useStore.getState().addElement({
      kind: 'transistor',
      x1: 0,
      y1: 0,
      x2: 160,
      y2: 0,
      flags: 0,
      params: { pnp: 1 },
    });

  it('rotates a selected resistor 90 degrees, swapping length and breadth', () => {
    const id = addResistor();
    useStore.getState().select([id]);

    useStore.getState().rotateSelection();

    const r = useStore.getState().elements[0];
    expect(Math.abs(r.x2 - r.x1)).toBe(0);
    expect(Math.abs(r.y2 - r.y1)).toBe(160);
  });

  it('restores the original after four rotations', () => {
    const id = addResistor();
    const original = useStore.getState().elements[0];
    useStore.getState().select([id]);

    for (let i = 0; i < 4; i++) useStore.getState().rotateSelection();

    expect(useStore.getState().elements[0]).toEqual(original);
  });

  it('mirrors a selected transistor, keeping its bounding box and flipping post order', () => {
    const id = addTransistor();
    const before = postsOf(useStore.getState().elements[0]);
    useStore.getState().select([id]);

    useStore.getState().mirrorSelection();

    const t = useStore.getState().elements[0];
    const after = postsOf(t);
    expect(t.x1).toBe(160);
    expect(t.x2).toBe(0);
    // A horizontal mirror reverses the axis direction and leaves the flag.
    expect(t.flags & 1).toBe(0);
    const box = (pts: { x: number; y: number }[]) => ({
      minX: Math.min(...pts.map((p) => p.x)),
      maxX: Math.max(...pts.map((p) => p.x)),
      minY: Math.min(...pts.map((p) => p.y)),
      maxY: Math.max(...pts.map((p) => p.y)),
    });
    expect(box(after)).toEqual(box(before));
    expect(after.map((p) => [p.x, p.y])).toEqual([
      [160, 0],
      [0, -16],
      [0, 16],
    ]);
  });

  it('swaps terminals on a selected diode, reversing post order around the body centre', () => {
    const id = addDiode();
    useStore.getState().select([id]);

    useStore.getState().swapTerminals();

    const d = useStore.getState().elements[0];
    expect(d.x1).toBe(160);
    expect(d.x2).toBe(0);
    expect(postsOf(d)[0]).toEqual({ x: 160, y: 0 });
    expect(postsOf(d)[1]).toEqual({ x: 0, y: 0 });
    expect((d.x1 + d.x2) / 2).toBe(80);
  });

  it.each([
    [
      'rotateSelection',
      () => {
        const id = addResistor();
        useStore.getState().select([id]);
      },
      () => useStore.getState().rotateSelection(),
    ],
    [
      'mirrorSelection',
      () => {
        const id = addTransistor();
        useStore.getState().select([id]);
      },
      () => useStore.getState().mirrorSelection(),
    ],
    [
      'swapTerminals',
      () => {
        const id = addDiode();
        useStore.getState().select([id]);
      },
      () => useStore.getState().swapTerminals(),
    ],
  ] as const)('%s is one undo step', (_name, setUp, run) => {
    setUp();
    const original = useStore.getState().elements[0];
    const before = useStore.getState().undoStack.length;

    run();

    expect(useStore.getState().undoStack.length).toBe(before + 1);
    useStore.getState().undo();
    expect(useStore.getState().elements[0]).toEqual(original);
  });

  it('is a no-op with nothing selected, leaving the undo stack untouched', () => {
    addResistor();
    const before = useStore.getState().undoStack.length;
    const revision = useStore.getState().revision;

    useStore.getState().rotateSelection();
    useStore.getState().mirrorSelection();
    useStore.getState().swapTerminals();

    const s = useStore.getState();
    expect(s.undoStack).toHaveLength(before);
    expect(s.revision).toBe(revision);
  });

  it('is a no-op when the selection cannot take the command, matching a disabled menu item', () => {
    const resistor = addResistor();
    const ground = useStore.getState().addElement({
      kind: 'ground',
      x1: 0,
      y1: 0,
      x2: 0,
      y2: 0,
      flags: 0,
      params: {},
    });
    const before = useStore.getState().undoStack.length;

    // Mirror is only offered on the asymmetric bodies.
    useStore.getState().select([resistor]);
    useStore.getState().mirrorSelection();
    // Rotate needs two posts; a ground has one.
    useStore.getState().select([ground]);
    useStore.getState().rotateSelection();

    const s = useStore.getState();
    expect(s.undoStack).toHaveLength(before);
    expect(s.elements.find((e) => e.id === resistor)).toMatchObject({ x1: 0, x2: 160 });
  });
});

describe('context menu state', () => {
  it('openContextMenu stores coordinates and an element target', () => {
    useStore.getState().openContextMenu(10, 20, 7);
    expect(useStore.getState().contextMenu).toEqual({ x: 10, y: 20, target: 7 });
  });

  it('openContextMenu over empty canvas stores a null target', () => {
    useStore.getState().openContextMenu(5, 6, null);
    expect(useStore.getState().contextMenu).toEqual({ x: 5, y: 6, target: null });
  });

  it('closeContextMenu clears it', () => {
    useStore.getState().openContextMenu(10, 20, 7);
    useStore.getState().closeContextMenu();
    expect(useStore.getState().contextMenu).toBeNull();
  });

  it('opening twice replaces rather than stacks', () => {
    useStore.getState().openContextMenu(10, 20, 1);
    useStore.getState().openContextMenu(30, 40, null);
    expect(useStore.getState().contextMenu).toEqual({ x: 30, y: 40, target: null });
  });

  it('right-clicking an element outside the selection selects it alone', () => {
    const a = addResistor();
    const b = addCapacitor();
    useStore.getState().select([b]);
    useStore.getState().openContextMenu(10, 20, a);
    expect(useStore.getState().selectedIds).toEqual([a]);
    expect(useStore.getState().contextMenu?.target).toBe(a);
  });

  it('right-clicking an element already selected keeps the whole selection', () => {
    const a = addResistor();
    const b = addCapacitor();
    useStore.getState().select([a, b]);
    useStore.getState().openContextMenu(10, 20, a);
    expect(useStore.getState().selectedIds).toEqual([a, b]);
  });

  it('right-clicking empty canvas leaves the selection untouched', () => {
    const a = addResistor();
    useStore.getState().select([a]);
    useStore.getState().openContextMenu(10, 20, null);
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
    useStore.getState().markSaved(useStore.getState().toNetlist());
    addResistor();
    expect(dirty()).toBe(true);
  });

  it('save after editing cleans', () => {
    loadSample();
    addResistor();
    useStore.getState().markSaved(useStore.getState().toNetlist());
    expect(dirty()).toBe(false);
  });

  it('undo to the saved state is clean', () => {
    loadSample();
    useStore.getState().markSaved(useStore.getState().toNetlist());
    addResistor();
    expect(dirty()).toBe(true);
    useStore.getState().undo();
    expect(dirty()).toBe(false);
  });

  it('serialised settings dirty, display-only ones do not', () => {
    loadSample();
    useStore.getState().markSaved(useStore.getState().toNetlist());
    useStore.getState().updateSettings({ timeStep: 1e-5 });
    expect(dirty()).toBe(true);
    useStore.getState().markSaved(useStore.getState().toNetlist());
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
