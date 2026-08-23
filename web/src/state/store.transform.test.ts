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

  it('keeps every stored endpoint and post integral when rotating an odd-span element', () => {
    // x1: 10 and x2: 171 share no parity, the state a hand-edited netlist line
    // like `r 10 20 171 20` produces. A raw quarter turn about the midpoint
    // lands on .5 values, which would break the store invariant and leak a
    // fractional post into the saved file.
    const id = useStore.getState().addElement({
      kind: 'resistor',
      x1: 10,
      y1: 20,
      x2: 171,
      y2: 20,
      flags: 0,
      params: {},
    });
    useStore.getState().select([id]);

    useStore.getState().rotateSelection();

    const r = useStore.getState().elements[0];
    for (const v of [r.x1, r.y1, r.x2, r.y2]) expect(Number.isInteger(v)).toBe(true);
    for (const p of postsOf(r)) {
      expect(Number.isInteger(p.x)).toBe(true);
      expect(Number.isInteger(p.y)).toBe(true);
    }
  });

  it('rotating a selected switch2 turns the body but changes no parameter', () => {
    // Upstream's rotate cancels the SPDT's two flip reversals, so the command
    // must not disturb the throw, the group link or the session parity; the
    // mirror below is the single reversal that does.
    const id = useStore.getState().addElement({
      kind: 'switch2',
      x1: 0,
      y1: 0,
      x2: 160,
      y2: 0,
      flags: 0,
      params: { position: 1, momentary: 0, throwCount: 2, link: 3 },
      state: 1,
    });
    useStore.getState().select([id]);

    useStore.getState().rotateSelection();

    const r = useStore.getState().elements[0];
    expect(r.state).toBe(1);
    expect(r.params).toEqual({ position: 1, momentary: 0, throwCount: 2, link: 3 });
    expect(Math.abs(r.y2 - r.y1)).toBe(160);

    useStore.getState().mirrorSelection();
    const m = useStore.getState().elements[0];
    expect(m.state).toBe(0);
    expect(m.params.position).toBe(0);
    expect(m.params.flipParity).toBe(1);
  });

  it('rotating a selected dpdt leaves its throw alone too', () => {
    // Same upstream verdict for the DPDT: flipXY and flipY each reverse the
    // position (DPDTSwitchElm.java:264-277), so the rotate nets zero.
    const id = useStore.getState().addElement({
      kind: 'dpdtSwitch',
      x1: 0,
      y1: 0,
      x2: 160,
      y2: 0,
      flags: 0,
      params: { position: 1, momentary: 0, poleCount: 2 },
      state: 1,
    });
    useStore.getState().select([id]);

    useStore.getState().rotateSelection();

    const r = useStore.getState().elements[0];
    expect(r.state).toBe(1);
    expect(r.params.position).toBe(1);

    useStore.getState().mirrorSelection();
    expect(useStore.getState().elements[0].state).toBe(0);
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
    const text = useStore.getState().addElement({
      kind: 'decoration',
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
    // Rotate needs two points; a text annotation has one.
    useStore.getState().select([text]);
    useStore.getState().rotateSelection();

    const s = useStore.getState();
    expect(s.undoStack).toHaveLength(before);
    expect(s.elements.find((e) => e.id === resistor)).toMatchObject({ x1: 0, x2: 160 });
  });
});

