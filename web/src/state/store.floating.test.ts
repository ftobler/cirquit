import { beforeEach, describe, expect, it } from 'vitest';
import { addResistor, fresh } from './store.test-helpers';
import { useStore } from './store';
import { dockedScopes } from '../ui/scopeStrip';

const rect = { x: 10, y: 20, w: 300, h: 200 };

function twoScopes(): [number, number] {
  useStore.getState().addScope(addResistor(), 'voltage');
  useStore.getState().addScope(addResistor(), 'voltage');
  const [a, b] = useStore.getState().scopes.map((s) => s.id);
  return [a, b];
}

describe('floating scope panels', () => {
  beforeEach(() => {
    useStore.setState(fresh());
  });

  it('float takes a scope out of the dock, dock puts it back', () => {
    const [a, b] = twoScopes();
    useStore.getState().floatScope(a);
    const st = useStore.getState();
    // No rect yet: the layer places it at its cascade slot.
    expect(st.floating).toEqual([{ id: a, rect: null, slot: 0, z: 1 }]);
    expect(dockedScopes(st.scopes, st.floating).map((s) => s.id)).toEqual([b]);
    useStore.getState().dockScope(a);
    expect(useStore.getState().floating).toEqual([]);
  });

  it('is not an edit: no undo entry and the file is unchanged', () => {
    const [a] = twoScopes();
    const before = useStore.getState().toNetlist();
    const depth = useStore.getState().undoStack.length;
    useStore.getState().floatScope(a, rect);
    useStore.getState().setFloatRect(a, { ...rect, x: 99 });
    expect(useStore.getState().undoStack.length).toBe(depth);
    expect(useStore.getState().toNetlist()).toBe(before);
  });

  it('raises by z-index and never reorders the list', () => {
    const [a, b] = twoScopes();
    useStore.getState().floatScope(a, rect);
    useStore.getState().floatScope(b);
    const ids = () => useStore.getState().floating.map((f) => f.id);
    const top = () =>
      [...useStore.getState().floating].sort((p, q) => q.z - p.z)[0].id;
    expect(top()).toBe(b);
    useStore.getState().raiseFloatingScope(a);
    // The DOM order is the array order; a reorder would drop the pointer
    // capture of a drag that begins with this very raise.
    expect(ids()).toEqual([a, b]);
    expect(top()).toBe(a);
    // Raising the top panel again changes nothing at all.
    const before = useStore.getState().floating;
    useStore.getState().raiseFloatingScope(a);
    expect(useStore.getState().floating).toBe(before);
    // Floating an already floating scope raises it and keeps its rect.
    useStore.getState().floatScope(a);
    expect(useStore.getState().floating.find((f) => f.id === a)?.rect).toEqual(rect);
  });

  it('gives each panel a fixed cascade slot', () => {
    const [a, b] = twoScopes();
    useStore.getState().floatScope(a);
    useStore.getState().floatScope(b);
    useStore.getState().raiseFloatingScope(a);
    useStore.getState().dockScope(a);
    // b keeps the slot it was given, so its default place does not move.
    expect(useStore.getState().floating).toMatchObject([{ id: b, slot: 1 }]);
  });

  it('ignores rects and docks for scopes that are not floating', () => {
    const [a] = twoScopes();
    useStore.getState().setFloatRect(a, rect);
    useStore.getState().dockScope(a);
    useStore.getState().raiseFloatingScope(a);
    expect(useStore.getState().floating).toEqual([]);
  });

  it('undoing a removal brings the scope back still floating', () => {
    const [a] = twoScopes();
    useStore.getState().floatScope(a, rect);
    useStore.getState().removeScope(a);
    expect(useStore.getState().scopes.some((s) => s.id === a)).toBe(false);
    useStore.getState().undo();
    const st = useStore.getState();
    expect(st.scopes.some((s) => s.id === a)).toBe(true);
    expect(dockedScopes(st.scopes, st.floating).some((s) => s.id === a)).toBe(false);
  });

  it('refuses an id that names no scope', () => {
    useStore.getState().floatScope(12345);
    expect(useStore.getState().floating).toEqual([]);
  });

  it('a load or New docks every panel', () => {
    const [a] = twoScopes();
    useStore.getState().floatScope(a, rect);
    useStore.getState().newCircuit();
    expect(useStore.getState().floating).toEqual([]);
    twoScopes();
    useStore.getState().floatScope(useStore.getState().scopes[0].id, rect);
    useStore
      .getState()
      .loadNetlist('$ 1 0.000005 10 50 5 43 5e-11\nr 0 0 16 0 0 100\no 0 64 0 4099\n');
    expect(useStore.getState().floating).toEqual([]);
  });

  it('a drop moves a scope as one undo step and docks a floating one', () => {
    const [a, b] = twoScopes();
    const depth = useStore.getState().undoStack.length;
    useStore.getState().floatScope(b, rect);
    useStore.getState().moveScope(b, { kind: 'stack', withId: a });
    const st = useStore.getState();
    expect(st.floating).toEqual([]);
    expect(st.scopes.map((s) => [s.id, s.position])).toEqual([
      [a, 0],
      [b, 0],
    ]);
    expect(st.undoStack.length).toBe(depth + 1);
    useStore.getState().undo();
    expect(useStore.getState().scopes.map((s) => s.position)).toEqual([0, 1]);
  });

  it('a no-op drop pushes no undo entry, but still docks a floating scope', () => {
    const [, b] = twoScopes();
    useStore.getState().floatScope(b, rect);
    const depth = useStore.getState().undoStack.length;
    useStore.getState().moveScope(b, { kind: 'column', beforeId: null });
    expect(useStore.getState().undoStack.length).toBe(depth);
    expect(useStore.getState().floating).toEqual([]);
  });
});
