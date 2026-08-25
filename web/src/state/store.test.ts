import { beforeEach, describe, expect, it, vi } from 'vitest';
import { matchShortcut } from '../input/shortcuts';
import { modalSurface } from '../input/modalSurface';
import { DEFAULT_SETTINGS, GRID_SIZE, type SimSettings } from '../model/types';
import { LOGIC_INPUT_TERNARY } from '../model/registry/flags';
import { postsOf } from '../model/registry';
import { hitTestElement } from '../render/geometry';
import { scopePlotsToSpecs } from '../engine/simulator';
import { scaleStateFor, setScaleState } from '../scope/scale';
import { parseCircuit, serializeCircuit } from '../io/netlist';
import { SAMPLE } from '../io/netlist/fixtures';
import { ZOOM_FACTOR, circuitBounds, fitView, zoomAbout } from './view';
import { APP_PREF_STORAGE_KEY, loadAppPrefs, type StorageLike } from './appPrefs';
import {
  RECOVERY_STORAGE_KEY,
  readRecovery,
  startAutoSave,
  type RecoveryStorage,
} from './recovery';
import {
  hasUnsavedChanges,
  makeElement,
  makeToolElement,
  nextSwitchState,
  snap,
  useStore,
} from './store';
import { addCapacitor, addResistor, fresh } from './store.test-helpers';

