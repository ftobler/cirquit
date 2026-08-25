import { beforeEach, describe, expect, it } from 'vitest';
import { GRID_SIZE } from '../model/types';
import { parseCircuit } from '../io/netlist';
import { clearSessionModels, saveModel } from '../io/subcircuits';
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
    // Relative geometry preserved; the whole copy sits one grid step below
    // the source (the larger-gap direction for this flat circuit).
    expect(pasted[0].x1 - original[0].x1).toBe(0);
    expect(pasted[0].y1 - original[0].y1).toBe(GRID_SIZE);
    expect(pasted[1].x1 - pasted[0].x1).toBe(original[1].x1 - original[0].x1);
    // Fresh ids: a collision here corrupts the circuit silently.
    expect(pasted[0].id).not.toBe(a);
    expect(pasted[1].id).not.toBe(b);
  });

  it('repeated pastes fan out instead of stacking on the last copy', () => {
    const a = addResistor();
    useStore.getState().select([a]);
    useStore.getState().copySelection();
    const ys: number[] = [];
    for (let i = 0; i < 3; i++) {
      useStore.getState().pasteFromClipboard();
      const copy = useStore.getState().elements.at(-1)!;
      ys.push(copy.y1);
      useStore.getState().select([copy.id]);
      useStore.getState().copySelection();
    }
    // Each copy lands one grid step below everything already on the sheet,
    // upstream's bbox placement (CommandManager.java:583-592).
    expect(ys[1] - ys[0]).toBe(GRID_SIZE);
    expect(ys[2] - ys[1]).toBe(GRID_SIZE);
    expect(new Set(ys).size).toBe(3);
  });

  it('the paste goes right when the horizontal gap is the larger one', () => {
    // A tall, narrow circuit leaves more room to its sides than below it.
    const a = useStore.getState().addElement({
      kind: 'wire',
      x1: 0,
      y1: 0,
      x2: 0,
      y2: 640,
      flags: 0,
      params: {},
    });
    useStore.getState().select([a]);
    useStore.getState().copySelection();
    useStore.getState().pasteFromClipboard();
    const original = useStore.getState().elements.find((e) => e.id === a)!;
    const copy = useStore.getState().elements.at(-1)!;
    expect(copy.x1).toBe(original.x1 + GRID_SIZE);
    expect(copy.y1).toBe(original.y1);
  });

  it('pasting into an empty circuit keeps the clipboard coordinates', () => {
    useStore.setState({ clipboard: '$ 1 0.000005 10 50 5 5 1e-9\nr 320 64 480 64 0 1000\n' });
    useStore.getState().pasteFromClipboard();
    const [only] = useStore.getState().elements;
    expect(only.x1).toBe(320);
    expect(only.y1).toBe(64);
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

  it('pasting a corrupt stored clipboard is a silent no-op', () => {
    // A first line opening `<cir ` routes parseCircuit through the XML
    // converter, which throws on this truncated document. The bytes can be
    // in storage from tampering or another app, so the insert path must
    // swallow the throw instead of escaping through Ctrl+V.
    const a = addResistor();
    useStore.getState().select([a]);
    useStore.setState({ clipboard: '<cir ><w a="1">' });
    const undoBefore = useStore.getState().undoStack.length;
    const revisionBefore = useStore.getState().revision;
    useStore.getState().pasteFromClipboard();
    const s = useStore.getState();
    expect(s.elements).toHaveLength(1);
    expect(s.selectedIds).toEqual([a]);
    expect(s.revision).toBe(revisionBefore);
    expect(s.undoStack).toHaveLength(undoBefore);
  });

  it('paste with no clipboard is a no-op', () => {
    const a = addResistor();
    useStore.getState().select([a]);
    useStore.getState().pasteFromClipboard();
    expect(useStore.getState().elements).toHaveLength(1);
  });

  it('paste and duplicate of a named-model diode keep its resolved params', () => {
    // The paste path re-runs parseCircuit, which resolves the built-in name
    // again, so a copied 1N4148 must arrive with the model's params, not the
    // element defaults.
    const [loaded] = parseCircuit('d 176 80 384 80 2 1N4148').elements;
    useStore.getState().addElement(loaded);
    const id = useStore.getState().elements[0].id;
    useStore.getState().select([id]);

    useStore.getState().copySelection();
    useStore.getState().pasteFromClipboard();
    const pasted = useStore.getState().elements[1];
    expect(pasted.modelName).toBe('1N4148');
    expect(pasted.params.saturationCurrent).toBe(4.352e-9);
    expect(pasted.params.seriesResistance).toBe(0.6458);
    expect(pasted.params.forwardVoltage).toBeCloseTo(0.9491294544092825, 10);

    useStore.getState().select([pasted.id]);
    useStore.getState().duplicateSelection();
    const duped = useStore.getState().elements[2];
    expect(duped.modelName).toBe('1N4148');
    expect(duped.params.saturationCurrent).toBe(4.352e-9);
    expect(duped.params.forwardVoltage).toBeCloseTo(0.9491294544092825, 10);
  });
});

