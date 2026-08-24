/** The subcircuit `.` line and the File>Create Subcircuit / Subcircuit
 *  Manager features: parse, round-trip, model building from a selection and
 *  the library's storage round-trip. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { denyGlobalStorage } from '../../test/denyGlobalStorage';
import {
  buildModelFromSelection,
  clearSessionModels,
  compositeModelLine,
  describeBuildFailure,
  escapeChildField,
  getModel,
  listModels,
  modelToEngineSpec,
  nameTaken,
  parseCompositeModelLine,
  registerSessionModel,
  removeModel,
  renameCompositeModelLine,
  renameModel,
  saveModel,
  unescapeChildField,
  type SubcircuitStorage,
} from './subcircuits';
import { parseCircuit, serializeCircuit } from './netlist';
import {
  commitSubcircuitCreate,
  commitSubcircuitEdit,
  deleteSubcircuit,
  setSubcircuitDraft,
  startSubcircuitEdit,
} from '../ui/subcircuitManager';
import { summarizeImport } from './importSummary';
import { escapeToken, unescapeToken } from './netlist/tokens';
import { DEFAULT_SETTINGS, type CircuitElement } from '../model/types';
import { LABELED_NODE_INTERNAL } from '../model/registry/flags';
import { makeElement, makeToolElement, useStore } from '../state/store';
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

/** The same storage with a refusing deleter, standing in for one that keeps a
 *  key the user asked to drop. Nothing else changes, so the model stays
 *  readable and listed, which is exactly what makes the failure worth
 *  reporting. */
function stickyStorage(inner: SubcircuitStorage): SubcircuitStorage {
  return {
    ...inner,
    getItem: (k) => inner.getItem(k),
    setItem: (k, v) => inner.setItem(k, v),
    removeItem: () => {
      throw new Error('SecurityError');
    },
    listSubcircuitKeys: () => inner.listSubcircuitKeys(),
  };
}