describe('rotate under an in-flight pointer gesture', () => {
  /** A horizontal resistor at (0,0)-(160,0), selected: the element a drag has
   *  just grabbed. */
  const grabbed = () => {
    const id = addResistor();
    useStore.getState().select([id]);
    return id;
  };

  it('a settled selection still costs exactly one undo entry', () => {
    // The no-gesture arm of the dispatcher must be the command it always was.
    grabbed();
    const original = useStore.getState().elements[0];
    const before = useStore.getState().undoStack.length;

    useStore.getState().rotateSelection();

    expect(useStore.getState().undoStack.length).toBe(before + 1);
    useStore.getState().undo();
    expect(useStore.getState().elements[0]).toEqual(original);
  });

  it('a move gesture folds every turn into the drag\'s own undo entry', () => {
    grabbed();
    const original = useStore.getState().elements[0];
    // The pointer-down commit: the drag's whole baseline, as pointerDown.ts
    // pushes it before arming the move.
    useStore.getState().commit();
    useStore.getState().beginElementGesture('move');
    const before = useStore.getState().undoStack.length;

    useStore.getState().rotateSelection();
    useStore.getState().rotateSelection();
    useStore.getState().rotateSelection();

    expect(useStore.getState().undoStack).toHaveLength(before);
    // Three turns from horizontal leave it vertical, and one Ctrl+Z takes the
    // whole gesture back.
    expect(useStore.getState().elements[0].x1).toBe(useStore.getState().elements[0].x2);
    useStore.getState().endElementGesture();
    useStore.getState().undo();
    expect(useStore.getState().elements[0]).toEqual(original);
  });

  it('a move gesture turns each element about its own midpoint, not the group', () => {
    // Stated in the plan and worth pinning: group rotation is a separate
    // feature, so two parts keep their own centres.
    const a = addResistor();
    const b = useStore.getState().addElement({
      kind: 'resistor',
      x1: 0,
      y1: 160,
      x2: 160,
      y2: 160,
      flags: 0,
      params: { resistance: 1000 },
    });
    useStore.getState().select([a, b]);
    useStore.getState().commit();
    useStore.getState().beginElementGesture('move');

    useStore.getState().rotateSelection();

    const [ra, rb] = useStore.getState().elements;
    expect([ra.x1, ra.y1, ra.x2, ra.y2]).toEqual([80, 80, 80, -80]);
    expect([rb.x1, rb.y1, rb.x2, rb.y2]).toEqual([80, 240, 80, 80]);
  });

  it('a place gesture pins the press anchor and banks the turn count', () => {
    grabbed();
    useStore.getState().beginElementGesture('place');
    const before = useStore.getState().undoStack.length;

    // (x1,y1) is drag.start: the place branch only ever writes (x2,y2), so the
    // anchor must never move and the free end walks the four quadrants.
    useStore.getState().rotateSelection();
    expect(useStore.getState().elementGesture).toEqual({ kind: 'place', placeTurns: 1 });
    let r = useStore.getState().elements[0];
    expect([r.x1, r.y1, r.x2, r.y2]).toEqual([0, 0, 0, -160]);

    useStore.getState().rotateSelection();
    expect(useStore.getState().elementGesture?.placeTurns).toBe(2);
    r = useStore.getState().elements[0];
    expect([r.x1, r.y1, r.x2, r.y2]).toEqual([0, 0, -160, 0]);

    useStore.getState().rotateSelection();
    expect(useStore.getState().elementGesture?.placeTurns).toBe(3);

    useStore.getState().rotateSelection();
    // Back to where it started, and the count wraps rather than growing.
    expect(useStore.getState().elementGesture?.placeTurns).toBe(0);
    r = useStore.getState().elements[0];
    expect([r.x1, r.y1, r.x2, r.y2]).toEqual([0, 0, 160, 0]);
    expect(useStore.getState().undoStack).toHaveLength(before);
  });

  it('endElementGesture restores committing', () => {
    grabbed();
    useStore.getState().commit();
    useStore.getState().beginElementGesture('move');
    useStore.getState().rotateSelection();
    const before = useStore.getState().undoStack.length;

    useStore.getState().endElementGesture();
    expect(useStore.getState().elementGesture).toBeNull();
    useStore.getState().rotateSelection();

    expect(useStore.getState().undoStack.length).toBe(before + 1);
  });

  it('the gesture flag is transient: a snapshot restore never touches it', () => {
    // Unlike scopeGesture, an element gesture outlives an undo: the canvas
    // drag ref is still armed and the pointer is still down, so only the
    // canvas teardown may lower the flag. It must not be part of Snapshot.
    grabbed();
    useStore.getState().beginElementGesture('place');
    useStore.getState().rotateSelection();
    const banked = useStore.getState().elementGesture;
    useStore.getState().commit();
    useStore.getState().undo();
    expect(useStore.getState().elementGesture).toEqual(banked);
  });

  it('a selection the menu greys out is a no-op in every gesture state', () => {
    const resistor = addResistor();
    const text = useStore.getState().addElement({
      kind: 'decoration',
      x1: 0,
      y1: 0,
      x2: 0,
      y2: 0,
      flags: 0,
      params: {},
    });
    // Mixed: canRotate refuses the annotation, so the whole command is off,
    // the same guard the disabled menu row uses.
    useStore.getState().select([resistor, text]);
    const original = useStore.getState().elements.map((e) => ({ ...e }));
    const before = useStore.getState().undoStack.length;

    useStore.getState().rotateSelection();
    useStore.getState().beginElementGesture('move');
    useStore.getState().rotateSelection();
    useStore.getState().endElementGesture();
    useStore.getState().beginElementGesture('place');
    useStore.getState().rotateSelection();

    expect(useStore.getState().elements).toEqual(original);
    expect(useStore.getState().undoStack).toHaveLength(before);
    // A refused command must not bank a turn either, or the placement's
    // pointer-move would start rotating a part that never turned.
    expect(useStore.getState().elementGesture?.placeTurns).toBe(0);
  });
});

