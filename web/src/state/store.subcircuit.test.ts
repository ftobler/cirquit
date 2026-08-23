/** The subcircuit drill-in (feature/subcircuit-drill-in.md): the store's
 *  document context stack, the `.` line write-back on exit, and the surfaces
 *  that reset it. The engine is untouched; everything here is frontend state. */

import { beforeEach, describe, expect, it } from 'vitest';
import { parseCompositeModelLine, saveModel } from '../io/subcircuits';
import { useStore } from './store';
import { fresh } from './store.test-helpers';

/** A browser-shaped localStorage so the library's storage half works in node,
 *  the same fake `subcircuit.test.ts` installs. */
function installLocalStorage(): Map<string, string> {
  const store = new Map<string, string>();
  const fake = {
    get length() {
      return store.size;
    },
    key: (i: number) => [...store.keys()][i] ?? null,
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => store.clear(),
  };
  (globalThis as unknown as { localStorage?: unknown }).localStorage = fake;
  return store;
}

/** A two-1k-resistor divider model, the same shape the io round-trip tests
 *  use: `in` on node 1 (north), `out` on node 3 (south). */
const MODEL_LINE =
  '. myCirc 0 2 2 2 in 1 0 0 out 3 0 1 ' +
  'ResistorElm\\s1\\s2\\rResistorElm\\s2\\s3 ' +
  '0\\\\s1000\\s0\\\\s1000';

/** The same footprint but with two parallel resistors between the two pins:
 *  deleting one leaves the model valid, so the exit write-back is a success
 *  path rather than a pin-on-unused-net refusal. */
const PARALLEL_LINE =
  '. myCirc 0 2 2 2 in 1 0 0 out 2 0 1 ' +
  'ResistorElm\\s1\\s2\\rResistorElm\\s1\\s2 ' +
  '0\\\\s1000\\s0\\\\s1000';

const HEADER = '$ 1 0.000005 10 50 5 50 5e-11\n';

/** The outer document: a 410 naming the model, the model's `.` line, and two
 *  passthrough lines that must survive the drill-in untouched. */
function outer(modelLine = MODEL_LINE): string {
  return (
    HEADER +
    '410 0 0 64 64 1 myCirc\n' +
    modelLine +
    '\nh keep me\n' +
    '# keep me too\n'
  );
}

/** An outer document carrying a slider bound to its resistor, for the
 *  inner-does-not-leak assertion. */
function outerWithSlider(): string {
  return (
    HEADER +
    'r 0 0 160 0 0 1000\n' +
    '410 0 64 64 128 1 myCirc\n' +
    MODEL_LINE +
    '\n38 0 0 0 1000 loadslider 0\n' +
    'h keep me\n'
  );
}

beforeEach(() => {
  useStore.setState(fresh());
});

