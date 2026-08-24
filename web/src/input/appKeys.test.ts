/** The modal-surface keyboard gate (UIManager.java:996-1013),
 *  table driven over every blocking surface: while one is up no shortcut
 *  reaches the app on keydown, keyup releases nothing, and an open context
 *  menu owns Escape exclusively. Everything runs against the real store with
 *  a recording host; no DOM anywhere. */

import { beforeEach, describe, expect, it } from 'vitest';
import { clearUserModels } from '../model/deviceModels';
import type { AppState } from '../state/types';
import { useStore } from '../state/store';
import { addResistor, fresh } from '../state/store.test-helpers';
import { handleAppKeyDown, handleAppKeyUp, type AppKeyEvent, type AppKeyHost } from './appKeys';
import { modalSurface } from './modalSurface';

beforeEach(() => {
  useStore.setState(fresh());
  clearUserModels();
});

const key = (partial: { key: string } & Partial<AppKeyEvent>): AppKeyEvent => ({
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...partial,
});

/** A host that records every browser side effect instead of performing it,
 *  so a test can assert nothing at all was dispatched behind a modal. */
const recordingHost = (): AppKeyHost & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    openFile: () => void calls.push('open'),
    print: () => void calls.push('print'),
    alert: (message) => void calls.push(`alert:${message}`),
    openPalette: () => void calls.push('palette'),
    stateAfter: () => useStore.getState(),
  };
};

const diodeEntry = (name: string) => ({
  name,
  builtIn: false as const,
  flags: 0,
  saturationCurrent: 1e-9,
  seriesResistance: 0,
  emissionCoefficient: 2,
  breakdownVoltage: 0,
});

const menuAt = () => ({ x: 24, y: 24, target: null, circuit: { x: 0, y: 0 }, focusSearch: false });

/** Every surface the gate must treat as owning the keyboard, each opened by
 *  writing its own store field directly. */
const SURFACES: readonly (readonly [string, () => Partial<AppState>])[] = [
  ['dialog', () => ({ dialog: 'about' })],
  ['scopeProperties', () => ({ scopeProperties: 1 })],
  ['elementProperties', () => ({ elementProperties: 1 })],
  [
    'deviceModelEditor',
    () => ({ deviceModelEditor: { family: 'diode', initial: diodeEntry('draft') } }),
  ],
  ['contextMenu', () => ({ contextMenu: menuAt() })],
];

describe('modalSurface', () => {
  it('is false on the bare editor state', () => {
    expect(modalSurface(useStore.getState())).toBe(false);
  });

  it.each(SURFACES)('is true while %s is up', (_name, open) => {
    useStore.setState(open());
    expect(modalSurface(useStore.getState())).toBe(true);
  });
});

