import { beforeEach, describe, expect, it } from 'vitest';
import { postsOf } from '../model/registry';
import { useStore } from './store';
import { addResistor, fresh } from './store.test-helpers';

beforeEach(() => useStore.setState(fresh()));

describe('rotate, mirror and swap terminals', () => {
  const addDiode = () =>
    useStore.getState().addElement({
      kind: 'diode',
      x1: 0,
      y1: 0,
      x2: 160,
      y2: 0,
      flags: 0,
      params: {},
    });

  const addTransistor = () =>
    useStore.getState().addElement({
      kind: 'transistor',
      x1: 0,
      y1: 0,
      x2: 160,
      y2: 0,
      flags: 0,
      params: { pnp: 1 },
    });

  it('rotates a selected resistor 90 degrees, swapping length and breadth', () => {
    const id = addResistor();
    useStore.getState().select([id]);

    useStore.getState().rotateSelection();

    const r = useStore.getState().elements[0];
    expect(Math.abs(r.x2 - r.x1)).toBe(0);
    expect(Math.abs(r.y2 - r.y1)).toBe(160);
  });

  it('restores the original after four rotations', () => {
    const id = addResistor();
    const original = useStore.getState().elements[0];
    useStore.getState().select([id]);

    for (let i = 0; i < 4; i++) useStore.getState().rotateSelection();

    expect(useStore.getState().elements[0]).toEqual(original);
  });

  it('mirrors a selected transistor, keeping its bounding box and flipping post order', () => {
    const id = addTransistor();
    const before = postsOf(useStore.getState().elements[0]);
    useStore.getState().select([id]);

    useStore.getState().mirrorSelection();

    const t = useStore.getState().elements[0];
    const after = postsOf(t);
    expect(t.x1).toBe(160);
    expect(t.x2).toBe(0);
    // A horizontal mirror reverses the axis direction and leaves the flag.
    expect(t.flags & 1).toBe(0);
    const box = (pts: { x: number; y: number }[]) => ({
      minX: Math.min(...pts.map((p) => p.x)),
      maxX: Math.max(...pts.map((p) => p.x)),
      minY: Math.min(...pts.map((p) => p.y)),
      maxY: Math.max(...pts.map((p) => p.y)),
    });
    expect(box(after)).toEqual(box(before));
    expect(after.map((p) => [p.x, p.y])).toEqual([
      [160, 0],
      [0, -16],
      [0, 16],
    ]);
  });

  it('swaps terminals on a selected diode, reversing post order around the body centre', () => {
    const id = addDiode();
    useStore.getState().select([id]);

    useStore.getState().swapTerminals();

    const d = useStore.getState().elements[0];
    expect(d.x1).toBe(160);
    expect(d.x2).toBe(0);
    expect(postsOf(d)[0]).toEqual({ x: 160, y: 0 });
    expect(postsOf(d)[1]).toEqual({ x: 0, y: 0 });
    expect((d.x1 + d.x2) / 2).toBe(80);
  });

  it.each([
    [
      'rotateSelection',
      () => {
        const id = addResistor();
        useStore.getState().select([id]);
      },
      () => useStore.getState().rotateSelection(),
    ],
    [
      'mirrorSelection',
      () => {
        const id = addTransistor();
        useStore.getState().select([id]);
      },
      () => useStore.getState().mirrorSelection(),
    ],
    [
      'swapTerminals',
      () => {
        const id = addDiode();
        useStore.getState().select([id]);
      },
      () => useStore.getState().swapTerminals(),
    ],
  ] as const)('%s is one undo step', (_name, setUp, run) => {
    setUp();
    const original = useStore.getState().elements[0];
    const before = useStore.getState().undoStack.length;

    run();

    expect(useStore.getState().undoStack.length).toBe(before + 1);
    useStore.getState().undo();
    expect(useStore.getState().elements[0]).toEqual(original);
  });

  it('is a no-op with nothing selected, leaving the undo stack untouched', () => {
    addResistor();
    const before = useStore.getState().undoStack.length;
    const revision = useStore.getState().revision;

    useStore.getState().rotateSelection();
    useStore.getState().mirrorSelection();
    useStore.getState().swapTerminals();

    const s = useStore.getState();
    expect(s.undoStack).toHaveLength(before);
    expect(s.revision).toBe(revision);
  });

  it('is a no-op when the selection cannot take the command, matching a disabled menu item', () => {
    const resistor = addResistor();
    const ground = useStore.getState().addElement({
      kind: 'ground',
      x1: 0,
      y1: 0,
      x2: 0,
      y2: 0,
      flags: 0,
      params: {},
    });
    const before = useStore.getState().undoStack.length;

    // Mirror is only offered on the asymmetric bodies.
    useStore.getState().select([resistor]);
    useStore.getState().mirrorSelection();
    // Rotate needs two posts; a ground has one.
    useStore.getState().select([ground]);
    useStore.getState().rotateSelection();

    const s = useStore.getState();
    expect(s.undoStack).toHaveLength(before);
    expect(s.elements.find((e) => e.id === resistor)).toMatchObject({ x1: 0, x2: 160 });
  });
});
