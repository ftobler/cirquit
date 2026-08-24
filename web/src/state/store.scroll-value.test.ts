/** The wheel value popover's session in the store: open, step, close and
 *  revert against the real store. The session lives here rather than in
 *  component state so modalSurface can count it like upstream counts
 *  scrollValuePopup.isShowing() (UIManager.java:1007-1008); these tests pin
 *  the editing behaviour that must not change while it moves. */

import { beforeEach, describe, expect, it } from 'vitest';
import { selectionValue, stepScrollValue } from '../model/scrollValue';
import { useStore } from './store';
import { addResistor, fresh } from './store.test-helpers';

beforeEach(() => useStore.setState(fresh()));

const openOn = () => {
  const id = addResistor();
  const session = {
    session: {
      id,
      kind: 'resistor',
      param: 'resistance',
      values: [680, 820, 1000, 1200, 1500],
      index: 2,
      original: 1000,
      steps: 0,
      remainder: 0,
    },
    name: 'Resistance',
    x: 40,
    y: 60,
  };
  useStore.getState().openScrollValuePopover(session);
  return { id, session: session.session };
};

describe('openScrollValuePopover', () => {
  it('stores the session, label and position verbatim', () => {
    const { session } = openOn();
    expect(useStore.getState().scrollValuePopover).toEqual({
      session,
      name: 'Resistance',
      x: 40,
      y: 60,
    });
  });

  it('pushes no undo entry by itself; the opener commits first', () => {
    // onWheel commits before opening (the port of upstream's constructor
    // pushUndo), so the store action must not commit again behind its back.
    const depth = useStore.getState().undoStack.length;
    useStore.getState().openScrollValuePopover({
      session: { id: 1, kind: 'resistor', param: 'resistance', values: [1], index: 0, original: 1, steps: 0, remainder: 0 },
      name: 'R',
      x: 0,
      y: 0,
    });
    expect(useStore.getState().undoStack.length).toBe(depth);
  });
});

describe('stepScrollValuePopover', () => {
  it('advances the session and writes the stepped value through setParam', () => {
    const { id, session } = openOn();
    const before = useStore.getState();

    useStore.getState().stepScrollValuePopover(100);

    const after = useStore.getState();
    const stepped = stepScrollValue(session, 100, before.settings.wheelSensitivity);
    expect(after.scrollValuePopover?.session).toEqual(stepped);
    expect(after.elements.find((e) => e.id === id)?.params.resistance).toBe(
      selectionValue(stepped),
    );
    // A live value write rides the fast path, exactly like any other setParam.
    expect(after.paramRevision).toBe(before.paramRevision + 1);
    expect(after.revision).toBe(before.revision);
  });

  it('reads wheelSensitivity live so a mid-session settings change applies', () => {
    openOn();
    useStore.getState().updateSettings({ wheelSensitivity: 2 });

    useStore.getState().stepScrollValuePopover(100);

    const s = useStore.getState().scrollValuePopover?.session;
    expect(s?.steps).toBe(2);
  });

  it('is a no-op with no session open', () => {
    const before = useStore.getState();
    useStore.getState().stepScrollValuePopover(100);
    expect(useStore.getState().scrollValuePopover).toBeNull();
    expect(useStore.getState().paramRevision).toBe(before.paramRevision);
  });
});

describe('closeScrollValuePopover', () => {
  it('keeps the stepped value and clears the field', () => {
    const { id } = openOn();
    useStore.getState().stepScrollValuePopover(100);
    const stepped = useStore.getState().elements.find((e) => e.id === id)?.params.resistance;

    useStore.getState().closeScrollValuePopover();

    expect(useStore.getState().scrollValuePopover).toBeNull();
    expect(useStore.getState().elements.find((e) => e.id === id)?.params.resistance).toBe(stepped);
  });
});

describe('revertScrollValuePopover', () => {
  it('restores the opening value and clears the field', () => {
    const { id } = openOn();
    useStore.getState().stepScrollValuePopover(200);

    useStore.getState().revertScrollValuePopover();

    expect(useStore.getState().scrollValuePopover).toBeNull();
    expect(useStore.getState().elements.find((e) => e.id === id)?.params.resistance).toBe(1000);
  });

  it('is a no-op with no session open', () => {
    useStore.getState().revertScrollValuePopover();
    expect(useStore.getState().scrollValuePopover).toBeNull();
  });
});

describe('the whole session is one undo entry', () => {
  it('commit, open, steps and close undo back to the original circuit', () => {
    const id = addResistor();
    const store = useStore.getState();
    store.commit();
    const depth = useStore.getState().undoStack.length;

    store.openScrollValuePopover({
      session: {
        id,
        kind: 'resistor',
        param: 'resistance',
        values: [680, 820, 1000, 1200, 1500],
        index: 2,
        original: 1000,
        steps: 0,
        remainder: 0,
      },
      name: 'Resistance',
      x: 0,
      y: 0,
    });
    useStore.getState().stepScrollValuePopover(100);
    useStore.getState().closeScrollValuePopover();
    expect(useStore.getState().undoStack.length).toBe(depth);

    useStore.getState().undo();
    expect(useStore.getState().elements.find((e) => e.id === id)?.params.resistance).toBe(1000);
  });
});