describe('enterSubcircuit', () => {
  it('pushes the outer snapshot, loads the inner text and clears undo', () => {
    useStore.getState().loadNetlist(outer());
    useStore.getState().commit();
    const before = useStore.getState().toNetlist();
    const view = useStore.getState().view;
    expect(useStore.getState().undoStack.length).toBe(1);

    expect(useStore.getState().enterSubcircuit('myCirc')).toBe(true);

    const s = useStore.getState();
    // One stack entry holding the outer document and view.
    expect(s.subcircuitStack).toHaveLength(1);
    expect(s.subcircuitStack[0].modelName).toBe('myCirc');
    expect(s.subcircuitStack[0].document).toBe(before);
    expect(s.subcircuitStack[0].view).toEqual(view);
    // The canvas now shows the model's internals: two resistors, the pin
    // labels and the net-chain wires, and no 410.
    expect(s.elements.some((e) => e.kind === 'customComposite')).toBe(false);
    expect(s.elements.filter((e) => e.kind === 'resistor')).toHaveLength(2);
    // The inner session starts with a clean undo history, like upstream
    // clearing both stacks on pushContext (CirSim.java:480-482).
    expect(s.undoStack).toHaveLength(0);
    expect(s.redoStack).toHaveLength(0);
  });

  it('refuses the default model with the upstream alert text', () => {
    useStore.getState().loadNetlist(outer());
    expect(useStore.getState().enterSubcircuit('default')).toBe(false);
    expect(useStore.getState().subcircuitError).toBe("Can't edit this model.");
    expect(useStore.getState().subcircuitStack).toHaveLength(0);
  });

  it('refuses an unresolvable model name', () => {
    useStore.getState().loadNetlist(outer());
    expect(useStore.getState().enterSubcircuit('nope')).toBe(false);
    expect(useStore.getState().subcircuitError).toBe('No subcircuit named "nope" exists.');
    expect(useStore.getState().subcircuitStack).toHaveLength(0);
  });

  it('refuses a model whose children the port cannot parse, with the load banner', () => {
    const bad =
      '. bad 0 2 2 1 in 1 0 2 ' +
      'OpAmpElm\\s1\\s2 ' +
      '0\\\\s0';
    useStore.getState().loadNetlist(outer(bad));
    expect(useStore.getState().enterSubcircuit('bad')).toBe(false);
    expect(useStore.getState().subcircuitError).toMatch(/not implemented/);
    expect(useStore.getState().subcircuitStack).toHaveLength(0);
  });

  it('refuses a model containing a nested subcircuit (a 410 child) with a specific message', () => {
    const nested =
      '. nested 0 2 2 2 in 1 0 0 out 2 0 1 ' +
      'CustomCompositeElm\\s1\\s2 ' +
      '1\\sinner';
    const doc =
      HEADER +
      '410 0 0 64 64 1 nested\n' +
      nested +
      '\nh keep me\n';
    useStore.getState().loadNetlist(doc);
    expect(useStore.getState().enterSubcircuit('nested')).toBe(false);
    expect(useStore.getState().subcircuitError).toBe(
      "This subcircuit contains a nested subcircuit, which can't be edited here yet.",
    );
    expect(useStore.getState().subcircuitStack).toHaveLength(0);
    // A refusal leaves the canvas on the outer circuit: no half-loaded inner
    // document pointing at an uneditable 410 child.
    expect(useStore.getState().elements.some((e) => e.kind === 'customComposite')).toBe(true);
  });
});

describe('exitSubcircuit', () => {
  it('with no edits restores the outer document bit-for-bit and empties the stack', () => {
    useStore.getState().loadNetlist(outer());
    const before = useStore.getState().toNetlist();
    useStore.getState().enterSubcircuit('myCirc');

    useStore.getState().exitSubcircuit();

    const s = useStore.getState();
    expect(s.subcircuitStack).toHaveLength(0);
    expect(s.toNetlist()).toBe(before);
    // The pin labels are back to being a model, not canvas elements.
    expect(s.elements.some((e) => e.kind === 'labeledNode')).toBe(false);
    expect(s.elements.some((e) => e.kind === 'customComposite')).toBe(true);
  });

  it('round-trips the save byte for byte through an enter/exit pair', () => {
    useStore.getState().loadNetlist(outer());
    const before = useStore.getState().saveNetlist();
    useStore.getState().enterSubcircuit('myCirc');
    useStore.getState().exitSubcircuit();
    expect(useStore.getState().saveNetlist()).toBe(before);
  });

  it('rewrites only the target `.` line after an edit, in place, and rebuilds the 410', () => {
    useStore.getState().loadNetlist(outer(PARALLEL_LINE));
    useStore.getState().enterSubcircuit('myCirc');

    // Delete one of the two parallel resistors inside.
    const resistor = useStore.getState().elements.find((e) => e.kind === 'resistor')!;
    useStore.getState().select([resistor.id]);
    useStore.getState().deleteSelected();
    expect(useStore.getState().elements.filter((e) => e.kind === 'resistor')).toHaveLength(1);

    useStore.getState().exitSubcircuit();

    const saved = useStore.getState().toNetlist().split('\n');
    // The `.` line still sits between the same neighbours.
    const at = saved.findIndex((l) => l.startsWith('. '));
    expect(useStore.getState().toNetlist().split('\n')[at - 1]).toBe('410 0 0 64 64 1 myCirc');
    expect(useStore.getState().toNetlist().split('\n')[at + 1]).toBe('h keep me');
    // The `.` line was rewritten: one child now, not two.
    const model = parseCompositeModelLine(useStore.getState().toNetlist().split('\n')[at])!;
    expect(model.nodeList).toBe('ResistorElm 1 2');
    expect(model.elmDump).toBe('0\\s1000');
    // The other passthrough lines keep their positions and bytes.
    expect(useStore.getState().toNetlist()).toContain('\nh keep me\n# keep me too\n');
    // The 410 instance rebuilt against the updated library entry: its engine
    // payload now carries one child dump, so the rebuilt model has one child.
    const composite = useStore.getState().elements.find((e) => e.kind === 'customComposite')!;
    const spec = composite.model as unknown as { dumps: unknown[] };
    expect(spec.dumps).toHaveLength(1);
    expect(spec.dumps[0]).toBe('0_1000');
  });

  it('undo after exit removes exactly the model change and leaves the stack empty', () => {
    useStore.getState().loadNetlist(outer(PARALLEL_LINE));
    const originalLine = useStore
      .getState()
      .toNetlist()
      .split('\n')
      .find((l) => l.startsWith('. '))!;
    useStore.getState().enterSubcircuit('myCirc');
    const resistor = useStore.getState().elements.find((e) => e.kind === 'resistor')!;
    useStore.getState().select([resistor.id]);
    useStore.getState().deleteSelected();
    useStore.getState().exitSubcircuit();

    // One undo entry, covering the model change on the outer document.
    expect(useStore.getState().undoStack).toHaveLength(1);
    useStore.getState().undo();

    const s = useStore.getState();
    expect(s.subcircuitStack).toHaveLength(0);
    const line = s.toNetlist().split('\n').find((l) => l.startsWith('. '))!;
    expect(line).toBe(originalLine);
    const composite = s.elements.find((e) => e.kind === 'customComposite')!;
    const spec = composite.model as unknown as { dumps: unknown[] };
    expect(spec.dumps).toHaveLength(2);
  });

  it("the inner session's sliders and scopes do not leak outward", () => {
    useStore.getState().loadNetlist(outerWithSlider());
    const outerSliders = useStore.getState().sliders;
    expect(outerSliders).toHaveLength(1);
    useStore.getState().enterSubcircuit('myCirc');
    // Inside, the slider list starts empty (no `38` lines in the model).
    expect(useStore.getState().sliders).toHaveLength(0);

    // The user adds a slider and a scope inside.
    const resistor = useStore.getState().elements.find((e) => e.kind === 'resistor')!;
    useStore.getState().addSlider(resistor.id, 0, 'inner slider');
    useStore.getState().addScope(resistor.id, 'voltage');
    expect(useStore.getState().sliders).toHaveLength(1);

    useStore.getState().exitSubcircuit();

    const s = useStore.getState();
    // The outer document's own slider is restored; the inner one is gone.
    expect(s.sliders).toHaveLength(outerSliders.length);
    expect(s.sliders.map((x) => x.text)).toEqual(outerSliders.map((x) => x.text));
    expect(s.sliders.some((x) => x.text === 'inner slider')).toBe(false);
    expect(s.scopes).toHaveLength(0);
  });
});

