import { beforeEach, describe, expect, it } from 'vitest';
import { hasUnsavedChanges, useStore } from './store';
import { fresh } from './store.test-helpers';

beforeEach(() => useStore.setState(fresh()));

const NETLIST = [
  '$ 1 0.000005 10 50 5 50 5e-11',
  '413 0 0 64 0 0 4 4 2 5 6 -1 10 3 -1 -2',
  '',
].join('\n');

const sramId = () => useStore.getState().elements[0].id;

/** The saved 413 line of the current document. */
const sramLine = () =>
  useStore
    .getState()
    .toNetlist()
    .split('\n')
    .find((l) => l.startsWith('413 ')) ?? '';

describe('setMemoryContents', () => {
  it('swaps the pairs in one undo entry and restores exactly on undo', () => {
    useStore.getState().loadNetlist(NETLIST);
    const id = sramId();
    const before = useStore.getState().elements[0].params;
    useStore.getState().setMemoryContents(id, [
      [0, 1],
      [1, 2],
      [4, 9],
    ]);
    const after = useStore.getState().elements[0].params;
    expect(after.addr0).toBe(0);
    expect(after.val0).toBe(1);
    expect(after.addr1).toBe(1);
    expect(after.val1).toBe(2);
    expect(after.addr2).toBe(4);
    expect(after.val2).toBe(9);
    // The action's baseline commit is the whole edit: one undo restores the
    // exact pre-edit state.
    expect(useStore.getState().undoStack).toHaveLength(1);
    useStore.getState().undo();
    expect(useStore.getState().elements[0].params).toEqual(before);
  });

  it('marks the document dirty', () => {
    useStore.getState().loadNetlist(NETLIST);
    const s = useStore.getState();
    expect(hasUnsavedChanges(s.lastSaved, s.toNetlist())).toBe(false);
    useStore.getState().setMemoryContents(sramId(), [[0, 1]]);
    const after = useStore.getState();
    expect(hasUnsavedChanges(after.lastSaved, after.toNetlist())).toBe(true);
  });

  it('bumps revision and leaves the other params alone', () => {
    useStore.getState().loadNetlist(NETLIST);
    const id = sramId();
    const s = useStore.getState();
    useStore.getState().setMemoryContents(id, [[7, 3]]);
    const after = useStore.getState();
    expect(after.revision).toBe(s.revision + 1);
    expect(after.paramRevision).toBe(s.paramRevision + 1);
    const e = after.elements[0];
    expect(e.params.addressBits).toBe(4);
    expect(e.params.dataBits).toBe(4);
    expect(e.params.addr0).toBe(7);
    expect(e.params.val0).toBe(3);
  });

  it('an empty pair list saves a tokenless line', () => {
    useStore.getState().loadNetlist(NETLIST);
    useStore.getState().setMemoryContents(sramId(), []);
    expect(sramLine()).toBe('413 0 0 64 0 0 4 4');
  });

  it('a shrink cannot leave a stale trailing pair', () => {
    useStore.getState().loadNetlist(NETLIST);
    // The loaded line holds three pairs; shrink to one.
    useStore.getState().setMemoryContents(sramId(), [[0, 1]]);
    const e = useStore.getState().elements[0];
    expect(e.params.addr0).toBe(0);
    expect(e.params.addr1).toBeUndefined();
    expect(e.params.val1).toBeUndefined();
    expect(sramLine()).toBe('413 0 0 64 0 0 4 4 0 1 -1 -2');
  });

  it('a re-commit of the same pairs is a no-op', () => {
    useStore.getState().loadNetlist(NETLIST);
    const id = sramId();
    const s = useStore.getState();
    useStore.getState().setMemoryContents(id, [
      [2, 5],
      [3, 6],
      [10, 3],
    ]);
    const after = useStore.getState();
    expect(after.revision).toBe(s.revision);
    expect(after.undoStack).toHaveLength(0);
  });

  it('editing contents then serialising keeps memoryDump\'s grouped token stream', () => {
    useStore.getState().loadNetlist(NETLIST);
    useStore.getState().setMemoryContents(sramId(), [
      [0, 1],
      [1, 2],
      [4, 9],
    ]);
    expect(sramLine()).toBe('413 0 0 64 0 0 4 4 0 1 2 -1 4 9 -1 -2');
  });
});