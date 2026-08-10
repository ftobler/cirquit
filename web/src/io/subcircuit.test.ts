/** The subcircuit `.` line and the Tools>Create Subcircuit / Subcircuit
 *  Manager features: parse, round-trip, model building from a selection and
 *  the library's storage round-trip. */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildModelFromSelection,
  clearSessionModels,
  compositeModelLine,
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
  function resistor(x1: number, x2: number): CircuitElement {
    return makeElement('resistor', x1, 0, x2, 0) as CircuitElement;
  }

  it('the external pins are the posts that connect outside the selection', () => {
    // Two selected resistors in series, the second post of r2 tied to an
    // unselected load: only that shared coordinate is external.
    const r1 = { ...resistor(0, 160), id: 1 };
    const r2 = { ...resistor(160, 320), id: 2 };
    const load = { ...resistor(320, 480), id: 3 };
    const model = buildModelFromSelection([r1, r2, load], [1, 2]);

    expect(model).not.toBeNull();
    expect(model!.nodeList).toBe('ResistorElm 1 2\rResistorElm 2 3');
    // One external pin, the shared (320,0) post, carrying node 3.
    expect(model!.extList).toHaveLength(1);
    expect(model!.extList[0]).toEqual({ name: 'p0', node: 3, pos: 0, side: 3 });
    // The child dumps carry each resistor's flags and resistance.
    expect(model!.elmDump).toBe('0\\s1000 0\\s1000');
  });

  it('a wire behind a resistor makes the far post the external pin', () => {
    // r1 (selected) -> wire (selected) -> r2 (unselected): the wire collapses
    // the net, so r1's post at (160,0) and the wire end are the same node, and
    // that node is the single external pin.
    const r1 = { ...resistor(0, 160), id: 1 };
    const wire = { ...makeElement('wire', 160, 0, 320, 0), id: 2 };
    const r2 = { ...resistor(320, 480), id: 3 };
    const model = buildModelFromSelection([r1, wire, r2], [1, 2]);

    expect(model).not.toBeNull();
    expect(model!.nodeList).toBe('ResistorElm 1 2');
    expect(model!.extList).toHaveLength(1);
    expect(model!.extList[0].node).toBe(2);
  });

  it('north/south pins skip the reserved west pin column', () => {
    // A north, a west and an east external pin. The west side occupies grid
    // column 0, so the north pin's stored pos is shifted right by one, exactly
    // the xOffsetLeft adjustment upstream applies before saving
    // (EditCompositeModelDialog.java:97-104); west/east pins are not moved.
    const r1 = { ...resistor(0, 160), id: 1 };  // east post (160,0)
    const r2 = { ...makeElement('resistor', 0, -160, 0, 0), id: 2 };  // north post (0,-160)
    const r3 = { ...resistor(0, -160), id: 3 };  // west post (-160,0)
    const extEast = { ...resistor(160, 320), id: 10 };
    const extNorth = { ...makeElement('resistor', 0, -320, 0, -160), id: 11 };
    const extWest = { ...resistor(-160, -320), id: 12 };
    const model = buildModelFromSelection(
      [r1, r2, r3, extEast, extNorth, extWest],
      [1, 2, 3],
    );

    expect(model).not.toBeNull();
    const north = model!.extList.find((p) => p.side === 0);
    const west = model!.extList.find((p) => p.side === 2);
    const east = model!.extList.find((p) => p.side === 3);
    expect(north).toBeDefined();
    expect(west).toBeDefined();
    expect(east).toBeDefined();
    // The west column is reserved (xOffsetLeft 1), so the north pin sits one
    // column in; the west and east pins stay at the chip edge.
    expect(north!.pos).toBe(1);
    expect(west!.pos).toBe(0);
    expect(east!.pos).toBe(0);
    // The chip is wide enough for one N/S pin plus the two columns.
    expect(model!.sizeX).toBe(3);
  });

  it('a labeled node names the external pin it sits on', () => {
    const r1 = { ...resistor(0, 160), id: 1 };
    const r2 = { ...resistor(160, 320), id: 2 };
    const load = { ...resistor(320, 480), id: 3 };
    const label = {
      ...makeElement('labeledNode', 320, 0, 320, 0),
      id: 4,
      text: 'vout',
    };
    const model = buildModelFromSelection([r1, r2, load, label], [1, 2, 4]);

    expect(model!.extList).toHaveLength(1);
    expect(model!.extList[0].name).toBe('vout');
    // The labeled node itself is not a child model line.
    expect(model!.nodeList).toBe('ResistorElm 1 2\rResistorElm 2 3');
  });

  it('an unsupported kind is skipped, and nothing buildable means null', () => {
    const cap = { ...makeElement('capacitor', 0, 0, 160, 0), id: 1 };
    expect(buildModelFromSelection([cap], [1])).toBeNull();
    const r = { ...resistor(0, 160), id: 2 };
    const model = buildModelFromSelection([cap, r], [1, 2]);
    expect(model!.nodeList).toBe('ResistorElm 1 2');
  });

  it('an empty selection yields null', () => {
    expect(buildModelFromSelection([], [])).toBeNull();
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
  it('createSubcircuit opens the naming dialog with a draft from the selection', () => {
    const s = useStore.getState();
    const r1 = s.addElement(makeElement('resistor', 0, 0, 160, 0));
    const r2 = s.addElement(makeElement('resistor', 160, 0, 320, 0));
    const load = s.addElement(makeElement('resistor', 320, 0, 480, 0));
    s.select([r1, r2]);
    void load;

    expect(s.createSubcircuit()).toBe(true);
    const after = useStore.getState();
    expect(after.dialog).toBe('createSubcircuit');
    expect(after.subcircuitDraft).not.toBeNull();
    expect(after.subcircuitDraft!.extList).toHaveLength(1);
    expect(after.subcircuitDraft!.extList[0].node).toBe(3);
  });

  it('createSubcircuit fails with nothing buildable selected', () => {
    const s = useStore.getState();
    const id = s.addElement(makeElement('capacitor', 0, 0, 160, 0));
    s.select([id]);
    expect(s.createSubcircuit()).toBe(false);
    expect(useStore.getState().dialog).toBeNull();
    expect(useStore.getState().subcircuitDraft).toBeNull();
  });

  it('createSubcircuit fails when the selection has no external connection', () => {
    // A self-contained pair of resistors, nothing outside touches them, so
    // there is nothing to expose as a pin (upstream's "Device has no external
    // inputs/outputs!" abort).
    const s = useStore.getState();
    const r1 = s.addElement(makeElement('resistor', 0, 0, 160, 0));
    const r2 = s.addElement(makeElement('resistor', 160, 0, 320, 0));
    s.select([r1, r2]);
    expect(s.createSubcircuit()).toBe(false);
    expect(useStore.getState().subcircuitDraft).toBeNull();
  });

  it('saveSubcircuitDraft stores the named model and clears the draft', () => {
    const s = useStore.getState();
    const r1 = s.addElement(makeElement('resistor', 0, 0, 160, 0));
    const load = s.addElement(makeElement('resistor', 160, 0, 320, 0));
    s.select([r1]);
    void load;
    expect(s.createSubcircuit()).toBe(true);
    s.saveSubcircuitDraft('myCircuit');
    const after = useStore.getState();
    expect(after.dialog).toBeNull();
    expect(after.subcircuitDraft).toBeNull();
    const stored = getModel('myCircuit');
    expect(stored).not.toBeUndefined();
    expect(stored!.nodeList).toBe('ResistorElm 1 2');
  });

  it('cancelSubcircuitDraft drops the draft without storing it', () => {
    const s = useStore.getState();
    const r1 = s.addElement(makeElement('resistor', 0, 0, 160, 0));
    const load = s.addElement(makeElement('resistor', 160, 0, 320, 0));
    s.select([r1]);
    void load;
    expect(s.createSubcircuit()).toBe(true);
    s.cancelSubcircuitDraft();
    const after = useStore.getState();
    expect(after.dialog).toBeNull();
    expect(after.subcircuitDraft).toBeNull();
    expect(listModels()).toEqual([]);
  });
});