describe('drill-in resets', () => {
  it('a library-only model persists its edit through storage on exit', () => {
    const storage = installLocalStorage();
    saveModel(parseCompositeModelLine(PARALLEL_LINE)!);
    // The document references the model but carries no `.` line for it, so
    // the model lives only in storage.
    useStore.getState().loadNetlist(HEADER + '410 0 0 64 64 1 myCirc\n');
    expect(useStore.getState().elements.some((e) => e.kind === 'customComposite')).toBe(true);

    useStore.getState().enterSubcircuit('myCirc');
    const resistor = useStore.getState().elements.find((e) => e.kind === 'resistor')!;
    useStore.getState().select([resistor.id]);
    useStore.getState().deleteSelected();
    useStore.getState().exitSubcircuit();

    // No `.` line exists to rewrite, so the edit landed in storage.
    expect(useStore.getState().toNetlist()).not.toContain('\n.');
    const stored = parseCompositeModelLine(storage.get('subcircuit:myCirc')!)!;
    expect(stored.nodeList).toBe('ResistorElm 1 2');
    expect(stored.elmDump).toBe('0\\s1000');
  });

  it('loading a file mid-drill resets the stack entirely', () => {
    useStore.getState().loadNetlist(outer());
    useStore.getState().enterSubcircuit('myCirc');
    expect(useStore.getState().subcircuitStack).toHaveLength(1);

    useStore.getState().loadNetlist(HEADER + 'r 0 0 160 0 0 1000\n');

    expect(useStore.getState().subcircuitStack).toHaveLength(0);
    expect(useStore.getState().elements).toHaveLength(1);
  });

  it('New Blank Circuit resets the stack entirely', () => {
    useStore.getState().loadNetlist(outer());
    useStore.getState().enterSubcircuit('myCirc');

    useStore.getState().newCircuit();

    expect(useStore.getState().subcircuitStack).toHaveLength(0);
    expect(useStore.getState().elements).toHaveLength(0);
  });
});