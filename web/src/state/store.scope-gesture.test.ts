import { beforeEach, describe, expect, it } from 'vitest';
import type { StorageLike } from './appPrefs';
import { RECOVERY_STORAGE_KEY } from './recovery';
import { useStore } from './store';
import { addResistor, fresh, undoDepth } from './store.test-helpers';

beforeEach(() => useStore.setState(fresh()));

/** Builds a scope with one voltage plot and returns its ids. Mirrors the
 *  `scoped` helper in store.undo.test.ts. */
const scoped = () => {
  const a = addResistor();
  useStore.getState().addScope(a, 'voltage');
  const scopeId = useStore.getState().scopes[0].id;
  const plotId = useStore.getState().scopes[0].plots[0].id;
  return { a, scopeId, plotId };
};

const beginScope = () => useStore.getState().beginTransaction('Scope');
const endScope = () => useStore.getState().endTransaction();

describe('scope setter gesture-level undo', () => {
  it('a plot-Y drag collapses into one undo entry covering the whole drag', () => {
    const { plotId } = scoped();
    // Post-addScope state is the expected undo target: the drag must undo back
    // here, not to the last frame's position.
    const pre = useStore.getState().scopes;
    const baseline = undoDepth(useStore.getState());

    // The panel opens the transaction once at pointer-down, then the moves
    // mutate without checkpointing, then closes at pointer-up.
    beginScope();
    for (const pos of [10, 35, 60, 90, 120, 150]) {
      useStore.getState().setPlotManPosition(plotId, pos);
    }
    endScope();

    // Exactly one new entry (the gesture's pre-drag baseline), not one per frame.
    expect(undoDepth(useStore.getState())).toBe(baseline + 1);
    expect(useStore.getState().scopes[0].plots[0].manVPosition).toBe(150);

    // One undo reverts the entire drag, restoring the pre-drag position (0).
    useStore.getState().undo();
    expect(useStore.getState().scopes).toEqual(pre);
    expect(useStore.getState().scopes[0].plots[0].manVPosition).toBe(0);
  });

  it('a discrete setScopeSpeed outside a gesture still commits its own entry', () => {
    const { scopeId } = scoped();
    const baseline = undoDepth(useStore.getState());
    expect(useStore.getState().scopes[0].speed).toBe(64);

    useStore.getState().setScopeSpeed(scopeId, 128);

    // No open transaction, so the setter checkpoints itself, as the
    // properties/edit paths expect.
    expect(undoDepth(useStore.getState())).toBe(baseline + 1);
    expect(useStore.getState().scopes[0].speed).toBe(128);
    useStore.getState().undo();
    expect(useStore.getState().scopes[0].speed).toBe(64);
  });

  it('a speed wheel burst coalesces into one undo entry', () => {
    const { scopeId } = scoped();
    const pre = useStore.getState().scopes;
    const baseline = undoDepth(useStore.getState());

    // The panel opens the wheel transaction on the first zoom and closes it
    // after an idle timer; here we bracket it the same way the component does.
    beginScope();
    for (let i = 0; i < 5; i++) {
      useStore.getState().setScopeSpeed(scopeId, 64 * 2 ** (i + 1));
    }
    endScope();

    expect(undoDepth(useStore.getState())).toBe(baseline + 1);
    // The last zoom clamps at MAX_SPEED (1024), which is fine: the point under
    // test is the single undo entry, not the exact final value.
    expect(useStore.getState().scopes[0].speed).toBe(1024);

    useStore.getState().undo();
    expect(useStore.getState().scopes).toEqual(pre);
  });

  it('two separate gestures do not merge: each gets its own entry', () => {
    const { plotId } = scoped();
    const baseline = undoDepth(useStore.getState());

    beginScope();
    useStore.getState().setPlotManPosition(plotId, 20);
    endScope();

    beginScope();
    useStore.getState().setPlotManPosition(plotId, 80);
    endScope();

    // Two gestures, two entries; undoing steps back through each.
    expect(undoDepth(useStore.getState())).toBe(baseline + 2);
    useStore.getState().undo();
    expect(useStore.getState().scopes[0].plots[0].manVPosition).toBe(20);
    useStore.getState().undo();
    expect(useStore.getState().scopes[0].plots[0].manVPosition).toBe(0);
  });

  it('the open transaction is transient and never pollutes the snapshot', () => {
    const { plotId } = scoped();
    beginScope();
    useStore.getState().setPlotManPosition(plotId, 40);
    endScope();
    // The transaction is closed and is not part of the committed snapshot, so a
    // later discrete setter still commits normally.
    expect(useStore.getState().history.open).toBeNull();
    const { scopeId } = { scopeId: useStore.getState().scopes[0].id };
    const before = undoDepth(useStore.getState());
    useStore.getState().setScopeSpeed(scopeId, 256);
    expect(undoDepth(useStore.getState())).toBe(before + 1);
  });

  it('undo closes an open transaction if it was left raised', () => {
    const { plotId } = scoped();
    beginScope();
    useStore.getState().setPlotManPosition(plotId, 60);
    expect(useStore.getState().history.open).not.toBeNull();
    // A live revert mid-gesture must abort the transaction so no later edit is
    // merged into the (now reverted) gesture.
    useStore.getState().undo();
    expect(useStore.getState().history.open).toBeNull();
    expect(useStore.getState().scopes[0].plots[0].manVPosition).toBe(0);
  });

  it('an undo mid-drag closes the gesture instead of splitting the rest per move', () => {
    const { plotId } = scoped();
    const baseline = undoDepth(useStore.getState());

    beginScope();
    useStore.getState().setPlotManPosition(plotId, 40);
    expect(undoDepth(useStore.getState())).toBe(baseline + 1);

    // Ctrl+Z mid-drag: the revert aborts the transaction...
    useStore.getState().undo();
    expect(useStore.getState().history.open).toBeNull();
    expect(useStore.getState().scopes[0].plots[0].manVPosition).toBe(0);

    // ...and the panel cancels its plot drag on exactly that fall, so no later
    // pointermove reaches setPlotManPosition again. The teardown closes nothing
    // new; the gesture stayed one entry, consumed by the undo.
    endScope();
    expect(undoDepth(useStore.getState())).toBe(baseline);

    // A setter after the cancel is a fresh discrete interaction and owns
    // exactly one entry of its own.
    useStore.getState().setPlotManPosition(plotId, 80);
    expect(undoDepth(useStore.getState())).toBe(baseline + 1);
    expect(useStore.getState().scopes[0].plots[0].manVPosition).toBe(80);
  });

  it('redo closes an open transaction if it was left raised', () => {
    const { plotId } = scoped();
    beginScope();
    useStore.getState().setPlotManPosition(plotId, 60);
    endScope();
    expect(useStore.getState().scopes[0].plots[0].manVPosition).toBe(60);
    useStore.getState().undo();
    expect(useStore.getState().scopes[0].plots[0].manVPosition).toBe(0);
    // Simulate a drag still in flight while a redo command fires: an open
    // transaction that did not checkpoint, so the redo future is still there
    // for the redo to consume (a real begin would clear it).
    useStore.setState((s) => ({
      history: {
        ...s.history,
        open: { label: 'Scope', source: 'user', depth: 1, pushed: false },
      },
    }));
    expect(useStore.getState().history.open).not.toBeNull();
    useStore.getState().redo();
    expect(useStore.getState().history.open).toBeNull();
    expect(useStore.getState().scopes[0].plots[0].manVPosition).toBe(60);
  });
});