describe('the armed tool ghost turn', () => {
  it('counts quarter turns mod 4 and starts each tool flat', () => {
    useStore.getState().setTool('resistor');
    useStore.getState().turnTool();
    useStore.getState().turnTool();
    expect(useStore.getState().toolTurns).toBe(2);

    // Arming another part must not inherit the previous one's turn.
    useStore.getState().setTool('capacitor');
    expect(useStore.getState().toolTurns).toBe(0);

    for (let i = 0; i < 4; i++) useStore.getState().turnTool();
    expect(useStore.getState().toolTurns).toBe(0);

    useStore.getState().setTool(null);
    expect(useStore.getState().toolTurns).toBe(0);
  });

  it('is a no-op with no tool armed', () => {
    useStore.getState().turnTool();
    expect(useStore.getState().toolTurns).toBe(0);
    expect(useStore.getState().undoStack).toHaveLength(0);
  });

  it('is a no-op on a tool canRotate refuses', () => {
    // A post-only annotation: its stray second point is meaningless, so the
    // ghost cannot turn and the counter must not drift.
    useStore.getState().setTool('text');
    useStore.getState().turnTool();
    expect(useStore.getState().toolTurns).toBe(0);
  });

  it('commits nothing: the ghost is not in the document', () => {
    useStore.getState().setTool('resistor');
    const before = useStore.getState().undoStack.length;
    useStore.getState().turnTool();
    expect(useStore.getState().undoStack).toHaveLength(before);
    expect(useStore.getState().elements).toHaveLength(0);
  });

  it('is transient: an undo does not restore it', () => {
    const id = addResistor();
    useStore.getState().select([id]);
    useStore.getState().setTool('resistor');
    useStore.getState().turnTool();
    useStore.getState().commit();
    useStore.getState().setTool('capacitor');
    useStore.getState().turnTool();

    useStore.getState().undo();

    // The snapshot never carried it, so the restore leaves the live value.
    expect(useStore.getState().toolTurns).toBe(1);
    expect(useStore.getState().tool).toBe('capacitor');
  });

  it('takes precedence over the settled selection', () => {
    const id = addResistor();
    useStore.getState().select([id]);
    const original = { ...useStore.getState().elements[0] };
    useStore.getState().setTool('resistor');
    // The resistor's own creation is already on the stack; the ghost turn adds
    // nothing to it.
    const before = useStore.getState().undoStack.length;

    useStore.getState().rotateSelection();

    expect(useStore.getState().toolTurns).toBe(1);
    expect(useStore.getState().elements[0]).toEqual(original);
    expect(useStore.getState().undoStack).toHaveLength(before);
  });

  it('yields to a gesture in flight, in both kinds', () => {
    const id = addResistor();
    useStore.getState().select([id]);
    useStore.getState().setTool('resistor');

    useStore.getState().beginElementGesture('move');
    useStore.getState().rotateSelection();
    expect(useStore.getState().toolTurns).toBe(0);
    expect(Math.abs(useStore.getState().elements[0].y2 - useStore.getState().elements[0].y1)).toBe(
      160,
    );
    useStore.getState().endElementGesture();

    useStore.getState().beginElementGesture('place');
    useStore.getState().rotateSelection();
    expect(useStore.getState().toolTurns).toBe(0);
    expect(useStore.getState().elementGesture?.placeTurns).toBe(1);
  });
});
