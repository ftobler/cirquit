import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type SimSettings } from '../model/types';
import { useStore } from './store';

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
  dark: true,
  status: '',
  problem: null,
  undoStack: [],
  redoStack: [],
  revision: 0,
  paramRevision: 0,
  pendingParams: new Map(),
  pendingStates: new Map(),
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
    const id = useStore
      .getState()
      .addElement({
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
    [
      'moveElements',
      (id: number) => useStore.getState().moveElements([id], 16, 0),
    ],
    [
      'updateElement',
      (id: number) => useStore.getState().updateElement(id, { x2: 320 }),
    ],
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
    ['snapToGrid', true, false],
  ] as const)('%s reloads=%s', (key, value, reload) => {
    const before = useStore.getState().revision;
    useStore.getState().updateSettings({ [key]: value } as Partial<SimSettings>);
    expect(useStore.getState().revision - before).toBe(reload ? 1 : 0);
  });
});
