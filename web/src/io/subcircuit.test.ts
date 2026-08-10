/** The subcircuit `.` line and the File>Create Subcircuit / Subcircuit
 *  Manager features: parse, round-trip, model building from a selection and
 *  the library's storage round-trip. */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildModelFromSelection,
  clearSessionModels,
  compositeModelLine,
  describeBuildFailure,
  getModel,
  listModels,
  modelToEngineSpec,
  parseCompositeModelLine,
  registerSessionModel,
  removeModel,
  renameModel,
  saveModel,
  type SubcircuitStorage,
} from './subcircuits';
import { parseCircuit, serializeCircuit } from './netlist';
import { summarizeImport } from './importSummary';
import { DEFAULT_SETTINGS, type CircuitElement } from '../model/types';
import { LABELED_NODE_INTERNAL } from '../model/registry/flags';
import { makeElement, useStore } from '../state/store';
import { fresh } from '../state/store.test-helpers';

/** A representative `.` line: a two-1k-resistor divider with `in` on node 1
 *  (north) and `out` on node 3 (south), `\r`-separated model lines and
 *  space-separated escaped child dumps (CustomCompositeModel.java:208-225). */
const MODEL_LINE =
  '. myCirc 0 2 2 2 in 1 0 0 out 3 0 1 ' +
  'ResistorElm\\s1\\s2\\rResistorElm\\s2\\s3 ' +
  '0\\\\s1000\\s0\\\\s1000';

/** A header in the writer's own number forms, so the whole file (header
 *  included) round-trips byte-for-byte. */
const HEADER = '$ 1 0.000005 10 50 5 50 5e-11\n';

/** A fake storage backend keyed by the `subcircuit:` prefix, the same shape
 *  the library reads from the browser localStorage. */
function fakeStorage(): SubcircuitStorage {
  const store = new Map<string, string>();
  return {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => {
      store.set(k, v);
    },
    removeItem: (k) => {
      store.delete(k);
    },
    listSubcircuitKeys: () => [...store.keys()].filter((k) => k.startsWith('subcircuit:')),
  };
}

/** The same storage with a refusing writer, standing in for a quota-exceeded
 *  or private-browsing localStorage. Reads keep working, which is what makes
 *  the failure sneaky: an older key of the same name reads back fine. */
function fullStorage(inner: SubcircuitStorage): SubcircuitStorage {
  return {
    ...inner,
    setItem: () => {
      throw new Error('QuotaExceededError');
    },
    getItem: (k) => inner.getItem(k),
    removeItem: (k) => inner.removeItem(k),
    listSubcircuitKeys: () => inner.listSubcircuitKeys(),
  };
}

beforeEach(() => {
  clearSessionModels();
  useStore.setState(fresh());
});