describe('subcircuit models ride the clipboard', () => {
  /** A `.` line defining a one-pin resistor-divider model named `name`. */
  const subLine = (name: string) => `. ${name} 0 2 2 1 in 1 0 0 ResistorElm\\s1\\s2 0\\\\s1000`;

  /** A loadable document: the model line plus a 410 naming it. */
  const subDoc = (name: string) =>
    ['$ 1 0.000005 10 50 5 50 5e-11', subLine(name), `410 0 0 64 0 1 ${name}`].join('\n');

  it('paste of a `.` line and a 410 re-emits the model in the saved document', () => {
    useStore.setState({ clipboard: [subLine('amp'), '410 0 0 64 0 1 amp'].join('\n') });
    useStore.getState().pasteFromClipboard();
    const out = useStore.getState().toNetlist().split('\n');
    expect(out).toContain(subLine('amp'));
    // An empty circuit takes the clipboard's own coordinates, so the pasted
    // chip saves exactly as it was copied.
    expect(out).toContain('410 0 0 64 0 1 amp');
  });

  it('copy of a 410 carries the `.` line that defines its model', () => {
    useStore.getState().loadNetlist(subDoc('amp'));
    const chip = useStore.getState().elements[0];
    useStore.getState().select([chip.id]);
    useStore.getState().copySelection();
    const clip = useStore.getState().clipboard ?? '';
    expect(clip).toContain(subLine('amp'));

    useStore.setState(fresh());
    useStore.setState({ clipboard: clip });
    useStore.getState().pasteFromClipboard();
    const out = useStore.getState().toNetlist();
    expect(out).toContain(subLine('amp'));
    expect(out).toContain('410 0 0 64 0 1 amp');
  });

  it('same-document paste keeps one `.` line per model', () => {
    useStore.getState().loadNetlist(subDoc('amp'));
    const chip = useStore.getState().elements[0];
    useStore.getState().select([chip.id]);
    // The clipboard carries the `.` line, so pasting back into the same
    // document must replace the loaded line instead of stacking a second one.
    useStore.getState().copySelection();
    useStore.getState().pasteFromClipboard();
    const out = useStore.getState().toNetlist().split('\n');
    expect(out.filter((l) => l.startsWith('. amp'))).toHaveLength(1);
    expect(out.filter((l) => l.startsWith('410'))).toHaveLength(2);
  });

  it('a paste replaces a same-named model the document already defines', () => {
    useStore.getState().loadNetlist(subDoc('amp'));
    // Model B carries a different body under the same name, so pasting it must
    // displace model A's `.` line, or a reload would re-bind the document's
    // 410s to whichever `.` line parses last.
    const modelB = '. amp 0 3 2 1 in 1 0 0 ResistorElm\\s1\\s2 0\\\\s2000';
    useStore.setState({ clipboard: `${modelB}\n410 64 0 128 0 1 amp\n` });
    useStore.getState().pasteFromClipboard();
    const out = useStore.getState().toNetlist().split('\n');
    const ampLines = out.filter((l) => l.startsWith('. amp'));
    expect(ampLines).toHaveLength(1);
    expect(ampLines[0]).toBe(modelB);
    const chips = parseCircuit(useStore.getState().toNetlist()).elements.filter(
      (e) => e.kind === 'customComposite',
    );
    expect(chips).toHaveLength(2);
    for (const chip of chips) {
      expect(chip.model).toEqual({ model: 'ResistorElm 1 2', external: [1], dumps: ['0_2000'] });
    }
  });

  it('duplicate of a 410 keeps exactly one `.` line in the document', () => {
    useStore.getState().loadNetlist(subDoc('amp'));
    const chip = useStore.getState().elements[0];
    useStore.getState().select([chip.id]);
    useStore.getState().duplicateSelection();
    const out = useStore.getState().toNetlist().split('\n');
    expect(out.filter((l) => l.startsWith('. amp'))).toHaveLength(1);
    expect(out.filter((l) => l.startsWith('410'))).toHaveLength(2);
  });

  it('duplicate of a 410 resolves its model from the library', () => {
    useStore.getState().loadNetlist(subDoc('amp'));
    const chip = useStore.getState().elements[0];
    useStore.getState().select([chip.id]);
    useStore.getState().duplicateSelection();
    const s = useStore.getState();
    expect(s.elements).toHaveLength(2);
    const [original, dup] = s.elements;
    // The duplicate serializes bare (its `.` line is already in the document),
    // so the fresh part must resolve its payload the way placement does, or it
    // draws the fallback stub and never simulates.
    expect(dup.model).toEqual(original.model);
    // Re-parsing the saved document resolves both instances, not just the one
    // whose `.` line sits in the file.
    const re = parseCircuit(s.toNetlist());
    expect(re.elements).toHaveLength(2);
    expect(re.elements.every((e) => e.kind === 'customComposite' && e.model !== undefined)).toBe(
      true,
    );
  });

  it('copy-paste of a 410 resolves a library-only model', () => {
    clearSessionModels();
    // A document whose 410 has no `.` line: the model lives only in the
    // library, so a copy has no `.` line to carry and the paste must resolve
    // the name against the library instead. A load rebuilds the session half
    // of the library from the file, so the storage half has to hold the model
    // for the loaded 410 to resolve against the merged library at load.
    const store = new Map<string, string>();
    saveModel(
      {
        name: 'onlylib',
        flags: 0,
        sizeX: 2,
        sizeY: 2,
        extList: [{ name: 'in', node: 1, pos: 0, side: 2 }],
        nodeList: 'ResistorElm 1 2',
        // The escaped child dump form a built model and a `.` line both use.
        elmDump: '0\\s1000',
      },
      {
        getItem: (k) => store.get(k) ?? null,
        setItem: (k, v) => {
          store.set(k, v);
        },
        removeItem: (k) => {
          store.delete(k);
        },
        listSubcircuitKeys: () => [...store.keys()].filter((k) => k.startsWith('subcircuit:')),
      },
    );
    // The store's load path reads storage through `globalThis.localStorage`;
    // point it at the fake for this test, as store.load.test.ts does.
    const prev = (globalThis as { localStorage?: Storage }).localStorage;
    (globalThis as { localStorage?: Storage }).localStorage = {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => {
        store.set(k, v);
      },
      removeItem: (k) => {
        store.delete(k);
      },
      clear: () => {},
    } as Storage;
    try {
      useStore
        .getState()
        .loadNetlist(['$ 1 0.000005 10 50 5 50 5e-11', '410 0 0 64 0 1 onlylib'].join('\n'));
      const chip = useStore.getState().elements[0];
      // The load resolves the name against the merged library, so the loaded
      // part simulates immediately rather than only after the paste.
      expect(chip.model).toBeDefined();
      useStore.getState().select([chip.id]);
      useStore.getState().copySelection();
      const clip = useStore.getState().clipboard ?? '';
      expect(clip).not.toContain('. onlylib');
      useStore.setState(fresh());
      useStore.setState({ clipboard: clip });
      useStore.getState().pasteFromClipboard();
      const pasted = useStore.getState().elements[0];
      expect(pasted.kind).toBe('customComposite');
      expect(pasted.model).toBeDefined();
    } finally {
      (globalThis as { localStorage?: Storage }).localStorage = prev;
    }
  });

  it('undo of a subcircuit paste restores the prior document lines', () => {
    const before = useStore.getState().passthrough;
    useStore.setState({ clipboard: [subLine('amp'), '410 0 0 64 0 1 amp'].join('\n') });
    useStore.getState().pasteFromClipboard();
    expect(useStore.getState().passthrough).toContain(subLine('amp'));
    expect(useStore.getState().order.length).toBeGreaterThan(0);
    useStore.getState().undo();
    expect(useStore.getState().passthrough).toEqual(before);
    expect(useStore.getState().order).toEqual([]);
  });
});