describe('wholesale document replacement lowers gestures by policy', () => {
  /** Opens a scope transaction and arms an element gesture with nothing
   *  mounted: beginTransaction is exactly what a panel pointer-down runs and
   *  beginElementGesture what a canvas drag arms, so no React teardown exists
   *  here to lower them for the action. */
  const armGestures = () => {
    scoped();
    beginScope();
    useStore.getState().beginElementGesture('move');
    expect(useStore.getState().history.open).not.toBeNull();
    expect(useStore.getState().elementGesture).toEqual({ kind: 'move', placeTurns: 0 });
  };

  it('loadNetlist aborts the transaction and clears the gesture beside its epoch bump', () => {
    armGestures();
    const epoch = useStore.getState().revertEpoch;

    useStore.getState().loadNetlist('$ 1 0.000005 10 50 5\nr 0 0 160 0 0 100\n');

    // The transaction and gesture drop as part of the action itself, not via an
    // unmount cleanup this headless run could never deliver.
    expect(useStore.getState().history.open).toBeNull();
    expect(useStore.getState().elementGesture).toBeNull();
    expect(useStore.getState().revertEpoch).toBe(epoch + 1);
  });

  it('newCircuit lowers both flags on its own replacement', () => {
    armGestures();
    const epoch = useStore.getState().revertEpoch;

    useStore.getState().newCircuit();

    expect(useStore.getState().history.open).toBeNull();
    expect(useStore.getState().elementGesture).toBeNull();
    expect(useStore.getState().revertEpoch).toBe(epoch + 1);
  });

  it('recoverAutoSave lowers both flags through its load', () => {
    // Recovery bytes in storage, the row armed; recoverAutoSave routes through
    // loadNetlist, so the lowering must survive that indirection.
    const map = new Map<string, string>([
      [RECOVERY_STORAGE_KEY, '$ 1 0.000005 10.2 50 5 43 5e-11\nr 0 0 16 0 0 100\n'],
    ]);
    (globalThis as { localStorage?: StorageLike }).localStorage = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
    };
    armGestures();
    const epoch = useStore.getState().revertEpoch;

    try {
      useStore.setState({ hasRecovery: true });
      useStore.getState().recoverAutoSave();
    } finally {
      delete (globalThis as { localStorage?: StorageLike }).localStorage;
    }

    expect(useStore.getState().elements).toHaveLength(1);
    expect(useStore.getState().hasRecovery).toBe(false);
    expect(useStore.getState().history.open).toBeNull();
    expect(useStore.getState().elementGesture).toBeNull();
    expect(useStore.getState().revertEpoch).toBe(epoch + 1);
  });
});