describe('the `.` model line', () => {
  it('decodes the fields into the right model structure', () => {
    const model = parseCompositeModelLine(MODEL_LINE);
    expect(model).not.toBeNull();
    expect(model!.name).toBe('myCirc');
    expect(model!.flags).toBe(0);
    expect(model!.sizeX).toBe(2);
    expect(model!.sizeY).toBe(2);
    expect(model!.extList).toEqual([
      { name: 'in', node: 1, pos: 0, side: 0 },
      { name: 'out', node: 3, pos: 0, side: 1 },
    ]);
    expect(model!.nodeList).toBe('ResistorElm 1 2\rResistorElm 2 3');
    // The elmDump is the space-separated escaped child dumps, one per model
    // line, in the same order.
    expect(model!.elmDump).toBe('0\\s1000 0\\s1000');
  });

  it('re-serialises to the same `.` line', () => {
    const model = parseCompositeModelLine(MODEL_LINE)!;
    expect(compositeModelLine(model)).toBe(MODEL_LINE);
  });

  it('a file carrying a `.` line round-trips byte-for-byte', () => {
    const text = HEADER + MODEL_LINE + '\nr 0 0 160 0 0 1000\n';
    const parsed = parseCircuit(text);
    // The `.` line is not an element and not unsupported: it rides in
    // passthrough in place.
    expect(parsed.elements).toHaveLength(1);
    expect(parsed.passthrough).toContain(MODEL_LINE);
    expect(parsed.unsupported).not.toContain('.');
    const out = serializeCircuit(
      parsed.elements,
      { ...DEFAULT_SETTINGS, ...parsed.settings },
      parsed.scopes,
      parsed.passthrough,
      parsed.order,
    );
    expect(out).toBe(text);
  });

  it('a truncated `.` line is preserved but never resolves', () => {
    const line = '. broken 0 2 2';
    const parsed = parseCircuit(line + '\n');
    expect(parseCompositeModelLine(line)).toBeNull();
    expect(parsed.passthrough).toContain(line);
    const out = serializeCircuit(
      parsed.elements,
      { ...DEFAULT_SETTINGS, ...parsed.settings },
      parsed.scopes,
      parsed.passthrough,
      parsed.order,
    );
    expect(out.trim()).toBe(line);
  });

  it('hands the parsed model back instead of registering it', () => {
    const storage = fakeStorage();
    // Parsing is inspection, not a commit: the import preview and the paste
    // probe both run this, so the library must not grow behind them, however
    // many times the same text is parsed.
    const parsed = parseCircuit(HEADER + MODEL_LINE + '\n');
    parseCircuit(HEADER + MODEL_LINE + '\n');
    expect(listModels(storage)).toEqual([]);
    expect(getModel('myCirc', storage)).toBeUndefined();
    // The interpreted copy rides out with the parse result, for the caller
    // that does commit the text.
    expect(parsed.compositeModels).toHaveLength(1);
    expect(parsed.compositeModels[0].name).toBe('myCirc');
    expect(parsed.compositeModels[0].extList).toHaveLength(2);
  });

  it('summarising an import leaves the library empty', () => {
    const storage = fakeStorage();
    summarizeImport(HEADER + MODEL_LINE + '\nr 0 0 160 0 0 1000\n');
    expect(listModels(storage)).toEqual([]);
  });

  it('a committed load registers the model for later resolution', () => {
    useStore.getState().loadNetlist(HEADER + MODEL_LINE + '\n');
    const model = getModel('myCirc');
    expect(model).not.toBeUndefined();
    expect(model!.extList).toHaveLength(2);
  });

  it('converts to the engine spec the composite kind expects', () => {
    const model = parseCompositeModelLine(MODEL_LINE)!;
    expect(modelToEngineSpec(model)).toEqual({
      model: 'ResistorElm 1 2\rResistorElm 2 3',
      external: [1, 3],
      // The `.` line's space-separated escaped dumps become the `_`-joined
      // tokens the engine's apply_dump splits.
      dumps: ['0_1000', '0_1000'],
    });
  });

  it('walks a flat upstream-style elmDump into aligned child dumps', () => {
    // A genuine upstream `.` line escapes each child dump (its spaces become
    // `\s`, so the whole child is one token) and then re-escapes the joined
    // elmDump for the line: within a child the escapes double up (`\\s`),
    // while the literal separator between children survives as a single `\s`
    // (CompositeElm.dumpElements + CustomLogicModel.escape). The outer
    // unescape must therefore land on `0\s...\s0.5 0\s1000`, split cleanly on
    // the separator space, and inner-unescape one rail and one resistor dump,
    // staying aligned with the two model lines.
    const line =
      '. driver 0 1 1 1 vcc 1 0 3 ' +
      'RailElm\\s1\\rResistorElm\\s1\\s2 ' +
      '0\\\\s0\\\\s40\\\\s-9\\\\s0\\\\s0\\\\s0.5\\s0\\\\s1000';
    const model = parseCompositeModelLine(line)!;
    expect(model.nodeList).toBe('RailElm 1\rResistorElm 1 2');
    expect(modelToEngineSpec(model)).toEqual({
      model: 'RailElm 1\rResistorElm 1 2',
      external: [1],
      dumps: ['0_0_40_-9_0_0_0.5', '0_1000'],
    });
  });

  it('an escaped name and pin name survive the round trip', () => {
    const line =
      '. my\\sdiv\\spart 0 1 1 1 my\\snode 1 0 2 ' +
      'ResistorElm\\s1\\s2 ' +
      '0\\\\s1000';
    const model = parseCompositeModelLine(line)!;
    expect(model.name).toBe('my div part');
    expect(model.extList[0].name).toBe('my node');
    expect(compositeModelLine(model)).toBe(line);
  });
});

