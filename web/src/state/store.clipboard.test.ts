import { beforeEach, describe, expect, it } from 'vitest';
import { GRID_SIZE } from '../model/types';
import { parseCircuit } from '../io/netlist';
import { useStore } from './store';
import { addCapacitor, addResistor, dropId, fresh } from './store.test-helpers';

beforeEach(() => useStore.setState(fresh()));

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