beforeEach(() => useStore.setState(fresh()));

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

  it('places a relay coil and contact already carrying the linking label', () => {
    // Upstream's constructors default both labels to "label" (RelayCoilElm.java:
    // 88, RelayContactElm.java:62), so a freshly placed pair links up without a
    // hand-typed label.
    expect(makeElement('relayCoil', 0, 0, 0, 64).text).toBe('label');
    expect(makeElement('relayContact', 0, 0, 64, 0).text).toBe('label');
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

  it('unblowFuses clears fuse blown state and its queued confirm, nothing else', () => {
    const fuseId = useStore.getState().addElement({
      kind: 'fuse',
      x1: 0,
      y1: 0,
      x2: 160,
      y2: 0,
      flags: 0,
      params: { resistance: 0.0613, i2t: 6.73 },
    });
    const switchId = useStore.getState().addElement({
      kind: 'switch',
      x1: 0,
      y1: 0,
      x2: 160,
      y2: 0,
      flags: 0,
      params: { position: 0 },
    });
    // A fuse that popped in-session (the frame loop synced e.state) with its
    // pop-confirm still queued, plus an unrelated queued switch throw.
    useStore.getState().setElementState(fuseId, 1);
    useStore.getState().setElementState(switchId, 1);
    const before = useStore.getState();

    useStore.getState().unblowFuses();

    const after = useStore.getState();
    // The fuse un-pops and its queued confirm is dropped, so the next frame's
    // pendingStates drain cannot re-apply `blown true` to the reset fuse.
    expect(after.elements.find((e) => e.id === fuseId)?.state).toBe(0);
    expect(after.pendingStates.has(fuseId)).toBe(false);
    // The switch throw rides through untouched.
    expect(after.elements.find((e) => e.id === switchId)?.state).toBe(1);
    expect(after.pendingStates.get(switchId)).toBe(1);
    // The store-side reset is silent: no rebuild and no extra fast-path drain.
    expect(after.revision).toBe(before.revision);
    expect(after.paramRevision).toBe(before.paramRevision);
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

  it('keeps a source pulse-duty flag in step with its waveform', () => {
    // The engine reads bit 4 (VOLTAGE_PULSE_DUTY) at build time and re-applies
    // the legacy 1/(2*pi) duty whenever it is absent, so the stored flags must
    // carry it exactly when a voltage/rail source is pulse. The edit stays on
    // the fast path: only a rebuild would re-read the flags.
    const id = useStore.getState().addElement({
      kind: 'voltage',
      x1: 0,
      y1: 64,
      x2: 0,
      y2: 0,
      flags: 16,
      params: { waveform: 0, dutyCycle: 0.5 },
    });
    const before = useStore.getState();

    useStore.getState().setParam(id, 'waveform', 5);
    let after = useStore.getState();
    expect(after.elements[0].flags & 4).toBe(4);
    expect(after.revision).toBe(before.revision);
    expect(after.pendingParams.get(`${id}:waveform`)?.value).toBe(5);

    useStore.getState().setParam(id, 'dutyCycle', 0.3);
    after = useStore.getState();
    expect(after.elements[0].params.dutyCycle).toBe(0.3);
    // The flag stays set while the waveform is pulse, so a rebuild serialises
    // the edited 0.3 rather than snapping it back to 1/(2*pi).
    expect(after.elements[0].flags & 4).toBe(4);

    useStore.getState().setParam(id, 'waveform', 1);
    after = useStore.getState();
    expect(after.elements[0].flags & 4).toBe(0);

    // A rail behaves the same way.
    const railId = useStore.getState().addElement({
      kind: 'rail',
      x1: 0,
      y1: 64,
      x2: 0,
      y2: 0,
      flags: 16,
      params: { waveform: 0 },
    });
    useStore.getState().setParam(railId, 'waveform', 5);
    const rail = useStore.getState().elements.find((e) => e.id === railId);
    expect((rail?.flags ?? 0) & 4).toBe(4);
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

  it.each(['vccs', 'vcvs', 'cccs', 'ccvs'])(
    'bumps revision when a controlled source Output Function is edited',
    (kind) => {
      const id = useStore.getState().addElement({
        kind,
        x1: 0,
        y1: 0,
        x2: 64,
        y2: 0,
        flags: 0,
        params: { inputCount: 2 },
        text: '.1*(a-b)',
      });
      const before = useStore.getState();

      useStore.getState().setText(id, '2*(a-b)');

      const after = useStore.getState();
      expect(after.revision).toBe(before.revision + 1);
      expect(after.paramRevision).toBe(before.paramRevision);
      expect(after.elements.find((e) => e.id === id)?.text).toBe('2*(a-b)');
    },
  );

  it('a display-only text edit changes the text and leaves paramRevision untouched', () => {
    const id = addDecoration('old');
    const before = useStore.getState();

    useStore.getState().setText(id, 'hello');

    const after = useStore.getState();
    expect(after.elements.find((e) => e.id === id)?.text).toBe('hello');
    expect(after.revision).toBe(before.revision);
    expect(after.paramRevision).toBe(before.paramRevision);
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
    ['movePoint', (id: number) => useStore.getState().movePoint(id, 0, 16, 0)],
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

describe('no-op drag updates do not rebuild the engine', () => {
  // Every no-op below is the shape a pointer event inside one grid cell sends
  // during a drag or placement. Each revision bump is a full setCircuit in the
  // frame loop, so a guard that misses these would make large circuits janky.

  it('updateElement with identical coordinates does not bump revision', () => {
    const id = addResistor(); // x1=0, y1=0, x2=160, y2=0
    const before = useStore.getState().revision;

    useStore.getState().updateElement(id, { x2: 160, y2: 0 });

    expect(useStore.getState().revision).toBe(before);
  });

  it('updateElement with a sub-grid jitter that rounds back does not bump revision', () => {
    const id = addResistor();
    const before = useStore.getState().revision;

    // The writer rounds geometry, so 159.6 lands back on the stored 160.
    useStore.getState().updateElement(id, { x2: 159.6, y1: -0.4 });

    expect(useStore.getState().revision).toBe(before);
    expect(useStore.getState().elements[0].x2).toBe(160);
  });

  it('updateElement with identical params does not bump revision', () => {
    const id = addResistor();
    const before = useStore.getState().revision;

    // The wattmeter width drag re-sends the whole params object each move;
    // an in-cell move keeps every value, so nothing may rebuild.
    useStore.getState().updateElement(id, { params: { resistance: 1000 } });

    expect(useStore.getState().revision).toBe(before);
  });

  it('moveElements with a zero delta does not bump revision', () => {
    const id = addResistor();
    const before = useStore.getState().revision;

    useStore.getState().moveElements([id], 0, 0);

    expect(useStore.getState().revision).toBe(before);
  });

  it('moveElements with a delta that rounds to zero does not bump revision', () => {
    const id = addResistor();
    const before = useStore.getState().revision;

    useStore.getState().moveElements([id], 0.4, -0.4);

    expect(useStore.getState().revision).toBe(before);
  });

  it('placement with an unchanged snapped position does not bump revision', () => {
    // The `place` handler re-sends the snapped second post on every
    // pointermove. A move into a fresh grid cell rebuilds once; a following
    // move that stays inside that cell sends the identical post and must not
    // rebuild the engine again.
    const id = addResistor();
    useStore.getState().updateElement(id, { x2: 320 });
    const before = useStore.getState().revision;
    expect(before).toBeGreaterThan(0);

    useStore.getState().updateElement(id, { x2: 320 });

    expect(useStore.getState().revision).toBe(before);
  });
});

describe('requestEdit selects and opens the properties dialog', () => {
  it('selects that id alone and opens the dialog on it', () => {
    const a = addResistor();
    const b = addResistor();
    useStore.getState().select([a]);
    // Force the wide layout so the parts drawer is expected to stay open.
    const original = (globalThis as { window?: Window }).window;
    (globalThis as { window?: Window }).window = {
      innerWidth: 1200,
    } as unknown as Window;
    useStore.getState().setPartsOpen(true);
    try {
      useStore.getState().requestEdit(b);

      const s = useStore.getState();
      expect(s.selectedIds).toEqual([b]);
      expect(s.elementProperties).toBe(b);
      expect(s.panelOpen).toBe(true);
      // On the wide layout the parts drawer is left open.
      expect(s.partsOpen).toBe(true);
    } finally {
      (globalThis as { window?: Window }).window = original;
    }
  });

  it('closes the context menu it was invoked from, and closes on demand', () => {
    const a = addResistor();
    useStore.getState().openContextMenu(10, 20, a, { x: 0, y: 0 });

    useStore.getState().requestEdit(a);
    expect(useStore.getState().contextMenu).toBeNull();
    expect(useStore.getState().elementProperties).toBe(a);

    useStore.getState().closeElementProperties();
    expect(useStore.getState().elementProperties).toBeNull();
    // Closing the dialog leaves the element selected, so the side panel keeps
    // showing the same rows.
    expect(useStore.getState().selectedIds).toEqual([a]);
  });

  it('retargets the dialog when a second element is edited', () => {
    const a = addResistor();
    const b = addResistor();
    useStore.getState().requestEdit(a);
    useStore.getState().requestEdit(b);
    expect(useStore.getState().elementProperties).toBe(b);
  });

  it('keeps the whole selection when the target is already in it', () => {
    const a = addResistor();
    const b = addResistor();
    useStore.getState().select([a, b]);

    useStore.getState().requestEdit(b);

    // Nothing is deselected, and the edited element leads the selection so the
    // options panel (which reads selectedIds[0]) shows it, not its neighbour.
    expect(useStore.getState().selectedIds).toEqual([b, a]);
    expect(useStore.getState().panelOpen).toBe(true);
  });

  it('opens the options drawer and closes the parts drawer on the narrow layout', () => {
    addResistor();
    useStore.getState().setPartsOpen(true);
    // Simulate the mobile breakpoint so the parts drawer is expected to close.
    const original = (globalThis as { window?: Window }).window;
    (globalThis as { window?: Window }).window = {
      innerWidth: 400,
    } as unknown as Window;
    try {
      useStore.getState().requestEdit(useStore.getState().elements[0].id);
      const s = useStore.getState();
      expect(s.panelOpen).toBe(true);
      expect(s.partsOpen).toBe(false);
    } finally {
      (globalThis as { window?: Window }).window = original;
    }
  });

  it('opens the options drawer but leaves the parts drawer open on the wide layout', () => {
    addResistor();
    useStore.getState().setPartsOpen(true);
    const original = (globalThis as { window?: Window }).window;
    (globalThis as { window?: Window }).window = {
      innerWidth: 1200,
    } as unknown as Window;
    try {
      useStore.getState().requestEdit(useStore.getState().elements[0].id);
      const s = useStore.getState();
      expect(s.panelOpen).toBe(true);
      expect(s.partsOpen).toBe(true);
    } finally {
      (globalThis as { window?: Window }).window = original;
    }
  });
});

describe('drawer state', () => {
  it('setPartsOpen opens and closes the parts drawer', () => {
    useStore.getState().setPartsOpen(true);
    expect(useStore.getState().partsOpen).toBe(true);
    useStore.getState().setPartsOpen(false);
    expect(useStore.getState().partsOpen).toBe(false);
  });

  it('only one drawer is open at a time', () => {
    useStore.getState().setPartsOpen(true);
    useStore.getState().setPanelOpen(true);
    let s = useStore.getState();
    expect(s.panelOpen).toBe(true);
    expect(s.partsOpen).toBe(false);

    useStore.getState().setPartsOpen(true);
    s = useStore.getState();
    expect(s.partsOpen).toBe(true);
    expect(s.panelOpen).toBe(false);
  });
});

describe('movePoint moves a single stored endpoint', () => {
  it('post 0 patches only x1/y1', () => {
    const id = addResistor();
    useStore.getState().movePoint(id, 0, 16, 0);
    const e = useStore.getState().elements[0];
    expect([e.x1, e.y1]).toEqual([16, 0]);
    expect([e.x2, e.y2]).toEqual([160, 0]);
  });

  it('post 1 patches only x2/y2', () => {
    const id = addResistor();
    useStore.getState().movePoint(id, 1, 0, 16);
    const e = useStore.getState().elements[0];
    expect([e.x1, e.y1]).toEqual([0, 0]);
    expect([e.x2, e.y2]).toEqual([160, 16]);
  });

  it('is a no-op on an unknown id', () => {
    const before = useStore.getState().revision;
    useStore.getState().movePoint(999, 0, 16, 0);
    expect(useStore.getState().revision).toBe(before);
  });
});

describe('hover and net-highlight store state', () => {
  it('setHovered stores the element id and clears to null', () => {
    const id = addResistor();
    useStore.getState().setHovered(id);
    expect(useStore.getState().hoveredId).toBe(id);
    useStore.getState().setHovered(null);
    expect(useStore.getState().hoveredId).toBeNull();
  });

  it('setHighlightedNode stores the engine node and clears to null', () => {
    useStore.getState().setHighlightedNode(3);
    expect(useStore.getState().highlightedNode).toBe(3);
    useStore.getState().setHighlightedNode(null);
    expect(useStore.getState().highlightedNode).toBeNull();
  });

  it('loadNetlist clears hover and the highlighted net', () => {
    useStore.getState().setHovered(1);
    useStore.getState().setHighlightedNode(3);
    useStore.getState().loadNetlist('r 0 0 16 0 0 100\n');
    expect(useStore.getState().hoveredId).toBeNull();
    expect(useStore.getState().highlightedNode).toBeNull();
  });

  it('a rebuild (a revision bump) clears the highlighted net', () => {
    // The engine renumbers nodes on every rebuild, so a highlight from before
    // the bump would light the wrong net until the mouse moves. The revision
    // bump must clear it; the hover re-sets it on the next shift-hover.
    useStore.getState().setHighlightedNode(3);
    useStore.getState().moveElements([addResistor()], GRID_SIZE, 0);
    expect(useStore.getState().revision).toBeGreaterThan(0);
    expect(useStore.getState().highlightedNode).toBeNull();
  });
});

describe('momentary switch press-and-release', () => {
  const addMomentary = () =>
    useStore.getState().addElement({
      kind: 'switch',
      x1: 0,
      y1: 0,
      x2: 160,
      y2: 0,
      flags: 0,
      // The file format loads a momentary switch open (position 1).
      params: { position: 1, momentary: 1 },
      state: 1,
    });

  it('toggles to closed on press and back to open on release', () => {
    const id = addMomentary();
    useStore.getState().setElementState(id, 0); // press: closed
    expect(useStore.getState().elements[0].state).toBe(0);
    useStore.getState().setElementState(id, 1); // release: open
    expect(useStore.getState().elements[0].state).toBe(1);
  });

  it('a press-toggle twice returns to the resting position', () => {
    const id = addMomentary();
    const e = () => useStore.getState().elements[0];
    useStore.getState().setElementState(id, ((e().state ?? 0) + 1) % 2);
    useStore.getState().setElementState(id, ((e().state ?? 0) + 1) % 2);
    expect(e().state).toBe(1);
  });
});

describe('switch keyboard shortcuts', () => {
  const addSwitch = (
    params: { momentary?: number; position?: number } = {},
    keyShortcut?: string,
  ) =>
    useStore.getState().addElement({
      kind: 'switch',
      x1: 0,
      y1: 0,
      x2: 160,
      y2: 0,
      flags: 0,
      params: { position: 0, momentary: 0, ...params },
      state: params.position ?? 0,
      ...(keyShortcut !== undefined ? { keyShortcut } : {}),
    });

  it('setKeyShortcut stores a single lowercase char and clears on empty', () => {
    const id = addSwitch();
    useStore.getState().setKeyShortcut(id, 'A');
    expect(useStore.getState().elements[0].keyShortcut).toBe('a');
    // Upstream trims and clears an empty string (SwitchElm.java:278-282).
    useStore.getState().setKeyShortcut(id, '  ');
    expect(useStore.getState().elements[0].keyShortcut).toBeUndefined();
  });

  it('the keyShortcut never enters the netlist: session-only', () => {
    const id = addSwitch();
    useStore.getState().setKeyShortcut(id, 'k');
    const line = useStore.getState().toNetlist().split('\n')[1];
    expect(line).toBe('s 0 0 160 0 0 0 false');
  });

  it('toggleSwitchByKey finds a switch by keyShortcut and toggles it', () => {
    addSwitch({}, 'k');
    expect(useStore.getState().toggleSwitchByKey('k')).toBe(true);
    expect(useStore.getState().elements[0].state).toBe(1);
    expect(useStore.getState().toggleSwitchByKey('k')).toBe(true);
    expect(useStore.getState().elements[0].state).toBe(0);
  });

  it('a shifted press still matches the lowercase assignment', () => {
    addSwitch({}, 'k');
    expect(useStore.getState().toggleSwitchByKey('K')).toBe(true);
    expect(useStore.getState().elements[0].state).toBe(1);
  });

  it('toggleSwitchByKey no-ops with no match', () => {
    addSwitch({}, 'k');
    expect(useStore.getState().toggleSwitchByKey('x')).toBe(false);
    expect(useStore.getState().elements[0].state).toBe(0);
    // A switch without an assignment is never toggled by any key.
    const other = useStore.getState().addElement({
      kind: 'switch',
      x1: 0,
      y1: 0,
      x2: 160,
      y2: 0,
      flags: 0,
      params: { position: 0, momentary: 0 },
      state: 0,
    });
    expect(useStore.getState().toggleSwitchByKey('k')).toBe(true);
    expect(useStore.getState().elements.find((e) => e.id === other)?.state).toBe(0);
  });

  it('toggles every switch sharing the key, like the upstream loop', () => {
    const first = addSwitch({}, 'k');
    const second = addSwitch({}, 'k');
    // Both must throw on one keydown, or a second momentary switch sharing
    // the key would be closed by the matching keyup but never opened by the
    // keydown (UIManager.java:1256-1268 loops the whole list).
    expect(useStore.getState().toggleSwitchByKey('k')).toBe(true);
    expect(useStore.getState().elements.find((e) => e.id === first)?.state).toBe(1);
    expect(useStore.getState().elements.find((e) => e.id === second)?.state).toBe(1);
  });

  it('releases every momentary switch sharing the key on keyup', () => {
    const first = useStore.getState().addElement({
      kind: 'switch',
      x1: 0,
      y1: 0,
      x2: 160,
      y2: 0,
      flags: 0,
      params: { position: 1, momentary: 1 },
      state: 1,
      keyShortcut: 'k',
    });
    const second = useStore.getState().addElement({
      kind: 'switch',
      x1: 0,
      y1: 0,
      x2: 160,
      y2: 0,
      flags: 0,
      params: { position: 1, momentary: 1 },
      state: 1,
      keyShortcut: 'k',
    });
    useStore.getState().toggleSwitchByKey('k'); // keydown closes both
    expect(useStore.getState().elements.find((e) => e.id === first)?.state).toBe(0);
    expect(useStore.getState().elements.find((e) => e.id === second)?.state).toBe(0);
    useStore.getState().releaseMomentaryByKey('k'); // keyup reopens both
    expect(useStore.getState().elements.find((e) => e.id === first)?.state).toBe(1);
    expect(useStore.getState().elements.find((e) => e.id === second)?.state).toBe(1);
  });

  it('a space-assigned switch wins over the Space select-mode fallback', () => {
    // Upstream's keypress branch toggles a switch whose keyShortcut is the
    // space key before its cc==32 select-mode fallback (UIManager.java:
    // 1250-1291). The sanitizer trims, so this reaches the element only
    // directly, but the match must still throw it.
    const id = useStore.getState().addElement({
      kind: 'switch',
      x1: 0,
      y1: 0,
      x2: 160,
      y2: 0,
      flags: 0,
      params: { position: 0, momentary: 0 },
      state: 0,
      keyShortcut: ' ',
    });
    expect(useStore.getState().toggleSwitchByKey(' ')).toBe(true);
    expect(useStore.getState().elements.find((e) => e.id === id)?.state).toBe(1);
  });

  it('a switch assignment wins over a user-assigned command on the same key', () => {
    addSwitch({}, 'k');
    // The precedence is App.tsx order (switch keyShortcut before matchShortcut),
    // but the store half of it is that the switch path fires regardless of what
    // the overlay binds to the same key (UIManager.java:1178 vs 1248).
    useStore.getState().setShortcuts({ copy: 'k' });
    expect(useStore.getState().toggleSwitchByKey('k')).toBe(true);
    expect(useStore.getState().elements[0].state).toBe(1);
  });

  it('a keyboard toggle pushes no undo entry, unlike the pointer throw', () => {
    addSwitch({}, 'k');
    useStore.getState().commit();
    const before = useStore.getState().undoStack.length;
    useStore.getState().toggleSwitchByKey('k');
    // The pointer path commits per click (a deliberate port divergence); the
    // keyboard path matches upstream's no-push toggle, so undo does not grow.
    expect(useStore.getState().undoStack.length).toBe(before);
    expect(useStore.getState().elements[0].state).toBe(1);
  });

  it('an SPDT cycles its throws like the pointer toggle', () => {
    useStore.getState().addElement({
      kind: 'switch2',
      x1: 0,
      y1: 0,
      x2: 160,
      y2: 0,
      flags: 0,
      params: { position: 0, throwCount: 3 },
      state: 0,
      keyShortcut: 's',
    });
    useStore.getState().toggleSwitchByKey('s');
    expect(useStore.getState().elements[0].state).toBe(1);
    useStore.getState().toggleSwitchByKey('s');
    expect(useStore.getState().elements[0].state).toBe(2);
    useStore.getState().toggleSwitchByKey('s');
    expect(useStore.getState().elements[0].state).toBe(0);
  });

  it('a ternary logic input cycles its three positions', () => {
    // The pointer toggle routes through nextSwitchState, so the ternary range
    // (LogicInputElm FLAG_TERNARY) must reach position 2 instead of folding
    // back to 0 after one click.
    const base = {
      id: 1,
      kind: 'logicInput',
      x1: 0,
      y1: 0,
      x2: 160,
      y2: 0,
      flags: 1, // FLAG_TERNARY
      params: { position: 0, momentary: 0 },
      state: 0,
    };
    expect(nextSwitchState(base)).toBe(1);
    expect(nextSwitchState({ ...base, state: 1 })).toBe(2);
    expect(nextSwitchState({ ...base, state: 2 })).toBe(0);
  });

  it('a two-level logic input flips between its two positions', () => {
    const base = {
      id: 1,
      kind: 'logicInput',
      x1: 0,
      y1: 0,
      x2: 160,
      y2: 0,
      flags: 0,
      params: { position: 0, momentary: 0 },
      state: 0,
    };
    expect(nextSwitchState(base)).toBe(1);
    expect(nextSwitchState({ ...base, state: 1 })).toBe(0);
  });

  it('clicking a ternary logic input cycles 0, 1, 2, 0 with a pending state each step', () => {
    // The pointer toggle routes through nextSwitchState and setElementState,
    // which is what queues the engine's pendingStates; every click must carry
    // the new position to the engine, not just redraw the glyph.
    const id = useStore.getState().addElement({
      kind: 'logicInput',
      x1: 0,
      y1: 0,
      x2: 160,
      y2: 0,
      flags: 1, // FLAG_TERNARY
      params: { position: 0, momentary: 0 },
      state: 0,
    });
    for (const expected of [1, 2, 0]) {
      const e = useStore.getState().elements[0];
      useStore.getState().setElementState(id, nextSwitchState(e));
      expect(useStore.getState().elements[0].state).toBe(expected);
      expect(useStore.getState().pendingStates.get(id)).toBe(expected);
    }
  });

  it('clicking an unflagged logic input still alternates 0/1 with a pending state each step', () => {
    const id = useStore.getState().addElement({
      kind: 'logicInput',
      x1: 0,
      y1: 0,
      x2: 160,
      y2: 0,
      flags: 0,
      params: { position: 0, momentary: 0 },
      state: 0,
    });
    for (const expected of [1, 0]) {
      const e = useStore.getState().elements[0];
      useStore.getState().setElementState(id, nextSwitchState(e));
      expect(useStore.getState().elements[0].state).toBe(expected);
      expect(useStore.getState().pendingStates.get(id)).toBe(expected);
    }
  });

  it('releaseMomentaryByKey lets a momentary switch back up on keyup', () => {
    addSwitch({ momentary: 1, position: 1 }, 'k'); // rest open
    useStore.getState().toggleSwitchByKey('k'); // keydown closes it
    expect(useStore.getState().elements[0].state).toBe(0);
    useStore.getState().releaseMomentaryByKey('k');
    expect(useStore.getState().elements[0].state).toBe(1);
  });

  it('releaseMomentaryByKey leaves a latched switch alone', () => {
    addSwitch({ momentary: 0, position: 0 }, 'k');
    useStore.getState().toggleSwitchByKey('k');
    expect(useStore.getState().elements[0].state).toBe(1);
    useStore.getState().releaseMomentaryByKey('k');
    // A latching switch stays where the press put it.
    expect(useStore.getState().elements[0].state).toBe(1);
  });

  it('a keyup for an assigned key leaves resting momentaries alone', () => {
    // The release outranks every gate now, so it also sees keyups with no
    // canvas press behind it: typing an assigned letter into a text field
    // lands here. Nothing is held, so nothing may move.
    addSwitch({ momentary: 1, position: 1 }, 'k'); // rest open
    addSwitch({ momentary: 1, position: 0 }, 'j'); // rest closed
    expect(useStore.getState().releaseMomentaryByKey('k')).toBe(false);
    expect(useStore.getState().releaseMomentaryByKey('j')).toBe(false);
    expect(useStore.getState().elements[0].state).toBe(1);
    expect(useStore.getState().elements[1].state).toBe(0);
  });

  it('a duplicate keyup cannot walk a released momentary off its rest', () => {
    addSwitch({ momentary: 1, position: 1 }, 'k'); // rest open
    useStore.getState().toggleSwitchByKey('k'); // held closed
    expect(useStore.getState().releaseMomentaryByKey('k')).toBe(true);
    expect(useStore.getState().elements[0].state).toBe(1);
    expect(useStore.getState().releaseMomentaryByKey('k')).toBe(false);
    expect(useStore.getState().elements[0].state).toBe(1);
  });

  it('releaseHeldMomentaries returns every held momentary to rest, for window blur', () => {
    // A key-held switch and one armed by pointer throw: blur mid-press loses
    // the keyup and the pointerup alike, so the release-all is the safety net.
    const keyed = addSwitch({ momentary: 1, position: 1 }, 'k'); // rest open
    const thrown = addSwitch({ momentary: 1, position: 0 }); // rest closed
    useStore.getState().toggleSwitchByKey('k');
    useStore.getState().toggleSwitch(thrown);
    expect(useStore.getState().elements[0].state).toBe(0);
    expect(useStore.getState().elements[1].state).toBe(1);

    useStore.getState().releaseHeldMomentaries();
    expect(useStore.getState().elements[0].state).toBe(1);
    expect(useStore.getState().elements[1].state).toBe(0);

    // The engine learns the rest states too.
    expect(useStore.getState().pendingStates.get(keyed)).toBe(1);
    expect(useStore.getState().pendingStates.get(thrown)).toBe(0);
  });

  it('releaseHeldMomentaries leaves resting and latched switches alone', () => {
    addSwitch({ momentary: 1, position: 1 }, 'k');
    const latched = addSwitch({ momentary: 0, position: 0 }, 'j');
    useStore.getState().setElementState(latched, 1);
    useStore.getState().clearPending();

    useStore.getState().releaseHeldMomentaries();
    expect(useStore.getState().elements[0].state).toBe(1);
    expect(useStore.getState().elements[1].state).toBe(1);
    expect(useStore.getState().pendingStates.size).toBe(0);
  });

  it('a released hold leaves no redo future standing over it', () => {
    // setElementState arms a switch without touching the stacks, so this
    // builds a real redo future over a held momentary.
    const id = addSwitch({ momentary: 1, position: 1 }, 'k');
    useStore.getState().commit();
    const r = addResistor();
    useStore.getState().updateElement(r, { params: { resistance: 42 } });
    useStore.getState().undo();
    expect(useStore.getState().redoStack.length).toBeGreaterThan(0);
    useStore.getState().setElementState(id, 0); // held closed

    useStore.getState().releaseHeldMomentaries();
    // Same rule as the per-key release: the release writes snapshot-carried
    // state with no entry of its own, so a stale redo future would silently
    // rewind it.
    expect(useStore.getState().redoStack).toHaveLength(0);
  });

  it('the MBB cycles its four positions and the DPDT its two', () => {
    const mbb = {
      id: 1,
      kind: 'mbbSwitch',
      x1: 0,
      y1: 0,
      x2: 160,
      y2: 0,
      flags: 0,
      params: { position: 0, momentary: 0, link: 0 },
      state: 0,
    };
    expect(nextSwitchState(mbb)).toBe(1);
    expect(nextSwitchState({ ...mbb, state: 1 })).toBe(2);
    expect(nextSwitchState({ ...mbb, state: 2 })).toBe(3);
    expect(nextSwitchState({ ...mbb, state: 3 })).toBe(0);

    const dpdt = {
      id: 2,
      kind: 'dpdtSwitch',
      x1: 0,
      y1: 0,
      x2: 160,
      y2: 0,
      flags: 0,
      params: { position: 0, momentary: 0, poleCount: 2 },
      state: 0,
    };
    expect(nextSwitchState(dpdt)).toBe(1);
    expect(nextSwitchState({ ...dpdt, state: 1 })).toBe(0);
  });

  it('a centre-off SPDT cycles through the open middle position', () => {
    // Upstream's simpleToggle cycles over posCount (Switch2Elm.java:83,155-156),
    // so a flagged two-throw switch walks 0, 1, 2, 0 and rests its lever on the
    // open stop; an unflagged one keeps walking 0, 1, 0 over its two throws.
    const base = {
      id: 1,
      kind: 'switch2',
      x1: 0,
      y1: 0,
      x2: 160,
      y2: 0,
      flags: 1, // SWITCH2_CENTER_OFF
      params: { position: 0, momentary: 0, throwCount: 2 },
      state: 0,
    };
    expect(nextSwitchState(base)).toBe(1);
    expect(nextSwitchState({ ...base, state: 1 })).toBe(2);
    expect(nextSwitchState({ ...base, state: 2 })).toBe(0);

    const plain = { ...base, flags: 0 };
    expect(nextSwitchState(plain)).toBe(1);
    expect(nextSwitchState({ ...plain, state: 1 })).toBe(0);
  });

  it('clicking through a centre-off SPDT opens it and queues the engine state', () => {
    // The pointer toggle reaches the open middle stop, and the engine rebuild
    // carries position 2 through pendingStates exactly like any other throw.
    const id = useStore.getState().addElement({
      kind: 'switch2',
      x1: 0,
      y1: 0,
      x2: 160,
      y2: 0,
      flags: 1, // SWITCH2_CENTER_OFF
      params: { position: 0, momentary: 0, throwCount: 2 },
      state: 0,
    });
    useStore.getState().toggleSwitch(id);
    expect(useStore.getState().elements[0].state).toBe(1);
    expect(useStore.getState().pendingStates.get(id)).toBe(1);
    useStore.getState().toggleSwitch(id);
    expect(useStore.getState().elements[0].state).toBe(2);
    expect(useStore.getState().pendingStates.get(id)).toBe(2);
    useStore.getState().toggleSwitch(id);
    expect(useStore.getState().elements[0].state).toBe(0);
    expect(useStore.getState().pendingStates.get(id)).toBe(0);
  });

  it('toggleSwitchByKey throws an MBB and DPDT by their shortcut', () => {
    useStore.getState().addElement({
      kind: 'mbbSwitch',
      x1: 0,
      y1: 0,
      x2: 160,
      y2: 0,
      flags: 0,
      params: { position: 0, momentary: 0, link: 0 },
      state: 0,
      keyShortcut: 'm',
    });
    useStore.getState().addElement({
      kind: 'dpdtSwitch',
      x1: 0,
      y1: 0,
      x2: 160,
      y2: 0,
      flags: 0,
      params: { position: 0, momentary: 0, poleCount: 2 },
      state: 0,
      keyShortcut: 'd',
    });
    useStore.getState().toggleSwitchByKey('m');
    expect(useStore.getState().elements[0].state).toBe(1);
    useStore.getState().toggleSwitchByKey('m');
    expect(useStore.getState().elements[0].state).toBe(2);
    useStore.getState().toggleSwitchByKey('d');
    expect(useStore.getState().elements[1].state).toBe(1);
    useStore.getState().toggleSwitchByKey('d');
    expect(useStore.getState().elements[1].state).toBe(0);
  });

  it('a linked MBB carries every switch in its group along', () => {
    // Upstream's toggle() scans the whole element list and copies its position
    // into every MBB with the same link (MBBSwitchElm.java:182-195); the store
    // toggle fans the throw out in one set so the engine sees one edit.
    const add = (link: number, position: number) =>
      useStore.getState().addElement({
        kind: 'mbbSwitch',
        x1: 0,
        y1: 0,
        x2: 160,
        y2: 0,
        flags: 0,
        params: { position, momentary: 0, link },
        state: position,
      });
    add(0, 0); // unlinked: must not move
    add(7, 0); // group 7
    add(7, 2); // group 7
    add(0, 3); // unlinked
    const [unlinkedA, linkedA, linkedB, unlinkedB] = useStore.getState().elements;

    useStore.getState().toggleSwitch(linkedA.id);

    const els = useStore.getState().elements;
    expect(els[0].state).toBe(0); // unlinked stays
    expect(els[1].state).toBe(1); // group member threw
    expect(els[2].state).toBe(1); // group member threw to the same position
    expect(els[3].state).toBe(3); // other unlinked stays
    // One toggle is one engine edit entry per affected element, queued in the
    // same set().
    expect(useStore.getState().pendingStates.get(linkedA.id)).toBe(1);
    expect(useStore.getState().pendingStates.get(linkedB.id)).toBe(1);
    expect(useStore.getState().pendingStates.get(unlinkedA.id)).toBeUndefined();
    expect(useStore.getState().pendingStates.get(unlinkedB.id)).toBeUndefined();
  });

  it('a linked MBB keyboard toggle fans out too', () => {
    useStore.getState().addElement({
      kind: 'mbbSwitch',
      x1: 0,
      y1: 0,
      x2: 160,
      y2: 0,
      flags: 0,
      params: { position: 0, momentary: 0, link: 4 },
      state: 0,
      keyShortcut: 'm',
    });
    useStore.getState().addElement({
      kind: 'mbbSwitch',
      x1: 0,
      y1: 0,
      x2: 160,
      y2: 0,
      flags: 0,
      params: { position: 2, momentary: 0, link: 4 },
      state: 2,
    });
    useStore.getState().toggleSwitchByKey('m');
    const els = useStore.getState().elements;
    expect(els[0].state).toBe(1);
    expect(els[1].state).toBe(1);
  });

  it('a linked SPDT throws every switch2 in its group along', () => {
    // Upstream's toggle() scans the whole element list and copies its position
    // into every SPDT with the same link (Switch2Elm.java:155-173); the store
    // toggle fans the throw out in one set so the engine sees one edit.
    const add = (link: number, position: number) =>
      useStore.getState().addElement({
        kind: 'switch2',
        x1: 0,
        y1: 0,
        x2: 160,
        y2: 0,
        flags: 0,
        params: { position, momentary: 0, throwCount: 2, link },
        state: position,
      });
    add(0, 0); // unlinked: must not move
    add(3, 0); // group 3
    add(3, 0); // group 3
    add(0, 1); // unlinked
    const [unlinkedA, linkedA, linkedB, unlinkedB] = useStore.getState().elements;
    useStore.getState().commit();
    const before = useStore.getState().undoStack.length;

    useStore.getState().toggleSwitch(linkedA.id);

    const els = useStore.getState().elements;
    expect(els[0].state).toBe(0); // unlinked stays
    expect(els[1].state).toBe(1); // target threw
    expect(els[2].state).toBe(1); // group member threw to the same position
    expect(els[3].state).toBe(1); // other unlinked stays
    // One toggle is one engine edit entry per affected element, queued in the
    // same set().
    expect(useStore.getState().pendingStates.get(linkedA.id)).toBe(1);
    expect(useStore.getState().pendingStates.get(linkedB.id)).toBe(1);
    expect(useStore.getState().pendingStates.get(unlinkedA.id)).toBeUndefined();
    expect(useStore.getState().pendingStates.get(unlinkedB.id)).toBeUndefined();
    // A run-mode toggle pushes no undo entry, like the keyboard path.
    expect(useStore.getState().undoStack.length).toBe(before);
  });

  it('a different link leaves its group alone', () => {
    useStore.getState().addElement({
      kind: 'switch2',
      x1: 0,
      y1: 0,
      x2: 160,
      y2: 0,
      flags: 0,
      params: { position: 0, momentary: 0, throwCount: 2, link: 4 },
      state: 0,
    });
    useStore.getState().addElement({
      kind: 'switch2',
      x1: 0,
      y1: 0,
      x2: 160,
      y2: 0,
      flags: 0,
      params: { position: 0, momentary: 0, throwCount: 2, link: 7 },
      state: 0,
    });
    const a = useStore.getState().elements[0];
    useStore.getState().toggleSwitch(a.id);
    expect(useStore.getState().elements[0].state).toBe(1);
    expect(useStore.getState().elements[1].state).toBe(0);
    expect(useStore.getState().pendingStates.get(useStore.getState().elements[1].id)).toBeUndefined();
  });

  it('a mirrored twin lands on the opposite throw and stays consistent', () => {
    // The twin carries flipParity 1, the runtime positionFlipped flag upstream
    // toggles on every mirror; the toggle scan mirrors the new position into
    // it (Switch2Elm.java:164-168).
    const add = (link: number, position: number, flipParity: number) =>
      useStore.getState().addElement({
        kind: 'switch2',
        x1: 0,
        y1: 0,
        x2: 160,
        y2: 0,
        flags: 0,
        params: { position, momentary: 0, throwCount: 2, link, flipParity },
        state: position,
      });
    add(3, 0, 1); // mirrored twin
    add(3, 0, 0); // target
    const [twin, target] = useStore.getState().elements;

    useStore.getState().toggleSwitch(target.id);
    let els = useStore.getState().elements;
    expect(els[1].state).toBe(1); // target threw to 1
    expect(els[0].state).toBe(0); // twin mirrored: posCount-1-1 = 0
    expect(useStore.getState().pendingStates.get(twin.id)).toBe(0);

    useStore.getState().toggleSwitch(target.id);
    els = useStore.getState().elements;
    expect(els[1].state).toBe(0);
    expect(els[0].state).toBe(1); // twin mirrored: posCount-1-0 = 1
  });

  it('a centre-off pair walks both switches through their three stops together', () => {
    const add = (link: number, position: number) =>
      useStore.getState().addElement({
        kind: 'switch2',
        x1: 0,
        y1: 0,
        x2: 160,
        y2: 0,
        flags: 1, // SWITCH2_CENTER_OFF
        params: { position, momentary: 0, throwCount: 2, link },
        state: position,
      });
    add(5, 0);
    add(5, 0);
    const a = useStore.getState().elements[0];

    useStore.getState().toggleSwitch(a.id);
    expect(useStore.getState().elements[0].state).toBe(1);
    expect(useStore.getState().elements[1].state).toBe(1);
    useStore.getState().toggleSwitch(a.id);
    expect(useStore.getState().elements[0].state).toBe(2);
    expect(useStore.getState().elements[1].state).toBe(2);
    useStore.getState().toggleSwitch(a.id);
    expect(useStore.getState().elements[0].state).toBe(0);
    expect(useStore.getState().elements[1].state).toBe(0);
  });

  it('a twin only takes a position it owns: a 2-stop twin skips the centre-off middle', () => {
    // Upstream's `if (pos < s2.posCount)` guard (Switch2Elm.java:167-168): the
    // plain twin has no open middle, so when the centre-off target walks into
    // position 2 the twin keeps its last throw instead of wrapping.
    useStore.getState().addElement({
      kind: 'switch2',
      x1: 0,
      y1: 0,
      x2: 160,
      y2: 0,
      flags: 1, // SWITCH2_CENTER_OFF
      params: { position: 0, momentary: 0, throwCount: 2, link: 5 },
      state: 0,
    });
    useStore.getState().addElement({
      kind: 'switch2',
      x1: 0,
      y1: 0,
      x2: 160,
      y2: 0,
      flags: 0,
      params: { position: 0, momentary: 0, throwCount: 2, link: 5 },
      state: 0,
    });
    const target = useStore.getState().elements[0];
    useStore.getState().toggleSwitch(target.id);
    expect(useStore.getState().elements[1].state).toBe(1);
    useStore.getState().toggleSwitch(target.id); // into the open middle
    expect(useStore.getState().elements[0].state).toBe(2);
    expect(useStore.getState().elements[1].state).toBe(1); // kept its throw
    useStore.getState().toggleSwitch(target.id);
    expect(useStore.getState().elements[1].state).toBe(0);
  });

  it('a linked SPDT keyboard toggle fans out too', () => {
    useStore.getState().addElement({
      kind: 'switch2',
      x1: 0,
      y1: 0,
      x2: 160,
      y2: 0,
      flags: 0,
      params: { position: 0, momentary: 0, throwCount: 2, link: 9 },
      state: 0,
      keyShortcut: 's',
    });
    useStore.getState().addElement({
      kind: 'switch2',
      x1: 0,
      y1: 0,
      x2: 160,
      y2: 0,
      flags: 0,
      params: { position: 1, momentary: 0, throwCount: 2, link: 9 },
      state: 1,
    });
    useStore.getState().toggleSwitchByKey('s');
    const els = useStore.getState().elements;
    expect(els[0].state).toBe(1);
    expect(els[1].state).toBe(1);
  });

  it('a group-number edit lands in the S line slot and round-trips', () => {
    const id = useStore.getState().addElement({
      kind: 'switch2',
      x1: 0,
      y1: 0,
      x2: 160,
      y2: 0,
      flags: 4, // SWITCH_LABEL
      params: { position: 1, momentary: 0, throwCount: 2, link: 0 },
      state: 1,
      text: 'myLabel',
    });
    useStore.getState().setParam(id, 'link', 7);
    // The S line writes position momentary label link throwCount, so the
    // group number sits between the optional label and the throw count
    // (Switch2Elm.java:44-50).
    const line = useStore.getState().toNetlist().split('\n')[1];
    expect(line).toBe('S 0 0 160 0 4 1 false myLabel 7 2');
    const back = parseCircuit(useStore.getState().toNetlist()).elements[0];
    expect(back.params.link).toBe(7);
    expect(back.params.throwCount).toBe(2);
  });

  it('a DPDT poleCount edit normalizes to the engine integer range', () => {
    useStore.getState().addElement({
      kind: 'dpdtSwitch',
      x1: 0,
      y1: 0,
      x2: 160,
      y2: 0,
      flags: 0,
      params: { position: 0, momentary: 0, poleCount: 2 },
      state: 0,
    });
    const id = useStore.getState().elements[0].id;
    useStore.getState().setParam(id, 'poleCount', 2.5);
    expect(useStore.getState().elements[0].params.poleCount).toBe(2);
    useStore.getState().setParam(id, 'poleCount', 11);
    expect(useStore.getState().elements[0].params.poleCount).toBe(10);
    useStore.getState().setParam(id, 'poleCount', 1);
    expect(useStore.getState().elements[0].params.poleCount).toBe(2);
  });

  it('setShortcuts replaces the overlay without touching the circuit', () => {
    const id = addSwitch();
    useStore.getState().setShortcuts({ copy: 'Ctrl+z', toggleRunning: 'p' });
    expect(useStore.getState().shortcuts).toEqual({ copy: 'Ctrl+z', toggleRunning: 'p' });
    expect(useStore.getState().elements[0].id).toBe(id);
  });
});

describe('crossover switch keyboard shortcuts', () => {
  // The def advertises the Keyboard Shortcut field and the pointer path arms
  // its momentary, so the key loops must honour the kind too: upstream's
  // scans match every SwitchElm subclass (CrossSwitchElm extends SwitchElm).
  const addCross = (
    params: { position?: number; momentary?: number } = {},
    keyShortcut?: string,
  ) =>
    useStore.getState().addElement({
      kind: 'crossSwitch',
      x1: 0,
      y1: 0,
      x2: 160,
      y2: 0,
      flags: 0,
      params: { position: 0, momentary: 0, ...params },
      state: params.position ?? 0,
      ...(keyShortcut !== undefined ? { keyShortcut } : {}),
    });

  it('toggleSwitchByKey throws and resets a crossover switch', () => {
    addCross({}, 'x');
    expect(useStore.getState().toggleSwitchByKey('x')).toBe(true);
    expect(useStore.getState().elements[0].state).toBe(1);
    expect(useStore.getState().toggleSwitchByKey('x')).toBe(true);
    expect(useStore.getState().elements[0].state).toBe(0);
  });

  it('releases a momentary crossover switch on keyup', () => {
    // A momentary cross switch rests open at position 1 like the push switch
    // (SwitchElm's momentary constructor), so keydown closes to 0 and keyup
    // must find it held and put it back.
    addCross({ position: 1, momentary: 1 }, 'x');
    expect(useStore.getState().toggleSwitchByKey('x')).toBe(true);
    expect(useStore.getState().elements[0].state).toBe(0);
    expect(useStore.getState().releaseMomentaryByKey('x')).toBe(true);
    expect(useStore.getState().elements[0].state).toBe(1);
    expect(useStore.getState().releaseMomentaryByKey('x')).toBe(false);
  });
});

describe('logic input keyboard shortcuts', () => {
  // Upstream's LogicInputElm extends SwitchElm, so its scans toggle an
  // assigned logic input too, deliberately without needAnalyze: the toggle is
  // a voltage flip done in doStep, not a restamp (UIManager.java:1263-1265).
  const addLogic = (
    opts: { flags?: number; params?: Record<string, number> } = {},
    keyShortcut?: string,
  ) =>
    useStore.getState().addElement({
      kind: 'logicInput',
      x1: 0,
      y1: 0,
      x2: 64,
      y2: 64,
      flags: opts.flags ?? 0,
      params: { hiV: 5, loV: 0, position: 0, momentary: 0, ...(opts.params ?? {}) },
      state: 0,
      ...(keyShortcut !== undefined ? { keyShortcut } : {}),
    });

  it('toggleSwitchByKey flips a logic input between low and high', () => {
    addLogic({}, 'h');
    expect(useStore.getState().toggleSwitchByKey('h')).toBe(true);
    expect(useStore.getState().elements[0].state).toBe(1);
    expect(useStore.getState().toggleSwitchByKey('h')).toBe(true);
    expect(useStore.getState().elements[0].state).toBe(0);
  });

  it('a ternary logic input walks all three positions', () => {
    addLogic({ flags: LOGIC_INPUT_TERNARY }, 'h');
    for (const expected of [1, 2, 0]) {
      expect(useStore.getState().toggleSwitchByKey('h')).toBe(true);
      expect(useStore.getState().elements[0].state).toBe(expected);
    }
  });

  it('the keyboard flip queues an engine param, never a rebuild', () => {
    // The needAnalyze skip: like every keyboard throw, the edit rides
    // pendingStates, so revision (the rebuild counter) stays put.
    addLogic({}, 'h');
    const before = useStore.getState().revision;
    useStore.getState().toggleSwitchByKey('h');
    expect(useStore.getState().pendingStates.get(useStore.getState().elements[0].id)).toBe(1);
    expect(useStore.getState().revision).toBe(before);
  });

  it('releases a momentary logic input on keyup', () => {
    addLogic({ params: { momentary: 1 } }, 'h');
    expect(useStore.getState().toggleSwitchByKey('h')).toBe(true);
    expect(useStore.getState().elements[0].state).toBe(1);
    expect(useStore.getState().releaseMomentaryByKey('h')).toBe(true);
    expect(useStore.getState().elements[0].state).toBe(0);
    expect(useStore.getState().releaseMomentaryByKey('h')).toBe(false);
  });
});

describe('the s key on an empty circuit', () => {
  it('arms the switch tool for a plain s keydown', () => {
    // The App.tsx keydown order: the switch keyShortcut path first (no switch
    // here, so it no-ops), then matchShortcut resolves 's' to switch, which
    // the place dispatch turns into setTool. The pure matcher test stops at
    // the action; this pins the store half the component performs on a fresh
    // circuit, so a duplicate shortcut that re-armed 's' to another kind
    // would fail here.
    const s = useStore.getState();
    expect(s.tool).toBeNull();
    expect(s.toggleSwitchByKey('s')).toBe(false);
    const action = matchShortcut(
      { key: 's', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false },
      s.shortcuts,
    );
    expect(action).toEqual({ type: 'place', kind: 'switch' });
    if (action?.type === 'place') s.setTool(action.kind);
    expect(useStore.getState().tool).toBe('switch');
  });
});

describe('updateSettings reload classification', () => {
  it.each([
    ['timeStep', 1e-5, true],
    // The adaptive floor and flag are engine options too, so either forces a
    // rebuild like timeStep does.
    ['minTimeStep', 1e-9, true],
    ['adaptiveTimeStep', false, true],
    // The DC operating point decides the solve itself, so it must rebuild.
    ['autoDC', false, true],
    // iterCount is a header round-trip field, never sent to the engine.
    ['iterCount', 10, false],
    ['stepsPerFrame', 160, false],
    ['voltageRange', 5, false],
    ['powerRange', 50, false],
    ['currentSpeed', 50, false],
    ['showCurrent', true, false],
    ['showValues', true, false],
    ['showVoltageColor', true, false],
    ['showPowerColor', true, false],
    ['showGrid', true, false],
    ['editable', false, false],
    // Toggling the wheel value stepper changes only which gesture the wheel
    // serves, never the netlist, so it must not restart the simulation.
    ['mouseWheelEdit', false, false],
    // Dot direction is a per-frame render argument like showCurrent; flipping
    // it must not restart the simulation.
    ['conventional', false, false],
    // The resistor symbol is pure draw-mode like conventional; the choice must
    // not restart the simulation.
    ['euroResistors', false, false],
    // The gate symbol toggle is pure draw-mode like euroResistors; the choice
    // must not restart the simulation.
    ['euroGates', false, false],
    ['showCrosshair', true, false],
    // The hitbox overlay is a draw-only diagnostic; switching it on must not
    // restart the simulation any more than the crosshair does.
    ['showHitboxes', true, false],
    ['valueFontSize', 14, false],
    ['shortDecimalDigits', 2, false],
    ['decimalDigits', 4, false],
    ['wheelSensitivity', 2, false],
    ['positiveColor', '#ff0000', false],
    ['negativeColor', '#00ff00', false],
    ['neutralColor', '#888888', false],
    ['selectionColor', '#00ffff', false],
    ['currentColor', '#ffff00', false],
  ] as const)('%s reloads=%s', (key, value, reload) => {
    const before = useStore.getState().revision;
    useStore.getState().updateSettings({ [key]: value } as Partial<SimSettings>);
    expect(useStore.getState().revision - before).toBe(reload ? 1 : 0);
  });

  it('keeps the two colour modes mutually exclusive without reloading', () => {
    // Turning power on flips voltage off, and vice versa, mirroring upstream's
    // menu toggles (Menus.java:190-197). Neither is a rebuild reason, so the
    // simulation keeps running through the mode flip.
    const before = useStore.getState().revision;
    useStore.getState().updateSettings({ showPowerColor: true });
    let s = useStore.getState();
    expect(s.settings.showPowerColor).toBe(true);
    expect(s.settings.showVoltageColor).toBe(false);
    expect(s.revision).toBe(before);

    useStore.getState().updateSettings({ showVoltageColor: true });
    s = useStore.getState();
    expect(s.settings.showVoltageColor).toBe(true);
    expect(s.settings.showPowerColor).toBe(false);
    expect(s.revision).toBe(before);
  });
});

describe('resetSettings', () => {
  it('puts the dialog\'s settings back to their defaults', () => {
    useStore.getState().updateSettings({
      timeStep: 1e-4,
      stepsPerFrame: 320,
      voltageRange: 20,
      showGrid: true,
      showValues: false,
      conventional: false,
      positiveColor: '#ff0000',
      wheelSensitivity: 4,
      valueFontSize: 20,
    });

    useStore.getState().resetSettings();

    const s = useStore.getState().settings;
    expect(s.timeStep).toBe(DEFAULT_SETTINGS.timeStep);
    expect(s.stepsPerFrame).toBe(DEFAULT_SETTINGS.stepsPerFrame);
    expect(s.voltageRange).toBe(DEFAULT_SETTINGS.voltageRange);
    expect(s.showGrid).toBe(DEFAULT_SETTINGS.showGrid);
    expect(s.showValues).toBe(DEFAULT_SETTINGS.showValues);
    expect(s.conventional).toBe(DEFAULT_SETTINGS.conventional);
    expect(s.positiveColor).toBeNull();
    expect(s.wheelSensitivity).toBe(DEFAULT_SETTINGS.wheelSensitivity);
    expect(s.valueFontSize).toBe(DEFAULT_SETTINGS.valueFontSize);
  });

  it('leaves the settings the dialog does not show alone', () => {
    // Read-only mode, the symbol standards, the wheel stepper and the hitbox
    // overlay live behind other menus: a reset in Other Options must not reach
    // across and re-enable editing on a circuit shared read-only.
    useStore.getState().updateSettings({
      editable: false,
      euroResistors: false,
      euroGates: false,
      mouseWheelEdit: false,
      showHitboxes: true,
      iterCount: 42,
    });

    useStore.getState().resetSettings();

    const s = useStore.getState().settings;
    expect(s.editable).toBe(false);
    expect(s.euroResistors).toBe(false);
    expect(s.euroGates).toBe(false);
    expect(s.mouseWheelEdit).toBe(false);
    expect(s.showHitboxes).toBe(true);
    expect(s.iterCount).toBe(42);
  });

  it('rebuilds once, because the timestep is among the keys it restores', () => {
    useStore.getState().updateSettings({ timeStep: 1e-4 });
    const before = useStore.getState().revision;
    useStore.getState().resetSettings();
    expect(useStore.getState().revision - before).toBe(1);
  });
});

describe('euroResistors persistence', () => {
  it('survives a simulated reload: updateSettings stores it, re-init reads it', () => {
    // Node has no localStorage, so inject one for the duration, exactly the
    // injected-storage pattern appPrefs.test.ts uses.
    const map = new Map<string, string>();
    (globalThis as { localStorage?: StorageLike }).localStorage = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
    };
    try {
      useStore.getState().updateSettings({ euroResistors: false });
      const blob = JSON.parse(map.get(APP_PREF_STORAGE_KEY) ?? '{}') as Record<string, unknown>;
      expect(blob.euroResistors).toBe(false);
      // The store initialiser merges stored prefs over DEFAULT_SETTINGS; a
      // reload must therefore come back American.
      expect({ ...DEFAULT_SETTINGS, ...loadAppPrefs() }).toMatchObject({ euroResistors: false });
      // A default-ON fresh store stays European.
      expect(useStore.getState().settings.euroResistors).toBe(false);
    } finally {
      delete (globalThis as { localStorage?: StorageLike }).localStorage;
    }
  });
});

describe('euroGates persistence', () => {
  it('survives a simulated reload: updateSettings stores it, re-init reads it', () => {
    const map = new Map<string, string>();
    (globalThis as { localStorage?: StorageLike }).localStorage = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
    };
    try {
      useStore.getState().updateSettings({ euroGates: false });
      const blob = JSON.parse(map.get(APP_PREF_STORAGE_KEY) ?? '{}') as Record<string, unknown>;
      expect(blob.euroGates).toBe(false);
      // The store initialiser merges stored prefs over DEFAULT_SETTINGS, so a
      // reload comes back ANSI and a default store stays IEC.
      expect({ ...DEFAULT_SETTINGS, ...loadAppPrefs() }).toMatchObject({ euroGates: false });
      expect(useStore.getState().settings.euroGates).toBe(false);
    } finally {
      delete (globalThis as { localStorage?: StorageLike }).localStorage;
    }
    // A default store keeps the IEC gate shapes (the port deliberately
    // diverges from GateElm.useEuroGates).
    expect(DEFAULT_SETTINGS.euroGates).toBe(true);
  });
});

describe('showHitboxes debug toggle', () => {
  it('defaults off, toggles through updateSettings and persists', () => {
    const map = new Map<string, string>();
    (globalThis as { localStorage?: StorageLike }).localStorage = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
    };
    try {
      // The overlay is a diagnostic, so a fresh store must never show it.
      expect(DEFAULT_SETTINGS.showHitboxes).toBe(false);
      expect(useStore.getState().settings.showHitboxes).toBe(false);

      useStore.getState().updateSettings({ showHitboxes: true });
      expect(useStore.getState().settings.showHitboxes).toBe(true);
      const blob = JSON.parse(map.get(APP_PREF_STORAGE_KEY) ?? '{}') as Record<string, unknown>;
      expect(blob.showHitboxes).toBe(true);
      expect({ ...DEFAULT_SETTINGS, ...loadAppPrefs() }).toMatchObject({ showHitboxes: true });

      useStore.getState().updateSettings({ showHitboxes: false });
      expect(useStore.getState().settings.showHitboxes).toBe(false);
    } finally {
      delete (globalThis as { localStorage?: StorageLike }).localStorage;
    }
  });

  it('is draw-only: the toggle changes nothing the netlist or a pick can see', () => {
    const id = useStore.getState().addElement(makeElement('resistor', 0, 0, 64, 0));
    useStore.getState().select([id]);
    const before = serializeCircuit(useStore.getState().elements, useStore.getState().settings);
    const revision = useStore.getState().revision;

    useStore.getState().updateSettings({ showHitboxes: true });

    const after = serializeCircuit(useStore.getState().elements, useStore.getState().settings);
    expect(after).toBe(before);
    expect(useStore.getState().revision).toBe(revision);
    expect(useStore.getState().selectedIds).toEqual([id]);
    // The picker reads the elements, never the setting, so the same click
    // still lands on the same element with the overlay on.
    expect(hitTestElement({ x: 32, y: 0 }, useStore.getState().elements, 1)?.id).toBe(id);
  });
});

describe('mouseWheelEdit persistence', () => {
  it('defaults on, toggles through updateSettings and persists', () => {
    const map = new Map<string, string>();
    (globalThis as { localStorage?: StorageLike }).localStorage = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
    };
    try {
      // Upstream defaults the wheel value stepper on (UIManager.java:143).
      expect(DEFAULT_SETTINGS.mouseWheelEdit).toBe(true);
      expect(useStore.getState().settings.mouseWheelEdit).toBe(true);

      useStore.getState().updateSettings({ mouseWheelEdit: false });
      expect(useStore.getState().settings.mouseWheelEdit).toBe(false);
      const blob = JSON.parse(map.get(APP_PREF_STORAGE_KEY) ?? '{}') as Record<string, unknown>;
      expect(blob.mouseWheelEdit).toBe(false);
      expect({ ...DEFAULT_SETTINGS, ...loadAppPrefs() }).toMatchObject({ mouseWheelEdit: false });

      useStore.getState().updateSettings({ mouseWheelEdit: true });
      expect(useStore.getState().settings.mouseWheelEdit).toBe(true);
    } finally {
      delete (globalThis as { localStorage?: StorageLike }).localStorage;
    }
  });
});

describe('recover auto-save', () => {
  const RECOVERY = `$ 1 0.000005 10.2 50 5 43 5e-11
r 0 0 16 0 0 100
`;

  /** Puts a recovery into the (absent, under node) browser storage. */
  const withRecovery = (text: string) => {
    const map = new Map<string, string>([[RECOVERY_STORAGE_KEY, text]]);
    (globalThis as { localStorage?: StorageLike }).localStorage = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
    };
  };

  it('hasRecovery initialises true when a recovery is stored and false otherwise', () => {
    try {
      withRecovery(RECOVERY);
      // The store initialiser computes hasRecovery from readRecovery() once at
      // module load; re-running that expression against the injected storage
      // is what a page reload of the store would read.
      useStore.setState({ ...fresh(), hasRecovery: readRecovery() !== null });
      expect(useStore.getState().hasRecovery).toBe(true);
    } finally {
      delete (globalThis as { localStorage?: StorageLike }).localStorage;
    }
    useStore.setState(fresh());
    expect(useStore.getState().hasRecovery).toBe(false);
  });

  it('recoverAutoSave loads the recovery, pushes exactly one undo entry and disables the row', () => {
    try {
      withRecovery(RECOVERY);
      addResistor(); // a pre-recovery circuit to undo back to
      useStore.setState({ hasRecovery: true });
      useStore.getState().recoverAutoSave();
      const s = useStore.getState();
      expect(s.elements).toHaveLength(1);
      expect(s.elements[0].params.resistance).toBe(100);
      expect(s.hasRecovery).toBe(false);
      expect(s.undoStack).toHaveLength(1);
      // Undo restores the pre-recovery circuit, not the empty baseline.
      s.undo();
      expect(useStore.getState().elements[0].params.resistance).toBe(1000);
    } finally {
      delete (globalThis as { localStorage?: StorageLike }).localStorage;
    }
  });

  it('a recovered circuit counts as unsaved until the user exports', () => {
    try {
      withRecovery(RECOVERY);
      useStore.getState().recoverAutoSave();
      const s = useStore.getState();
      expect(hasUnsavedChanges(s.lastSaved, s.toNetlist())).toBe(true);
      s.markSaved();
      expect(hasUnsavedChanges(useStore.getState().lastSaved, s.toNetlist())).toBe(false);
    } finally {
      delete (globalThis as { localStorage?: StorageLike }).localStorage;
    }
  });

  it('without a recovery recoverAutoSave is a no-op', () => {
    addResistor();
    const before = useStore.getState();
    useStore.getState().recoverAutoSave();
    const s = useStore.getState();
    expect(s.undoStack).toHaveLength(before.undoStack.length);
    expect(s.revision).toBe(before.revision);
    expect(s.hasRecovery).toBe(false);
    expect(s.elements[0].params.resistance).toBe(1000);
  });

  it('undo after a recovery restores the pre-recovery unmatchedScopes, not the recovered file\'s', () => {
    // Both files carry a normal resistor plus an `o` line whose element index
    // (5) does not resolve to any element line this build read, the same
    // "index lands on an element line this build could not read" shape
    // unmatchedScopes exists for. Each lands its own entry there.
    const PRE_RECOVERY = [
      '$ 1 0.000005 10.2 50 5 43 5e-11',
      'r 0 0 16 0 0 100',
      'o 5 64 0 4099 20 0.05 0 2 4 3',
      '',
    ].join('\n');
    const RECOVERY = [
      '$ 1 0.000005 10.2 50 5 43 5e-11',
      'r 0 0 16 0 0 200',
      'o 5 64 0 4099 20 0.05 0 2 4 7',
      '',
    ].join('\n');
    try {
      withRecovery(RECOVERY);
      useStore.getState().loadNetlist(PRE_RECOVERY);
      const preUnmatched = useStore.getState().unmatchedScopes;
      expect(preUnmatched).toHaveLength(1);
      useStore.setState({ hasRecovery: true });

      useStore.getState().recoverAutoSave();
      const recovered = useStore.getState();
      expect(recovered.unmatchedScopes).toHaveLength(1);
      expect(recovered.unmatchedScopes[0].raw).not.toEqual(preUnmatched[0].raw);

      recovered.undo();
      const afterUndo = useStore.getState();
      // The pre-recovery unmatched scope is back, not the recovered file's.
      expect(afterUndo.unmatchedScopes).toEqual(preUnmatched);

      // A subsequent save must serialise the pre-recovery unmatched o line,
      // not the recovered file's, proving the round trip actually closes.
      const saved = afterUndo.toNetlist();
      expect(saved).toContain('o 5 64 0 4099 20 0.05 0 2 4 3');
      expect(saved).not.toContain('o 5 64 0 4099 20 0.05 0 2 4 7');
    } finally {
      delete (globalThis as { localStorage?: StorageLike }).localStorage;
    }
  });

  it('a clean load keeps the previous session recovery, a real edit overwrites it', () => {
    vi.useFakeTimers();
    const map = new Map<string, string>([[RECOVERY_STORAGE_KEY, 'stale recovery']]);
    const storage: RecoveryStorage = {
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => void map.set(k, v),
      removeItem: (k) => void map.delete(k),
    };
    let stop: (() => void) | null = null;
    try {
      stop = startAutoSave(
        () => useStore,
        () => useStore.getState().toNetlist(),
        { storage, delayMs: 1000, now: () => 0 },
      );
      // The startup path: loadNetlist bumps revision, so the watcher fires,
      // but a clean circuit must not clobber the stale slot.
      useStore.getState().loadNetlist('$ 1 0.000005 10.2 50 5 43 5e-11\nr 0 0 16 0 0 100\n');
      vi.advanceTimersByTime(5000);
      expect(map.get(RECOVERY_STORAGE_KEY)).toBe('stale recovery');
      // A real edit dirties the circuit and must land in the slot.
      addResistor();
      vi.advanceTimersByTime(5000);
      expect(map.get(RECOVERY_STORAGE_KEY)).toContain('r 0 0 160 0 0 1000');
    } finally {
      stop?.();
      vi.useRealTimers();
    }
  });
});

describe('simulation settings', () => {
  it('DEFAULT_SETTINGS carries the new keys with upstream values', () => {
    expect(DEFAULT_SETTINGS.showCrosshair).toBe(false);
    // European symbols are the port's default (upstream's non-US default).
    expect(DEFAULT_SETTINGS.euroResistors).toBe(true);
    // The gates default IEC too, deliberately diverging from upstream's
    // non-German locale default (GateElm.useEuroGates) so a default schematic
    // is IEC throughout.
    expect(DEFAULT_SETTINGS.euroGates).toBe(true);
    // The two symbol toggles must agree, or a default schematic draws in two
    // standards.
    expect(DEFAULT_SETTINGS.euroResistors).toBe(DEFAULT_SETTINGS.euroGates);
    expect(DEFAULT_SETTINGS.valueFontSize).toBe(12);
    expect(DEFAULT_SETTINGS.shortDecimalDigits).toBe(1);
    expect(DEFAULT_SETTINGS.decimalDigits).toBe(3);
    expect(DEFAULT_SETTINGS.wheelSensitivity).toBe(1);
    expect(DEFAULT_SETTINGS.positiveColor).toBeNull();
    expect(DEFAULT_SETTINGS.negativeColor).toBeNull();
    expect(DEFAULT_SETTINGS.neutralColor).toBeNull();
    expect(DEFAULT_SETTINGS.selectionColor).toBeNull();
    expect(DEFAULT_SETTINGS.currentColor).toBeNull();
  });

  it('keeps the settings object a flat, JSON-serializable shape', () => {
    const s = useStore.getState().settings;
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });

  it('preserves header flag bit 2 through a load and save', () => {
    // The small-grid option is gone, but a file saved with upstream's bit 2
    // must come back with the bit still set: the byte upstream wrote is the
    // byte the port writes. Bit 2 is decoded into nothing, just parked in the
    // headerFlags passthrough.
    useStore.getState().loadNetlist('$ 3 0.000005 10 50 5 43 5e-11\nr 0 0 16 0 0 100\n');
    expect(Number(useStore.getState().settings.headerFlags) & 2).toBe(2);
    expect(useStore.getState().toNetlist().split('\n')[0]).toBe('$ 3 0.000005 10 50 5 43 5e-11');
    useStore.getState().loadNetlist('$ 1 0.000005 10 50 5 43 5e-11\nr 0 0 16 0 0 100\n');
    expect(Number(useStore.getState().settings.headerFlags ?? 0) & 2).toBe(0);
    expect(useStore.getState().toNetlist().split('\n')[0]).toBe('$ 1 0.000005 10 50 5 43 5e-11');
  });

  it('newCircuit resets circuit settings but keeps app prefs and plain settings', () => {
    // autoDC is header-borne (a circuit setting), positiveColor an app pref,
    // stepsPerFrame a plain setting: New resets only the first.
    useStore.getState().updateSettings({ autoDC: true, positiveColor: '#123456' });
    useStore.getState().updateSettings({ stepsPerFrame: 320 });
    useStore.getState().newCircuit();
    const s = useStore.getState().settings;
    expect(s.autoDC).toBe(false);
    expect(s.showCurrent).toBe(true);
    expect(s.positiveColor).toBe('#123456');
    expect(s.stepsPerFrame).toBe(320);
  });

  it('grid spacing is a constant even on a small-grid file', () => {
    // The small-grid option is gone, so a file that sets upstream's header bit
    // 2 must not change the snap step: placement and drag still land on 16.
    useStore.getState().loadNetlist('$ 3 0.000005 10 50 5 43 5e-11\nr 0 0 16 0 0 100\n');
    expect(Number(useStore.getState().settings.headerFlags) & 2).toBe(2);
    // Place: the pointer is snapped to the grid before the element is created,
    // exactly as the interaction does (useCanvasInteractions.ts:371-373).
    const x = snap(7.5, GRID_SIZE);
    const y = snap(23.25, GRID_SIZE);
    const id = useStore.getState().addElement(makeToolElement('resistor', x, y, x + GRID_SIZE, y));
    let e = useStore.getState().elements.find((el) => el.id === id)!;
    expect([e.x1, e.y1, e.x2, e.y2].every((v) => v % GRID_SIZE === 0)).toBe(true);
    // Drag: each pointer is snapped before its delta is taken, as the move
    // handler does (useCanvasInteractions.ts:534-535), so the stored
    // coordinates stay on 16-multiples.
    const from = snap(7.5, GRID_SIZE);
    const to = snap(59.3, GRID_SIZE);
    useStore.getState().moveElements([id], to - from, 0);
    e = useStore.getState().elements.find((el) => el.id === id)!;
    expect([e.x1, e.y1, e.x2, e.y2].every((v) => v % GRID_SIZE === 0)).toBe(true);
  });
});

describe('load resets the header stepping fields to their defaults', () => {
  it('a file that stops before minTimeStep does not inherit the previous file', () => {
    useStore.getState().loadNetlist('$ 0 0.000005 10 50 5 50 1e-9\nr 0 0 16 0 0 100\n');
    expect(useStore.getState().settings.minTimeStep).toBe(1e-9);

    useStore.getState().loadNetlist('$ 0 5e-6 10 50 5\nr 0 0 16 0 0 100\n');
    expect(useStore.getState().settings.minTimeStep).toBe(DEFAULT_SETTINGS.minTimeStep);
    expect(useStore.getState().settings.iterCount).toBe(DEFAULT_SETTINGS.iterCount);
    // A file with no adaptive flag loads as fixed-step, which is also the
    // default, so the header fields fall back to DEFAULT_SETTINGS.
    expect(useStore.getState().settings.adaptiveTimeStep).toBe(false);
  });

  it('a header without flag 128 loads with autoDC off, matching upstream', () => {
    useStore.getState().loadNetlist('$ 0 0.000005 10 50 5 50 1e-9\nr 0 0 16 0 0 100\n');
    expect(useStore.getState().settings.autoDC).toBe(false);

    // And one with the bit set loads with it on.
    useStore.getState().loadNetlist('$ 128 0.000005 10 50 5 50 1e-9\nr 0 0 16 0 0 100\n');
    expect(useStore.getState().settings.autoDC).toBe(true);
  });
});

describe('diode model name', () => {
  it('editing a value drops the model name', () => {
    const [loaded] = parseCircuit('d 176 80 384 80 2 1N4148').elements;
    expect(loaded.modelName).toBe('1N4148');
    useStore.getState().addElement(loaded);
    const id = useStore.getState().elements[0].id;
    expect(useStore.getState().elements[0].modelName).toBe('1N4148');

    useStore.getState().setParam(id, 'forwardVoltage', 0.9);

    const e = useStore.getState().elements[0];
    expect(e.modelName).toBeUndefined();
    expect(e.params.forwardVoltage).toBe(0.9);
  });

  it('editing the zener voltage drops the model name', () => {
    const [loaded] = parseCircuit('z 100 100 100 0 2 default-zener').elements;
    expect(loaded.modelName).toBe('default-zener');
    useStore.getState().addElement(loaded);
    const id = useStore.getState().elements[0].id;

    useStore.getState().setParam(id, 'breakdownVoltage', 6.2);
    const e = useStore.getState().elements[0];
    expect(e.modelName).toBeUndefined();
    expect(e.params.breakdownVoltage).toBe(6.2);

    const line =
      serializeCircuit(useStore.getState().elements, { ...DEFAULT_SETTINGS })
        .trim()
        .split('\n')
        .find((l) => l.startsWith('z ')) ?? '';
    // The value form, not the stale name, and FLAG_MODEL is cleared so a
    // reload reads the tokens as numbers rather than a bogus model name.
    expect(line).toBe('z 100 100 100 0 1 0.805904783 6.2');
  });

  it('keeps the model name when a non-model param is edited', () => {
    const [loaded] = parseCircuit('d 176 80 384 80 2 1N4148').elements;
    useStore.getState().addElement(loaded);
    const id = useStore.getState().elements[0].id;

    useStore.getState().setParam(id, 'resistance', 5);

    expect(useStore.getState().elements[0].modelName).toBe('1N4148');
  });

  it('load-edit-save-reload keeps the edit as a value, not a stale model name', () => {
    // Regression: the value form used to keep FLAG_MODEL (bit 2) from the
    // loaded line, so a reload read the fwdrop token as a bogus model name and
    // silently lost the edit.
    const [loaded] = parseCircuit('d 176 80 384 80 2 1N4148').elements;
    useStore.getState().addElement(loaded);
    const id = useStore.getState().elements[0].id;

    useStore.getState().setParam(id, 'forwardVoltage', 0.9);
    expect(useStore.getState().elements[0].modelName).toBeUndefined();

    const line =
      serializeCircuit(useStore.getState().elements, { ...DEFAULT_SETTINGS })
        .trim()
        .split('\n')
        .find((l) => l.startsWith('d ')) ?? '';
    expect(line).toBe('d 176 80 384 80 1 0.9');

    const [again] = parseCircuit(line).elements;
    expect(again.params.forwardVoltage).toBe(0.9);
    expect(again.modelName).toBeUndefined();
  });

  it('editing the zener forward drop drops the model name', () => {
    // The generated-name form upstream writes for a 0.7 V 6.2 V zener, plus
    // the `34` model line it depends on. After resolution the element carries
    // the model's params, including the 6.2 V breakdown; without the line the
    // baked breakdown stays 5.6, so the `34` line is part of the fixture.
    const text = [
      'z 100 100 100 0 2 fwdrop\\q0.7\\szvoltage\\q6.2',
      '34 fwdrop\\q0.7\\szvoltage\\q6.2 0 1.328e-6 0 2 6.2 0',
    ].join('\n');
    const [loaded] = parseCircuit(text).elements;
    expect(loaded.modelName).toBe('fwdrop=0.7 zvoltage=6.2');
    expect(loaded.params.breakdownVoltage).toBe(6.2);
    useStore.getState().addElement(loaded);
    const id = useStore.getState().elements[0].id;

    useStore.getState().setParam(id, 'forwardVoltage', 0.65);

    const e = useStore.getState().elements[0];
    expect(e.modelName).toBeUndefined();
    expect(e.params.forwardVoltage).toBe(0.65);

    const line =
      serializeCircuit(useStore.getState().elements, { ...DEFAULT_SETTINGS })
        .trim()
        .split('\n')
        .find((l) => l.startsWith('z ')) ?? '';
    expect(line).toBe('z 100 100 100 0 1 0.65 6.2');
  });

  it('editing the zener series resistance drops the model name and saves the value form', () => {
    // Series resistance is a new zener field whose live edit the engine
    // declines (diode.rs:419), so the frame loop falls back to a full
    // rebuild. The store contract is the same as the diode's: the params
    // update, the stale model name goes, and the save writes the value form
    // carrying the model's real derived forward drop.
    const text = [
      'z 100 100 100 0 2 fwdrop\\q0.7\\szvoltage\\q6.2',
      '34 fwdrop\\q0.7\\szvoltage\\q6.2 0 1.328e-6 0 2 6.2 0',
    ].join('\n');
    const [loaded] = parseCircuit(text).elements;
    useStore.getState().addElement(loaded);
    const id = useStore.getState().elements[0].id;

    useStore.getState().setParam(id, 'seriesResistance', 0.2);

    const s = useStore.getState();
    const e = s.elements[0];
    expect(e.modelName).toBeUndefined();
    expect(e.params.seriesResistance).toBe(0.2);
    expect(s.pendingParams.get(`${id}:seriesResistance`)).toEqual({
      id,
      name: 'seriesResistance',
      value: 0.2,
    });

    const line =
      serializeCircuit(s.elements, { ...DEFAULT_SETTINGS })
        .trim()
        .split('\n')
        .find((l) => l.startsWith('z ')) ?? '';
    expect(line).toBe('z 100 100 100 0 1 0.7000019711998504 6.2');
  });

  it('editing a varactor model value drops the model name', () => {
    // The varactor shares the diode machinery upstream, so a stale name
    // re-applies the model on the next reload and silently discards the
    // edit. This pins the lifecycle fix in store.setParam.
    const text = ['176 100 100 100 0 2 myvar 0 4e-12', '34 myvar 0 1.328e-6 0 2 0 0'].join('\n');
    const [loaded] = parseCircuit(text).elements;
    expect(loaded.modelName).toBe('myvar');
    useStore.getState().addElement(loaded);
    const id = useStore.getState().elements[0].id;

    useStore.getState().setParam(id, 'forwardVoltage', 0.65);

    const e = useStore.getState().elements[0];
    expect(e.modelName).toBeUndefined();
    expect(e.params.forwardVoltage).toBe(0.65);
  });

  it('editing an LED model value drops the model name', () => {
    // Once LEDs resolve named models, a stale `default-led` name re-applies
    // the model on the next reload and silently discards a forward-drop edit.
    // This pins the LED's place in the store name-drop kind check.
    const [loaded] = parseCircuit('162 0 0 100 0 2 default-led 1 0 0 0.01').elements;
    expect(loaded.modelName).toBe('default-led');
    useStore.getState().addElement(loaded);
    const id = useStore.getState().elements[0].id;

    useStore.getState().setParam(id, 'forwardVoltage', 2.5);

    const e = useStore.getState().elements[0];
    expect(e.modelName).toBeUndefined();
    expect(e.params.forwardVoltage).toBe(2.5);
  });

  it('setModelName sets the name, re-resolves params and bumps revision', () => {
    // A model-name pick sets the name and writes the built-in table's params
    // into the element, then bumps `revision` so the engine rebuilds: model
    // params are read at build time and can change the stamp or the node
    // count, so the live set_param path is not safe here.
    const [loaded] = parseCircuit('d 176 80 384 80 0 0.805904783').elements;
    useStore.getState().addElement(loaded);
    const id = useStore.getState().elements[0].id;
    const before = useStore.getState();

    useStore.getState().setModelName(id, '1N4148');

    const e = useStore.getState().elements[0];
    expect(e.modelName).toBe('1N4148');
    expect(e.params.saturationCurrent).toBe(4.352e-9);
    expect(e.params.seriesResistance).toBe(0.6458);
    expect(e.params.emissionCoefficient).toBe(1.906);
    expect(e.params.forwardVoltage).toBeCloseTo(0.9491294544092825, 10);
    const after = useStore.getState();
    expect(after.revision).toBe(before.revision + 1);
    // A full rebuild, not a set_param patch.
    expect(after.paramRevision).toBe(before.paramRevision);
    expect(after.pendingParams.size).toBe(0);
  });

  it('setModelName with an empty string deletes the name and saves the value form', () => {
    // The name-free value form: the derived forward drop the resolution wrote
    // is what a save dumps once the name goes.
    const [loaded] = parseCircuit('d 176 80 384 80 2 1N4148').elements;
    useStore.getState().addElement(loaded);
    const id = useStore.getState().elements[0].id;
    expect(useStore.getState().elements[0].params.forwardVoltage).toBeCloseTo(
      0.9491294544092825,
      10,
    );

    useStore.getState().setModelName(id, '');

    const e = useStore.getState().elements[0];
    expect(e.modelName).toBeUndefined();
    const line =
      serializeCircuit(useStore.getState().elements, { ...DEFAULT_SETTINGS })
        .trim()
        .split('\n')
        .find((l) => l.startsWith('d ')) ?? '';
    expect(line).toBe('d 176 80 384 80 1 0.9491294544092825');
  });

  it('setModelName with an unknown name keeps the current params', () => {
    // A miss behaves like a load-time fallback: the name is stored (it
    // round-trips) but the params stay untouched.
    const [loaded] = parseCircuit('d 176 80 384 80 0 0.805904783').elements;
    useStore.getState().addElement(loaded);
    const id = useStore.getState().elements[0].id;
    useStore.getState().setModelName(id, 'not-a-model');
    const e = useStore.getState().elements[0];
    expect(e.modelName).toBe('not-a-model');
    expect(e.params.forwardVoltage).toBe(0.805904783);
    expect(e.params.saturationCurrent).toBeUndefined();
  });
});

describe('the integer-coordinate invariant', () => {
  it('a snap-off drag never produces fractional posts', () => {
    // This is the drag that used to feed `[17.3, 8]` to serde's `[i32; 2]`.
    const id = addResistor();
    useStore.getState().select([id]);

    for (let i = 0; i < 10; i++) {
      useStore.getState().moveElements([id], 0.3, 1.7);
    }

    const e = useStore.getState().elements[0];
    expect([e.x1, e.y1, e.x2, e.y2].every(Number.isInteger)).toBe(true);
    // The engine sees postsOf, so the posts must be integral too.
    expect(postsOf(e).every((p) => Number.isInteger(p.x) && Number.isInteger(p.y))).toBe(true);
  });

  it('a group move keeps its internal spacing', () => {
    // Delta rounding rather than per-coordinate rounding: both resistors must
    // land on the same rounded offset, so their relative geometry is intact.
    const a = useStore.getState().addElement({
      kind: 'resistor',
      x1: 0,
      y1: 0,
      x2: 160,
      y2: 0,
      flags: 0,
      params: { resistance: 1000 },
    });
    const b = useStore.getState().addElement({
      kind: 'resistor',
      x1: 176,
      y1: 0,
      x2: 336,
      y2: 0,
      flags: 0,
      params: { resistance: 1000 },
    });
    const elements = () => useStore.getState().elements;
    const before = Math.abs(
      elements().find((x) => x.id === a)!.x1 - elements().find((x) => x.id === b)!.x1,
    );

    useStore.getState().moveElements([a, b], 2.3, 0.7);

    const after = Math.abs(
      elements().find((x) => x.id === a)!.x1 - elements().find((x) => x.id === b)!.x1,
    );
    expect(after).toBe(before);
    for (const id of [a, b]) {
      const e = elements().find((x) => x.id === id)!;
      expect([e.x1, e.y1, e.x2, e.y2].every(Number.isInteger)).toBe(true);
    }
  });

  it('placement rounds fractional coordinates even with snap off', () => {
    const e = makeElement('resistor', 0.4, 1.6, 32.5, 1.5);
    expect([e.x1, e.y1, e.x2, e.y2]).toEqual([0, 2, 33, 2]);
    expect([e.x1, e.y1, e.x2, e.y2].every(Number.isInteger)).toBe(true);
  });

  it('updateElement rounds geometry and passes non-geometry patches through', () => {
    const id = addResistor();
    useStore.getState().updateElement(id, { x2: 80.5, y1: -3.4 });
    let e = useStore.getState().elements[0];
    expect(e.x2).toBe(81); // Math.round(80.5)
    expect(e.y1).toBe(-3);

    useStore.getState().updateElement(id, { flags: 2 });
    e = useStore.getState().elements[0];
    expect(e.flags).toBe(2);
    expect(e.x1).toBe(0); // untouched geometry stays untouched
  });

  it('setParam rejects NaN and Infinity outright', () => {
    const id = addResistor();
    const before = useStore.getState();

    useStore.getState().setParam(id, 'resistance', NaN);
    useStore.getState().setParam(id, 'voltage', Infinity);

    const after = useStore.getState();
    expect(after.elements[0].params.resistance).toBe(1000);
    expect(after.elements[0].params.voltage).toBeUndefined();
    expect(after.pendingParams.size).toBe(0);
    expect(after.paramRevision).toBe(before.paramRevision);
  });
});

describe('controlled-source input count edits are normalised', () => {
  const addControlled = (kind: string) =>
    useStore.getState().addElement({
      kind,
      x1: 0,
      y1: 0,
      x2: 96,
      y2: 0,
      flags: 0,
      params: { inputCount: 2 },
    });

  it.each([
    ['vcvs', 2.5, 2],
    ['vccs', 2.5, 2],
    ['ccvs', 2.5, 2],
    ['cccs', 2.5, 2],
  ])('setParam truncates a fractional %s input count to the engine integer', (kind, given, expected) => {
    // The "# of Inputs" range slider can land on a fraction. The engine
    // truncates it to an integer post count (`(x as i64)` in the
    // controlled-source constructors), so the store must write back the same
    // integer or a rebuild trips the post-count guard and the circuit never
    // comes back (circuit.rs:261-269).
    const id = addControlled(kind);
    useStore.getState().setParam(id, 'inputCount', given);
    const after = useStore.getState();
    const e = after.elements.find((x) => x.id === id);
    expect(e?.params.inputCount).toBe(expected);
    expect(after.pendingParams.get(`${id}:inputCount`)?.value).toBe(expected);
  });

  it('clamps the boundary counts to the engine 1..8 range on edit', () => {
    const id = addControlled('vcvs');
    useStore.getState().setParam(id, 'inputCount', 0.5);
    expect(useStore.getState().elements.find((e) => e.id === id)?.params.inputCount).toBe(1);
    useStore.getState().setParam(id, 'inputCount', 9.5);
    expect(useStore.getState().elements.find((e) => e.id === id)?.params.inputCount).toBe(8);
  });
});

describe('gate input count edits are normalised', () => {
  const addGate = (kind: string) =>
    useStore.getState().addElement({
      kind,
      x1: 0,
      y1: 0,
      x2: 96,
      y2: 0,
      flags: 0,
      params: { inputCount: 2 },
    });

  it.each([
    ['andGate', 2.5, 2],
    ['nandGate', 2.5, 2],
    ['orGate', 2.5, 2],
    ['norGate', 2.5, 2],
    ['xorGate', 2.5, 2],
    ['xnorGate', 2.5, 2],
  ])('setParam truncates a fractional %s input count to the engine integer', (kind, given, expected) => {
    // The "# of Inputs" range slider can land on a fraction. The engine
    // truncates it to an integer post count (`(x as i64)` in logic.rs:76), so
    // the store must write back the same integer or a rebuild trips the
    // post-count guard and the circuit never comes back (circuit.rs:261-269).
    const id = addGate(kind);
    useStore.getState().setParam(id, 'inputCount', given);
    const after = useStore.getState();
    const e = after.elements.find((x) => x.id === id);
    expect(e?.params.inputCount).toBe(expected);
    expect(after.pendingParams.get(`${id}:inputCount`)?.value).toBe(expected);
  });

  it('clamps the boundary counts to the engine 1..8 range on edit', () => {
    const id = addGate('andGate');
    useStore.getState().setParam(id, 'inputCount', 0.5);
    expect(useStore.getState().elements.find((e) => e.id === id)?.params.inputCount).toBe(1);
    useStore.getState().setParam(id, 'inputCount', 9.5);
    expect(useStore.getState().elements.find((e) => e.id === id)?.params.inputCount).toBe(8);
  });
});

describe('multiplexer select-bit edits are normalised', () => {
  const addChip = (kind: string) =>
    useStore.getState().addElement({
      kind,
      x1: 0,
      y1: 0,
      x2: 192,
      y2: 0,
      flags: 0,
      params: kind === 'deMultiplexer' ? { selectBits: 2 } : { bits: 2 },
    });

  it.each([
    ['multiplexer', 'bits', 2.5, 2],
    ['deMultiplexer', 'selectBits', 2.5, 3],
  ])('setParam normalises a fractional %s select-bit count to the engine integer', (kind, name, given, expected) => {
    // The "# of Select Bits" number field can land on a fraction. The engine
    // truncates the multiplexer's count and rounds the demultiplexer's to a
    // channel count, so the store must write back the same integer or a
    // rebuild trips the post-count guard and the circuit never comes back
    // (circuit.rs:261-269).
    const id = addChip(kind);
    useStore.getState().setParam(id, name, given);
    const after = useStore.getState();
    const e = after.elements.find((x) => x.id === id);
    expect(e?.params[name]).toBe(expected);
    expect(after.pendingParams.get(`${id}:${name}`)?.value).toBe(expected);
  });

  it('clamps the boundary select-bit counts to the engine range on edit', () => {
    const mux = addChip('multiplexer');
    useStore.getState().setParam(mux, 'bits', 0.5);
    expect(useStore.getState().elements.find((e) => e.id === mux)?.params.bits).toBe(1);
    useStore.getState().setParam(mux, 'bits', 6.5);
    expect(useStore.getState().elements.find((e) => e.id === mux)?.params.bits).toBe(6);

    const demux = addChip('deMultiplexer');
    // 0.4 rounds to 0, which the engine turns into the default 2
    // (de_multiplexer.rs:42-46); 0.5 rounds to 1. A negative count saturates
    // through the same default.
    useStore.getState().setParam(demux, 'selectBits', 0.4);
    expect(useStore.getState().elements.find((e) => e.id === demux)?.params.selectBits).toBe(2);
    useStore.getState().setParam(demux, 'selectBits', 7);
    expect(useStore.getState().elements.find((e) => e.id === demux)?.params.selectBits).toBe(6);
    useStore.getState().setParam(demux, 'selectBits', -1);
    expect(useStore.getState().elements.find((e) => e.id === demux)?.params.selectBits).toBe(2);
  });
});

describe('chip bit-width edits are normalised', () => {
  const addChip = (kind: string) =>
    useStore.getState().addElement({
      kind,
      x1: 0,
      y1: 0,
      x2: 192,
      y2: 0,
      flags: 0,
      params: { bits: 4 },
    });

  it.each([
    ['adc', 2],
    ['dac', 2],
    ['decimalDisplay', 2],
    ['latch', 2],
    ['counter', 3],
    ['ringCounter', 2],
  ])('setParam truncates a fractional %s bit count to the engine integer', (kind, expected) => {
    // The "# of Bits" number field can land on a fraction. Every one of these
    // engines derives its width with an `(x as usize)` cast, which truncates
    // (adc.rs:28, dac.rs:36, decimal_display.rs:24, latch.rs:40,
    // counter.rs:27, ring_counter.rs:26), so the store must write back the
    // truncated integer or a rebuild trips the post-count guard and the
    // circuit never comes back (circuit.rs:261-269).
    const id = addChip(kind);
    useStore.getState().setParam(id, 'bits', 2.5);
    const after = useStore.getState();
    const e = after.elements.find((x) => x.id === id);
    expect(e?.params.bits).toBe(expected);
    expect(after.pendingParams.get(`${id}:bits`)?.value).toBe(expected);
  });

  it('clamps the boundary bit counts to each engine range on edit', () => {
    // The engines clamp the truncated width to their own floor and ceiling
    // (`(x as usize).clamp/max`, the same lines as above): adc to 2..30,
    // decimal display to 1..8, the rest to just a floor. A negative or
    // non-finite value saturates to the floor through the usize cast to 0.
    const cases: [string, number, number][] = [
      ['adc', 1.5, 2],
      ['adc', 30.5, 30],
      ['adc', -1, 2],
      ['dac', 0.5, 1],
      ['dac', -1, 1],
      ['decimalDisplay', 0.5, 1],
      ['decimalDisplay', 8.5, 8],
      ['decimalDisplay', -1, 1],
      ['latch', 1.5, 2],
      ['latch', -1, 2],
      ['counter', 2.5, 3],
      ['counter', -1, 3],
      ['ringCounter', 1.5, 2],
      ['ringCounter', -1, 2],
    ];
    for (const [kind, given, expected] of cases) {
      const id = addChip(kind);
      useStore.getState().setParam(id, 'bits', given);
      expect(
        useStore.getState().elements.find((e) => e.id === id)?.params.bits,
        `${kind} bits ${given} should normalise to ${expected}`,
      ).toBe(expected);
    }
  });
});

describe('FieldDef.integer catch-all normalises every other counting field', () => {
  const add = (kind: string, params: Record<string, number>) =>
    useStore.getState().addElement({
      kind,
      x1: 0,
      y1: 0,
      x2: 160,
      y2: 0,
      flags: 0,
      params,
    });

  it.each([
    ['counter', { bits: 3, modulus: 10 }, 'modulus', 10.5, 11],
    ['counter2', { bits: 3, modulus: 10 }, 'modulus', 10.5, 11],
    ['dataRecorder', { dataCount: 1024 }, 'dataCount', 1024.5, 1025],
    ['relay', { poleCount: 2 }, 'poleCount', 2.5, 3],
    ['stopTrigger', { count: 1 }, 'count', 1.5, 2],
  ])(
    'setParam rounds a fractional %s %s to a whole number',
    (kind, params, name, given, expected) => {
      // A slider can hand these a fraction through setParam without passing
      // the spinner's own guard. The catch-all clamps to the field's range the
      // same way the spinner does, so the saved netlist token is never
      // fractional.
      const id = add(kind, params);
      useStore.getState().setParam(id, name, given);
      const after = useStore.getState();
      const e = after.elements.find((x) => x.id === id);
      expect(e?.params[name]).toBe(expected);
      expect(after.pendingParams.get(`${id}:${name}`)?.value).toBe(expected);
    },
  );

  it('clamps an integer field to its def minimum', () => {
    const id = add('relay', { poleCount: 2 });
    useStore.getState().setParam(id, 'poleCount', 0.5);
    expect(useStore.getState().elements.find((e) => e.id === id)?.params.poleCount).toBe(1);
  });

  it('leaves a continuous field untouched', () => {
    const id = add('counter', { bits: 3, modulus: 10 });
    useStore.getState().setParam(id, 'highVoltage', 4.7);
    expect(useStore.getState().elements.find((e) => e.id === id)?.params.highVoltage).toBe(4.7);
  });
});

describe('undo parity', () => {
  const addSwitch = () =>
    useStore.getState().addElement({
      kind: 'switch',
      x1: 0,
      y1: 0,
      x2: 160,
      y2: 0,
      flags: 0,
      params: { position: 0, momentary: 0 },
      state: 0,
    });

  it('restores a value edit in one step', () => {
    const id = addResistor();
    const baseline = useStore.getState().undoStack.length;

    useStore.getState().beginEdit();
    useStore.getState().setParam(id, 'resistance', 2000);

    expect(useStore.getState().undoStack.length).toBe(baseline + 1);
    useStore.getState().undo();
    expect(useStore.getState().elements[0].params.resistance).toBe(1000);
    expect(useStore.getState().undoStack.length).toBe(baseline);
  });

  it('coalesces a slider drag to one undo entry', () => {
    const id = addResistor();
    const baseline = useStore.getState().undoStack.length;

    useStore.getState().beginEdit();
    // The drag ends at 900, not the pre-edit 1000, so the restore assertion
    // below actually exercises the undo rather than passing on an unchanged
    // value.
    for (let i = 1; i <= 10; i++) {
      useStore.getState().setParam(id, 'resistance', i * 90);
    }

    // The whole drag is one session, so exactly one entry lands.
    expect(useStore.getState().undoStack.length).toBe(baseline + 1);
    expect(useStore.getState().elements[0].params.resistance).toBe(900);
    useStore.getState().undo();
    expect(useStore.getState().elements[0].params.resistance).toBe(1000);
  });

  it('restores a run-mode switch toggle', () => {
    const id = addSwitch();

    useStore.getState().commit();
    useStore.getState().setElementState(id, 1);

    useStore.getState().undo();

    // No clearPending in this test: undo itself must bring back the committed
    // element state. pendingStates is a live frame queue, not part of the undo
    // Snapshot (types.ts:36), so the element state is what proves the undo.
    expect(useStore.getState().elements[0].state).toBe(0);
  });

  it('dedups consecutive identical commits', () => {
    // A plain pointer-down over an element that changed nothing since the last
    // commit must not grow the stack.
    useStore.getState().commit();
    useStore.getState().commit();
    expect(useStore.getState().undoStack).toHaveLength(1);
  });

  it('restores settings and view with the undo', () => {
    useStore.getState().updateSettings({ voltageRange: 10 });
    useStore.getState().setView({ x: 100, y: 50, scale: 2 });
    useStore.getState().commit();

    // A setting changed before a real action is captured at that action's
    // commit: addElement's own commit dedups against the one above, so undoing
    // brings back the committed settings and view, not the post-commit ones.
    useStore.getState().addElement({
      kind: 'resistor',
      x1: 0,
      y1: 0,
      x2: 160,
      y2: 0,
      flags: 0,
      params: { resistance: 1000 },
    });
    useStore.getState().updateSettings({ voltageRange: 20 });
    useStore.getState().setView({ x: 0, y: 0, scale: 1 });
    useStore.getState().undo();

    const s = useStore.getState();
    expect(s.settings.voltageRange).toBe(10);
    expect(s.view).toEqual({ x: 100, y: 50, scale: 2 });
    expect(s.elements).toHaveLength(0);
  });

  it('does not alias the live state into the undo snapshot', () => {
    const id = addResistor();
    useStore.getState().commit();

    useStore.getState().moveElements([id], 3.3, 0);
    useStore.getState().setParam(id, 'resistance', 999);

    // The snapshot taken before the drag must still hold the originals; a
    // future in-place mutator would silently corrupt history here.
    const top = useStore.getState().undoStack[useStore.getState().undoStack.length - 1];
    expect(top.elements[0]).toMatchObject({
      x1: 0,
      y1: 0,
      x2: 160,
      y2: 0,
      params: { resistance: 1000 },
    });
    const live = useStore.getState().elements[0];
    expect(live.params.resistance).toBe(999);
    expect(live.x1).not.toBe(top.elements[0].x1);
  });

  it('keeps a real change after a no-op commit undoable', () => {
    useStore.getState().commit();
    addResistor();
    // The click that changed nothing is one entry whose state still holds the
    // element: the first undo is a no-op, the second removes it.
    useStore.getState().commit();
    useStore.getState().undo();
    expect(useStore.getState().elements).toHaveLength(1);
    useStore.getState().undo();
    expect(useStore.getState().elements).toHaveLength(0);
  });
});

describe('wire split on connect', () => {
  const addWire = (x1: number, y1: number, x2: number, y2: number) =>
    useStore.getState().addElement({
      kind: 'wire',
      x1,
      y1,
      x2,
      y2,
      flags: 0,
      params: {},
    });

  it('dropping a wire end onto a wire interior splits it into two connected halves', () => {
    const crossed = addWire(0, 0, 160, 0);
    const placed = addWire(0, 32, 80, 0);

    useStore.getState().placeWireEnd(placed, 80, 0);

    const s = useStore.getState();
    // The crossed wire is gone, replaced by two halves sharing (80,0).
    expect(s.elements.some((e) => e.id === crossed)).toBe(false);
    const spans = s.elements.filter((e) => e.kind === 'wire').map((e) => [e.x1, e.y1, e.x2, e.y2]);
    expect(spans).toContainEqual([0, 0, 80, 0]);
    expect(spans).toContainEqual([80, 0, 160, 0]);
    // The placed end sits exactly on the split point, which the engine merges
    // into one node: the three share a terminal coordinate.
    const end = s.elements.find((e) => e.id === placed);
    expect(end?.x2).toBe(80);
    expect(end?.y2).toBe(0);
  });

  it('is one undo step back to the pre-drop state', () => {
    const crossed = addWire(0, 0, 160, 0);
    const placed = addWire(0, 32, 80, 0);

    useStore.getState().placeWireEnd(placed, 80, 0);
    expect(useStore.getState().elements).toHaveLength(3);

    useStore.getState().undo();

    // The original crossed wire is back, with no halves and no placed wire.
    const s = useStore.getState();
    expect(s.elements.some((e) => e.id === crossed)).toBe(true);
    expect(s.elements.some((e) => e.id === placed)).toBe(false);
    expect(s.elements).toHaveLength(1);
  });

  it('an endpoint drop does not split the crossed wire', () => {
    const crossed = addWire(0, 0, 160, 0);
    const placed = addWire(0, 32, 0, 0);

    useStore.getState().placeWireEnd(placed, 0, 0);

    const s = useStore.getState();
    expect(s.elements.some((e) => e.id === crossed)).toBe(true);
    expect(s.elements).toHaveLength(2);
  });

  it('leaves wires alone when the drop crosses nothing', () => {
    const a = addWire(0, 0, 160, 0);
    const b = addWire(0, 32, 80, 64);

    useStore.getState().placeWireEnd(b, 80, 64);

    const s = useStore.getState();
    expect(s.elements).toHaveLength(2);
    expect(s.elements.some((e) => e.id === a)).toBe(true);
    expect(s.elements.find((e) => e.id === b)).toMatchObject({ x2: 80, y2: 64 });
  });

  it('round-trips the split wires through the netlist', () => {
    const crossed = addWire(0, 0, 160, 0);
    const placed = addWire(0, 32, 80, 0);
    useStore.getState().placeWireEnd(placed, 80, 0);
    expect(useStore.getState().elements.some((e) => e.id === crossed)).toBe(false);

    const { elements } = parseCircuit(useStore.getState().toNetlist());
    const wires = elements.filter((e) => e.kind === 'wire');
    expect(wires).toHaveLength(3);
    const spans = wires.map((e) => [e.x1, e.y1, e.x2, e.y2]);
    // Every wire survives a save and a load at the same coordinates.
    expect(spans).toContainEqual([0, 0, 80, 0]);
    expect(spans).toContainEqual([80, 0, 160, 0]);
    expect(spans).toContainEqual([0, 32, 80, 0]);
  });
});

describe('scope o-line fidelity', () => {
  const TWO_PLOT = [
    '$ 1 0.000005 10.20027730826997 50 5 43 5e-11',
    'r 0 0 16 0 0 100',
    'r 16 0 32 0 0 100',
    'r 32 0 48 0 0 100',
    'r 48 0 64 0 0 100',
    'r 64 0 80 0 0 100',
    'o 4 64 0 4099 20 0.05 0 2 4 3',
    '',
  ].join('\n');

  it('toNetlist emits the loaded o-line verbatim, not a 4-token stub', () => {
    useStore.getState().loadNetlist(TWO_PLOT);
    const lines = useStore.getState().toNetlist().split('\n');
    expect(lines).toContain('o 4 64 0 4099 20 0.05 0 2 4 3');
    expect(lines.some((l) => /^o \d+ 64 0 4099$/.test(l))).toBe(false);
  });

  it('a two-plot line produces two ordered engine specs', () => {
    useStore.getState().loadNetlist(TWO_PLOT);
    const s = useStore.getState();
    const specs = scopePlotsToSpecs(s.scopes, { ...DEFAULT_SETTINGS, ...s.settings });
    expect(specs).toHaveLength(2);
    expect(specs[0]).toMatchObject({
      value: 'voltage',
      elementId: s.scopes[0].plots[0].elementId,
    });
    expect(specs[1]).toMatchObject({
      value: 'current',
      elementId: s.scopes[0].plots[0].elementId,
    });
    // Engine trace indices are array positions, pinning column ordering:
    // plot 0 is trace 0 and plot 1 is trace 1.
    expect(specs.map((x) => x.plotId)).toEqual(s.scopes[0].plots.map((p) => p.id));
    expect(specs.findIndex((x) => x.plotId === s.scopes[0].plots[0].id)).toBe(0);
    expect(specs.findIndex((x) => x.plotId === s.scopes[0].plots[1].id)).toBe(1);
  });

  it('addScope dedupes and generates a loadable default line', () => {
    const id = addResistor();
    useStore.getState().addScope(id, 'voltage');
    useStore.getState().addScope(id, 'voltage');
    expect(useStore.getState().scopes).toHaveLength(1);
    const line = useStore
      .getState()
      .toNetlist()
      .split('\n')
      .find((l) => l.startsWith('o '));
    // A voltage scope carries a current companion for most elements, so the
    // generated line is the two-plot form upstream parses.
    expect(line).toBe('o 0 64 0 4099 20 0.05 0 2 0 3');
  });

  it('addScope power emits the W-scale token the line needs', () => {
    const id = addResistor();
    useStore.getState().addScope(id, 'power');
    const line = useStore
      .getState()
      .toNetlist()
      .split('\n')
      .find((l) => l.startsWith('o '));
    expect(line).toBe('o 0 64 7 4099 20 0.05 0 1 20');
  });

  it('addScope dedupes against a plot on a loaded two-plot line', () => {
    useStore.getState().loadNetlist(TWO_PLOT);
    const s = useStore.getState();
    const elementId = s.scopes[0].plots[0].elementId as number;
    useStore.getState().addScope(elementId, 'voltage');
    // The loaded line already shows voltage on that element, so the duplicate
    // is a no-op while the two plots stay.
    expect(useStore.getState().scopes).toHaveLength(1);
    expect(useStore.getState().scopes[0].plots).toHaveLength(2);
  });

  it('deleteSelected removes a scope whose any plot element is deleted', () => {
    const a = addResistor();
    const b = addResistor();
    useStore.getState().addScope(a, 'voltage');
    useStore.getState().addScope(b, 'current');
    useStore.getState().select([a]);
    useStore.getState().deleteSelected();
    expect(useStore.getState().scopes).toHaveLength(1);
    expect(useStore.getState().scopes[0].plots[0].elementId).toBe(b);
  });

  it('deleteSelected removes a two-plot scope when its element goes', () => {
    useStore.getState().loadNetlist(TWO_PLOT);
    const s = useStore.getState();
    const target = s.elements.find((e) => s.scopes[0].plots.some((p) => p.elementId === e.id));
    expect(target).toBeDefined();
    useStore.getState().select([target!.id]);
    useStore.getState().deleteSelected();
    expect(useStore.getState().scopes).toHaveLength(0);
  });
});

describe('scope speed', () => {
  it('setScopeSpeed clamps, bumps scopeRevision only on real change, and serializes', () => {
    const id = addResistor();
    useStore.getState().addScope(id, 'voltage');
    const scopeId = useStore.getState().scopes[0].id;
    const beforeScope = useStore.getState().scopeRevision;
    const beforeRevision = useStore.getState().revision;

    useStore.getState().setScopeSpeed(scopeId, 128);
    const s = useStore.getState();
    expect(s.scopes[0].speed).toBe(128);
    expect(s.scopeRevision).toBe(beforeScope + 1);
    expect(s.revision).toBe(beforeRevision); // scopeRevision is the fast path

    // A no-op must not bump anything.
    useStore.getState().setScopeSpeed(scopeId, 128);
    expect(useStore.getState().scopeRevision).toBe(beforeScope + 1);

    // Clamps at both ends of 1..1024.
    useStore.getState().setScopeSpeed(scopeId, 99999);
    expect(useStore.getState().scopes[0].speed).toBe(1024);
    useStore.getState().setScopeSpeed(scopeId, 0);
    expect(useStore.getState().scopes[0].speed).toBe(1);

    // The live speed lands in the serialized line's speed token (raw[0]).
    const line = useStore
      .getState()
      .toNetlist()
      .split('\n')
      .find((l) => l.startsWith('o '));
    expect(line).toBe('o 0 1 0 4099 20 0.05 0 2 0 3');
  });

  it('loadNetlist restores a non-default o-line speed and saves it back', () => {
    useStore
      .getState()
      .loadNetlist(
        '$ 0 0.000005 10 50 5 43 5e-11\n' +
          'r 0 0 16 0 0 100\nr 16 0 32 0 0 100\n' +
          'o 0 128 0 4099 20 0.05 0 2 4 3\n',
      );
    const s = useStore.getState();
    expect(s.scopes[0].speed).toBe(128);

    // Editing the speed writes it back over the loaded token; the rest of the
    // line stays verbatim.
    useStore.getState().setScopeSpeed(s.scopes[0].id, 256);
    const line = useStore
      .getState()
      .toNetlist()
      .split('\n')
      .find((l) => l.startsWith('o '));
    expect(line).toBe('o 0 256 0 4099 20 0.05 0 2 4 3');
  });
});

describe('scope panels', () => {
  it('addScope creates a V+I pair for a resistor and a single V plot for an output', () => {
    const r = addResistor();
    useStore.getState().addScope(r, 'voltage');
    expect(useStore.getState().scopes[0].plots.map((p) => p.value)).toEqual(['voltage', 'current']);

    const outId = useStore.getState().addElement({
      kind: 'output',
      x1: 0,
      y1: 0,
      x2: 32,
      y2: 0,
      flags: 0,
      params: {},
    });
    useStore.getState().addScope(outId, 'voltage');
    const outScope = useStore
      .getState()
      .scopes.find((x) => x.plots.some((p) => p.elementId === outId));
    expect(outScope?.plots.map((p) => p.value)).toEqual(['voltage']);
  });

  it('togglePlot adds and removes a plot but never empties the panel', () => {
    const r = addResistor();
    useStore.getState().addScope(r, 'voltage');
    const scopeId = useStore.getState().scopes[0].id;

    useStore.getState().togglePlot(scopeId, 'current');
    expect(useStore.getState().scopes[0].plots).toHaveLength(1);

    useStore.getState().togglePlot(scopeId, 'current');
    expect(useStore.getState().scopes[0].plots).toHaveLength(2);

    // Removing the only plot is refused.
    useStore.getState().togglePlot(scopeId, 'current');
    expect(useStore.getState().scopes[0].plots).toHaveLength(1);
    useStore.getState().togglePlot(scopeId, 'voltage');
    expect(useStore.getState().scopes[0].plots).toHaveLength(1);
  });

  /** A combined panel holding exactly [V(A), V(B)]: the default settings give
   *  every voltage scope a current companion, which would blur the identity
   *  case this block is about, so it is switched off for the setup. */
  const twoVoltageCombined = () => {
    useStore.setState((s) => ({ settings: { ...s.settings, showCurrent: false } }));
    const a = addResistor();
    const b = addResistor();
    useStore.getState().addScope(a, 'voltage');
    useStore.getState().addScope(b, 'voltage');
    const [sa, sb] = useStore.getState().scopes;
    useStore.getState().combineScopes(sa.id, sb.id);
    const combined = useStore.getState().scopes[0];
    expect(combined.plots.map((p) => p.elementId)).toEqual([a, b]);
    return { a, b, combined };
  };

  it('removePlot removes the clicked plot, not the first with its value', () => {
    const { a, b, combined } = twoVoltageCombined();

    // Right-clicking V(B) resolves B's plot id (ScopePanel selectPlotAt); the
    // value-keyed togglePlot path would kill both voltage plots here.
    useStore.getState().removePlot(combined.id, combined.plots[1].id);
    expect(useStore.getState().scopes[0].plots.map((p) => p.elementId)).toEqual([a]);
    expect(useStore.getState().scopes[0].plots.some((p) => p.elementId === b)).toBe(false);
  });

  it('removePlot refuses to empty the panel', () => {
    // A single-plot panel: showCurrent off so addScope creates no companion,
    // making V(A) the last samplable plot in it.
    useStore.setState((s) => ({ settings: { ...s.settings, showCurrent: false } }));
    useStore.getState().addScope(addResistor(), 'voltage');
    const scope = useStore.getState().scopes[0];
    const before = useStore.getState().undoStack.length;

    useStore.getState().removePlot(scope.id, scope.plots[0].id);
    expect(useStore.getState().scopes[0].plots).toHaveLength(1);
    expect(useStore.getState().undoStack.length).toBe(before);
  });

  it('removePlot refuses a raw-only plot', () => {
    // An out-of-table value token loads as a plot kept only to re-emit the
    // o line byte-for-byte; removing it would silently drop those tokens
    // from every later save.
    useStore.getState().loadNetlist(
      ['$ 1 0.000005 10 50 5 43 5e-11', 't 0 0 16 0 0 1 0 0 0 0 0', 'o 0 64 9 4099 20 0.05 0 1', ''].join(
        '\n',
      ),
    );
    const scope = useStore.getState().scopes[0];
    const rawOnly = scope.plots[0];
    expect(rawOnly.value).toBeNull();
    // A companion samplable pair keeps the panel above the empty guard, so
    // the refusal below is the raw-only rule and not the length one.
    useStore.getState().addToScope(addResistor(), scope.id, 'voltage');
    expect(useStore.getState().scopes[0].plots).toHaveLength(3);
    const before = useStore.getState().undoStack.length;

    useStore.getState().removePlot(scope.id, rawOnly.id);
    expect(useStore.getState().scopes[0].plots).toHaveLength(3);
    expect(
      useStore.getState().scopes[0].plots.find((p) => p.id === rawOnly.id),
    ).toMatchObject({ value: null });
    expect(useStore.getState().undoStack.length).toBe(before);
  });

  it('removePlot ignores a stale plot id', () => {
    useStore.getState().addScope(addResistor(), 'voltage');
    const scopeId = useStore.getState().scopes[0].id;
    // Destroy a real plot through the front door, then aim the command at its
    // id: an open menu can easily outlive the plot it was opened over.
    const victim = useStore.getState().scopes[0].plots[1].id;
    useStore.getState().togglePlot(scopeId, 'current');
    const before = useStore.getState().undoStack.length;

    useStore.getState().removePlot(scopeId, victim);
    expect(useStore.getState().scopes[0].plots).toHaveLength(1);
    expect(useStore.getState().undoStack.length).toBe(before);
  });

  it('removePlot leaves the scope-family scale state alone', () => {
    useStore.getState().addScope(addResistor(), 'voltage');
    const scope = useStore.getState().scopes[0];
    const victim = scope.plots[0];
    setScaleState(scope.id, victim.value, { gridMax: 3, showNegative: true });

    useStore.getState().removePlot(scope.id, victim.id);
    // Upstream never resets scale[] when a plot is removed (the entry belongs
    // to the scope's units family): removing one trace keeps it for any
    // sibling, and the frame loop drops it only with the whole scope.
    expect(scaleStateFor(scope.id, victim.value)).toEqual({ gridMax: 3, showNegative: true });
  });

  it('addToScope adds the plot to the right scope, deduping per scope', () => {
    const r = addResistor();
    useStore.getState().addScope(r, 'voltage');
    useStore.getState().addScope(addResistor(), 'current');
    const [first, second] = useStore.getState().scopes;
    // The target element: a second resistor not yet scoped.
    const other = addResistor();
    const before = useStore.getState().undoStack.length;
    const rev = useStore.getState().revision;

    useStore.getState().addToScope(other, first.id, 'voltage');

    const s = useStore.getState();
    const updated = s.scopes.find((x) => x.id === first.id)!;
    const untouched = s.scopes.find((x) => x.id === second.id)!;
    expect(updated.plots.some((p) => p.elementId === other && p.value === 'voltage')).toBe(true);
    expect(untouched.plots.some((p) => p.elementId === other)).toBe(false);
    expect(s.undoStack.length).toBe(before + 1);
    expect(s.revision).toBe(rev + 1);

    // Adding the same plot again is a no-op, no second undo entry.
    useStore.getState().addToScope(other, first.id, 'voltage');
    const after = useStore.getState();
    expect(after.scopes.find((x) => x.id === first.id)!.plots).toHaveLength(updated.plots.length);
    expect(after.undoStack.length).toBe(before + 1);
  });

  it('addToScope is a no-op for an unknown scope and does not dedup across scopes', () => {
    const r = addResistor();
    useStore.getState().addScope(r, 'voltage');
    useStore.getState().addScope(addResistor(), 'current');
    const [first] = useStore.getState().scopes;
    const other = addResistor();
    // The same element is already scoped elsewhere; that must not block adding
    // it to a specific scope (unlike addScope's global dedup).
    useStore.getState().addToScope(other, first.id, 'voltage');
    expect(
      useStore.getState().scopes.some((x) => x.plots.some((p) => p.elementId === other)),
    ).toBe(true);

    const before = useStore.getState().undoStack.length;
    useStore.getState().addToScope(other, 999, 'voltage');
    expect(useStore.getState().undoStack.length).toBe(before);
  });

  it('combineScopes merges plot lists and drops the emptied scope', () => {
    const a = addResistor();
    const b = addResistor();
    useStore.getState().addScope(a, 'voltage');
    useStore.getState().addScope(b, 'voltage');
    const [sa, sb] = useStore.getState().scopes;
    useStore.getState().combineScopes(sa.id, sb.id);
    const s = useStore.getState();
    expect(s.scopes).toHaveLength(1);
    expect(s.scopes[0].plots).toHaveLength(4);
  });

  it('separateScope keeps a V+I pair together and splits the rest', () => {
    const a = addResistor();
    const b = addResistor();
    useStore.getState().addScope(a, 'voltage'); // V+I of a
    useStore.getState().addScope(b, 'current'); // lone I of b
    const [sa, sb] = useStore.getState().scopes;
    useStore.getState().combineScopes(sa.id, sb.id);

    useStore.getState().separateScope(sa.id);
    const s = useStore.getState();
    expect(s.scopes).toHaveLength(2);
    const vPanel = s.scopes.find((x) => x.plots.some((p) => p.value === 'voltage'));
    expect(vPanel?.plots.map((p) => p.value)).toEqual(['voltage', 'current']);
    const iPanel = s.scopes.find((x) => !x.plots.some((p) => p.value === 'voltage'));
    expect(iPanel?.plots.map((p) => p.value)).toEqual(['current']);
  });

  it('stack and unstack update positions, one undo restores each command', () => {
    const a = addResistor();
    const b = addResistor();
    const c = addResistor();
    useStore.getState().addScope(a, 'voltage');
    useStore.getState().addScope(b, 'voltage');
    useStore.getState().addScope(c, 'voltage');
    let s = useStore.getState();
    expect(s.scopes.map((x) => x.position)).toEqual([0, 1, 2]);

    // stackScope commits itself, so one undo restores the pre-stack layout.
    const top = s.scopes[2].id;
    let pre = s.scopes;
    useStore.getState().stackScope(top);
    s = useStore.getState();
    expect(s.scopes.map((x) => x.position)).toEqual([0, 1, 1]);
    useStore.getState().undo();
    expect(useStore.getState().scopes).toEqual(pre);

    // unstackScope commits itself too, so one undo restores the stacked
    // layout it started from.
    useStore.getState().stackScope(top);
    pre = useStore.getState().scopes;
    useStore.getState().unstackScope(top);
    s = useStore.getState();
    expect(s.scopes.map((x) => x.position)).toEqual([0, 1, 2]);
    useStore.getState().undo();
    expect(useStore.getState().scopes).toEqual(pre);
  });

  it('the Scopes menu batch commands each undo in one step', () => {
    const a = addResistor();
    const b = addResistor();
    useStore.getState().addScope(a, 'voltage');
    useStore.getState().addScope(b, 'voltage');

    // stackAllScopes: one undo restores the pre-stack positions.
    let pre = useStore.getState().scopes;
    useStore.getState().stackAllScopes();
    let s = useStore.getState();
    expect(s.scopes.map((x) => x.position)).toEqual([0, 0]);
    useStore.getState().undo();
    expect(useStore.getState().scopes).toEqual(pre);

    // unstackAllScopes: one undo restores the stacked layout it started from.
    useStore.getState().stackAllScopes();
    pre = useStore.getState().scopes;
    useStore.getState().unstackAllScopes();
    s = useStore.getState();
    expect(s.scopes.map((x) => x.position)).toEqual([0, 1]);
    useStore.getState().undo();
    expect(useStore.getState().scopes).toEqual(pre);

    // combineAllScopes: one undo restores both scopes and all their plots.
    pre = useStore.getState().scopes;
    useStore.getState().combineAllScopes();
    s = useStore.getState();
    expect(s.scopes).toHaveLength(1);
    expect(s.scopes[0].plots).toHaveLength(4);
    useStore.getState().undo();
    expect(useStore.getState().scopes).toEqual(pre);

    // separateAllScopes: one undo restores the combined scope. Each original
    // V+I pair stays together, so two panels come back.
    useStore.getState().combineAllScopes();
    pre = useStore.getState().scopes;
    useStore.getState().separateAllScopes();
    s = useStore.getState();
    expect(s.scopes).toHaveLength(2);
    expect(s.scopes.map((x) => x.plots.map((p) => p.value))).toEqual([
      ['voltage', 'current'],
      ['voltage', 'current'],
    ]);
    useStore.getState().undo();
    expect(useStore.getState().scopes).toEqual(pre);
  });

  it('the batch commands are no-ops with nothing to act on', () => {
    const baseline = useStore.getState().undoStack.length;
    useStore.getState().stackAllScopes();
    useStore.getState().unstackAllScopes();
    useStore.getState().combineAllScopes();
    useStore.getState().separateAllScopes();
    expect(useStore.getState().scopes).toHaveLength(0);
    expect(useStore.getState().undoStack.length).toBe(baseline);
  });
});

describe('scope coupling fast path', () => {
  it('setPlotCoupling changes the flag without rewinding the simulation', () => {
    const id = addResistor();
    useStore.getState().addScope(id, 'voltage');
    const scope = useStore.getState().scopes[0];
    const beforeRevision = useStore.getState().revision;
    const beforeScopeRevision = useStore.getState().scopeRevision;

    useStore.getState().setPlotCoupling(scope.id, scope.plots[0].id, true);
    const s = useStore.getState();
    expect(s.scopes[0].plots[0].acCoupled).toBe(true);
    // A coupling toggle is a scope-capture flag, so it goes through the scope
    // fast path (applyScopeParams) and must not force a full circuit reload.
    expect(s.revision).toBe(beforeRevision);
    expect(s.scopeRevision).toBe(beforeScopeRevision);

    // Toggling back off also avoids the reload.
    useStore.getState().setPlotCoupling(scope.id, scope.plots[0].id, false);
    expect(useStore.getState().scopes[0].plots[0].acCoupled).toBe(false);
    expect(useStore.getState().revision).toBe(beforeRevision);
  });

  it('AC coupling is refused for current plots, matching canAcCouple', () => {
    const id = addResistor();
    useStore.getState().addScope(id, 'voltage'); // V+I pair
    const scope = useStore.getState().scopes[0];
    const currentPlot = scope.plots.find((p) => p.value === 'current');
    const voltagePlot = scope.plots.find((p) => p.value === 'voltage');
    expect(currentPlot).toBeDefined();
    expect(voltagePlot).toBeDefined();
    if (!currentPlot || !voltagePlot) return;

    useStore.getState().setPlotCoupling(scope.id, currentPlot.id, true);
    expect(useStore.getState().scopes[0].plots.find((p) => p.value === 'current')?.acCoupled).toBe(
      false,
    );

    useStore.getState().setPlotCoupling(scope.id, voltagePlot.id, true);
    expect(useStore.getState().scopes[0].plots.find((p) => p.value === 'voltage')?.acCoupled).toBe(
      true,
    );
  });
});

describe('scope mutator coverage', () => {
  it('removeScope drops the scope and bumps revision; an unknown id is a no-op', () => {
    const r = addResistor();
    useStore.getState().addScope(r, 'voltage');
    const scopeId = useStore.getState().scopes[0].id;
    const before = useStore.getState().revision;

    useStore.getState().removeScope(scopeId);
    let s = useStore.getState();
    expect(s.scopes).toHaveLength(0);
    expect(s.revision).toBe(before + 1);

    // An unknown id returns before commit, so nothing moves.
    const baseline = s.undoStack.length;
    const rev = s.revision;
    useStore.getState().removeScope(999);
    s = useStore.getState();
    expect(s.scopes).toHaveLength(0);
    expect(s.undoStack.length).toBe(baseline);
    expect(s.revision).toBe(rev);
  });

  it('removing the scoped scope closes its Scope Properties gate', () => {
    // The panel renders null once the scope is gone but stays mounted with
    // its Escape listener, so a stale id here kept modalSurface() true
    // forever and every shortcut died until a lucky Escape.
    const r = addResistor();
    useStore.getState().addScope(r, 'voltage');
    const scopeId = useStore.getState().scopes[0].id;
    useStore.getState().openScopeProperties(scopeId);
    expect(modalSurface(useStore.getState())).toBe(true);

    useStore.getState().removeScope(scopeId);
    expect(useStore.getState().scopeProperties).toBeNull();
    expect(modalSurface(useStore.getState())).toBe(false);
  });

  it('removing another scope keeps the open Scope Properties gate', () => {
    const r = addResistor();
    useStore.getState().addScope(r, 'voltage');
    useStore.getState().addScope(addCapacitor(), 'voltage');
    const [first] = useStore.getState().scopes;
    const second = useStore.getState().scopes[1];
    useStore.getState().openScopeProperties(first.id);

    useStore.getState().removeScope(second.id);
    expect(useStore.getState().scopeProperties).toBe(first.id);
    expect(modalSurface(useStore.getState())).toBe(true);
  });

  it('loadNetlist clears an open Scope Properties gate', () => {
    // Loading a file replaces the whole scope list, so the dialog's id can
    // only point at a vanished scope.
    const r = addResistor();
    useStore.getState().addScope(r, 'voltage');
    useStore.getState().openScopeProperties(useStore.getState().scopes[0].id);

    useStore.getState().loadNetlist(SAMPLE);
    expect(useStore.getState().scopeProperties).toBeNull();
    expect(modalSurface(useStore.getState())).toBe(false);
  });

  it('newCircuit clears an open Scope Properties gate', () => {
    const r = addResistor();
    useStore.getState().addScope(r, 'voltage');
    useStore.getState().openScopeProperties(useStore.getState().scopes[0].id);

    useStore.getState().newCircuit();
    expect(useStore.getState().scopeProperties).toBeNull();
    expect(modalSurface(useStore.getState())).toBe(false);
  });

  it('deleteSelected closes the gate of a scope whose element went', () => {
    // The context menu's Delete row works while Scope Properties is up: both
    // are modal store fields and neither closes the other, so this path is
    // live even though the keyboard gate blocks the Delete key itself.
    const r = addResistor();
    useStore.getState().addScope(r, 'voltage');
    useStore.getState().openScopeProperties(useStore.getState().scopes[0].id);
    useStore.getState().select([r]);

    useStore.getState().deleteSelected();
    expect(useStore.getState().scopeProperties).toBeNull();
    expect(modalSurface(useStore.getState())).toBe(false);
  });

  it('deleteSelected keeps the gate when the scoped scope survives', () => {
    const r = addResistor();
    useStore.getState().addScope(r, 'voltage');
    const scopeId = useStore.getState().scopes[0].id;
    const other = addCapacitor();
    useStore.getState().openScopeProperties(scopeId);
    useStore.getState().select([other]);

    useStore.getState().deleteSelected();
    expect(useStore.getState().scopeProperties).toBe(scopeId);
    expect(modalSurface(useStore.getState())).toBe(true);
  });

  it('undoing past a scope closes its Scope Properties gate', () => {
    // addScope commits, so one undo lands on the scope-less list while the
    // dialog id lives on. The menubar's Undo row is clickable by mouse even
    // though the modal gate blocks Ctrl+Z, so this path needs its own clear.
    const r = addResistor();
    useStore.getState().addScope(r, 'voltage');
    useStore.getState().openScopeProperties(useStore.getState().scopes[0].id);
    expect(modalSurface(useStore.getState())).toBe(true);

    useStore.getState().undo();
    expect(useStore.getState().scopes).toHaveLength(0);
    expect(useStore.getState().scopeProperties).toBeNull();
    expect(modalSurface(useStore.getState())).toBe(false);
  });

  it('an undo that keeps the scoped scope keeps its gate', () => {
    const r = addResistor();
    useStore.getState().addScope(r, 'voltage');
    const scopeId = useStore.getState().scopes[0].id;
    // The capacitor's own commit is the undo target, and its snapshot still
    // holds the scope.
    addCapacitor();
    useStore.getState().openScopeProperties(scopeId);

    useStore.getState().undo();
    expect(useStore.getState().scopes.some((x) => x.id === scopeId)).toBe(true);
    expect(useStore.getState().scopeProperties).toBe(scopeId);
    expect(modalSurface(useStore.getState())).toBe(true);
  });

  it('setScopeTrigger patches the trigger and forces a reload; unknown id is a no-op', () => {
    const r = addResistor();
    useStore.getState().addScope(r, 'voltage');
    const scopeId = useStore.getState().scopes[0].id;
    const before = useStore.getState().revision;

    useStore.getState().setScopeTrigger(scopeId, { mode: 'normal', edge: 'falling', level: 2.5 });
    let s = useStore.getState();
    expect(s.scopes[0].trigger).toEqual({ mode: 'normal', edge: 'falling', level: 2.5 });
    // The trigger is part of the engine spec, so it must reload.
    expect(s.revision).toBe(before + 1);

    // A partial patch merges over the previous trigger.
    useStore.getState().setScopeTrigger(scopeId, { edge: 'rising' });
    expect(useStore.getState().scopes[0].trigger).toEqual({
      mode: 'normal',
      edge: 'rising',
      level: 2.5,
    });

    const rev = useStore.getState().revision;
    useStore.getState().setScopeTrigger(999, { level: 1 });
    s = useStore.getState();
    expect(s.revision).toBe(rev);
    expect(s.scopes[0].trigger.level).toBe(2.5);
  });

  it('setScopeFlags patches the display fields without a reload', () => {
    const r = addResistor();
    useStore.getState().addScope(r, 'voltage');
    const scopeId = useStore.getState().scopes[0].id;
    const beforeRevision = useStore.getState().revision;
    const beforeScopeRevision = useStore.getState().scopeRevision;

    useStore.getState().setScopeFlags(scopeId, {
      label: 'Renamed',
      manualScale: true,
      showMax: false,
    });
    const s = useStore.getState();
    expect(s.scopes[0].label).toBe('Renamed');
    expect(s.scopes[0].manualScale).toBe(true);
    expect(s.scopes[0].showMax).toBe(false);
    // Display fields are pure scope state: neither the rebuild nor the scope
    // fast path fires (store.ts:1496).
    expect(s.revision).toBe(beforeRevision);
    expect(s.scopeRevision).toBe(beforeScopeRevision);
  });
});

describe('arrow-nudge selection', () => {
  it('moves the whole selection by the delta and is exactly one undo step', () => {
    const a = addResistor();
    const b = addResistor();
    useStore.getState().select([a, b]);
    const baseline = useStore.getState().undoStack.length;

    useStore.getState().nudgeSelection(GRID_SIZE, 0);

    const after = useStore.getState();
    // commit before the move makes the whole press one entry.
    expect(after.undoStack.length).toBe(baseline + 1);
    for (const id of [a, b]) {
      const e = after.elements.find((x) => x.id === id)!;
      expect([e.x1, e.y1, e.x2, e.y2]).toEqual([GRID_SIZE, 0, 160 + GRID_SIZE, 0]);
    }

    useStore.getState().undo();
    const s = useStore.getState();
    expect(s.undoStack.length).toBe(baseline);
    for (const id of [a, b]) {
      const e = s.elements.find((x) => x.id === id)!;
      expect([e.x1, e.y1, e.x2, e.y2]).toEqual([0, 0, 160, 0]);
    }
  });

  it('with no selection changes nothing and pushes no undo entry', () => {
    const baseline = useStore.getState().undoStack.length;
    useStore.getState().nudgeSelection(GRID_SIZE, 0);
    const s = useStore.getState();
    expect(s.elements).toHaveLength(0);
    expect(s.undoStack.length).toBe(baseline);
  });
});

describe('keyboard zoom', () => {
  it('zoomAbout keeps the focal circuit point fixed and clamps to the wheel range', () => {
    const view = { x: 10, y: 20, scale: 2 };
    const cx = 100;
    const cy = 50;

    const out = zoomAbout(view, cx, cy, ZOOM_FACTOR);
    // The screen position of the focal point is unchanged by the zoom: the
    // point under the cursor stays put, the same law the wheel uses.
    expect((cx - out.x) * out.scale).toBeCloseTo((cx - view.x) * view.scale);
    expect((cy - out.y) * out.scale).toBeCloseTo((cy - view.y) * view.scale);
    expect(out.scale).toBeCloseTo(2 * ZOOM_FACTOR);

    // The wheel's clamp, pinned so the keyboard cannot leave its range.
    expect(zoomAbout(view, cx, cy, 100).scale).toBe(6);
    expect(zoomAbout(view, cx, cy, 1e-6).scale).toBe(0.15);
  });

  it('zoomReset sets scale to exactly 1 about the same centre', () => {
    useStore.getState().setView({ x: 40, y: -20, scale: 2.5 });
    useStore.getState().setViewSize(800, 600);
    const before = useStore.getState().view;
    const cx = before.x + 800 / (2 * before.scale);
    const cy = before.y + 600 / (2 * before.scale);

    useStore.getState().zoomReset();

    const s = useStore.getState();
    expect(s.view.scale).toBe(1);
    // The screen-centre circuit point stays at the screen centre.
    expect((cx - s.view.x) * s.view.scale).toBeCloseTo((cx - before.x) * before.scale);
    expect((cy - s.view.y) * s.view.scale).toBeCloseTo((cy - before.y) * before.scale);
  });

  it('zoomReset pins scale to exactly 1 even at a 1.12-power scale', () => {
    // 1.973822685184001 is 1.12^6; dividing by it produces 0.9999999999999999,
    // which a naive 1/scale factor would leave behind. zoom100 must report an
    // exact 100% whatever the current zoom (MouseManager.java:1338).
    useStore.getState().setView({ x: 10, y: 20, scale: 1.973822685184001 });
    useStore.getState().setViewSize(800, 600);

    useStore.getState().zoomReset();

    expect(useStore.getState().view.scale).toBe(1);
  });

  it('zoomIn zooms about the screen centre, keeping the centred point centred', () => {
    useStore.getState().setView({ x: 0, y: 0, scale: 1 });
    useStore.getState().setViewSize(800, 600);
    const before = useStore.getState().view;

    useStore.getState().zoomIn();

    const s = useStore.getState();
    expect(s.view.scale).toBeCloseTo(ZOOM_FACTOR);
    // The circuit point that was at the old centre (400, 300) is at the new
    // centre too, so the zoom looks like it happens around the middle of the
    // screen, the way upstream's zoomCircuit does.
    const cx = before.x + 800 / (2 * before.scale);
    const cy = before.y + 600 / (2 * before.scale);
    expect((cx - s.view.x) * s.view.scale).toBeCloseTo(400);
    expect((cy - s.view.y) * s.view.scale).toBeCloseTo(300);
  });

  it('zoomOut clamps at the wheel minimum', () => {
    useStore.getState().setView({ x: 0, y: 0, scale: 0.1 });
    useStore.getState().setViewSize(800, 600);

    useStore.getState().zoomOut();

    expect(useStore.getState().view.scale).toBe(0.15);
  });

  it('setView refuses a non-finite view so a poisoned zoom cannot stick', () => {
    useStore.getState().setView({ x: 40, y: -20, scale: 2.5 });
    useStore.getState().setViewSize(800, 600);
    // Every canvas zoomAbout output (wheel, pinch, keyboard) reaches the store
    // through setView; a NaN view must not be written, or the next zoomAbout
    // derives NaN from it forever.
    useStore.getState().setView({ x: NaN, y: NaN, scale: 1 });

    expect(useStore.getState().view).toEqual({ x: 40, y: -20, scale: 2.5 });

    // A subsequent zoom step recovers instead of rewriting NaN.
    useStore.getState().zoomIn();
    const s = useStore.getState();
    expect(Number.isFinite(s.view.x)).toBe(true);
    expect(Number.isFinite(s.view.y)).toBe(true);
    expect(s.view.scale).toBeCloseTo(2.5 * ZOOM_FACTOR);
  });

  it('setView refuses a zero or negative scale so zoomReset cannot divide by it', () => {
    useStore.getState().setView({ x: 40, y: -20, scale: 2.5 });

    // A finite but zero scale would make zoomReset's 1 / scale Infinity and
    // Infinity * 0 NaN, re-poisoning the view after setView's write.
    useStore.getState().setView({ x: 10, y: 20, scale: 0 });
    useStore.getState().setView({ x: 10, y: 20, scale: -1 });

    expect(useStore.getState().view).toEqual({ x: 40, y: -20, scale: 2.5 });
  });

  it('setViewSize refuses a non-finite size', () => {
    useStore.getState().setViewSize(800, 600);

    useStore.getState().setViewSize(NaN, NaN);

    expect(useStore.getState().viewSize).toEqual({ w: 800, h: 600 });
  });
});

describe('center circuit', () => {
  it('matches fitView over the element bounds and pushes no undo', () => {
    useStore.getState().loadNetlist(SAMPLE);
    useStore.getState().setView({ x: 5, y: 9, scale: 3 });
    useStore.getState().setViewSize(800, 600);
    const baseline = useStore.getState().undoStack.length;
    const bounds = circuitBounds(useStore.getState().elements);
    expect(bounds).not.toBeNull();

    useStore.getState().centerCircuit();

    const s = useStore.getState();
    expect(s.view).toEqual(fitView(bounds!, s.viewSize.w, s.viewSize.h));
    // A view change is not a topology change, so the undo stack is untouched.
    expect(s.undoStack.length).toBe(baseline);
  });

  it('is a no-op on an empty circuit', () => {
    useStore.getState().setView({ x: 5, y: 9, scale: 3 });

    useStore.getState().centerCircuit();

    expect(useStore.getState().view).toEqual({ x: 5, y: 9, scale: 3 });
  });

  it('requestCenter bumps the counter without touching the view', () => {
    useStore.getState().loadNetlist(SAMPLE);
    useStore.getState().setView({ x: 5, y: 9, scale: 3 });
    const before = useStore.getState().centerRequest;

    useStore.getState().requestCenter();

    expect(useStore.getState().centerRequest).toBe(before + 1);
    // The fit itself is the canvas's to run once it has re-measured; the
    // request alone must not move the view.
    expect(useStore.getState().view).toEqual({ x: 5, y: 9, scale: 3 });
  });

  it('a load asks for a second centre after the layout settles', () => {
    // A loaded circuit can add or drop the scope strip, which resizes the
    // canvas only on the next render: the fit the load runs itself measured
    // the old layout, so the canvas has to re-fit once the new one is up.
    const before = useStore.getState().centerRequest;

    useStore.getState().loadNetlist(SAMPLE);

    expect(useStore.getState().centerRequest).toBe(before + 1);
  });

  it('on a zero-sized canvas leaves the view finite', () => {
    // The canvas a ResizeObserver measured while zero-sized: the fit must not
    // return {scale: 0, x: NaN, y: NaN} and poison every later zoom step.
    useStore.getState().loadNetlist(SAMPLE);
    useStore.getState().setViewSize(0, 0);

    useStore.getState().centerCircuit();

    const v = useStore.getState().view;
    expect(Number.isFinite(v.x)).toBe(true);
    expect(Number.isFinite(v.y)).toBe(true);
    expect(v.scale).toBeGreaterThan(0);
  });
});

describe('white background and dialog state', () => {
  it('setDark flips the flag', () => {
    expect(useStore.getState().dark).toBe(true);
    useStore.getState().setDark(false);
    expect(useStore.getState().dark).toBe(false);
    useStore.getState().setDark(true);
    expect(useStore.getState().dark).toBe(true);
  });

  it('openDialog replaces and closeDialog clears', () => {
    expect(useStore.getState().dialog).toBeNull();
    useStore.getState().openDialog('importText');
    expect(useStore.getState().dialog).toBe('importText');
    // Opening a second dialog replaces the first; only one overlay is live.
    useStore.getState().openDialog('about');
    expect(useStore.getState().dialog).toBe('about');
    useStore.getState().closeDialog();
    expect(useStore.getState().dialog).toBeNull();
  });

  it('the Other Options dialog opens from its menu row and closes', () => {
    useStore.getState().openDialog('otherOptions');
    expect(useStore.getState().dialog).toBe('otherOptions');
    useStore.getState().closeDialog();
    expect(useStore.getState().dialog).toBeNull();
  });

  it('the sliders dialog opens from its menu row and closes', () => {
    useStore.getState().openDialog('sliders');
    expect(useStore.getState().dialog).toBe('sliders');
    useStore.getState().closeDialog();
    expect(useStore.getState().dialog).toBeNull();
  });
});

describe('saveNetlist overlays live state', () => {
  const RC = '$ 1 0.000005 10.2 50 5 43 5e-11\nc 0 0 32 0 4 0.00001 5 0 0\n';

  it('loadNetlist baselines lastSaved to the non-live toNetlist', () => {
    useStore.getState().loadNetlist(RC);
    const s = useStore.getState();
    expect(s.lastSaved).toBe(s.toNetlist());
    // toNetlist is the byte-identical round trip of the loaded file.
    expect(s.toNetlist()).toBe(RC);
  });

  it('saveNetlist writes the live tokens while toNetlist stays stale', () => {
    useStore.getState().loadNetlist(RC);
    const capId = useStore.getState().elements[0].id;
    useStore.getState().setLiveStateProvider(() => ({
      [capId]: { voltDiff: 8.16, seriesResistance: 0.1 },
    }));
    const s = useStore.getState();
    const live = s.saveNetlist();
    // The saved bytes carry the live charge and the validate ESR...
    expect(live).toContain('c 0 0 32 0 4 0.00001 8.16 0 0.1');
    // ...while the non-live document keeps the load-time values, so the F5
    // baseline and the corpus golden do not chase every charge change.
    expect(s.toNetlist()).toContain('c 0 0 32 0 4 0.00001 5 0 0');
    expect(s.toNetlist()).toBe(RC);
  });

  it('without a provider saveNetlist equals toNetlist', () => {
    useStore.getState().loadNetlist(RC);
    const s = useStore.getState();
    expect(s.liveStateProvider).toBeNull();
    expect(s.saveNetlist()).toBe(s.toNetlist());
  });

  it('markSaved baselines the non-live document, so a save stays clean', () => {
    // The Save As flow computes the live bytes for the download and then marks
    // saved. The baseline must be the non-live toNetlist, or the F5 and
    // autosave clean checks, which compare against it, would report every
    // saved circuit as dirty.
    useStore.getState().loadNetlist(RC);
    const capId = useStore.getState().elements[0].id;
    useStore.getState().setLiveStateProvider(() => ({
      [capId]: { voltDiff: 8.16, seriesResistance: 0.1 },
    }));
    const s = useStore.getState();
    const written = s.saveNetlist();
    expect(written).not.toBe(s.toNetlist());
    s.markSaved();
    expect(useStore.getState().lastSaved).toBe(s.toNetlist());
    expect(hasUnsavedChanges(useStore.getState().lastSaved, useStore.getState().toNetlist())).toBe(
      false,
    );
  });

  it('setLiveStateProvider swaps the reader in and out', () => {
    useStore.getState().setLiveStateProvider(() => ({}));
    expect(useStore.getState().liveStateProvider).not.toBeNull();
    useStore.getState().setLiveStateProvider(null);
    expect(useStore.getState().liveStateProvider).toBeNull();
  });
});

describe('import from text equals open', () => {
  it('loadNetlist from the dialog path produces the pinned SAMPLE counts', () => {
    useStore.getState().loadNetlist(SAMPLE);
    const s = useStore.getState();
    expect(s.elements).toHaveLength(7);
    expect(s.scopes).toHaveLength(1);
    // A load clears the undo stacks exactly like the Open flow.
    expect(s.undoStack).toHaveLength(0);
  });
});

describe('sliders bound to element parameters', () => {
  const SLIDER_FIXTURE = `$ 0 0.000005 10 50 5 43 5e-11
r 0 0 16 0 0 100
r 16 0 32 0 0 220
38 0 0 1 101 Resistance
`;

  // A square-wave source plus the corpus-shaped duty slider: `38 14 6 0 100`
  // declares min 0 max 100 (percent), the port's dutyCycle param is 0..1.
  const DUTY_FIXTURE = `$ 0 0.000005 10 50 5 43 5e-11
v 0 0 0 16 0 2 40 5 5 0 0.5
38 0 6 0 100 Duty\\sCycle
`;

  it('a slider move edits the bound element through the fast path', () => {
    useStore.getState().loadNetlist(SLIDER_FIXTURE);
    const s = useStore.getState();
    const resistorId = s.elements[0].id;
    const sliderId = s.sliders[0].id;

    useStore.getState().setSliderValue(sliderId, 75);

    const after = useStore.getState();
    expect(after.elements[0].params.resistance).toBe(75);
    expect(after.pendingParams.get(`${resistorId}:resistance`)).toEqual({
      id: resistorId,
      name: 'resistance',
      value: 75,
    });
    expect(after.sliders[0].id).toBe(sliderId);
  });

  it('a slider with no resolvable parameter does nothing', () => {
    // The slider targets element index 3, which does not exist: inert but
    // preserved, so nothing is queued and the element is untouched.
    useStore
      .getState()
      .loadNetlist('$ 0 0.000005 10 50 5 43 5e-11\nr 0 0 16 0 0 100\n38 3 0 1 101 Ghost\n');
    const s = useStore.getState();
    useStore.getState().setSliderValue(s.sliders[0].id, 50);
    const after = useStore.getState();
    expect(after.elements[0].params.resistance).toBe(100);
    expect(after.pendingParams.size).toBe(0);
  });

  it('a drag is one undo entry and restores the element with it', () => {
    useStore.getState().loadNetlist(SLIDER_FIXTURE);
    const sliderId = useStore.getState().sliders[0].id;
    const baseline = useStore.getState().undoStack.length;

    useStore.getState().beginEdit();
    useStore.getState().setSliderValue(sliderId, 30);
    useStore.getState().setSliderValue(sliderId, 75);

    const mid = useStore.getState();
    expect(mid.undoStack.length).toBe(baseline + 1);
    expect(mid.elements[0].params.resistance).toBe(75);

    useStore.getState().undo();
    const s = useStore.getState();
    // The whole element, geometry included, comes back from the snapshot.
    expect(s.elements[0]).toMatchObject({
      x1: 0,
      y1: 0,
      x2: 16,
      y2: 0,
      params: { resistance: 100 },
    });
  });

  it('deleting the bound element drops the slider and its serialized line', () => {
    useStore.getState().loadNetlist(SLIDER_FIXTURE);
    const s = useStore.getState();
    useStore.getState().select([s.elements[0].id]);
    useStore.getState().deleteSelected();

    const after = useStore.getState();
    expect(after.sliders).toHaveLength(0);
    // The line no longer serializes at all, unlike a sentinel which would.
    expect(after.toNetlist()).not.toContain('38');
    expect(after.toNetlist()).toContain('r 16 0 32 0 0 220');

    // Undo restores the element, the slider and its place in the file.
    after.undo();
    const restored = useStore.getState();
    expect(restored.sliders).toHaveLength(1);
    expect(restored.toNetlist()).toContain('38 0 0 1 101 Resistance');
  });

  it('deleting an element ahead of the bound one renumbers its e token', () => {
    // The -1 sentinel is unreachable through the store: deleteSelected drops
    // the slider of a deleted element, so nothing here emits it. It is
    // produced only by direct serialization of a stale config and is covered
    // in netlist/sliders.test.ts. What this test pins is the renumbering: the
    // bound resistor slid to index 0, so its slider line is rewritten.
    useStore.getState().loadNetlist(SLIDER_FIXTURE);
    const s = useStore.getState();
    useStore.getState().select([s.elements[1].id]); // the resistor ahead of the bound one
    useStore.getState().deleteSelected();
    const out = useStore.getState().toNetlist();
    expect(out).toContain('38 0 0 1 101 Resistance');
  });

  it('a duty-cycle slider drag writes a fraction, not the file percent', () => {
    // The corpus slider `38 14 6 0 100 Duty\sCycle` declares min 0 max 100
    // (percent) because upstream's edit item is dutyCycle*100
    // (VoltageElm.java:578), but the port's dutyCycle param is a fraction in
    // [0, 1], the divide-by-100 setEditValue does (:660). The scale applies
    // between the panel's position conversion and setParam.
    useStore.getState().loadNetlist(DUTY_FIXTURE);
    const s = useStore.getState();
    const sliderId = s.sliders[0].id;

    useStore.getState().setSliderValue(sliderId, 50);

    const after = useStore.getState();
    expect(after.elements[0].params.dutyCycle).toBe(0.5);
    // A save keeps the duty token a fraction, not the percent the slider uses.
    const vLine = after
      .toNetlist()
      .split('\n')
      .find((l) => l.startsWith('v '))!;
    expect(vLine.split(' ').at(-1)).toBe('0.5');
  });

  it('a slider move bumps paramRevision, not revision (the sim clock survives)', () => {
    useStore.getState().loadNetlist(SLIDER_FIXTURE);
    const s = useStore.getState();
    const before = { revision: s.revision, paramRevision: s.paramRevision };

    useStore.getState().setSliderValue(s.sliders[0].id, 50);

    const after = useStore.getState();
    expect(after.revision).toBe(before.revision);
    expect(after.paramRevision).toBe(before.paramRevision + 1);
  });

  it('sliders load and clear with the circuit', () => {
    useStore.getState().loadNetlist(SLIDER_FIXTURE);
    expect(useStore.getState().sliders).toHaveLength(1);
    useStore.getState().newCircuit();
    expect(useStore.getState().sliders).toHaveLength(0);
    expect(useStore.getState().toNetlist()).not.toContain('38');
  });

  it('addSlider creates a slider bound to the element param, serialized canonically', () => {
    const id = addResistor();
    const baseline = useStore.getState().undoStack.length;

    useStore.getState().addSlider(id, 0, 'Resistance');

    const s = useStore.getState();
    expect(s.sliders).toHaveLength(1);
    expect(s.sliders[0]).toMatchObject({
      elementId: id,
      editItem: 0,
      min: 1,
      max: 1000,
      step: 0,
      text: 'Resistance',
      logarithmic: false,
      shared: null,
    });
    // raw stays empty so the line is the writer's canonical fresh form, and
    // the caption resolves the param on reload (resolveParam matches by
    // label). No `ano` token and no FLAG_SHARED bit: this slider is not
    // shared, and the reader only consumes an `ano` token under FLAG_SHARED
    // (parse.ts), so writing one unconditionally here would come back as a
    // misread caption and step on the next load.
    expect(s.sliders[0].raw).toEqual([]);
    expect(s.toNetlist().split('\n').find((l) => l.startsWith('38 '))).toBe(
      '38 0 F0 0 1 1000 Resistance 0',
    );
    // One undo step: the dialog's create is an edit like any other.
    expect(s.undoStack.length).toBe(baseline + 1);

    s.undo();
    expect(useStore.getState().sliders).toHaveLength(0);
  });

  it('addSlider dedupes on the (element, edit item) pair', () => {
    const id = addResistor();
    useStore.getState().addSlider(id, 0, 'Resistance');
    useStore.getState().addSlider(id, 0, 'Resistance');
    expect(useStore.getState().sliders).toHaveLength(1);
    // A second field still creates a second slider.
    const voltage = useStore.getState().addElement({
      kind: 'voltage',
      x1: 0,
      y1: 0,
      x2: 0,
      y2: 64,
      flags: 16,
      params: { waveform: 0, frequency: 1000, maxVoltage: 5, bias: 0, phaseShift: 0, dutyCycle: 0.5 },
    });
    useStore.getState().addSlider(voltage, 0, 'Max voltage');
    expect(useStore.getState().sliders).toHaveLength(2);
  });

  it('addSlider dedupes on the resolved field, not the raw editItem', () => {
    // A corpus slider whose editItem drifted from its caption (the `38 6 6 0
    // 100 Duty\sCycle` fixture): index 6 is out of range for the voltage
    // source's six adjustable fields, but the caption binds it to dutyCycle.
    const voltage = useStore.getState().addElement({
      kind: 'voltage',
      x1: 0,
      y1: 0,
      x2: 0,
      y2: 64,
      flags: 16,
      params: { waveform: 0, frequency: 1000, maxVoltage: 5, bias: 0, phaseShift: 0, dutyCycle: 0.5 },
    });
    useStore.getState().addSlider(voltage, 6, 'Duty Cycle');
    expect(useStore.getState().sliders).toHaveLength(1);
    // The dialog offers the duty cycle field at index 5; a check there must
    // recognise the loaded slider and not create a duplicate.
    useStore.getState().addSlider(voltage, 5, 'Duty Cycle');
    expect(useStore.getState().sliders).toHaveLength(1);
    expect(useStore.getState().sliders[0]).toMatchObject({ elementId: voltage, editItem: 6 });
  });

  it('addSlider refuses a missing element', () => {
    useStore.getState().addSlider(999, 0, 'Ghost');
    expect(useStore.getState().sliders).toHaveLength(0);
    expect(useStore.getState().undoStack.length).toBe(0);
  });

  it('removeSlider drops the slider and its line, one undo step', () => {
    const id = addResistor();
    useStore.getState().addSlider(id, 0, 'Resistance');
    const sliderId = useStore.getState().sliders[0].id;
    expect(useStore.getState().toNetlist()).toContain('38 ');

    useStore.getState().removeSlider(sliderId);

    const s = useStore.getState();
    expect(s.sliders).toHaveLength(0);
    expect(s.toNetlist()).not.toContain('38 ');

    s.undo();
    expect(useStore.getState().sliders).toHaveLength(1);
  });

  it('removeSlider is a no-op for an unknown id', () => {
    const id = addResistor();
    useStore.getState().addSlider(id, 0, 'Resistance');
    const baseline = useStore.getState().undoStack.length;

    useStore.getState().removeSlider(999);

    expect(useStore.getState().sliders).toHaveLength(1);
    expect(useStore.getState().undoStack.length).toBe(baseline);
  });

  it('setSliderElement records the scoped dialog target and can clear it', () => {
    const id = addResistor();
    useStore.getState().setSliderElement(id);
    expect(useStore.getState().sliderElementId).toBe(id);
    useStore.getState().setSliderElement(null);
    expect(useStore.getState().sliderElementId).toBeNull();
  });
});

describe('convert wires to routed', () => {
  const addWire = (x1: number, y1: number, x2: number, y2: number) =>
    useStore.getState().addElement({
      kind: 'wire',
      x1,
      y1,
      x2,
      y2,
      flags: 0,
      params: {},
    });

  it('merges a chain into one routed wire: one undo entry, one revision bump', () => {
    const a = addWire(0, 0, 80, 0);
    const b = addWire(80, 0, 160, 0);
    const c = addWire(160, 0, 160, 80);
    const baseline = useStore.getState().undoStack.length;
    const rev = useStore.getState().revision;

    useStore.getState().convertWiresToRouted();

    const s = useStore.getState();
    const wires = s.elements.filter((e) => e.kind === 'wire');
    expect(wires).toHaveLength(1);
    // The merged wire keeps the first chain wire's id, so scopes and the
    // file-order slot attached to it survive.
    expect(wires[0].id).toBe(a);
    expect(wires[0].route).toEqual([
      [0, 0],
      [80, 0],
      [160, 0],
      [160, 80],
    ]);
    // One commit for the whole command, exactly as upstream pushes once
    // (CommandManager.java:141-145).
    expect(s.undoStack.length).toBe(baseline + 1);
    // The engine reload sees one wire where it saw three, electrically
    // identical because wires merge into nodes by coordinate.
    expect(s.revision).toBe(rev + 1);

    s.undo();
    const u = useStore.getState();
    expect(u.elements.some((e) => e.id === a)).toBe(true);
    expect(u.elements.some((e) => e.id === b)).toBe(true);
    expect(u.elements.some((e) => e.id === c)).toBe(true);
    expect(u.elements.every((e) => e.kind !== 'wire' || !e.route)).toBe(true);
  });

  it('converts only the selected wires, and the next command takes the rest', () => {
    const a = addWire(0, 0, 80, 0);
    const b = addWire(80, 0, 160, 0);
    const c = addWire(0, 80, 80, 80);
    useStore.getState().select([a, c]);

    useStore.getState().convertWiresToRouted();

    // a and c are separate single wires, so each converts to a two-point route;
    // b, not selected, stays plain (WireConverter.java:15-21).
    const routed = useStore.getState().elements.filter((w) => w.route);
    expect(routed).toHaveLength(2);
    expect(useStore.getState().elements.find((w) => w.id === b)?.route).toBeUndefined();

    // With the routed pair selected, no plain wire is selected any more, so the
    // next command converts every remaining plain wire, b included.
    useStore.getState().convertWiresToRouted();
    expect(useStore.getState().elements.find((w) => w.id === b)?.route).toEqual([
      [80, 0],
      [160, 0],
    ]);
  });

  it('is a no-op when every wire is already routed: no undo entry, no bump', () => {
    addWire(0, 0, 80, 0);
    addWire(80, 0, 160, 0);
    useStore.getState().convertWiresToRouted();
    const baseline = useStore.getState().undoStack.length;
    const rev = useStore.getState().revision;

    useStore.getState().convertWiresToRouted();

    expect(useStore.getState().undoStack.length).toBe(baseline);
    expect(useStore.getState().revision).toBe(rev);
  });

  it('placeWireEnd still splits a routed wire, into two routed halves', () => {
    const crossed = useStore.getState().addElement({
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
    const placed = addWire(0, 96, 80, 80);

    useStore.getState().placeWireEnd(placed, 80, 80);

    const s = useStore.getState();
    expect(s.elements.some((e) => e.id === crossed)).toBe(false);
    const wires = s.elements.filter((e) => e.kind === 'wire');
    expect(wires).toHaveLength(3);
    // The routed wire splits at the bend vertex into two routed halves sharing
    // (80,80), the split point the placed end now sits on.
    const halves = wires.filter((w) => w.id !== placed).sort((p, q) => p.x1 - q.x1);
    expect(halves[0].route).toEqual([
      [0, 0],
      [80, 80],
    ]);
    expect(halves[1].route).toEqual([
      [80, 80],
      [160, 0],
    ]);
    expect(halves[0].x2).toBe(80);
    expect(halves[0].y2).toBe(80);
    expect(halves[1].x1).toBe(80);
    expect(halves[1].y1).toBe(80);
    expect(s.elements.find((e) => e.id === placed)).toMatchObject({ x2: 80, y2: 80 });
  });

  it('a routed wire post drag re-routes the polyline to the new endpoint', () => {
    const id = useStore.getState().addElement({
      kind: 'wire',
      x1: 0,
      y1: 0,
      x2: 160,
      y2: 0,
      flags: 0,
      params: {},
      route: [
        [0, 0],
        [0, 80],
        [160, 0],
      ],
    });

    // A post drag (ctrl-drag or row/col sweep) moves one endpoint: the route
    // recomputes from the new endpoints instead of going stale, so the
    // polyline follows the dragged post.
    useStore.getState().updateElement(id, { x2: 160, y2: 80 });

    const e = useStore.getState().elements[0];
    expect(e.route).toEqual([
      [0, 0],
      [160, 0],
      [160, 80],
    ]);
    expect([e.x1, e.y1, e.x2, e.y2]).toEqual([0, 0, 160, 80]);
  });

  it('a routed wire post drag re-routes around other element bodies', () => {
    const id = useStore.getState().addElement({
      kind: 'wire',
      x1: 0,
      y1: 0,
      x2: 160,
      y2: 0,
      flags: 0,
      params: {},
      route: [
        [0, 0],
        [80, 0],
        [160, 0],
      ],
    });
    // A resistor body sits on the direct y=0 run; dragging the far end up to
    // (160,-64) must route around it, not straight through its cells.
    useStore.getState().addElement({
      kind: 'resistor',
      x1: 64,
      y1: 0,
      x2: 96,
      y2: 0,
      flags: 0,
      params: { resistance: 1000 },
    });

    useStore.getState().updateElement(id, { x2: 160, y2: -64 });

    const e = useStore.getState().elements.find((q) => q.id === id);
    expect(e?.route).toEqual([
      [0, 0],
      [0, -64],
      [160, -64],
    ]);
  });

  it('a group move translates the polyline instead of re-routing it', () => {
    const id = useStore.getState().addElement({
      kind: 'wire',
      x1: 0,
      y1: 0,
      x2: 160,
      y2: 0,
      flags: 0,
      params: {},
      route: [
        [0, 0],
        [0, 80],
        [160, 0],
      ],
    });

    // Moving the selection is not an endpoint edit, so the route travels with
    // the wire (RoutedWireElm.move, RoutedWireElm.java:76-82) rather than
    // re-routing from scratch.
    useStore.getState().moveElements([id], 16, 0);

    expect(useStore.getState().elements[0]).toMatchObject({
      x1: 16,
      y1: 0,
      x2: 176,
      y2: 0,
      route: [
        [16, 0],
        [16, 80],
        [176, 0],
      ],
    });
  });

  it('serializes routed wires as plain w lines, with no route in text or engine spec', () => {
    addWire(0, 0, 80, 0);
    addWire(80, 0, 160, 0);
    useStore.getState().convertWiresToRouted();

    const s = useStore.getState();
    const wLine = s
      .toNetlist()
      .split('\n')
      .find((l) => l.startsWith('w '));
    // The route never enters the file: a plain two-endpoint w line, exactly
    // what upstream's text format would write (RoutedWireElm has no text dump).
    expect(wLine).toBe('w 0 0 160 0 0');

    // A reload has no routes: save/reload degrades routed wires to straight
    // wires, upstream's own text-format behavior.
    const parsed = parseCircuit(s.toNetlist());
    expect(parsed.elements.every((e) => !e.route)).toBe(true);

    // And the engine spec (the object setCircuit hands to serde) is built from
    // explicit fields, so a route on the store element never crosses. Mirrors
    // the spec construction in simulator.ts like store.handoff.test.ts does.
    const spec = s.elements.map((e) => ({
      id: e.id,
      kind: e.kind,
      posts: postsOf(e).map((p) => [Math.round(p.x), Math.round(p.y)]),
      params: e.params,
      label: e.text ?? null,
      flags: e.flags,
    }));
    expect(JSON.stringify(spec)).not.toContain('route');
    expect(spec[0].posts).toEqual([
      [0, 0],
      [160, 0],
    ]);
  });
});

describe('wire split on a post drag', () => {
  const addWire = (x1: number, y1: number, x2: number, y2: number) =>
    useStore.getState().addElement({
      kind: 'wire',
      x1,
      y1,
      x2,
      y2,
      flags: 0,
      params: {},
    });

  it('splits the wire a dragged post landed on', () => {
    const crossed = addWire(0, 0, 160, 0);
    const dragged = addWire(80, 80, 80, 0);

    useStore.getState().autoSplitAt({ x: 80, y: 0 }, dragged);

    const s = useStore.getState();
    expect(s.elements.some((e) => e.id === crossed)).toBe(false);
    const spans = s.elements.filter((e) => e.kind === 'wire').map((e) => [e.x1, e.y1, e.x2, e.y2]);
    expect(spans).toContainEqual([0, 0, 80, 0]);
    expect(spans).toContainEqual([80, 0, 160, 0]);
    // The dragged wire itself is untouched.
    expect(spans).toContainEqual([80, 80, 80, 0]);
  });

  it('splits every wire crossing the drop point, not just the first', () => {
    // Two wires cross at (80,0) without a post there; a post dropped on the
    // crossing has to join both, which takes two splits.
    addWire(0, 0, 160, 0);
    addWire(80, -80, 80, 80);
    const dragged = addWire(0, 32, 80, 0);

    useStore.getState().autoSplitAt({ x: 80, y: 0 }, dragged);

    const wires = useStore.getState().elements.filter((e) => e.kind === 'wire');
    expect(wires).toHaveLength(5);
    const spans = wires.map((e) => [e.x1, e.y1, e.x2, e.y2]);
    expect(spans).toContainEqual([0, 0, 80, 0]);
    expect(spans).toContainEqual([80, 0, 160, 0]);
    expect(spans).toContainEqual([80, -80, 80, 0]);
    expect(spans).toContainEqual([80, 0, 80, 80]);
  });

  it('never splits the dragged element itself', () => {
    // The dragged wire's own span passes through the drop point of its post,
    // which must not cost it a split.
    const dragged = addWire(0, 0, 160, 0);

    useStore.getState().autoSplitAt({ x: 80, y: 0 }, dragged);

    expect(useStore.getState().elements).toHaveLength(1);
  });

  it('leaves an endpoint drop and an empty-canvas drop alone', () => {
    const crossed = addWire(0, 0, 160, 0);
    const dragged = addWire(0, 32, 0, 0);

    // Post to post is an ordinary connection, and (80,64) is on nothing.
    useStore.getState().autoSplitAt({ x: 0, y: 0 }, dragged);
    useStore.getState().autoSplitAt({ x: 80, y: 64 }, dragged);

    const s = useStore.getState();
    expect(s.elements).toHaveLength(2);
    expect(s.elements.some((e) => e.id === crossed)).toBe(true);
  });

  it("ignores a drop on a part's drawn body: only its bare leads split", () => {
    // (80,0) is the middle of the zigzag, not a lead, so nothing connects
    // there and the resistor keeps its span.
    const resistor = useStore.getState().addElement({
      kind: 'resistor',
      x1: 0,
      y1: 0,
      x2: 160,
      y2: 0,
      flags: 0,
      params: { resistance: 1000 },
    });
    const dragged = addWire(80, 80, 80, 0);

    useStore.getState().autoSplitAt({ x: 80, y: 0 }, dragged);

    const s = useStore.getState();
    expect(s.elements).toHaveLength(2);
    expect(s.elements.find((e) => e.id === resistor)).toMatchObject({ x1: 0, x2: 160 });
  });

  it("splits a part's lead, pulling the post in and filling the rest with a wire", () => {
    // Upstream's splitLeadsAt (MouseManager.java:615-636): the picture does
    // not change, but the drop point becomes a real terminal instead of a bad
    // connection. A 160-long resistor's body is 32 long about its middle, so
    // (32,0) is on post 0's lead.
    const resistor = useStore.getState().addElement({
      kind: 'resistor',
      x1: 0,
      y1: 0,
      x2: 160,
      y2: 0,
      flags: 0,
      params: { resistance: 1000 },
    });
    const dragged = addWire(32, 80, 32, 0);

    useStore.getState().autoSplitAt({ x: 32, y: 0 }, dragged);

    const s = useStore.getState();
    expect(s.elements.find((e) => e.id === resistor)).toMatchObject({
      x1: 32,
      y1: 0,
      x2: 160,
      y2: 0,
    });
    // The wire that fills what the lead gave up, from the drop point back to
    // where the post was.
    const spans = s.elements.filter((e) => e.kind === 'wire').map((e) => [e.x1, e.y1, e.x2, e.y2]);
    expect(spans).toContainEqual([32, 0, 0, 0]);
    // The dragged wire is untouched, and nothing else was added.
    expect(spans).toContainEqual([32, 80, 32, 0]);
    expect(s.elements).toHaveLength(3);
  });

  it('splits the far lead too, and never the element being dragged', () => {
    const resistor = useStore.getState().addElement({
      kind: 'resistor',
      x1: 0,
      y1: 0,
      x2: 160,
      y2: 0,
      flags: 0,
      params: { resistance: 1000 },
    });
    const dragged = addWire(128, 80, 128, 0);

    useStore.getState().autoSplitAt({ x: 128, y: 0 }, dragged);

    const s = useStore.getState();
    expect(s.elements.find((e) => e.id === resistor)).toMatchObject({ x2: 128, y2: 0 });
    const spans = s.elements.filter((e) => e.kind === 'wire').map((e) => [e.x1, e.y1, e.x2, e.y2]);
    expect(spans).toContainEqual([128, 0, 160, 0]);

    // A second drop at the same point now lands on the new wire's endpoint and
    // on the resistor's post, so nothing more happens.
    const count = s.elements.length;
    useStore.getState().autoSplitAt({ x: 128, y: 0 }, dragged);
    expect(useStore.getState().elements).toHaveLength(count);
  });

  it('takes the lead split back with the drag, in one undo step', () => {
    const resistor = useStore.getState().addElement({
      kind: 'resistor',
      x1: 0,
      y1: 0,
      x2: 160,
      y2: 0,
      flags: 0,
      params: { resistance: 1000 },
    });
    const dragged = addWire(32, 80, 32, 0);
    useStore.getState().commit();
    const baseline = useStore.getState().undoStack.length;

    useStore.getState().autoSplitAt({ x: 32, y: 0 }, dragged);
    expect(useStore.getState().undoStack.length).toBe(baseline);

    useStore.getState().undo();

    const s = useStore.getState();
    expect(s.elements).toHaveLength(2);
    expect(s.elements.find((e) => e.id === resistor)).toMatchObject({ x1: 0, x2: 160 });
  });

  it('pushes no undo entry of its own: the drag committed at pointer-down', () => {
    const crossed = addWire(0, 0, 160, 0);
    const dragged = addWire(80, 80, 80, 0);
    // What a post drag does: commit the baseline, move the post, then split.
    useStore.getState().commit();
    useStore.getState().updateElement(dragged, { x2: 80, y2: 0 });
    const baseline = useStore.getState().undoStack.length;

    useStore.getState().autoSplitAt({ x: 80, y: 0 }, dragged);
    expect(useStore.getState().undoStack.length).toBe(baseline);

    useStore.getState().undo();

    // One step takes the move and the split back together.
    const s = useStore.getState();
    expect(s.elements).toHaveLength(2);
    expect(s.elements.find((e) => e.id === crossed)).toMatchObject({ x1: 0, y1: 0, x2: 160, y2: 0 });
  });

  it('splits a routed wire the post landed on, into two routed halves', () => {
    const routed = useStore.getState().addElement({
      kind: 'wire',
      x1: 0,
      y1: 0,
      x2: 160,
      y2: 0,
      flags: 0,
      params: {},
      route: [
        [0, 0],
        [0, 80],
        [160, 80],
        [160, 0],
      ],
    });
    const dragged = addWire(80, 160, 80, 80);

    useStore.getState().autoSplitAt({ x: 80, y: 80 }, dragged);

    const s = useStore.getState();
    expect(s.elements.some((e) => e.id === routed)).toBe(false);
    const routes = s.elements.filter((e) => e.route !== undefined).map((e) => e.route);
    expect(routes).toContainEqual([
      [0, 0],
      [0, 80],
      [80, 80],
    ]);
    expect(routes).toContainEqual([
      [80, 80],
      [160, 80],
      [160, 0],
    ]);
  });

  it('bumps the revision so the engine reloads with the new wires', () => {
    const dragged = addWire(80, 80, 80, 0);
    addWire(0, 0, 160, 0);
    const rev = useStore.getState().revision;

    useStore.getState().autoSplitAt({ x: 80, y: 0 }, dragged);

    expect(useStore.getState().revision).toBe(rev + 1);
  });
});

describe('a drawn wire connects where it crosses junction posts', () => {
  // Upstream's WireElm.draggingDone: a freshly drawn plain wire splits at
  // every existing junction-dot post lying on its interior, and any
  // sub-segment duplicating an existing colinear two-terminal element is
  // dropped instead of laid parallel (WireElm.java:286-316).
  const addWire = (x1: number, y1: number, x2: number, y2: number) =>
    useStore.getState().addElement({
      kind: 'wire',
      x1,
      y1,
      x2,
      y2,
      flags: 0,
      params: {},
    });
  const spans = () =>
    useStore
      .getState()
      .elements.filter((e) => e.kind === 'wire')
      .map((e) => [e.x1, e.y1, e.x2, e.y2]);

  it('splits at a T-junction post mid-span, one undo entry for the whole gesture', () => {
    // A real T-junction: two bar wires and a grounded post share (80,0), so a
    // junction dot draws there. The ground's stem hangs off the far side, so
    // the drawn span crosses exactly one dot point.
    addWire(0, 0, 80, 0);
    addWire(80, 0, 160, 0);
    useStore
      .getState()
      .addElement({ kind: 'ground', x1: 80, y1: 0, x2: 80, y2: 32, flags: 0, params: {} });
    const baseline = useStore.getState().undoStack.length;

    useStore.getState().addWires([{ x1: 80, y1: -96, x2: 80, y2: 96 }]);

    // The drawn run came back split at the crossing, so both halves meet the
    // junction's node.
    expect(spans()).toContainEqual([80, -96, 80, 0]);
    expect(spans()).toContainEqual([80, 0, 80, 96]);
    // The gesture pushed exactly one entry, and it takes everything back.
    expect(useStore.getState().undoStack.length).toBe(baseline + 1);
    useStore.getState().undo();
    expect(spans()).toEqual([
      [0, 0, 80, 0],
      [80, 0, 160, 0],
    ]);
  });

  it('splits at a dead-end post too', () => {
    // A dangling stub's far end counts one post, which upstream's
    // postDrawList includes like any junction dot.
    addWire(80, 0, 80, 32);

    useStore.getState().addWires([{ x1: 0, y1: 0, x2: 160, y2: 0 }]);

    expect(spans()).toContainEqual([0, 0, 80, 0]);
    expect(spans()).toContainEqual([80, 0, 160, 0]);
    // The stub is untouched; its end is now a real connection.
    expect(spans()).toContainEqual([80, 0, 80, 32]);
  });

  it('drops a sub-segment that would lie parallel on an existing part', () => {
    // Redrawing an existing connection across its middle junction must not
    // lay a second copy over each half: an electrical loop upstream avoids
    // with hasDirectConnection. Both halves duplicate existing wires, so the
    // whole drawn wire vanishes again.
    addWire(0, 0, 80, 0);
    addWire(80, 0, 160, 0);
    addWire(80, 0, 80, 80);
    const before = useStore.getState().elements;

    useStore.getState().addWires([{ x1: 0, y1: 0, x2: 160, y2: 0 }]);

    expect(useStore.getState().elements).toEqual(before);
  });

  it('leaves a crossing without a post alone', () => {
    // The horizontal wire has no terminal mid-span, so (80,0) is not a dot
    // point and the drawn wire stays whole.
    addWire(0, 0, 160, 0);
    const before = useStore.getState().elements.length;

    useStore.getState().addWires([{ x1: 80, y1: -64, x2: 80, y2: 64 }]);

    expect(useStore.getState().elements).toHaveLength(before + 1);
    expect(spans()).toContainEqual([80, -64, 80, 64]);
    expect(spans()).toContainEqual([0, 0, 160, 0]);
  });

  it('still splits what an endpoint lands on when the interior crosses nothing', () => {
    // The endpoint-driven rule (placeWireEnd) keeps working unchanged beside
    // the new interior pass.
    addWire(0, 0, 160, 0);

    useStore.getState().addWires([{ x1: 80, y1: -64, x2: 80, y2: 0 }]);

    expect(spans()).toContainEqual([0, 0, 80, 0]);
    expect(spans()).toContainEqual([80, 0, 160, 0]);
    expect(spans()).toContainEqual([80, -64, 80, 0]);
    expect(useStore.getState().elements.filter((e) => e.kind === 'wire')).toHaveLength(3);
  });

  it('never splits at a plain seam between two colinear wires', () => {
    // The case upstream's postDrawList choice exists for: two posts meeting
    // end to end count exactly 2, draw no dot, and are not meant to become a
    // distinct node of their own, so drawing through the seam must leave
    // them alone.
    addWire(0, 0, 80, 0);
    addWire(80, 0, 160, 0);

    useStore.getState().addWires([{ x1: 80, y1: -64, x2: 80, y2: 64 }]);

    expect(spans()).toContainEqual([80, -64, 80, 64]);
    expect(useStore.getState().elements.filter((e) => e.kind === 'wire')).toHaveLength(3);
  });

  it('never splits at a bare text anchor', () => {
    // A label parked mid-span is pure drawing (GraphicElm.java:35): upstream
    // gives TextElm no posts, so the anchor draws no dot and a run drawn
    // through it stays whole instead of becoming two dangling halves.
    useStore.getState().addElement({
      kind: 'decoration',
      x1: 80,
      y1: 0,
      x2: 80,
      y2: 0,
      flags: 4,
      params: {},
      text: 'note',
    });

    useStore.getState().addWires([{ x1: 0, y1: 0, x2: 160, y2: 0 }]);
    const baseline = useStore.getState().undoStack.length;

    useStore.getState().addWires([{ x1: 80, y1: -64, x2: 80, y2: 64 }]);

    expect(spans()).toContainEqual([80, -64, 80, 64]);
    expect(spans()).toContainEqual([0, 0, 160, 0]);
    expect(useStore.getState().elements.filter((e) => e.kind === 'wire')).toHaveLength(2);
    expect(useStore.getState().undoStack.length).toBe(baseline + 1);
  });

  it('returns no ids when every piece of a drawn leg duplicates existing parts', () => {
    // Redrawing an existing connection across its junction drops every piece
    // as a parallel duplicate, so the gesture ends with no id to select
    // rather than one no element holds.
    addWire(0, 0, 80, 0);
    addWire(80, 0, 160, 0);
    addWire(80, 0, 80, -64);

    const ids = useStore.getState().addWires([{ x1: 0, y1: 0, x2: 160, y2: 0 }]);
    const s = useStore.getState();

    expect(ids).toEqual([]);
    // Whatever the caller kept from this gesture is real geometry.
    for (const id of [...ids, ...s.selectedIds]) {
      expect(s.elements.some((e) => e.id === id)).toBe(true);
    }
    expect(s.elements.filter((e) => e.kind === 'wire')).toHaveLength(3);
  });

  it('keeps the drawn wire id on its first surviving piece', () => {
    // Upstream turns the dragged element itself into the first segment, so
    // what the gesture selected survives the split.
    addWire(0, 0, 80, 0);
    addWire(80, 0, 160, 0);
    useStore
      .getState()
      .addElement({ kind: 'ground', x1: 80, y1: 0, x2: 80, y2: 32, flags: 0, params: {} });

    const [drawn] = useStore.getState().addWires([{ x1: 80, y1: -96, x2: 80, y2: 96 }]);

    const piece = useStore
      .getState()
      .elements.find((e) => e.id === drawn && e.kind === 'wire');
    expect(piece).toBeDefined();
    expect([piece!.x1, piece!.y1, piece!.x2, piece!.y2]).toEqual([80, -96, 80, 0]);
  });

  it('never re-splits when an existing element merely moves across posts', () => {
    // Only freshly drawn wires get the pass: a moved element crossing posts
    // connects nothing, exactly as before.
    addWire(0, 0, 80, 0);
    addWire(80, 0, 160, 0);
    addWire(80, 0, 80, 80);
    const mover = addWire(240, -64, 240, 64);

    useStore.getState().moveElements([mover], -160, 0);

    // The moved wire arrived on the T-junction whole: same count, no pieces.
    expect(useStore.getState().elements.filter((e) => e.kind === 'wire')).toHaveLength(4);
    expect(spans()).toContainEqual([80, -64, 80, 64]);
  });
});

describe('manual wire split (Split Wire Manually)', () => {
  const addWire = (x1: number, y1: number, x2: number, y2: number) =>
    useStore.getState().addElement({
      kind: 'wire',
      x1,
      y1,
      x2,
      y2,
      flags: 0,
      params: {},
    });

  it('splits a wire at the snapped interior point into two halves, one undo step', () => {
    const id = addWire(0, 0, 64, 0);
    const baseline = useStore.getState().undoStack.length;
    const rev = useStore.getState().revision;

    useStore.getState().splitWireAt(id, { x: 33, y: 1 });

    const s = useStore.getState();
    expect(s.elements.some((e) => e.id === id)).toBe(false);
    const wires = s.elements.filter((e) => e.kind === 'wire');
    expect(wires).toHaveLength(2);
    // The off-grid click snaps to (32, 0) and splits there, like upstream's
    // doSplit snapGrid (MouseManager.java:586-593).
    const sorted = [...wires].sort((p, q) => p.x1 - q.x1);
    expect(sorted[0]).toMatchObject({ x1: 0, y1: 0, x2: 32, y2: 0 });
    expect(sorted[1]).toMatchObject({ x1: 32, y1: 0, x2: 64, y2: 0 });
    expect(s.undoStack.length).toBe(baseline + 1);
    expect(s.revision).toBe(rev + 1);

    s.undo();
    expect(useStore.getState().elements.find((e) => e.id === id)).toMatchObject({
      x1: 0,
      y1: 0,
      x2: 64,
      y2: 0,
    });
  });

  it('refuses a non-wire target', () => {
    const id = addWire(0, 0, 64, 0);
    const resistor = useStore.getState().addElement({
      kind: 'resistor',
      x1: 0,
      y1: 0,
      x2: 32,
      y2: 0,
      flags: 0,
      params: { resistance: 1000 },
    });
    const before = useStore.getState().elements.length;
    const baseline = useStore.getState().undoStack.length;

    useStore.getState().splitWireAt(resistor, { x: 16, y: 0 });

    const s = useStore.getState();
    expect(s.elements.length).toBe(before);
    expect(s.elements.some((e) => e.id === id)).toBe(true);
    expect(s.undoStack.length).toBe(baseline);
  });

  it('refuses an endpoint, which is an ordinary connection not a split', () => {
    const id = addWire(0, 0, 64, 0);
    const baseline = useStore.getState().undoStack.length;

    useStore.getState().splitWireAt(id, { x: 0, y: 0 });

    const s = useStore.getState();
    expect(s.elements).toHaveLength(1);
    expect(s.elements[0].id).toBe(id);
    expect(s.elements[0].x2).toBe(64);
    expect(s.undoStack.length).toBe(baseline);
  });

  it('refuses a point off the span', () => {
    const id = addWire(0, 0, 64, 0);

    // Snaps to (80, 0), past the far end.
    useStore.getState().splitWireAt(id, { x: 81, y: 0 });

    expect(useStore.getState().elements).toHaveLength(1);
  });

  it('splits a routed wire at its bend vertex into two routed halves', () => {
    const id = useStore.getState().addElement({
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

    useStore.getState().splitWireAt(id, { x: 80, y: 80 });

    const wires = useStore.getState().elements.filter((e) => e.kind === 'wire');
    expect(wires).toHaveLength(2);
    const sorted = [...wires].sort((p, q) => p.x1 - q.x1);
    expect(sorted[0].route).toEqual([
      [0, 0],
      [80, 80],
    ]);
    expect(sorted[1].route).toEqual([
      [80, 80],
      [160, 0],
    ]);
  });
});