describe('building a model from a selection', () => {
  let nextId = 1;
  beforeEach(() => {
    nextId = 1;
  });

  function resistor(x1: number, y1: number, x2: number, y2: number): CircuitElement {
    return { ...makeElement('resistor', x1, y1, x2, y2), id: nextId++ } as CircuitElement;
  }

  /** A labeled node with its post at `x,y` pointing `dx,dy`: the direction is
   *  what upstream reads for the pin's chip side, so every fixture states it. */
  function label(text: string, x: number, y: number, dx: number, dy: number): CircuitElement {
    return {
      ...makeElement('labeledNode', x, y, x + dx, y + dy),
      id: nextId++,
      text,
    } as CircuitElement;
  }

  /** The documented upstream flow: a divider with `in` and `out` labels. */
  function labeledDivider(): CircuitElement[] {
    return [
      resistor(0, 0, 160, 0),
      resistor(160, 0, 320, 0),
      label('in', 0, 0, -32, 0),
      label('out', 320, 0, 32, 0),
    ];
  }

  it('builds a model from a fully selected circuit with labeled ends', () => {
    // The flow the manual documents: draw it, label the ends, Select All,
    // Create Subcircuit. Nothing sits outside the selection, so the old
    // "connects to the rest" rule found no pins at all and refused.
    const elements = labeledDivider();
    const ids = elements.map((e) => e.id);
    const built = buildModelFromSelection(elements, ids);

    expect(built.unsupported).toEqual([]);
    expect(built.model).not.toBeNull();
    expect(built.model!.nodeList).toBe('ResistorElm 1 2\rResistorElm 2 3');
    expect(built.model!.extList).toEqual([
      { name: 'in', node: 1, pos: 0, side: 2 },
      { name: 'out', node: 3, pos: 0, side: 3 },
    ]);
    // The child dumps carry each resistor's flags and resistance.
    expect(built.model!.elmDump).toBe('0\\s1000 0\\s1000');
  });

  it('falls back to the whole circuit when nothing is selected', () => {
    // Upstream's `sel = app.isSelection()`: an empty selection is the whole
    // circuit, not an error (SimulationManager.java:1567).
    const elements = labeledDivider();
    const ids = elements.map((e) => e.id);
    const all = buildModelFromSelection(elements, ids);
    const none = buildModelFromSelection(elements, []);
    expect(none.model).toEqual(all.model);
  });

  it('a wire behind a resistor carries the label to the resistor net', () => {
    // The label sits at the far end of a wire, so the union-find has to merge
    // the two coordinates before the pin can find its node.
    const r = resistor(0, 0, 160, 0);
    const wire = { ...makeElement('wire', 160, 0, 320, 0), id: nextId++ } as CircuitElement;
    const out = label('out', 320, 0, 32, 0);
    const built = buildModelFromSelection([r, wire, out, label('in', 0, 0, -32, 0)], []);

    expect(built.model!.nodeList).toBe('ResistorElm 1 2');
    const pin = built.model!.extList.find((p) => p.name === 'out');
    expect(pin).toEqual({ name: 'out', node: 2, pos: 0, side: 3 });
  });

  it('takes each pin side from the label direction, not the bounding box', () => {
    // Four nets in a row: the east-pointing label is on the leftmost net and
    // the west-pointing one on the rightmost, so a bounding-box rule would get
    // both backwards.
    const elements = [
      resistor(0, 0, 160, 0),
      resistor(160, 0, 320, 0),
      resistor(320, 0, 480, 0),
      resistor(480, 0, 640, 0),
      label('east', 0, 0, 32, 0),
      label('north', 160, 0, 0, -32),
      label('south', 320, 0, 0, 32),
      label('west', 480, 0, -32, 0),
      // A label the user never dragged: no direction at all, and upstream's
      // default side is west (SimulationManager.java:1581).
      label('nodir', 640, 0, 0, 0),
    ];
    const built = buildModelFromSelection(elements, []);
    const sideOf = (name: string) => built.model!.extList.find((p) => p.name === name)!.side;

    expect(sideOf('north')).toBe(0);
    expect(sideOf('south')).toBe(1);
    expect(sideOf('west')).toBe(2);
    expect(sideOf('east')).toBe(3);
    expect(sideOf('nodir')).toBe(2);

    // One north/south pin each, and both the west and the east column
    // occupied, so the width is 1 + xOffsetLeft + xOffsetRight.
    expect(built.model!.sizeX).toBe(3);
    // Two west pins against one east pin, so pinsWE is 2 and sets the height.
    expect(built.model!.sizeY).toBe(2);

    // The same chip with one west pin instead of two: the height is now the
    // minHeight of 2 that a chip with both a north and a south pin gets, not
    // the single west/east pin (EditCompositeModelDialog.java:106-111).
    const oneWest = buildModelFromSelection(
      elements.filter((e) => e.text !== 'nodir'),
      [],
    );
    expect(oneWest.model!.sizeX).toBe(3);
    expect(oneWest.model!.sizeY).toBe(2);
  });

  it('carries annotations and scopes through instead of refusing on them', () => {
    // Upstream's extraList exempts ScopeElm and every GraphicElm
    // (SimulationManager.java:1622-1627). Refusing on them would make Create
    // Subcircuit useless on any annotated circuit, which is 49 of the 374
    // bundled ones.
    const elements = [
      resistor(0, 0, 160, 0),
      label('in', 0, 0, -32, 0),
      label('out', 160, 0, 32, 0),
      { ...makeElement('decoration', 0, -64, 160, -64), id: nextId++, text: 'a note' },
      { ...makeElement('box', 0, -96, 160, 96), id: nextId++ },
      { ...makeElement('line', 0, 96, 160, 96), id: nextId++ },
      { ...makeElement('scope', 200, 200, 360, 300), id: nextId++ },
    ] as CircuitElement[];
    const built = buildModelFromSelection(elements, []);
    expect(built.unsupported).toEqual([]);
    expect(built.model!.nodeList).toBe('ResistorElm 1 2');
    expect(built.model!.extList).toHaveLength(2);
  });

  it('skips a labeled node marked internal', () => {
    // Upstream's `lne.isInternal()` skip (SimulationManager.java:1575-1576):
    // an internal node names a private net, so it is not a pin. Without the
    // check the grounded internal node below refuses the whole build.
    const internal = {
      ...label('mid', 160, 0, 0, 32),
      flags: LABELED_NODE_INTERNAL,
    };
    const elements = [
      resistor(0, 0, 160, 0),
      resistor(160, 0, 320, 0),
      label('in', 0, 0, -32, 0),
      internal,
      label('out', 320, 0, 32, 0),
    ];
    const built = buildModelFromSelection(elements, []);
    expect(built.model).not.toBeNull();
    expect(built.model!.extList.map((p) => p.name)).toEqual(['in', 'out']);
  });

  it('orders west pins by y, in the order they will be drawn', () => {
    // The labels are listed out of order on purpose: `pos` is the index within
    // the side after sorting, not the order the elements happen to be in.
    const elements = [
      resistor(0, 0, 160, 0),
      resistor(0, 160, 160, 160),
      resistor(0, 320, 160, 320),
      label('w2', 0, 320, -32, 0),
      label('w0', 0, 0, -32, 0),
      label('w1', 0, 160, -32, 0),
    ];
    const built = buildModelFromSelection(elements, []);
    expect(built.model!.extList.map((p) => [p.name, p.pos, p.side])).toEqual([
      ['w0', 0, 2],
      ['w1', 1, 2],
      ['w2', 2, 2],
    ]);
    // Three west pins and no north/south ones: one column wide, three tall.
    expect(built.model!.sizeX).toBe(2);
    expect(built.model!.sizeY).toBe(3);
  });

  it('orders north pins by x and skips the reserved west column', () => {
    // The west pin column occupies grid column 0, so north positions shift one
    // column right (EditCompositeModelDialog.java:97-104).
    const elements = [
      resistor(0, 0, 0, 160),
      resistor(160, 0, 160, 160),
      resistor(320, 0, 320, 160),
      label('n2', 320, 0, 0, -32),
      label('n0', 0, 0, 0, -32),
      label('n1', 160, 0, 0, -32),
      label('w', 0, 160, -32, 0),
    ];
    const built = buildModelFromSelection(elements, []);
    const north = built.model!.extList.filter((p) => p.side === 0);
    expect(north.map((p) => [p.name, p.pos])).toEqual([
      ['n0', 1],
      ['n1', 2],
      ['n2', 3],
    ]);
    // The west pin itself stays at the chip edge.
    expect(built.model!.extList.find((p) => p.side === 2)!.pos).toBe(0);
    // Three north pins plus the reserved west column.
    expect(built.model!.sizeX).toBe(4);
  });

  it('refuses a labeled node on the ground net', () => {
    const elements = [
      resistor(0, 0, 160, 0),
      { ...makeElement('ground', 160, 0, 160, 32), id: nextId++ } as CircuitElement,
      label('in', 0, 0, -32, 0),
      label('gnd', 160, 0, 32, 0),
    ];
    const built = buildModelFromSelection(elements, []);
    expect(built.model).toBeNull();
    expect(built.reason).toBe('Node "gnd" can\'t be connected to ground');
  });

  it('refuses a pin whose net no child touches', () => {
    const elements = [
      resistor(0, 0, 160, 0),
      label('in', 0, 0, -32, 0),
      label('floating', 400, 0, 32, 0),
    ];
    const built = buildModelFromSelection(elements, []);
    expect(built.model).toBeNull();
    expect(built.reason).toBe('Node "floating" is not used!');
  });

  it('maps a grounded net onto model node 0 instead of dropping the ground', () => {
    // `composite.rs:210` reserves model node 0 for ground. Handing the net an
    // ordinary id instead left the model with no ground reference at all, so
    // the placed instance went singular.
    const elements = [
      resistor(0, 0, 160, 0),
      { ...makeElement('ground', 160, 0, 160, 32), id: nextId++ } as CircuitElement,
      label('in', 0, 0, -32, 0),
    ];
    const built = buildModelFromSelection(elements, []);
    expect(built.model!.nodeList).toBe('ResistorElm 1 0');
    // The ground symbol is not a child of its own.
    expect(built.model!.nodeList).not.toContain('GroundElm');
    expect(built.model!.elmDump).toBe('0\\s1000');
    expect(built.model!.extList).toEqual([{ name: 'in', node: 1, pos: 0, side: 2 }]);
  });

  it('refuses a kind the composite cannot represent instead of truncating', () => {
    // The old behaviour built a model out of the resistor alone and said
    // nothing, so the stored subcircuit was quietly missing half the circuit.
    const elements = [
      resistor(0, 0, 160, 0),
      { ...makeElement('capacitor', 160, 0, 320, 0), id: nextId++ } as CircuitElement,
      { ...makeElement('diode', 320, 0, 480, 0), id: nextId++ } as CircuitElement,
      label('in', 0, 0, -32, 0),
      label('out', 480, 0, 32, 0),
    ];
    const built = buildModelFromSelection(elements, []);
    expect(built.model).toBeNull();
    expect(built.unsupported).toEqual(['Capacitor', 'Diode']);
    expect(describeBuildFailure(built)).toBe(
      'Cannot build a subcircuit from this selection: it contains Capacitor, Diode, ' +
        'which the subcircuit engine cannot represent yet.',
    );
  });

  it('keeps the first label on a net and adds no second pin for it', () => {
    const elements = [
      resistor(0, 0, 160, 0),
      resistor(160, 0, 320, 0),
      label('in', 0, 0, -32, 0),
      label('out', 320, 0, 32, 0),
      label('alsoOut', 320, 0, 0, 32),
    ];
    const built = buildModelFromSelection(elements, []);
    expect(built.model!.extList.map((p) => p.name)).toEqual(['in', 'out']);
  });

  it('refuses a selection with no labeled nodes at all', () => {
    const built = buildModelFromSelection([resistor(0, 0, 160, 0)], []);
    expect(built.model).toBeNull();
    expect(built.reason).toContain('no external inputs/outputs');
  });

  it('an empty selection yields null with the generic prompt', () => {
    const built = buildModelFromSelection([], []);
    expect(built.model).toBeNull();
    expect(built.reason).toBeUndefined();
    expect(describeBuildFailure(built)).toBe('There is nothing here to turn into a subcircuit.');
  });

  it('the built model survives the `.` line round trip', () => {
    const elements = labeledDivider();
    const model = { ...buildModelFromSelection(elements, []).model!, name: 'divider' };
    const reparsed = parseCompositeModelLine(compositeModelLine(model));
    expect(reparsed).toEqual(model);
  });
});