/** A browser-shaped `localStorage` backed by a plain map, returned alongside
 *  the map so tests can seed and inspect keys. The library reads
 *  `globalThis.localStorage` through `defaultStorage`, and the store's rename
 *  path has nowhere to inject a fake past it, so these tests give it a real
 *  one, which is also what makes the doubling reproducible: without persisted
 *  keys the old code's promotion of the file's model into storage had nowhere
 *  to land. */
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

  it('renames the model in a `.` line and leaves every other byte alone', () => {
    const renamed = renameCompositeModelLine(MODEL_LINE, 'myCirc', 'amp');
    expect(renamed).toBe(MODEL_LINE.replace('. myCirc', '. amp'));
    // A name needing escapes is escaped like the writer would, and comes back
    // unescaped through the parser.
    const spaced = renameCompositeModelLine(MODEL_LINE, 'myCirc', 'my amp')!;
    expect(spaced).toContain('. my\\samp ');
    expect(parseCompositeModelLine(spaced)!.name).toBe('my amp');
  });

  it('leaves a line that is not this model alone', () => {
    // Another model's line, a non-`.` line and a truncated one all answer null,
    // so the rename walk over the file passes them through untouched.
    expect(renameCompositeModelLine(MODEL_LINE, 'other', 'amp')).toBeNull();
    expect(renameCompositeModelLine('r 0 0 160 0 0 1000', 'myCirc', 'amp')).toBeNull();
    expect(renameCompositeModelLine('. myCirc 0 2 2', 'myCirc', 'amp')).toBeNull();
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

  it('orders the ext list alphabetically while keeping each pin pos and side', () => {
    // Upstream sorts the assembled side-major list by name, case-insensitively,
    // before the model is written (EditCompositeModelDialog.java:76-80), and
    // the `.` line's pin order is what the other half consumes, so a west pin
    // `z` and an east pin `a` come back alphabetical while their derived
    // `pos`/`side` are untouched.
    const elements = [
      resistor(0, 0, 160, 0),
      resistor(0, 160, 160, 160),
      label('z', 0, 160, -32, 0),
      label('a', 160, 160, 32, 0),
    ];
    const built = buildModelFromSelection(elements, []);
    expect(built.model!.extList).toEqual([
      { name: 'a', node: 4, pos: 0, side: 3 },
      { name: 'z', node: 3, pos: 0, side: 2 },
    ]);
  });

  it('keeps side-major order for names that tie under case-insensitive sort', () => {
    // `ab` and `AB` compare equal once lowercased, so the sort is a tie and
    // `Array.prototype.sort` is stable: the west pin keeps the side-major
    // position it held before the alphabetical pass, as Java's stable
    // `Collections.sort` does (EditCompositeModelDialog.java:76-80).
    const elements = [
      resistor(0, 0, 160, 0),
      resistor(0, 160, 160, 160),
      label('ab', 0, 160, -32, 0),
      label('AB', 160, 160, 32, 0),
    ];
    const built = buildModelFromSelection(elements, []);
    expect(built.model!.extList.map((p) => [p.name, p.node, p.pos, p.side])).toEqual([
      ['ab', 3, 0, 2],
      ['AB', 4, 0, 3],
    ]);
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
      { ...makeElement('transformer', 160, 0, 320, 0), id: nextId++ } as CircuitElement,
      { ...makeElement('opamp', 320, 0, 480, 0), id: nextId++ } as CircuitElement,
      label('in', 0, 0, -32, 0),
      label('out', 480, 0, 32, 0),
    ];
    const built = buildModelFromSelection(elements, []);
    expect(built.model).toBeNull();
    expect(built.unsupported).toEqual(['Transformer', 'Op-amp']);
    expect(describeBuildFailure(built)).toBe(
      'Cannot build a subcircuit from this selection: it contains Transformer, Op-amp, ' +
        'which the subcircuit engine cannot represent yet.',
    );
  });

  it('builds a model carrying logic children, the input count riding the dump', () => {
    // A selection holding gates used to be refused outright, so no subcircuit
    // could contain logic at all. The gate's model line names one node per
    // input plus the output, and its dump's first field is the input count,
    // which is what lets the engine rebuild a wide gate.
    const gate = {
      ...makeElement('nandGate', 0, 0, 96, 0),
      id: nextId++,
      params: { inputCount: 3, highVoltage: 5 },
    } as CircuitElement;
    const inverter = { ...makeElement('inverter', 96, 0, 192, 0), id: nextId++ } as CircuitElement;
    const elements = [
      gate,
      inverter,
      label('a', 0, -16, -32, 0),
      label('b', 0, 0, -32, 0),
      label('c', 0, 16, -32, 0),
      label('out', 192, 0, 32, 0),
    ];
    const built = buildModelFromSelection(elements, []);

    expect(built.unsupported).toEqual([]);
    const lines = built.model!.nodeList.split('\r');
    // Three inputs then the output, then the inverter hanging off it.
    expect(lines[0].split(' ')).toHaveLength(5);
    expect(lines[0].startsWith('NandGateElm ')).toBe(true);
    expect(lines[1].startsWith('InverterElm ')).toBe(true);
    // The gate's own output node is the inverter's input.
    expect(lines[0].split(' ').at(-1)).toBe(lines[1].split(' ')[1]);
    // inputCount, last output voltage, high level; then the inverter's slew
    // rate and high level.
    expect(built.model!.elmDump.split(' ')[0]).toBe('0\\s3\\s0\\s5');
  });

  it('builds a model carrying capacitor, diode and inductor children', () => {
    // These kinds used to refuse the build outright; now they become child
    // model lines and their numeric dump fields ride the `.` line round trip
    // and the engine spec, so the engine can rebuild the children with their
    // values.
    const elements = [
      resistor(0, 0, 160, 0),
      { ...makeElement('capacitor', 160, 0, 320, 0), id: nextId++ } as CircuitElement,
      { ...makeElement('diode', 320, 0, 480, 0), id: nextId++ } as CircuitElement,
      { ...makeElement('inductor', 480, 0, 640, 0), id: nextId++ } as CircuitElement,
      label('in', 0, 0, -32, 0),
      label('out', 640, 0, 32, 0),
    ];
    const built = buildModelFromSelection(elements, []);
    expect(built.unsupported).toEqual([]);
    expect(built.model).not.toBeNull();
    expect(built.model!.nodeList).toBe(
      'ResistorElm 1 2\rCapacitorElm 2 3\rDiodeElm 3 4\rInductorElm 4 5',
    );
    expect(built.model!.extList.map((p) => [p.name, p.node])).toEqual([
      ['in', 1],
      ['out', 5],
    ]);
    // The child dumps carry each kind's flags and numeric fields in the
    // registry dump order: the capacitor's FLAG_RESISTANCE (4) bit and its
    // four tokens, the diode's FLAG_FWDROP (1) bit and forward drop, and the
    // inductor's four tokens.
    const engineSpec = modelToEngineSpec(built.model!);
    expect(engineSpec.dumps).toEqual([
      '0_1000',
      '4_0.00001_0_0.001_0',
      '1_0.805904783',
      '0_1_0_0_0',
    ]);
    // The `.` line round trip needs a name, which only the save step assigns.
    const reparsed = parseCompositeModelLine(
      compositeModelLine({ ...built.model!, name: 'mixed' }),
    );
    expect(reparsed).toEqual({ ...built.model!, name: 'mixed' });
  });

  it('keeps child dump fields containing `_` and a space intact through the round trip', () => {
    // A switch label is a string dump field, so a label with an underscore
    // and a space is exactly the value the `_`-join corrupts: the writer
    // turns every underscore into a space and the loader splits every space
    // into a new field. The child-dump escaping must keep the label one
    // field end to end.
    const elements = [
      {
        ...makeElement('switch', 0, 0, 160, 0),
        id: nextId++,
        text: 'my_switch on',
      } as CircuitElement,
      label('in', 0, 0, -32, 0),
      label('out', 160, 0, 32, 0),
    ];
    const built = buildModelFromSelection(elements, []);
    expect(built.unsupported).toEqual([]);
    const model = built.model!;
    expect(model.nodeList).toBe('SwitchElm 1 2');
    // The stored `.` line form: the label's `_` encoded `\u`, its space `\s`,
    // each backslash doubled again by the outer token escape. The label is
    // still a single `\s`-separated field of the child token.
    expect(model.elmDump).toBe('4\\s0\\sfalse\\smy\\\\uswitch\\\\son');
    // The engine token: the loader's unescape/split/join restores the
    // `_`-joined form with the label still one field (the engine drops the
    // non-numeric switch label either way).
    expect(modelToEngineSpec(model).dumps).toEqual(['4_0_false_my\\uswitch\\son']);
    // The inverse of the loader, the way the engine dumps would walk back to
    // an elmDump, recovers the stored token exactly.
    const back = modelToEngineSpec(model).dumps.map((d) => escapeToken(d.split('_').join(' ')));
    expect(back.join(' ')).toBe(model.elmDump);
    // Decoding that recovered dump yields the original switch fields.
    const fields = unescapeToken(back[0]).split(' ').map(unescapeChildField);
    expect(fields).toEqual(['4', '0', 'false', 'my_switch on']);
    // And the `.` line round trip keeps the elmDump byte for byte.
    const reparsed = parseCompositeModelLine(
      compositeModelLine({ ...model, name: 'labelled' }),
    );
    expect(reparsed).toEqual({ ...model, name: 'labelled' });
  });

  it('round-trips a diode model name containing an underscore', () => {
    // The named-model form of a diode dump carries the model name as its
    // only field; a name with an underscore is another real `_`-in-field case
    // (a built-in 34-line name is never escaped, so one reaching the dump has
    // a real underscore).
    const elements = [
      {
        ...makeElement('diode', 0, 0, 160, 0),
        id: nextId++,
        modelName: '1N_4148',
      } as CircuitElement,
      label('in', 0, 0, -32, 0),
      label('out', 160, 0, 32, 0),
    ];
    const built = buildModelFromSelection(elements, []);
    expect(built.unsupported).toEqual([]);
    const model = built.model!;
    // FLAG_MODEL (bit 2) with the model name as the one field.
    expect(model.elmDump).toBe('2\\s1N\\\\u4148');
    const dumps = modelToEngineSpec(model).dumps;
    expect(dumps).toEqual(['2_1N\\u4148']);
    // The loader round trip keeps the name in one field.
    const fields = unescapeToken(escapeToken(dumps[0].split('_').join(' ')))
      .split(' ')
      .map(unescapeChildField);
    expect(fields).toEqual(['2', '1N_4148']);
  });

  it('the child-dump field escaping round-trips any value', () => {
    // Backslashes come first in the encoding, so a value that already looks
    // like an escape, or mixes all three special characters, still decodes.
    for (const value of ['plain', 'with_space', '1N_4148', 'a\\b', 'a\\u', 'a\\s', 'a\\_b', 'x_u\\v w']) {
      expect(unescapeChildField(escapeChildField(value))).toBe(value);
    }
  });

  it('maps jfet and mosfet channel type onto the polarity-named class', () => {
    // The channel type is not a dump token; it lives in the element's `pnp`
    // param, which the class name carries to the engine (composite.rs
    // `child_kind`). A P-channel part must become a PJfetElm/PMosfetElm line
    // and its dump must set the MOSFET_PNP flag bit 1.
    const elements = [
      {
        ...makeElement('jfet', 0, 0, 160, 0),
        id: nextId++,
        params: { pnp: -1, beta: 0.00125, threshold: -4 },
      } as CircuitElement,
      {
        ...makeElement('mosfet', 160, 0, 320, 0),
        id: nextId++,
        params: { pnp: -1, beta: 0.02, threshold: 1.5 },
      } as CircuitElement,
      label('gate', 0, 0, -32, 0),
      // A jfet/mosfet's gate is point 1 and the source/drain hang off point 2
      // at ±16 perpendicular, so the labelled nets are the gate and the far
      // perpendicular post.
      label('drn', 320, -16, 32, 0),
    ];
    const built = buildModelFromSelection(elements, []);
    expect(built.unsupported).toEqual([]);
    const lines = built.model!.nodeList.split('\r');
    expect(lines[0]).toMatch(/^PJfetElm /);
    expect(lines[1]).toMatch(/^PMosfetElm /);
    // The child dumps start with the channel-type flag bit, then the
    // threshold/beta pair the engine reads.
    const engineSpec = modelToEngineSpec(built.model!);
    expect(engineSpec.dumps[0]).toBe('1_-4_0.00125');
    expect(engineSpec.dumps[1]).toBe('1_1.5_0.02');
    // And the N-channel form round-trips to the N-named class.
    const n = buildModelFromSelection(
      [
        {
          ...makeElement('jfet', 0, 0, 160, 0),
          id: nextId++,
          params: { pnp: 1, beta: 0.00125, threshold: -4 },
        } as CircuitElement,
        label('gate', 0, 0, -32, 0),
        label('src', 160, 16, 32, 0),
      ],
      [],
    );
    expect(n.model!.nodeList).toMatch(/^NJfetElm /);
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

    expect(removeModel('stored', storage)).toBe('stored');
    expect(listModels(storage)).toEqual([]);
    expect(storage.getItem('subcircuit:stored')).toBeNull();
    // Nothing left to remove, which is a stale row rather than a delete.
    expect(removeModel('stored', storage)).toBe('none');
  });

  it('rename moves the stored model to its new name', () => {
    const storage = fakeStorage();
    saveModel(parseCompositeModelLine(MODEL_LINE)!, storage);
    expect(renameModel('myCirc', 'renamed', storage)).toBe('renamed');
    const renamed = getModel('renamed', storage);
    expect(renamed).not.toBeUndefined();
    expect(renamed!.name).toBe('renamed');
    expect(renamed!.extList).toEqual(parseCompositeModelLine(MODEL_LINE)!.extList);
    expect(getModel('myCirc', storage)).toBeUndefined();
    // The old key goes with it, or the model would be listed twice.
    expect(storage.getItem('subcircuit:myCirc')).toBeNull();
    // A blank, unchanged or missing name is refused, each in its own words so
    // the Manager can tell a retypeable refusal from a vanished model.
    expect(renameModel('renamed', '', storage)).toBe('blank');
    expect(renameModel('renamed', 'renamed', storage)).toBe('unchanged');
    expect(renameModel('nope', 'x', storage)).toBe('missing');
  });

  it('a rename onto a missing model writes nothing', () => {
    const storage = fakeStorage();
    expect(renameModel('nope', 'x', storage)).toBe('missing');
    expect(listModels(storage)).toEqual([]);
    expect(storage.getItem('subcircuit:x')).toBeNull();
  });

  it('nameTaken sees both stores and only the names that are there', () => {
    const storage = fakeStorage();
    saveModel({ ...parseCompositeModelLine(MODEL_LINE)!, name: 'stored' }, storage);
    registerSessionModel({ ...parseCompositeModelLine(MODEL_LINE)!, name: 'fromFile' });
    expect(nameTaken('stored', storage)).toBe(true);
    expect(nameTaken('fromFile', storage)).toBe(true);
    expect(nameTaken('free', storage)).toBe(false);
    // Without storage only the session map can answer, the same way `getModel`
    // degrades when localStorage is gone.
    expect(nameTaken('stored', undefined)).toBe(false);
    expect(nameTaken('fromFile', undefined)).toBe(true);
  });

  it('a rename onto a taken name refuses instead of destroying that model', () => {
    // The regression: `divider` renamed onto `amp` used to delete `amp` and
    // write `divider`'s body under its name, with nothing said and one row
    // fewer in the list.
    const storage = fakeStorage();
    const base = parseCompositeModelLine(MODEL_LINE)!;
    saveModel({ ...base, name: 'divider', nodeList: 'ResistorElm 1 2' }, storage);
    saveModel({ ...base, name: 'amp', nodeList: 'ResistorElm 3 4' }, storage);

    expect(renameModel('divider', 'amp', storage)).toBe('taken');
    expect(getModel('amp', storage)!.nodeList).toBe('ResistorElm 3 4');
    expect(getModel('divider', storage)!.nodeList).toBe('ResistorElm 1 2');
    expect(listModels(storage)).toHaveLength(2);
  });

  it('renaming a row that shadows a saved model uncovers it rather than moving it', () => {
    // The two are different models sharing a name: the file's copy is what the
    // row showed, so that is what moves, and the saved one comes back into
    // view under the old name. `uncovered` is what lets the Manager say so.
    const storage = fakeStorage();
    const base = parseCompositeModelLine(MODEL_LINE)!;
    saveModel({ ...base, nodeList: 'ResistorElm 9 9' }, storage);  // the saved one
    registerSessionModel({ ...base, nodeList: 'ResistorElm 1 2' });  // the file's

    expect(renameModel('myCirc', 'renamed', storage)).toBe('uncovered');
    expect(getModel('renamed', storage)!.nodeList).toBe('ResistorElm 1 2');
    expect(getModel('myCirc', storage)!.nodeList).toBe('ResistorElm 9 9');
    expect(listModels(storage).map((m) => m.name)).toEqual(['myCirc', 'renamed']);
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

    // The outcome names the store that was emptied, which is what tells the
    // Manager a saved model of this name is still there to offer to delete.
    expect(removeModel('myCirc', storage)).toBe('session');
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

  it('a rename storage refuses leaves the saved model exactly where it was', () => {
    // The remaining destroy path: deleting the original first and only then
    // writing the copy loses the model outright when the write is refused, as
    // it survives in the session map alone and the next load clears that. The
    // copy goes first, so a refusal is a no-op the user is told about.
    const inner = fakeStorage();
    saveModel(parseCompositeModelLine(MODEL_LINE)!, inner);
    const storage = fullStorage(inner);

    expect(renameModel('myCirc', 'renamed', storage)).toBe('refused');
    expect(inner.getItem('subcircuit:myCirc')).not.toBeNull();
    expect(getModel('myCirc', storage)!.name).toBe('myCirc');
    // No half-renamed leftover in the session map either.
    expect(getModel('renamed', storage)).toBeUndefined();
    expect(listModels(storage).map((m) => m.name)).toEqual(['myCirc']);
  });

  it('a rename whose delete is refused reports the row left behind', () => {
    // The copy landed, so the rename did happen, but the old key is still
    // there and the Manager has two rows to account for.
    const storage = stickyStorage(fakeStorage());
    saveModel(parseCompositeModelLine(MODEL_LINE)!, storage);
    expect(renameModel('myCirc', 'renamed', storage)).toBe('uncovered');
    expect(getModel('renamed', storage)!.name).toBe('renamed');
    expect(getModel('myCirc', storage)).not.toBeUndefined();
  });

  it('a delete storage refuses is not reported as a delete', () => {
    const storage = stickyStorage(fakeStorage());
    saveModel(parseCompositeModelLine(MODEL_LINE)!, storage);
    expect(removeModel('myCirc', storage)).toBe('refused');
    expect(getModel('myCirc', storage)!.name).toBe('myCirc');
    // Still `none` for a name nothing holds: the two are different events.
    expect(removeModel('ghost', storage)).toBe('none');
  });

  it('the Manager Delete clears both stores over the real library', () => {
    // The delete-through path end to end, with `removeModel` and `nameTaken`
    // themselves rather than a stub that only counts calls.
    const storage = fakeStorage();
    const base = parseCompositeModelLine(MODEL_LINE)!;
    saveModel({ ...base, sizeX: 9 }, storage);  // the user's saved model
    registerSessionModel({ ...base, sizeX: 2 });  // the open file's copy over it
    const answering = (answers: boolean[]) => ({
      remove: (name: string) => removeModel(name, storage),
      exists: (name: string) => nameTaken(name, storage),
      confirm: () => answers.shift() ?? false,
    });

    expect(deleteSubcircuit('myCirc', answering([true, true])).outcome).toBe('deleted');
    expect(listModels(storage)).toEqual([]);
    expect(storage.getItem('subcircuit:myCirc')).toBeNull();
  });

  it('the Manager Delete stops at the uncovered model when told to', () => {
    const storage = fakeStorage();
    const base = parseCompositeModelLine(MODEL_LINE)!;
    saveModel({ ...base, sizeX: 9 }, storage);
    registerSessionModel({ ...base, sizeX: 2 });
    const answering = (answers: boolean[]) => ({
      remove: (name: string) => removeModel(name, storage),
      exists: (name: string) => nameTaken(name, storage),
      confirm: () => answers.shift() ?? false,
    });

    // Declining the second prompt leaves the saved model listed, on purpose.
    expect(deleteSubcircuit('myCirc', answering([true, false])).outcome).toBe('uncovered');
    expect(listModels(storage).map((m) => m.sizeX)).toEqual([9]);
    // The row is now a plain saved model, so one more Delete finishes it with
    // a single prompt.
    expect(deleteSubcircuit('myCirc', answering([true])).outcome).toBe('deleted');
    expect(listModels(storage)).toEqual([]);
  });

  it('the Manager Delete reports a saved model storage would not drop', () => {
    const storage = stickyStorage(fakeStorage());
    saveModel(parseCompositeModelLine(MODEL_LINE)!, storage);
    const result = deleteSubcircuit('myCirc', {
      remove: (name) => removeModel(name, storage),
      exists: (name) => nameTaken(name, storage),
      confirm: () => true,
    });
    expect(result.outcome).toBe('refused');
    expect(result.notice).toContain('"myCirc"');
    expect(listModels(storage)).toHaveLength(1);
  });

  it('the Manager row reports a taken name and leaves both models listed', () => {
    // Plan test 5 without a DOM: the row's state is what the dialog renders,
    // so this is the same assertion one level down, and the library call is
    // the real one rather than a stub.
    const storage = fakeStorage();
    const base = parseCompositeModelLine(MODEL_LINE)!;
    saveModel({ ...base, name: 'divider' }, storage);
    saveModel({ ...base, name: 'amp' }, storage);

    const typed = setSubcircuitDraft(startSubcircuitEdit('divider'), 'amp');
    const result = commitSubcircuitEdit(typed, (oldName, newName) =>
      renameModel(oldName, newName, storage),
    );
    expect(result.outcome).toBe('taken');
    expect(result.state.editing).toBe('divider');  // still in edit mode
    expect(result.state.error).toContain('already exists');
    expect(listModels(storage).map((m) => m.name)).toEqual(['amp', 'divider']);
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
    // A transformer in the selection used to produce a resistor-only model
    // with no warning; now the command refuses and says which kind stopped it.
    const s = useStore.getState();
    const ids = addLabeledDivider();
    ids.push(s.addElement(makeElement('transformer', 160, 0, 160, 160)));
    s.select(ids);

    expect(s.createSubcircuit()).toBe(false);
    const after = useStore.getState();
    expect(after.dialog).toBeNull();
    expect(after.subcircuitDraft).toBeNull();
    expect(after.subcircuitError).toContain('Transformer');
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

  it('Create asks before replacing a model of the same name', () => {
    // Plan test 6 without a DOM: the dialog's OK is `commitSubcircuitCreate`
    // over the real library and store action, with only `window.confirm`
    // stubbed, which is all the dialog itself supplies.
    const s = useStore.getState();
    const ids = addLabeledDivider();
    expect(s.createSubcircuit()).toBe(true);
    s.saveSubcircuitDraft('amp');
    expect(getModel('amp')!.nodeList).toBe('ResistorElm 1 2\rResistorElm 2 3');

    // A second, different model, headed for the same name.
    s.select([ids[0], ids[2]]);
    expect(s.createSubcircuit()).toBe(true);
    const deps = (answer: boolean) => ({
      taken: nameTaken,
      confirm: () => answer,
      save: (name: string) => useStore.getState().saveSubcircuitDraft(name),
    });

    expect(commitSubcircuitCreate('amp', deps(false)).outcome).toBe('cancelled');
    expect(getModel('amp')!.nodeList).toBe('ResistorElm 1 2\rResistorElm 2 3');
    expect(useStore.getState().subcircuitDraft).not.toBeNull();  // still open to retype

    expect(commitSubcircuitCreate('amp', deps(true)).outcome).toBe('saved');
    expect(getModel('amp')!.nodeList).toBe('ResistorElm 1 2');
    expect(useStore.getState().subcircuitDraft).toBeNull();
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

describe('renaming a subcircuit the open file introduced', () => {
  /** The same `.` line under the name the bug report uses. */
  const DIVIDER_LINE = MODEL_LINE.replace('. myCirc', '. divider');
  const FILE = HEADER + DIVIDER_LINE + '\nr 0 0 160 0 0 1000\n';
  /** What the file must look like once `divider` has become `amp`: one token
   *  different and not a byte more. */
  const RENAMED_FILE = FILE.replace('. divider', '. amp');

  let stored: Map<string, string>;
  beforeEach(() => {
    stored = installLocalStorage();
  });
  afterEach(() => {
    delete (globalThis as unknown as { localStorage?: unknown }).localStorage;
  });

  const load = () => useStore.getState().loadNetlist(FILE);
  const rename = (from: string, to: string) => useStore.getState().renameSubcircuit(from, to);
  const netlist = () => useStore.getState().toNetlist();
  const names = () => listModels().map((m) => m.name);

  it('rewrites the `.` line instead of leaving the file saying the old name', () => {
    load();
    expect(rename('divider', 'amp')).toBe('renamed');
    // The whole file, byte for byte, with only the name token moved: the two
    // opaque tokens and the resistor line are untouched.
    expect(netlist()).toBe(RENAMED_FILE);
    expect(netlist()).not.toContain('divider');
    expect(names()).toEqual(['amp']);
  });

  it('saving and reloading finds exactly one model, under the new name', () => {
    // The regression: the rename used to write `amp` into storage and leave the
    // `.` line saying `divider`, so reloading the saved file listed both.
    load();
    rename('divider', 'amp');
    useStore.getState().loadNetlist(netlist());
    expect(names()).toEqual(['amp']);
    // Nor did the file's model get promoted into the saved library on the way
    // past, which is where the second copy used to come from.
    expect([...stored.keys()]).toEqual([]);
  });

  it('is one undo step, and undo puts the line and the model back', () => {
    load();
    // A load clears the stacks, so the rename's own commit is the only entry.
    expect(useStore.getState().undoStack).toHaveLength(0);
    rename('divider', 'amp');
    expect(useStore.getState().undoStack).toHaveLength(1);

    useStore.getState().undo();
    expect(netlist()).toBe(FILE);
    expect(names()).toEqual(['divider']);

    useStore.getState().redo();
    expect(netlist()).toBe(RENAMED_FILE);
    expect(names()).toEqual(['amp']);
  });

  it('a second rename is its own undo step', () => {
    // Nothing but the `.` line changes, so the commit dedup has to see the
    // document lines or the second rename would share the first one's entry.
    load();
    rename('divider', 'amp');
    rename('amp', 'buffer');
    expect(useStore.getState().undoStack).toHaveLength(2);
    useStore.getState().undo();
    expect(names()).toEqual(['amp']);
    useStore.getState().undo();
    expect(names()).toEqual(['divider']);
    expect(netlist()).toBe(FILE);
  });

  it('a rename of a saved model leaves the open circuit alone', () => {
    load();
    const base = parseCompositeModelLine(MODEL_LINE)!;
    stored.set('subcircuit:saved', compositeModelLine({ ...base, name: 'saved' }));
    const before = useStore.getState().passthrough;

    expect(rename('saved', 'renamed')).toBe('renamed');
    // No document edit, so no undo entry and not a byte of the file moved.
    expect(useStore.getState().passthrough).toBe(before);
    expect(useStore.getState().undoStack).toHaveLength(0);
    expect(netlist()).toBe(FILE);
    expect(names()).toEqual(['divider', 'renamed']);
  });

  it('a rename with no circuit open still works', () => {
    const base = parseCompositeModelLine(MODEL_LINE)!;
    stored.set('subcircuit:saved', compositeModelLine({ ...base, name: 'saved' }));
    expect(rename('saved', 'renamed')).toBe('renamed');
    expect(names()).toEqual(['renamed']);
    expect(useStore.getState().passthrough).toEqual([]);
    expect(useStore.getState().undoStack).toHaveLength(0);
  });

  it('a refusal leaves the file exactly as it was', () => {
    // `taken` and `missing` are the library's answers; what matters here is
    // that neither reaches the document.
    load();
    const base = parseCompositeModelLine(MODEL_LINE)!;
    stored.set('subcircuit:amp', compositeModelLine({ ...base, name: 'amp' }));

    expect(rename('divider', 'amp')).toBe('taken');
    expect(rename('nothing', 'amp')).toBe('missing');
    expect(netlist()).toBe(FILE);
    expect(useStore.getState().undoStack).toHaveLength(0);
  });

  it('renaming the copy from the file uncovers the saved model of that name', () => {
    // The `uncovered` notice says the old name is still listed, and it still
    // is: the saved model the file's copy was shadowing. Only the file's copy
    // moved, and only the file's line was rewritten.
    load();
    const base = parseCompositeModelLine(MODEL_LINE)!;
    stored.set('subcircuit:divider', compositeModelLine({ ...base, name: 'divider', sizeX: 9 }));

    expect(rename('divider', 'amp')).toBe('uncovered');
    expect(netlist()).toBe(RENAMED_FILE);
    expect(names()).toEqual(['amp', 'divider']);
    expect(getModel('divider')!.sizeX).toBe(9);  // the saved one, where it was
    expect(getModel('amp')!.sizeX).toBe(2);  // the file's, under its new name
  });

  it('a session model with no `.` line behind it is a library-only rename', () => {
    // A model a paste introduced: the library moves it, but there is no line in
    // this document to rewrite and so nothing to undo.
    load();
    registerSessionModel({ ...parseCompositeModelLine(MODEL_LINE)!, name: 'pasted' });
    expect(rename('pasted', 'moved')).toBe('renamed');
    expect(names()).toEqual(['divider', 'moved']);
    expect(netlist()).toBe(FILE);
    expect(useStore.getState().undoStack).toHaveLength(0);
  });

  it('an undo of an unrelated edit leaves the library alone', () => {
    // The session-map sync runs on every undo, so a step that touched no `.`
    // line must be inert. Two models it could disturb: one with no line behind
    // it at all, and one whose line is still there but whose library entry the
    // user has since replaced with a save of their own, which drops the session
    // copy on purpose (`saveModel`). Re-registering the file's copy would put
    // that shadow back and change which `divider` the Manager lists.
    load();
    registerSessionModel({ ...parseCompositeModelLine(MODEL_LINE)!, name: 'pasted' });
    saveModel({ ...parseCompositeModelLine(MODEL_LINE)!, name: 'divider', sizeX: 9 });
    useStore.getState().addElement(makeElement('resistor', 0, 160, 160, 160));

    useStore.getState().undo();
    expect(names()).toEqual(['divider', 'pasted']);
    expect(getModel('divider')!.sizeX).toBe(9);
  });

  it('an escaped name rides the whole rename, undo and re-save path escaped', () => {
    // The file's `.` line names the model in escaped form, so each surface
    // speaks a different dialect: the library and the rename take unescaped
    // names, the file and the rewrite keep them escaped. An assertion on only
    // one form would miss a rename that half-applied.
    const escaped = MODEL_LINE.replace('. myCirc', '. my\\sdivider');
    const escapedFile = HEADER + escaped + '\nr 0 0 160 0 0 1000\n';
    useStore.getState().loadNetlist(escapedFile);
    expect(names()).toEqual(['my divider']);

    expect(rename('my divider', 'my amp')).toBe('renamed');
    const saved = netlist();
    expect(saved).toBe(escapedFile.replace('. my\\sdivider', '. my\\samp'));
    expect(saved).toContain('. my\\samp ');
    expect(saved).not.toContain('my\\sdivider');
    // The rewritten line still parses to the unescaped new name.
    const line = saved.split('\n').find((l) => l.trim().startsWith('.'))!;
    expect(parseCompositeModelLine(line.trim())!.name).toBe('my amp');
    expect(names()).toEqual(['my amp']);

    useStore.getState().undo();
    expect(netlist()).toBe(escapedFile);
    expect(names()).toEqual(['my divider']);
  });

  it('a file carrying the same model twice rewrites both `.` lines', () => {
    // The two lines parse to the same model, so the library lists the name
    // once; a rename must move both lines or the reload would revive the old
    // name from the untouched one.
    const doubled = HEADER + DIVIDER_LINE + '\n' + DIVIDER_LINE + '\nr 0 0 160 0 0 1000\n';
    useStore.getState().loadNetlist(doubled);
    expect(names()).toEqual(['divider']);

    expect(rename('divider', 'amp')).toBe('renamed');
    const saved = netlist();
    expect(saved).toBe(doubled.replaceAll('. divider', '. amp'));
    expect(saved).not.toContain('. divider');
    expect(saved.split('\n').filter((l) => l.trim().startsWith('.')).length).toBe(2);
    expect(names()).toEqual(['amp']);
  });

  it('a rename after the file model was promoted into storage still reaches the `.` line', () => {
    // The confirm-on-taken path of Create Subcircuit saves the file's own
    // model under its name, which drops the session copy. Renaming it then
    // used to take the saved branch, skip the write-back and leave the file
    // saying the old name: one rename, two models after the next load. The
    // body match is what reaches the line now, because the promoted model is
    // that line's own body.
    load();
    saveModel(parseCompositeModelLine(DIVIDER_LINE)!);
    expect([...stored.keys()]).toEqual(['subcircuit:divider']);

    expect(rename('divider', 'amp')).toBe('renamed');
    expect(netlist()).toBe(RENAMED_FILE);
    expect(names()).toEqual(['amp']);
    expect([...stored.keys()]).toEqual(['subcircuit:amp']);
  });
});

describe('renaming a subcircuit a 410 element names', () => {
  /** The `. divider` line plus a 410 naming it, the shape whose next save used
   *  to break: the rename rewrote the `.` line but left the 410 saying the old
   *  name, so the saved file had a `410 ... divider` with no `.` definition
   *  left behind it. */
  const DIVIDER_LINE = MODEL_LINE.replace('. myCirc', '. divider');
  const FILE = HEADER + DIVIDER_LINE + '\n410 0 0 96 0 1 divider\n';
  /** The same file once `divider` has become `amp`: the name token of each of
   *  the two lines, and not a byte more. */
  const RENAMED_FILE =
    HEADER + DIVIDER_LINE.replace('. divider', '. amp') + '\n410 0 0 96 0 1 amp\n';
  /** A 410 naming a model only storage holds: no `.` line defines it, exactly
   *  the shape a placed part saves when its model never rode the file. */
  const STORED_ONLY_FILE = HEADER + '410 0 0 96 0 1 saved\n';

  let stored: Map<string, string>;
  beforeEach(() => {
    stored = installLocalStorage();
  });
  afterEach(() => {
    delete (globalThis as unknown as { localStorage?: unknown }).localStorage;
  });

  const load = () => useStore.getState().loadNetlist(FILE);
  const rename = (from: string, to: string) => useStore.getState().renameSubcircuit(from, to);
  const netlist = () => useStore.getState().toNetlist();
  const names = () => listModels().map((m) => m.name);
  const composite = () => useStore.getState().elements[0];

  it('rewrites the 410 text with the `.` line, and the saved file keeps working', () => {
    load();
    expect(rename('divider', 'amp')).toBe('renamed');
    // Both name tokens moved and nothing else, so the saved file still pairs
    // a `.` line with a 410 that resolves.
    expect(netlist()).toBe(RENAMED_FILE);
    expect(netlist()).not.toContain('divider');
    // The element kept its geometry and gained the new name; its
    // engine payload is name-independent, so the revision-bump rebuild reads
    // it as-is instead of dropping the part to its fallback body.
    expect(composite()).toMatchObject({
      x1: 0,
      y1: 0,
      x2: 96,
      y2: 0,
      text: 'amp',
      model: {
        model: 'ResistorElm 1 2\rResistorElm 2 3',
        external: [1, 3],
        dumps: ['0_1000', '0_1000'],
      },
    });
    // One undo step, exactly like a `.`-only rename, and it puts the element
    // text and the `.` line back together.
    useStore.getState().undo();
    expect(netlist()).toBe(FILE);
    expect(composite().text).toBe('divider');
    useStore.getState().redo();
    expect(netlist()).toBe(RENAMED_FILE);
    // The reload finds one model, under the new name, and the 410 resolves it.
    useStore.getState().loadNetlist(netlist());
    expect(names()).toEqual(['amp']);
    expect(useStore.getState().elements[0].text).toBe('amp');
    expect(useStore.getState().elements[0].model).toEqual({
      model: 'ResistorElm 1 2\rResistorElm 2 3',
      external: [1, 3],
      dumps: ['0_1000', '0_1000'],
    });
  });

  it("in the uncovered shape the 410 follows the file's model, not the stored one", () => {
    load();
    const base = parseCompositeModelLine(MODEL_LINE)!;
    stored.set('subcircuit:divider', compositeModelLine({ ...base, name: 'divider', sizeX: 9 }));

    expect(rename('divider', 'amp')).toBe('uncovered');
    // The file's copy moved, the stored model of that name stayed behind, and
    // the 410 now names the moved copy.
    expect(netlist()).toBe(RENAMED_FILE);
    expect(names()).toEqual(['amp', 'divider']);
    expect(composite().text).toBe('amp');
    expect(composite().model).toEqual({
      model: 'ResistorElm 1 2\rResistorElm 2 3',
      external: [1, 3],
      dumps: ['0_1000', '0_1000'],
    });
    expect(getModel('divider')!.sizeX).toBe(9);  // the stored one, where it was
    expect(getModel('amp')!.sizeX).toBe(2);  // the file's, under its new name
    // The saved file still resolves on reload, the stored `divider` untouched.
    useStore.getState().loadNetlist(netlist());
    expect(names()).toEqual(['amp', 'divider']);
    expect(useStore.getState().elements[0].text).toBe('amp');
  });

  it('a 410 naming a name nothing resolves is left alone', () => {
    const ghost = HEADER + DIVIDER_LINE + '\n410 0 0 96 0 1 divider\n410 0 0 96 0 1 nomodel\n';
    useStore.getState().loadNetlist(ghost);
    expect(rename('divider', 'amp')).toBe('renamed');
    const saved = netlist();
    expect(saved).toBe(
      ghost
        .replace('. divider', '. amp')
        .replace('410 0 0 96 0 1 divider', '410 0 0 96 0 1 amp'),
    );
    expect(saved).toContain('410 0 0 96 0 1 nomodel');
    const [renamed, ghostly] = useStore.getState().elements;
    expect(renamed.text).toBe('amp');
    expect(ghostly.text).toBe('nomodel');
    expect(ghostly.model).toBeUndefined();
  });

  it('a rename that matches no `.` line and no 410 stays a library-only no-op', () => {
    load();
    const base = parseCompositeModelLine(MODEL_LINE)!;
    stored.set('subcircuit:saved', compositeModelLine({ ...base, name: 'saved' }));

    expect(rename('saved', 'renamed')).toBe('renamed');
    // The 410 says `divider`, not `saved`, so the document did not move: no
    // undo entry and not a byte of the file changed.
    expect(useStore.getState().undoStack).toHaveLength(0);
    expect(netlist()).toBe(FILE);
    expect(composite().text).toBe('divider');
  });

  it('a rename reaches a 410 backed only by storage', () => {
    const base = parseCompositeModelLine(MODEL_LINE)!;
    stored.set('subcircuit:saved', compositeModelLine({ ...base, name: 'saved' }));
    useStore.getState().loadNetlist(STORED_ONLY_FILE);
    // The 410 resolved against storage at load, the way placement resolves a
    // part whose model never rode the file.
    expect(useStore.getState().elements[0].model).not.toBeUndefined();

    expect(rename('saved', 'renamed')).toBe('renamed');
    expect(netlist()).toBe(HEADER + '410 0 0 96 0 1 renamed\n');
    expect(useStore.getState().elements[0].text).toBe('renamed');
    expect(names()).toEqual(['renamed']);
    // The saved file resolves the moved name on reload.
    useStore.getState().loadNetlist(netlist());
    expect(names()).toEqual(['renamed']);
    expect(useStore.getState().elements[0].text).toBe('renamed');
    expect(useStore.getState().elements[0].model).toEqual({
      model: 'ResistorElm 1 2\rResistorElm 2 3',
      external: [1, 3],
      dumps: ['0_1000', '0_1000'],
    });
  });

  it('undo of a storage-only rename reverts the element text but not the library', () => {
    // The stored branch of `renameModel` is not transactional: it writes the
    // new key and drops the old one, and undo only re-syncs the session map
    // from `.` lines. The element text reverts through the snapshot, but the
    // library stays renamed, so a reload of the reverted file finds the old
    // name with nothing to resolve it.
    const base = parseCompositeModelLine(MODEL_LINE)!;
    stored.set('subcircuit:saved', compositeModelLine({ ...base, name: 'saved' }));
    useStore.getState().loadNetlist(STORED_ONLY_FILE);
    expect(rename('saved', 'renamed')).toBe('renamed');
    expect(useStore.getState().elements[0].text).toBe('renamed');

    useStore.getState().undo();
    expect(composite().text).toBe('saved');
    expect(netlist()).toBe(STORED_ONLY_FILE);
    expect(names()).toEqual(['renamed']);
    expect(getModel('saved')).toBeUndefined();
    useStore.getState().loadNetlist(STORED_ONLY_FILE);
    expect(useStore.getState().elements[0].text).toBe('saved');
    expect(useStore.getState().elements[0].model).toBeUndefined();
  });

  it('a rename reaches a 410 backed only by a pasted session model', () => {
    // A paste introduced the model without a `.` line: it lives only in the
    // session map, so the rename has no `.` line to rewrite and the 410's
    // text is the only document surface that can follow it.
    registerSessionModel({ ...parseCompositeModelLine(MODEL_LINE)!, name: 'pasted' });
    const id = useStore.getState().addElement(makeElement('customComposite', 0, 0, 96, 0));
    useStore.getState().setText(id, 'pasted');
    expect(useStore.getState().elements[0].model).not.toBeUndefined();

    expect(rename('pasted', 'moved')).toBe('renamed');
    const saved = netlist();
    expect(saved).toContain('410 0 0 96 0 1 moved');
    expect(saved).not.toContain('pasted');
    expect(useStore.getState().elements[0].text).toBe('moved');
    expect(useStore.getState().elements[0].model).toEqual({
      model: 'ResistorElm 1 2\rResistorElm 2 3',
      external: [1, 3],
      dumps: ['0_1000', '0_1000'],
    });
    expect(names()).toEqual(['moved']);
  });

  it('an escaped 410 name rides the rename to the escaped new name', () => {
    // The `.` line and the 410 both carry the escaped form of the model name,
    // like the escaped-name `.`-line test in the rename suite, so each surface
    // speaks its own dialect: the file and the rewrite stay escaped, the
    // library and the rename take the unescaped name.
    const escaped = MODEL_LINE.replace('. myCirc', '. my\\sdivider');
    const escapedFile = HEADER + escaped + '\n410 0 0 96 0 1 my\\sdivider\n';
    useStore.getState().loadNetlist(escapedFile);
    expect(names()).toEqual(['my divider']);

    expect(rename('my divider', 'my amp')).toBe('renamed');
    const saved = netlist();
    expect(saved).toBe(
      escapedFile
        .replace('. my\\sdivider', '. my\\samp')
        .replace('410 0 0 96 0 1 my\\sdivider', '410 0 0 96 0 1 my\\samp'),
    );
    expect(saved).not.toContain('my\\sdivider');
    // Both lines still parse to the unescaped new name.
    const line = saved.split('\n').find((l) => l.trim().startsWith('.'))!;
    expect(parseCompositeModelLine(line.trim())!.name).toBe('my amp');
    expect(useStore.getState().elements[0].text).toBe('my amp');
    expect(names()).toEqual(['my amp']);
    // A reload of the escaped file resolves the escaped name.
    useStore.getState().loadNetlist(saved);
    expect(names()).toEqual(['my amp']);
    expect(useStore.getState().elements[0].text).toBe('my amp');
    expect(useStore.getState().elements[0].model).toEqual({
      model: 'ResistorElm 1 2\rResistorElm 2 3',
      external: [1, 3],
      dumps: ['0_1000', '0_1000'],
    });
  });
});

describe('placing a custom composite 410', () => {
  it('resolves a session model the fresh part names', () => {
    // The fresh part carries the def's default model name, so a library entry
    // of that name is what the placement resolves (upstream's lastModelName
    // or the builtin "default" stub).
    registerSessionModel({ ...parseCompositeModelLine(MODEL_LINE)!, name: 'default' });
    const el = makeElement('customComposite', 0, 0, 96, 0);
    expect(el.kind).toBe('customComposite');
    expect(el.text).toBe('default');
    expect(el.model).toEqual({
      model: 'ResistorElm 1 2\rResistorElm 2 3',
      external: [1, 3],
      dumps: ['0_1000', '0_1000'],
    });
  });

  it('a fresh part whose name no library entry holds stays on the fallback', () => {
    const el = makeElement('customComposite', 0, 0, 96, 0);
    expect(el.text).toBe('default');
    expect(el.model).toBeUndefined();
  });

  it('the toolbox path resolves the same way', () => {
    registerSessionModel({ ...parseCompositeModelLine(MODEL_LINE)!, name: 'default' });
    const el = makeToolElement('customComposite', 0, 0, 96, 0);
    expect(el.text).toBe('default');
    expect(el.model).toEqual({
      model: 'ResistorElm 1 2\rResistorElm 2 3',
      external: [1, 3],
      dumps: ['0_1000', '0_1000'],
    });
  });

  it('a stored model resolves at placement through the browser storage path', () => {
    // The placement resolution reads the merged library via `getModel`, whose
    // storage half is the browser localStorage. Point the default storage at a
    // fake for this test, so a model that only storage holds resolves the same
    // way it would in a real browser session.
    const storage = fakeStorage();
    saveModel({ ...parseCompositeModelLine(MODEL_LINE)!, name: 'default' }, storage);
    const browserStorage: Storage = {
      get length() {
        return storage.listSubcircuitKeys().length;
      },
      key: (i) => storage.listSubcircuitKeys()[i] ?? null,
      getItem: (k) => storage.getItem(k),
      setItem: (k, v) => storage.setItem(k, v),
      removeItem: (k) => storage.removeItem(k),
      clear: () => {},
    };
    const prev = (globalThis as { localStorage?: Storage }).localStorage;
    (globalThis as { localStorage?: Storage }).localStorage = browserStorage;
    try {
      const el = makeElement('customComposite', 0, 0, 96, 0);
      expect(el.model).toEqual({
        model: 'ResistorElm 1 2\rResistorElm 2 3',
        external: [1, 3],
        dumps: ['0_1000', '0_1000'],
      });
    } finally {
      (globalThis as { localStorage?: Storage }).localStorage = prev;
    }
  });

  it('renaming a placed part re-resolves the payload the way placement does', () => {
    registerSessionModel(parseCompositeModelLine(MODEL_LINE)!);
    const id = useStore.getState().addElement(makeElement('customComposite', 0, 0, 96, 0));
    // The fresh part carries the default name, so it was placed unresolved;
    // a Model Name edit to a library name must pick the model up.
    useStore.getState().setText(id, 'myCirc');
    const after = useStore.getState().elements.find((e) => e.id === id);
    expect(after?.text).toBe('myCirc');
    expect(after?.model).toEqual({
      model: 'ResistorElm 1 2\rResistorElm 2 3',
      external: [1, 3],
      dumps: ['0_1000', '0_1000'],
    });
  });

  it('renaming a part to an unresolvable name clears the payload', () => {
    registerSessionModel({ ...parseCompositeModelLine(MODEL_LINE)!, name: 'default' });
    const id = useStore.getState().addElement(makeElement('customComposite', 0, 0, 96, 0));
    expect(useStore.getState().elements.find((e) => e.id === id)?.model).not.toBeUndefined();
    useStore.getState().setText(id, 'nope');
    const after = useStore.getState().elements.find((e) => e.id === id);
    expect(after?.text).toBe('nope');
    expect(after?.model).toBeUndefined();
  });
});

describe('denied-storage browsers', () => {
  // getModel and listModels run with no injected storage during netlist
  // resolution, so the default argument itself must survive a throwing
  // localStorage access (site data blocked).
  let restore = () => {};
  beforeEach(() => {
    restore = denyGlobalStorage();
  });
  afterEach(() => restore());

  it('getModel and listModels degrade to the session map when storage is denied', () => {
    const model = { ...parseCompositeModelLine(MODEL_LINE)!, name: 'fromFile' };
    registerSessionModel(model);
    expect(listModels()).toEqual([model]);
    expect(getModel('fromFile')).toEqual(model);
    expect(getModel('stored')).toBeUndefined();
    expect(nameTaken('fromFile')).toBe(true);
  });

  it('saveModel and removeModel are quiet when the storage access itself throws', () => {
    const model = { ...parseCompositeModelLine(MODEL_LINE)! };
    expect(() => saveModel(model)).not.toThrow();
    // The model still lands in the session map.
    expect(getModel(model.name)).toEqual(model);
    expect(() => removeModel(model.name)).not.toThrow();
  });
});
