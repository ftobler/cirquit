import { beforeEach, describe, expect, it } from 'vitest';
import { GRID_SIZE, type CircuitElement } from '../model/types';
import { postsOf } from '../model/registry';
import { useStore } from './store';
import { addResistor, fresh } from './store.test-helpers';

beforeEach(() => useStore.setState(fresh()));

const dff = (): Omit<CircuitElement, 'id'> => ({
  kind: 'dFlipFlop',
  x1: 0,
  y1: 0,
  x2: 6 * GRID_SIZE,
  y2: 0,
  flags: 0,
  params: { highVoltage: 5 },
});

describe('createTest', () => {
  it('places a logic input and output on every chip pin, connected by shared posts', () => {
    const chip = useStore.getState().addElement(dff());
    useStore.getState().select([chip]);
    const before = useStore.getState().elements.length;

    expect(useStore.getState().createTest()).toBe(true);

    const s = useStore.getState();
    // The D flip-flop at default flags has D and the clock on the west, Q and
    // /Q on the east: two inputs and two outputs.
    const placed = s.elements.slice(before);
    expect(placed).toHaveLength(4);
    expect(placed.filter((e) => e.kind === 'logicInput')).toHaveLength(2);
    expect(placed.filter((e) => e.kind === 'logicOutput')).toHaveLength(2);
    // Each harness lead's terminal sits exactly on a chip post, so the engine
    // merges the two into one node and the harness actually drives the chip.
    const chipPosts = postsOf({ id: chip, ...dff() });
    for (const p of placed) {
      expect(chipPosts).toContainEqual({ x: p.x1, y: p.y1 });
    }
    // createTest commits once for the whole harness (store.ts:887), so one
    // undo removes it entirely, exactly as upstream pushes once before
    // TestCreator.createTest (CommandManager.java:146-149).
    useStore.getState().undo();
    expect(useStore.getState().elements).toHaveLength(before);
  });

  it('harnesses a newly supported kind like counter2 from its pin table', () => {
    const chip = useStore.getState().addElement({
      kind: 'counter2',
      x1: 0,
      y1: 0,
      x2: 3 * GRID_SIZE,
      y2: 0,
      flags: 0,
      params: { bits: 4, modulus: 0, highVoltage: 5 },
    });
    useStore.getState().select([chip]);
    const before = useStore.getState().elements.length;

    expect(useStore.getState().createTest()).toBe(true);

    // The 4-bit counter carries I3..I0, the clock, CLR and EnP on the west
    // plus LOAD and EnT on the east: nine inputs; Q3..Q0 and RCO are the five
    // outputs (Counter2Elm.java:70-94).
    const placed = useStore.getState().elements.slice(before);
    expect(placed.filter((e) => e.kind === 'logicInput')).toHaveLength(9);
    expect(placed.filter((e) => e.kind === 'logicOutput')).toHaveLength(5);
  });

  it('refuses an analog source that draws a chip body but is not a harness target', () => {
    const id = useStore.getState().addElement({
      kind: 'vcvs',
      x1: 0,
      y1: 0,
      x2: 6 * GRID_SIZE,
      y2: 0,
      flags: 0,
      params: { gain: 1, inputCount: 2 },
    });
    useStore.getState().select([id]);

    expect(useStore.getState().createTest()).toBe(false);
    expect(useStore.getState().elements).toHaveLength(1);
  });

  it('reports false and places nothing when no single chip is selected', () => {
    const id = addResistor();
    useStore.getState().select([id]);
    const undoBefore = useStore.getState().undoStack.length;

    expect(useStore.getState().createTest()).toBe(false);
    expect(useStore.getState().elements).toHaveLength(1);
    expect(useStore.getState().undoStack).toHaveLength(undoBefore);

    useStore.getState().select([]);
    expect(useStore.getState().createTest()).toBe(false);
    expect(useStore.getState().elements).toHaveLength(1);
  });
});