describe('the model library and Subcircuit Manager store', () => {
  it('list/add/delete round-trip through the chosen store', () => {
    const storage = fakeStorage();
    const model = parseCompositeModelLine(MODEL_LINE)!;
    expect(listModels(storage)).toEqual([]);

    saveModel({ ...model, name: 'stored' }, storage);
    const listed = listModels(storage);
    expect(listed).toHaveLength(1);
    // The stored copy re-parses to the same fields, not just the same line.
    expect(listed[0].name).toBe('stored');
    expect(listed[0].nodeList).toBe(model.nodeList);
    expect(listed[0].extList).toEqual(model.extList);
    expect(storage.getItem('subcircuit:stored')).toBe(compositeModelLine({ ...model, name: 'stored' }));

    removeModel('stored', storage);
    expect(listModels(storage)).toEqual([]);
    expect(storage.getItem('subcircuit:stored')).toBeNull();
  });

  it('rename moves the stored model to its new name', () => {
    const storage = fakeStorage();
    saveModel(parseCompositeModelLine(MODEL_LINE)!, storage);
    expect(renameModel('myCirc', 'renamed', storage)).toBe(true);
    const renamed = getModel('renamed', storage);
    expect(renamed).not.toBeUndefined();
    expect(renamed!.name).toBe('renamed');
    expect(renamed!.extList).toEqual(parseCompositeModelLine(MODEL_LINE)!.extList);
    expect(getModel('myCirc', storage)).toBeUndefined();
    // A blank or missing name is refused.
    expect(renameModel('renamed', '', storage)).toBe(false);
    expect(renameModel('nope', 'x', storage)).toBe(false);
  });

  it('a session model from a loaded `.` line shadows the stored one', () => {
    const storage = fakeStorage();
    saveModel(parseCompositeModelLine(MODEL_LINE)!, storage);
    clearSessionModels();
    // A file loaded over the stored model registers the same name in the
    // session map, which wins the merged list, like upstream's local map.
    registerSessionModel(parseCompositeModelLine(MODEL_LINE)!);
    const listed = listModels(storage);
    expect(listed).toHaveLength(1);
    expect(listed[0].name).toBe('myCirc');
  });

  it('deleting a session model leaves the stored model of that name alone', () => {
    const storage = fakeStorage();
    // The user's own saved `myCirc`, and a different one of the same name that
    // the open file's `.` line brought in and that shadows it in the list.
    saveModel({ ...parseCompositeModelLine(MODEL_LINE)!, sizeX: 9 }, storage);
    registerSessionModel(parseCompositeModelLine(MODEL_LINE)!);
    expect(listModels(storage)).toHaveLength(1);
    expect(getModel('myCirc', storage)!.sizeX).toBe(2);  // the file's copy wins

    removeModel('myCirc', storage);
    // Deleting the shadow uncovers the saved model instead of destroying it:
    // the Manager still lists one `myCirc`, now the user's own.
    expect(storage.getItem('subcircuit:myCirc')).not.toBeNull();
    expect(getModel('myCirc', storage)!.sizeX).toBe(9);
    const listed = listModels(storage);
    expect(listed).toHaveLength(1);
    expect(listed[0].sizeX).toBe(9);
  });

  it('a saved model is stored once, so one Delete removes it', () => {
    const storage = fakeStorage();
    // Saving supersedes the session entry the file's `.` line left, or the
    // Manager's Delete would clear the session copy and leave the stored one
    // behind, needing a second click to finish the job.
    registerSessionModel(parseCompositeModelLine(MODEL_LINE)!);
    saveModel({ ...parseCompositeModelLine(MODEL_LINE)!, sizeX: 9 }, storage);
    expect(getModel('myCirc', storage)!.sizeX).toBe(9);
    removeModel('myCirc', storage);
    expect(listModels(storage)).toEqual([]);
    expect(getModel('myCirc', storage)).toBeUndefined();
  });

  it('with no storage at all the saved model stays in the session map', () => {
    // A disabled or absent localStorage must not swallow the model: it lives
    // in the session map until the next load, and a Delete still removes it.
    saveModel(parseCompositeModelLine(MODEL_LINE)!, undefined);
    expect(getModel('myCirc', undefined)!.name).toBe('myCirc');
    removeModel('myCirc', undefined);
    expect(getModel('myCirc', undefined)).toBeUndefined();
  });

  it('a refused write keeps the model in the session map', () => {
    // A full or private-mode localStorage throws from setItem. The model must
    // not vanish: it stays in the session map, listed and deletable, until the
    // next load.
    const storage = fullStorage(fakeStorage());
    saveModel(parseCompositeModelLine(MODEL_LINE)!, storage);
    expect(storage.getItem('subcircuit:myCirc')).toBeNull();
    expect(getModel('myCirc', storage)!.name).toBe('myCirc');
    expect(listModels(storage)).toHaveLength(1);
  });

  it('a refused overwrite does not mistake the old model for the new one', () => {
    // The regression the presence-only read-back had: the key already holds
    // v1, the write of v2 is refused, and reading the key back finds v1. Taken
    // as success that would drop the session copy and lose the model the user
    // just built, while the UI reported it saved.
    const inner = fakeStorage();
    saveModel({ ...parseCompositeModelLine(MODEL_LINE)!, sizeX: 1 }, inner);
    const storage = fullStorage(inner);
    saveModel({ ...parseCompositeModelLine(MODEL_LINE)!, sizeX: 7 }, storage);
    // Storage still holds v1, but the library hands out the v2 the user built.
    expect(inner.getItem('subcircuit:myCirc')).toBe(
      compositeModelLine({ ...parseCompositeModelLine(MODEL_LINE)!, sizeX: 1 }),
    );
    expect(getModel('myCirc', storage)!.sizeX).toBe(7);
  });

  it('a load drops a session model that storage refused to take', () => {
    // The session map is scoped to one load whatever put a model there, so the
    // stored v1 is what survives the next load, not the unsaveable v2.
    const inner = fakeStorage();
    saveModel({ ...parseCompositeModelLine(MODEL_LINE)!, sizeX: 1 }, inner);
    saveModel({ ...parseCompositeModelLine(MODEL_LINE)!, sizeX: 7 }, fullStorage(inner));
    useStore.getState().loadNetlist(HEADER + 'r 0 0 160 0 0 1000\n');
    expect(getModel('myCirc', inner)!.sizeX).toBe(1);
  });
});