describe.each(SURFACES)('keydown while %s is up', (_name, open) => {
  it('suppresses Delete, Backspace, Ctrl+Z and a placement letter', () => {
    const id = addResistor();
    useStore.getState().select([id]);
    useStore.setState(open());
    const host = recordingHost();
    const undoDepth = useStore.getState().undoStack.length;

    for (const ev of [
      key({ key: 'Delete' }),
      key({ key: 'Backspace' }),
      key({ key: 'z', ctrlKey: true }),
      key({ key: 'r' }),
    ]) {
      expect(handleAppKeyDown(useStore.getState(), ev, host)).toBe(false);
    }

    // Nothing reached the circuit behind the modal: the resistor survives
    // unselected-work intact, no tool armed, no undo entry popped, and the
    // browser-bound host never heard a command.
    expect(host.calls).toEqual([]);
    expect(useStore.getState().elements).toHaveLength(1);
    expect(useStore.getState().tool).toBeNull();
    expect(useStore.getState().undoStack.length).toBe(undoDepth);
  });

  it('releases nothing on keyup', () => {
    // A momentary switch is held closed by its key when the surface opens;
    // the gated keyup must leave it closed.
    useStore.getState().addElement({
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
    expect(useStore.getState().toggleSwitchByKey('k')).toBe(true);
    useStore.setState(open());

    expect(handleAppKeyUp(useStore.getState(), key({ key: 'k' }))).toBe(false);
    expect(useStore.getState().elements[0].state).toBe(0);
  });
});

describe('with every surface closed', () => {
  it('Delete deletes the selection and Ctrl+Z brings it back', () => {
    const id = addResistor();
    useStore.getState().select([id]);
    const host = recordingHost();

    expect(handleAppKeyDown(useStore.getState(), key({ key: 'Delete' }), host)).toBe(true);
    expect(useStore.getState().elements).toHaveLength(0);
    expect(handleAppKeyDown(useStore.getState(), key({ key: 'z', ctrlKey: true }), host)).toBe(
      true,
    );
    expect(useStore.getState().elements).toHaveLength(1);
  });

  it('a placement letter arms its tool', () => {
    expect(handleAppKeyDown(useStore.getState(), key({ key: 'r' }), recordingHost())).toBe(true);
    expect(useStore.getState().tool).toBe('resistor');
  });

  it('the switch key beats commands, and its keyup releases the momentary', () => {
    useStore.getState().addElement({
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
    const host = recordingHost();

    expect(handleAppKeyDown(useStore.getState(), key({ key: 'k' }), host)).toBe(true);
    expect(host.calls).toEqual([]);
    expect(useStore.getState().elements[0].state).toBe(0);

    // Modifiers suppress the release path, like upstream.
    expect(handleAppKeyUp(useStore.getState(), key({ key: 'k', ctrlKey: true }))).toBe(false);
    expect(handleAppKeyUp(useStore.getState(), key({ key: 'k' }))).toBe(true);
    expect(useStore.getState().elements[0].state).toBe(1);
  });
});

describe('Escape ownership', () => {
  /** The drill-in suite's outer document: one 410 naming the model, the
   *  model's own `.` line, and a passthrough line that must survive. */
  const OUTER =
    '$ 1 0.000005 10 50 5 50 5e-11\n' +
    '410 0 0 64 64 1 myCirc\n' +
    '. myCirc 0 2 2 2 in 1 0 0 out 3 0 1 ' +
    'ResistorElm\\s1\\s2\\rResistorElm\\s2\\s3 ' +
    '0\\\\s1000\\s0\\\\s1000\n' +
    'h keep me\n';

  const drillIn = () => {
    useStore.getState().loadNetlist(OUTER);
    expect(useStore.getState().enterSubcircuit('myCirc')).toBe(true);
    useStore.getState().setTool('resistor');
  };

  it('one Escape with a menu up closes only the menu: the drill-in and tool survive', () => {
    drillIn();
    useStore.setState({ contextMenu: menuAt() });
    const host = recordingHost();

    // The app-level handler stands down entirely; the menu owns the key.
    expect(handleAppKeyDown(useStore.getState(), key({ key: 'Escape' }), host)).toBe(false);

    // ContextMenu.tsx's own window listener is what closes the menu; mirror
    // it here to represent the one thing this Escape press does.
    useStore.getState().closeContextMenu();

    const s = useStore.getState();
    expect(host.calls).toEqual([]);
    expect(s.contextMenu).toBeNull();
    expect(s.subcircuitStack).toHaveLength(1);
    expect(s.tool).toBe('resistor');
  });

  it('without a menu, one Escape exits the drill-in and leaves the tool alone', () => {
    drillIn();

    expect(handleAppKeyDown(useStore.getState(), key({ key: 'Escape' }), recordingHost())).toBe(
      true,
    );

    const s = useStore.getState();
    expect(s.subcircuitStack).toHaveLength(0);
    expect(s.tool).toBe('resistor');
  });

  it('without a stack, one Escape disarms the armed tool and nothing else', () => {
    drillIn();
    useStore.getState().exitSubcircuit();
    expect(useStore.getState().subcircuitStack).toHaveLength(0);
    expect(useStore.getState().tool).toBe('resistor');

    expect(handleAppKeyDown(useStore.getState(), key({ key: 'Escape' }), recordingHost())).toBe(
      true,
    );

    expect(useStore.getState().tool).toBeNull();
    expect(useStore.getState().subcircuitStack).toHaveLength(0);
  });
});
