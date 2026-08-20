import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from './store';
import { addResistor, fresh } from './store.test-helpers';

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

describe('scope setter gesture-level undo', () => {
  it('a plot-Y drag collapses into one undo entry covering the whole drag', () => {
    const { plotId } = scoped();
    // Post-addScope state is the expected undo target: the drag must undo back
    // here, not to the last frame's position.
    const pre = useStore.getState().scopes;
    const baseline = useStore.getState().undoStack.length;

    // The panel fires beginScopeGesture once at pointer-down, then the moves
    // mutate without committing, then endScopeGesture at pointer-up.
    useStore.getState().beginScopeGesture();
    for (const pos of [10, 35, 60, 90, 120, 150]) {
      useStore.getState().setPlotManPosition(plotId, pos);
    }
    useStore.getState().endScopeGesture();

    // Exactly one new entry (the gesture's pre-drag baseline), not one per frame.
    expect(useStore.getState().undoStack.length).toBe(baseline + 1);
    expect(useStore.getState().scopes[0].plots[0].manVPosition).toBe(150);

    // One undo reverts the entire drag, restoring the pre-drag position (0).
    useStore.getState().undo();
    expect(useStore.getState().scopes).toEqual(pre);
    expect(useStore.getState().scopes[0].plots[0].manVPosition).toBe(0);
  });

  it('a discrete setScopeSpeed outside a gesture still commits its own entry', () => {
    const { scopeId } = scoped();
    const baseline = useStore.getState().undoStack.length;
    expect(useStore.getState().scopes[0].speed).toBe(64);

    useStore.getState().setScopeSpeed(scopeId, 128);

    // No gesture flag, so the setter commits itself, as the properties/edit
    // paths expect.
    expect(useStore.getState().undoStack.length).toBe(baseline + 1);
    expect(useStore.getState().scopes[0].speed).toBe(128);
    useStore.getState().undo();
    expect(useStore.getState().scopes[0].speed).toBe(64);
  });

  it('a speed wheel burst coalesces into one undo entry', () => {
    const { scopeId } = scoped();
    const pre = useStore.getState().scopes;
    const baseline = useStore.getState().undoStack.length;

    // The panel opens the wheel gesture on the first zoom and closes it after
    // an idle timer; here we bracket it the same way the component does.
    useStore.getState().beginScopeGesture();
    for (let i = 0; i < 5; i++) {
      useStore.getState().setScopeSpeed(scopeId, 64 * 2 ** (i + 1));
    }
    useStore.getState().endScopeGesture();

    expect(useStore.getState().undoStack.length).toBe(baseline + 1);
    // The last zoom clamps at MAX_SPEED (1024), which is fine: the point under
    // test is the single undo entry, not the exact final value.
    expect(useStore.getState().scopes[0].speed).toBe(1024);

    useStore.getState().undo();
    expect(useStore.getState().scopes).toEqual(pre);
  });

  it('two separate gestures do not merge: each gets its own entry', () => {
    const { plotId } = scoped();
    const baseline = useStore.getState().undoStack.length;

    useStore.getState().beginScopeGesture();
    useStore.getState().setPlotManPosition(plotId, 20);
    useStore.getState().endScopeGesture();

    useStore.getState().beginScopeGesture();
    useStore.getState().setPlotManPosition(plotId, 80);
    useStore.getState().endScopeGesture();

    // Two gestures, two entries; undoing steps back through each.
    expect(useStore.getState().undoStack.length).toBe(baseline + 2);
    useStore.getState().undo();
    expect(useStore.getState().scopes[0].plots[0].manVPosition).toBe(20);
    useStore.getState().undo();
    expect(useStore.getState().scopes[0].plots[0].manVPosition).toBe(0);
  });

  it('the gesture flag is transient and never pollutes the undo snapshot', () => {
    const { plotId } = scoped();
    useStore.getState().beginScopeGesture();
    useStore.getState().setPlotManPosition(plotId, 40);
    useStore.getState().endScopeGesture();
    // The flag is reset on end and is not part of the committed snapshot, so a
    // later discrete setter still commits normally.
    expect(useStore.getState().scopeGesture).toBe(false);
    const { scopeId } = { scopeId: useStore.getState().scopes[0].id };
    const before = useStore.getState().undoStack.length;
    useStore.getState().setScopeSpeed(scopeId, 256);
    expect(useStore.getState().undoStack.length).toBe(before + 1);
  });

  it('undo resets the gesture flag if it was left raised', () => {
    const { plotId } = scoped();
    useStore.getState().beginScopeGesture();
    useStore.getState().setPlotManPosition(plotId, 60);
    expect(useStore.getState().scopeGesture).toBe(true);
    // A live revert mid-gesture must drop the flag so no later edit is merged
    // into the (now reverted) gesture.
    useStore.getState().undo();
    expect(useStore.getState().scopeGesture).toBe(false);
    expect(useStore.getState().scopes[0].plots[0].manVPosition).toBe(0);
  });

  it('redo resets the gesture flag if it was left raised', () => {
    const { plotId } = scoped();
    useStore.getState().beginScopeGesture();
    useStore.getState().setPlotManPosition(plotId, 60);
    useStore.getState().endScopeGesture();
    expect(useStore.getState().scopes[0].plots[0].manVPosition).toBe(60);
    useStore.getState().undo();
    expect(useStore.getState().scopes[0].plots[0].manVPosition).toBe(0);
    // Simulate a drag still in flight while a redo command fires: the flag is
    // raised (without a commit that would wipe the redo stack).
    useStore.setState({ scopeGesture: true });
    expect(useStore.getState().scopeGesture).toBe(true);
    useStore.getState().redo();
    expect(useStore.getState().scopeGesture).toBe(false);
    expect(useStore.getState().scopes[0].plots[0].manVPosition).toBe(60);
  });
});