describe('the store actions behind the menu rows', () => {
  /** The labeled divider the Create Subcircuit flow is documented around,
   *  added through the store so the ids are the store's own. */
  function addLabeledDivider(): number[] {
    const s = useStore.getState();
    const ids = [
      s.addElement(makeElement('resistor', 0, 0, 160, 0)),
      s.addElement(makeElement('resistor', 160, 0, 320, 0)),
      s.addElement(makeElement('labeledNode', 0, 0, -32, 0)),
      s.addElement(makeElement('labeledNode', 320, 0, 352, 0)),
    ];
    s.setText(ids[2], 'in');
    s.setText(ids[3], 'out');
    return ids;
  }

  it('createSubcircuit opens the naming dialog with a draft from the selection', () => {
    const s = useStore.getState();
    const ids = addLabeledDivider();
    s.select(ids);

    expect(s.createSubcircuit()).toBe(true);
    const after = useStore.getState();
    expect(after.dialog).toBe('createSubcircuit');
    expect(after.subcircuitError).toBeNull();
    expect(after.subcircuitDraft).not.toBeNull();
    expect(after.subcircuitDraft!.extList.map((p) => p.name)).toEqual(['in', 'out']);
    expect(after.subcircuitDraft!.nodeList).toBe('ResistorElm 1 2\rResistorElm 2 3');
  });

  it('createSubcircuit leaves the refusal reason for the menubar to show', () => {
    // A capacitor in the selection used to produce a resistor-only model with
    // no warning; now the command refuses and says which kind stopped it.
    const s = useStore.getState();
    const ids = addLabeledDivider();
    ids.push(s.addElement(makeElement('capacitor', 160, 0, 160, 160)));
    s.select(ids);

    expect(s.createSubcircuit()).toBe(false);
    const after = useStore.getState();
    expect(after.dialog).toBeNull();
    expect(after.subcircuitDraft).toBeNull();
    expect(after.subcircuitError).toContain('Capacitor');
  });

  it('createSubcircuit fails when nothing is labeled', () => {
    // Nothing marks a pin, upstream's "Device has no external inputs/outputs!"
    // abort (EditCompositeModelDialog.java:72-75).
    const s = useStore.getState();
    const r1 = s.addElement(makeElement('resistor', 0, 0, 160, 0));
    const r2 = s.addElement(makeElement('resistor', 160, 0, 320, 0));
    s.select([r1, r2]);
    expect(s.createSubcircuit()).toBe(false);
    expect(useStore.getState().subcircuitDraft).toBeNull();
    expect(useStore.getState().subcircuitError).toContain('labeled nodes');
  });

  it('saveSubcircuitDraft stores the named model and clears the draft', () => {
    const s = useStore.getState();
    addLabeledDivider();
    // Nothing selected: the whole circuit is the subcircuit.
    expect(s.createSubcircuit()).toBe(true);
    s.saveSubcircuitDraft('myCircuit');
    const after = useStore.getState();
    expect(after.dialog).toBeNull();
    expect(after.subcircuitDraft).toBeNull();
    const stored = getModel('myCircuit');
    expect(stored).not.toBeUndefined();
    expect(stored!.nodeList).toBe('ResistorElm 1 2\rResistorElm 2 3');
    expect(stored!.extList).toHaveLength(2);
  });

  it('cancelSubcircuitDraft drops the draft without storing it', () => {
    const s = useStore.getState();
    const ids = addLabeledDivider();
    s.select(ids);
    expect(s.createSubcircuit()).toBe(true);
    s.cancelSubcircuitDraft();
    const after = useStore.getState();
    expect(after.dialog).toBeNull();
    expect(after.subcircuitDraft).toBeNull();
    expect(listModels()).toEqual([]);
  });
});
