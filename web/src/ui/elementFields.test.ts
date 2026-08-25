import { describe, expect, it, beforeEach } from 'vitest';
import { defFor } from '../model/registry';
import { clearUserModels, putUserModel } from '../model/deviceModels';
import { SRAM_HEX_DISPLAY } from '../model/registry/elements/sram';
import { VOLTAGE_TIME_SPEC } from '../model/registry/flags';
import { fieldLabel, type CircuitElement, type FieldDef } from '../model/types';
import {
  applyFieldChange,
  changeArmsBaseline,
  clampInteger,
  commitBinaryFile,
  commitContentsField,
  compositeEditModelState,
  deviceModelButtons,
  draftForToken,
  fieldRows,
  fieldValue,
  visibleFields,
  type DraftCell,
  type FieldEditActions,
} from './elementFields';

function elm(patch: Partial<CircuitElement> & { kind: string }): CircuitElement {
  return {
    id: 1,
    x1: 0,
    y1: 0,
    x2: 160,
    y2: 0,
    flags: 0,
    params: {},
    ...patch,
  };
}

/** Records which store action a field change reached, and with what, so the
 *  dispatch can be asserted without a store or a DOM. */
function recorder() {
  const calls: Array<[string, ...unknown[]]> = [];
  const actions: FieldEditActions = {
    setParam: (id, name, value) => calls.push(['setParam', id, name, value]),
    setText: (id, text) => calls.push(['setText', id, text]),
    setKeyShortcut: (id, key) => calls.push(['setKeyShortcut', id, key]),
    setModelName: (id, name) => calls.push(['setModelName', id, name]),
    updateElement: (id, patch) => calls.push(['updateElement', id, patch]),
  };
  return { calls, actions };
}

/** The def's field by name, so a test names the row it means rather than
 *  pinning the def's field order. */
function field(kind: string, name: string): FieldDef {
  const f = defFor(kind)?.fields?.find((x) => x.name === name);
  if (!f) throw new Error(`no ${name} field on ${kind}`);
  return f;
}

describe('deviceModelButtons', () => {
  beforeEach(() => clearUserModels());

  const none = { createSimple: false, createAdvanced: false, create: false, edit: false };

  it('gives the diode family both create buttons and nothing else', () => {
    expect(deviceModelButtons(elm({ kind: 'diode' }))).toEqual({
      ...none,
      createSimple: true,
      createAdvanced: true,
    });
    expect(deviceModelButtons(elm({ kind: 'zener' })).createSimple).toBe(true);
    expect(deviceModelButtons(elm({ kind: 'varactor' })).createAdvanced).toBe(true);
    expect(deviceModelButtons(elm({ kind: 'led' })).createSimple).toBe(true);
  });

  it('gives the transistor, mosfet and jfet one generic create button', () => {
    expect(deviceModelButtons(elm({ kind: 'transistor' }))).toEqual({ ...none, create: true });
    expect(deviceModelButtons(elm({ kind: 'mosfet' }))).toEqual({ ...none, create: true });
    expect(deviceModelButtons(elm({ kind: 'jfet' }))).toEqual({ ...none, create: true });
  });

  it('shows Edit only when the name resolves to a writable model, never a built-in', () => {
    // A value-form diode and a built-in name both leave Edit hidden.
    expect(deviceModelButtons(elm({ kind: 'diode' })).edit).toBe(false);
    expect(deviceModelButtons(elm({ kind: 'diode', modelName: '1N4148' })).edit).toBe(false);
    expect(deviceModelButtons(elm({ kind: 'transistor', modelName: 'default' })).edit).toBe(false);
    // An unknown name resolves to nothing, so Edit stays hidden.
    expect(deviceModelButtons(elm({ kind: 'diode', modelName: 'not-a-model' })).edit).toBe(false);
    // A writable entry (created or file-loaded) makes Edit appear.
    putUserModel('diode', { name: 'mydiode', builtIn: false, saturationCurrent: 1e-9, seriesResistance: 0, emissionCoefficient: 2, breakdownVoltage: 0 });
    expect(deviceModelButtons(elm({ kind: 'diode', modelName: 'mydiode' })).edit).toBe(true);
  });

  it('hides every button for an element that cannot name a model', () => {
    expect(deviceModelButtons(elm({ kind: 'resistor' }))).toEqual(none);
  });
});

describe('compositeEditModelState (the drill-in Edit Model button)', () => {
  it('shows only on a custom composite selection', () => {
    // The button row appears only for a 410 element.
    expect(compositeEditModelState(elm({ kind: 'resistor' }))).toBe('none');
    expect(compositeEditModelState(elm({ kind: 'diode' }))).toBe('none');
    expect(compositeEditModelState(elm({ kind: 'customComposite', text: 'amp' }))).toBe(
      'editable',
    );
  });

  it('the default model is not editable and alerts on click', () => {
    // A fresh part carries the default name, and clicking alerts upstream's
    // refusal instead of entering (CustomCompositeElm.java:253-255).
    expect(compositeEditModelState(elm({ kind: 'customComposite' }))).toBe('default');
    expect(compositeEditModelState(elm({ kind: 'customComposite', text: 'default' }))).toBe(
      'default',
    );
  });

  it('a named model opens the drill-in', () => {
    expect(compositeEditModelState(elm({ kind: 'customComposite', text: 'myCirc' }))).toBe(
      'editable',
    );
  });
});

describe('field rows', () => {
  it('gives one row per def field, in def order, with the element value', () => {
    const e = elm({ kind: 'resistor', params: { resistance: 4700 } });
    const rows = fieldRows(e);
    expect(rows.map((r) => r.field.name)).toEqual(
      defFor('resistor')!.fields!.map((f) => f.name),
    );
    expect(rows[0]).toMatchObject({ value: 4700 });
  });

  it('is empty for a def with no fields and for an unknown kind', () => {
    expect(fieldRows(elm({ kind: 'ohmmeter' }))).toEqual([]);
    expect(fieldRows(elm({ kind: 'not-a-real-kind' }))).toEqual([]);
  });

  it('reads a flag field as a checkbox 0 or 1, not as a params entry', () => {
    const circle = field('voltage', 'circleSymbol');
    const off = elm({ kind: 'voltage' });
    const on = elm({ kind: 'voltage', flags: circle.flag! });
    expect(fieldValue(off, circle)).toBe(0);
    expect(fieldValue(on, circle)).toBe(1);
    const row = fieldRows(on).find((r) => r.field.name === 'circleSymbol');
    expect(row?.value).toBe(1);
  });

  it('drops a field whose visible-predicate the element fails', () => {
    // The realistic op-amp hides the Slew Rate and Output Current Limit rows
    // on the 324v2, whose netlist takes no such tuning upstream
    // (OpAmpRealElm.java:288-289); the 741 and the old 324 keep them.
    const opampRows = (modelType: number) =>
      fieldRows(elm({ kind: 'opampReal', params: { modelType } })).map(
        (r) => r.field.name,
      );
    expect(opampRows(0)).toContain('slewRate');
    expect(opampRows(0)).toContain('currentLimit');
    expect(opampRows(1)).toContain('slewRate');
    expect(opampRows(2)).not.toContain('slewRate');
    expect(opampRows(2)).not.toContain('currentLimit');
  });

  it('reads the text, key shortcut and model targets off the element', () => {
    const e = elm({ kind: 'resistor', text: 'R load', keyShortcut: 'a', modelName: 'default' });
    expect(fieldValue(e, { name: 'x', label: 'X', target: 'text' })).toBe('R load');
    expect(fieldValue(e, { name: 'x', label: 'X', target: 'keyShortcut' })).toBe('a');
    expect(fieldValue(e, { name: 'x', label: 'X', target: 'modelName' })).toBe('default');
    // A missing value reads as the empty string, so the control stays
    // controlled instead of flipping to uncontrolled on a fresh element.
    expect(fieldValue(elm({ kind: 'resistor' }), { name: 'x', label: 'X', target: 'text' })).toBe('');
  });

  it('reads a missing param as 0 rather than undefined', () => {
    expect(fieldValue(elm({ kind: 'resistor' }), field('resistor', 'resistance'))).toBe(0);
  });
});

describe('field change dispatch', () => {
  it('sends a plain value to setParam', () => {
    const { calls, actions } = recorder();
    const e = elm({ kind: 'resistor', params: { resistance: 1000 } });
    applyFieldChange(e, field('resistor', 'resistance'), 4700, actions);
    expect(calls).toEqual([['setParam', 1, 'resistance', 4700]]);
  });

  it('sends the text, key shortcut and model targets to their own actions', () => {
    const { calls, actions } = recorder();
    const e = elm({ kind: 'resistor' });
    applyFieldChange(e, { name: 'x', label: 'X', target: 'text' }, 'R load', actions);
    applyFieldChange(e, { name: 'x', label: 'X', target: 'keyShortcut' }, 'a', actions);
    applyFieldChange(e, { name: 'x', label: 'X', target: 'modelName' }, 'default', actions);
    expect(calls).toEqual([
      ['setText', 1, 'R load'],
      ['setKeyShortcut', 1, 'a'],
      ['setModelName', 1, 'default'],
    ]);
  });

  it('routes a flag through updateElement, since a flag can change the stamp', () => {
    const { calls, actions } = recorder();
    const circle = field('voltage', 'circleSymbol');
    // Setting the bit keeps the other flags the element already carries.
    applyFieldChange(elm({ kind: 'voltage', flags: 1 }), circle, 1, actions);
    // Clearing it clears only that bit.
    applyFieldChange(elm({ kind: 'voltage', flags: 1 | circle.flag! }), circle, 0, actions);
    expect(calls).toEqual([
      ['updateElement', 1, { flags: 1 | circle.flag! }],
      ['updateElement', 1, { flags: 1 }],
    ]);
  });

  it('restores the duty cycle each waveform family expects when leaving or entering pulse', () => {
    const waveform = field('voltage', 'waveform');
    const into = recorder();
    applyFieldChange(elm({ kind: 'voltage', params: { waveform: 1 } }), waveform, 5, into.actions);
    expect(into.calls).toEqual([
      ['setParam', 1, 'dutyCycle', 1 / (2 * Math.PI)],
      ['setParam', 1, 'waveform', 5],
    ]);

    const outOf = recorder();
    applyFieldChange(elm({ kind: 'voltage', params: { waveform: 5 } }), waveform, 2, outOf.actions);
    expect(outOf.calls).toEqual([
      ['setParam', 1, 'dutyCycle', 0.5],
      ['setParam', 1, 'waveform', 2],
    ]);

    // Staying inside the family leaves the duty alone, so a duty the user
    // edited survives a re-pick of the same waveform.
    const same = recorder();
    applyFieldChange(elm({ kind: 'voltage', params: { waveform: 5 } }), waveform, 5, same.actions);
    expect(same.calls).toEqual([['setParam', 1, 'waveform', 5]]);

    // The rail shares the rule (RailElm extends VoltageElm and inherits the
    // edit table), so leaving or entering pulse on a rail resets it too.
    const railInto = recorder();
    applyFieldChange(elm({ kind: 'rail', params: { waveform: 1 } }), field('rail', 'waveform'), 5, railInto.actions);
    expect(railInto.calls).toEqual([
      ['setParam', 1, 'dutyCycle', 1 / (2 * Math.PI)],
      ['setParam', 1, 'waveform', 5],
    ]);
    const railOut = recorder();
    applyFieldChange(elm({ kind: 'rail', params: { waveform: 5 } }), field('rail', 'waveform'), 2, railOut.actions);
    expect(railOut.calls).toEqual([
      ['setParam', 1, 'dutyCycle', 0.5],
      ['setParam', 1, 'waveform', 2],
    ]);
  });
});

describe('SPDT group number row', () => {
  it('sits after the shortcut row as an integer 0..100', () => {
    const def = defFor('switch2')!;
    expect(def.fields!.map((f) => f.name)).toEqual(['keyShortcut', 'link']);
    expect(def.fields![1]).toMatchObject({
      name: 'link',
      label: 'Group Number (for linking)',
      min: 0,
      max: 100,
      integer: true,
    });
  });

  it('shows the stored link and routes an edit through the numeric param path', () => {
    const e = elm({ kind: 'switch2', params: { position: 0, throwCount: 2, link: 3 } });
    const row = fieldRows(e).find((r) => r.field.name === 'link');
    expect(row?.value).toBe(3);

    const { calls, actions } = recorder();
    applyFieldChange(e, field('switch2', 'link'), 7, actions);
    expect(calls).toEqual([['setParam', 1, 'link', 7]]);
  });
});

describe('clampInteger', () => {
  it('rounds to a whole number', () => {
    expect(clampInteger(3.4, { min: 1, max: 8 })).toBe(3);
    expect(clampInteger(3.6, { min: 1, max: 8 })).toBe(4);
    expect(clampInteger(-2.5, {})).toBe(-2);
  });

  it('holds the value inside the field range', () => {
    expect(clampInteger(0, { min: 1, max: 8 })).toBe(1);
    expect(clampInteger(99, { min: 1, max: 8 })).toBe(8);
    expect(clampInteger(5, { min: 1, max: 8 })).toBe(5);
  });

  it('leaves an open-ended field alone', () => {
    expect(clampInteger(1e6, {})).toBe(1e6);
    expect(clampInteger(4, { min: 2 })).toBe(4);
    expect(clampInteger(1, { min: 2 })).toBe(2);
  });
});

describe('whole-number fields', () => {
  // The controlled sources and every bit-width chip count things; a slider
  // would post 3.47 inputs, which the engine then truncates behind the
  // shown value. The def has to say so, and this is the guard that it does.
  const COUNTING_FIELDS: [kind: string, field: string][] = [
    ['vccs', 'inputCount'],
    ['vcvs', 'inputCount'],
    ['ccvs', 'inputCount'],
    ['cccs', 'inputCount'],
    ['andGate', 'inputCount'],
    ['counter', 'bits'],
    ['adc', 'bits'],
    ['dac', 'bits'],
    ['rom', 'addressBits'],
    ['sram', 'dataBits'],
    ['ledArray', 'sizeX'],
    ['multiplexer', 'bits'],
  ];

  it('are marked integer, so they render as a spinner and not a slider', () => {
    for (const [kind, name] of COUNTING_FIELDS) {
      const f = defFor(kind)?.fields?.find((x) => x.name === name);
      expect(f, `${kind}.${name}`).toBeDefined();
      expect(f?.integer, `${kind}.${name}`).toBe(true);
    }
  });

  it('leaves the genuinely continuous bounded fields as sliders', () => {
    for (const [kind, name] of [
      ['potentiometer', 'position'],
      ['voltage', 'dutyCycle'],
      ['transformer', 'couplingCoef'],
    ] as [string, string][]) {
      const f = defFor(kind)?.fields?.find((x) => x.name === name);
      expect(f?.integer, `${kind}.${name}`).toBeUndefined();
    }
  });
});

describe('controlled-source defaults', () => {
  // A fresh source with no expression evaluates an empty string, so the part
  // does nothing at all when dropped (VCCSElm.java:45, CCVSElm.java:39).
  it('gives every controlled source upstream\'s constructor expression', () => {
    expect(defFor('vccs')?.defaultText).toBe('.1*(a-b)');
    expect(defFor('vcvs')?.defaultText).toBe('.1*(a-b)');
    expect(defFor('ccvs')?.defaultText).toBe('2*a');
    expect(defFor('cccs')?.defaultText).toBe('2*a');
  });
});

describe('contents field rows', () => {
  // The memory editor joins the SRAM and ROM defs after the two bit widths,
  // the upstream dialog's row order (SRAMElm.java:127-144).
  it('sits between the bit widths and the rest of the rows on both defs', () => {
    for (const kind of ['sram', 'rom']) {
      const def = defFor(kind)!;
      const names = def.fields!.map((f) => f.name);
      expect(names.indexOf('contents')).toBe(2);
      expect(def.fields![2]).toMatchObject({
        name: 'contents',
        label: 'Contents',
        type: 'contents',
      });
    }
  });

  it('carries the rendered pair text in the current radix, the textarea seed', () => {
    const e = elm({
      kind: 'sram',
      params: { dataBits: 8, addr0: 10, val0: 255, addr1: 12, val1: 16 },
    });
    const row = fieldRows(e).find((r) => r.field.name === 'contents');
    expect(row?.value).toBe('10: 255\n12: 16\n');

    const hex = elm({
      kind: 'sram',
      flags: SRAM_HEX_DISPLAY,
      params: { dataBits: 8, addr0: 10, val0: 255, addr1: 12, val1: 16 },
    });
    expect(fieldRows(hex).find((r) => r.field.name === 'contents')?.value).toBe('A: FF\nC: 10\n');
  });

  it('derives the value per render, so a hex toggle re-radices without re-parsing', () => {
    // The same stored numbers give two texts: the flag only changes the
    // rendering, never the pairs underneath.
    const params = { dataBits: 8, addr0: 10, val0: 255 };
    const plain = elm({ kind: 'sram', params });
    const hex = elm({ kind: 'sram', flags: SRAM_HEX_DISPLAY, params });
    expect(fieldRows(plain).find((r) => r.field.name === 'contents')?.value).toBe('10: 255\n');
    expect(fieldRows(hex).find((r) => r.field.name === 'contents')?.value).toBe('A: FF\n');
  });
});

describe('contents field commit', () => {
  it('committing valid text calls setMemoryContents with the parsed pairs', () => {
    const e = elm({ kind: 'sram', params: { dataBits: 4 } });
    const alerts: string[] = [];
    const calls: Array<[number, [number, number][]]> = [];
    const ok = commitContentsField(e, '0: 1 2\n5: 9\n', (m) => alerts.push(m), {
      setMemoryContents: (id, pairs) => calls.push([id, pairs]),
    });
    expect(ok).toBe(true);
    expect(alerts).toEqual([]);
    expect(calls).toEqual([
      [1, [[0, 1], [1, 2], [5, 9]]],
    ]);
  });

  it('committing invalid text alerts and does not call the store', () => {
    const e = elm({ kind: 'sram', params: { dataBits: 4 } });
    const alerts: string[] = [];
    const calls: unknown[] = [];
    const ok = commitContentsField(e, '0: 1 xyz\n', (m) => alerts.push(m), {
      setMemoryContents: (id, pairs) => calls.push([id, pairs]),
    });
    expect(ok).toBe(false);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain('Line 1');
    expect(calls).toEqual([]);
  });

  it('parses bare hex only when hex display is on', () => {
    const hex = elm({ kind: 'sram', params: { dataBits: 8 }, flags: SRAM_HEX_DISPLAY });
    const alerts: string[] = [];
    const calls: Array<[number, [number, number][]]> = [];
    commitContentsField(hex, '0: FF\n', (m) => alerts.push(m), {
      setMemoryContents: (id, pairs) => calls.push([id, pairs]),
    });
    expect(alerts).toEqual([]);
    expect(calls).toEqual([[1, [[0, 255]]]]);

    const plain = elm({ kind: 'sram', params: { dataBits: 8 } });
    const plainAlerts: string[] = [];
    const plainCalls: unknown[] = [];
    commitContentsField(plain, '0: FF\n', (m) => plainAlerts.push(m), {
      setMemoryContents: (id, pairs) => plainCalls.push([id, pairs]),
    });
    expect(plainAlerts).toHaveLength(1);
    expect(plainCalls).toEqual([]);
  });
});

describe('binary contents file load', () => {
  // Upstream's SRAM edit dialog carries a Load Contents From File row after
  // the Hex Display checkbox (SRAMElm.java:154); the ROM has no such row.
  it('the sram def opts in between hexDisplay and reloadOnReset, the rom does not', () => {
    const names = defFor('sram')!.fields!.map((f) => f.name);
    expect(names.indexOf('loadFile')).toBe(names.indexOf('hexDisplay') + 1);
    const f = field('sram', 'loadFile');
    expect(f.type).toBe('file');
    expect(f.fileLoad).toBe('binary');
    expect(defFor('rom')!.fields!.some((x) => x.type === 'file')).toBe(false);
  });

  it('committing loaded bytes calls setMemoryContents with the decoded pairs', () => {
    const e = elm({ kind: 'sram', params: { dataBits: 8 }, flags: SRAM_HEX_DISPLAY });
    const alerts: string[] = [];
    const calls: Array<[number, [number, number][]]> = [];
    const ok = commitBinaryFile(e, [0xde, 0xad], (m) => alerts.push(m), {
      setMemoryContents: (id, pairs) => calls.push([id, pairs]),
    });
    expect(ok).toBe(true);
    expect(alerts).toEqual([]);
    expect(calls).toEqual([[1, [[0, 222], [1, 173]]]]);
  });

  it('loaded bytes mask to the configured data width', () => {
    // A byte cannot fit a narrower width; folding to the low bits matches
    // what the engine reads out of upstream's raw stored ints, and lets any
    // file load at any width instead of refusing wholesale.
    const e = elm({ kind: 'sram', params: { dataBits: 4 } });
    const alerts: string[] = [];
    const calls: Array<[number, [number, number][]]> = [];
    const ok = commitBinaryFile(e, [0xff, 0x21], (m) => alerts.push(m), {
      setMemoryContents: (id, pairs) => calls.push([id, pairs]),
    });
    expect(ok).toBe(true);
    expect(alerts).toEqual([]);
    expect(calls).toEqual([[1, [[0, 0x0f], [1, 0x01]]]]);
  });

  it('an empty file commits an empty pair list, clearing the contents', () => {
    const e = elm({ kind: 'sram', params: { dataBits: 8 } });
    const calls: Array<[number, [number, number][]]> = [];
    commitBinaryFile(e, [], () => {}, {
      setMemoryContents: (id, pairs) => calls.push([id, pairs]),
    });
    expect(calls).toEqual([[1, []]]);
  });
});

describe('contents draft versus a landed binary load', () => {
  // The race: with a typing draft still open, a binary file lands through the
  // store; blurring the stale draft afterwards must not overwrite the loaded
  // pairs (upstream dodges it by repopulating the dialog, SRAMLoadFile
  // .java:47). The live draft is derived from the external-write token, so
  // the whole sequence pins here without a DOM.
  it('a draft typed before the load drops, and blur leaves the loaded pairs standing', () => {
    const e = elm({ kind: 'sram', params: { dataBits: 8 } });
    const alerts: string[] = [];
    const calls: Array<[number, [number, number][]]> = [];
    const actions = { setMemoryContents: (id: number, pairs: [number, number][]) => void calls.push([id, pairs]) };
    // The user has typed a draft under token 0.
    const cell: DraftCell = { token: 0, text: '9: 9\n' };
    expect(draftForToken(cell, 0)).toBe('9: 9\n');
    // The binary file lands: the parent bumps the token, then the store
    // receives the file's pairs.
    expect(commitBinaryFile(e, [2, 3], (m) => alerts.push(m), actions)).toBe(true);
    const token = 1;
    // Blur hands the commit whatever draft is live under the new token:
    // nothing. The stale text never reaches the parser, so no second store
    // call can happen and the file's pairs stand.
    expect(draftForToken(cell, token)).toBeNull();
    expect(calls).toEqual([[1, [[0, 2], [1, 3]]]]);
  });

  it('a draft typed under the current token still commits', () => {
    const e = elm({ kind: 'sram', params: { dataBits: 8 } });
    const calls: Array<[number, [number, number][]]> = [];
    const draft = draftForToken({ token: 3, text: '0: 7\n' }, 3);
    expect(draft).toBe('0: 7\n');
    commitContentsField(e, draft!, () => {}, {
      setMemoryContents: (id, pairs) => calls.push([id, pairs]),
    });
    expect(calls).toEqual([[1, [[0, 7]]]]);
  });
});

describe('waveform-conditional voltage rows', () => {
  const names = (e: CircuitElement) => fieldRows(e).map((r) => r.field.name);
  const voltage = (waveform: number, flags = 0) =>
    elm({ kind: 'voltage', flags, params: { waveform, frequency: 125, dutyCycle: 0.25 } });

  it('a DC source shows only the DC rows, no frequency/duty/rise', () => {
    expect(names(voltage(0))).toEqual([
      'maxVoltage',
      'waveform',
      'bias',
      'showVoltage',
      'circleSymbol',
    ]);
  });

  it('a sine shows frequency and phase but no duty or rise', () => {
    expect(names(voltage(1))).toEqual([
      'maxVoltage',
      'waveform',
      'bias',
      'showVoltage',
      'frequency',
      'phaseShift',
    ]);
  });

  it('triangle and sawtooth match the sine row set', () => {
    const want = ['maxVoltage', 'waveform', 'bias', 'showVoltage', 'frequency', 'phaseShift'];
    expect(names(voltage(3))).toEqual(want);
    expect(names(voltage(4))).toEqual(want);
  });

  it('a square and a pulse offer frequency, phase, duty and rise', () => {
    const want = [
      'maxVoltage',
      'waveform',
      'bias',
      'showVoltage',
      'specifyAs',
      'frequency',
      'phaseShift',
      'dutyCycle',
      'riseTime',
    ];
    expect(names(voltage(2))).toEqual(want);
    expect(names(voltage(5))).toEqual(want);
  });

  it('noise matches DC minus the circle row: no frequency/duty/rise either', () => {
    expect(names(voltage(6))).toEqual(['maxVoltage', 'waveform', 'bias', 'showVoltage']);
    for (const wf of [0, 6]) {
      const rows = names(voltage(wf));
      for (const dead of ['frequency', 'phaseShift', 'dutyCycle', 'riseTime', 'highTime', 'lowTime', 'specifyAs']) {
        expect(rows, `waveform ${wf}`).not.toContain(dead);
      }
    }
  });
});

describe('voltage time-spec rows', () => {
  const on = () =>
    elm({
      kind: 'voltage',
      flags: VOLTAGE_TIME_SPEC,
      params: { waveform: 5, frequency: 125, dutyCycle: 0.25 },
    });

  it('with bit 32 set, a pulse swaps frequency and duty for High/Low Time', () => {
    expect(fieldRows(on()).map((r) => r.field.name)).toEqual([
      'maxVoltage',
      'waveform',
      'bias',
      'showVoltage',
      'specifyAs',
      'highTime',
      'phaseShift',
      'lowTime',
      'riseTime',
    ]);
  });

  it('the high row reads dutyCycle/frequency and the low row (1-duty)/frequency', () => {
    const rows = fieldRows(on());
    expect(rows.find((r) => r.field.name === 'highTime')?.value).toBe(0.25 / 125);
    expect(rows.find((r) => r.field.name === 'lowTime')?.value).toBe(0.75 / 125);
  });

  it('a square with bit 32 shows the same swapped pair', () => {
    const e = elm({ kind: 'voltage', flags: VOLTAGE_TIME_SPEC, params: { waveform: 2, frequency: 100, dutyCycle: 0.5 } });
    const rows = fieldRows(e).map((r) => r.field.name);
    expect(rows).toContain('highTime');
    expect(rows).toContain('lowTime');
    expect(rows).not.toContain('frequency');
    expect(rows).not.toContain('dutyCycle');
  });

  it('a sine carrying bit 32 keeps the frequency rows (timeSpec gates on timing)', () => {
    const e = elm({ kind: 'voltage', flags: VOLTAGE_TIME_SPEC, params: { waveform: 1 } });
    const rows = fieldRows(e).map((r) => r.field.name);
    expect(rows).toContain('frequency');
    expect(rows).not.toContain('highTime');
  });
});

describe('time-spec commit', () => {
  const timespec = (waveform: number, frequency: number, dutyCycle: number) =>
    elm({ kind: 'voltage', flags: VOLTAGE_TIME_SPEC, params: { waveform, frequency, dutyCycle } });

  it('committing High Time recomputes frequency and duty from both times', () => {
    // Stored (freq 100, duty 0.4) implies low = (1-0.4)/100 = 6e-3; committing
    // high = 2e-3 stores the plan's pair: freq = 1/(2e-3+6e-3) = 125 Hz and
    // duty = 2e-3/(2e-3+6e-3) = 0.25.
    const { calls, actions } = recorder();
    applyFieldChange(timespec(5, 100, 0.4), field('voltage', 'highTime'), 2e-3, actions);
    expect(calls).toEqual([
      ['setParam', 1, 'frequency', 125],
      ['setParam', 1, 'dutyCycle', 0.25],
    ]);
  });

  it('committing Low Time symmetrically stores the same pair', () => {
    // Stored (freq 250, duty 0.5) implies high = 0.5/250 = 2e-3; committing
    // low = 6e-3 stores the same recomputed pair, freq 125 Hz, duty 0.25.
    const { calls, actions } = recorder();
    applyFieldChange(timespec(5, 250, 0.5), field('voltage', 'lowTime'), 6e-3, actions);
    expect(calls).toEqual([
      ['setParam', 1, 'frequency', 125],
      ['setParam', 1, 'dutyCycle', 0.25],
    ]);
  });

  it('a zero or negative time leaves the stored pair untouched', () => {
    // Stored (freq 125, duty 0.25) already encodes high 2e-3 / low 6e-3; a
    // rejected commit mutates nothing and dispatches nothing, so the pair
    // survives exactly as it was.
    const base = timespec(5, 125, 0.25);
    for (const [name, v] of [['highTime', 0], ['highTime', -1], ['lowTime', 0]] as const) {
      const { calls, actions } = recorder();
      applyFieldChange(base, field('voltage', name), v, actions);
      expect(calls, `${name} ${v}`).toEqual([]);
    }
  });
});

describe('source phase and duty dialog units', () => {
  // The dialog speaks upstream's edit-item units, degrees and percent
  // (VoltageElm.java:573,:578-580), while params and files store radians and
  // fractions. Every test here pins one direction of that bridge.

  it('the phase row displays degrees, raw like upstream', () => {
    // Upstream shows phaseShift*180/pi as-is (:573), so a hand-edited
    // negative radian token displays its negative degrees.
    const f = field('voltage', 'phaseShift');
    expect(f.unit).toBe('deg');
    expect(fieldValue(elm({ kind: 'voltage', params: { phaseShift: Math.PI / 4 } }), f)).toBeCloseTo(45, 12);
    expect(fieldValue(elm({ kind: 'voltage', params: { phaseShift: -Math.PI / 2 } }), f)).toBeCloseTo(-90, 12);
  });

  it('committing degrees stores radians through pi/180', () => {
    const { calls, actions } = recorder();
    applyFieldChange(
      elm({ kind: 'voltage', params: { phaseShift: 0 } }),
      field('voltage', 'phaseShift'),
      90,
      actions,
    );
    expect(calls).toEqual([['setParam', 1, 'phaseShift', Math.PI / 2]]);
  });

  it('a phase commit wraps into [0, 2pi) exactly as upstream setEditValue', () => {
    // ((rad % 2pi) + 2pi) % 2pi (VoltageElm.java:648-650): typing -90 lands
    // at a stored phase of 3*pi/2, 450 folds back to 90, -180 folds to +180.
    const commit = (v: number) => {
      const { calls, actions } = recorder();
      applyFieldChange(
        elm({ kind: 'voltage', params: { phaseShift: 0 } }),
        field('voltage', 'phaseShift'),
        v,
        actions,
      );
      return (calls[0] as [string, number, string, number] | undefined)?.[3];
    };
    expect(commit(-90)).toBeCloseTo((3 * Math.PI) / 2, 12);
    expect(commit(450)).toBeCloseTo(Math.PI / 2, 12);
    expect(commit(-180)).toBeCloseTo(Math.PI, 12);
    // Wrapping 0 back onto a stored 0 changes nothing, so the diff dispatches
    // no setParam at all.
    expect(commit(0)).toBeUndefined();
  });

  it('degrees round-trip: pi/2 stored reads back 90', () => {
    const e = elm({ kind: 'voltage', params: { phaseShift: Math.PI / 2 } });
    expect(fieldValue(e, field('voltage', 'phaseShift'))).toBeCloseTo(90, 12);
  });

  it('the rail shares the degree row', () => {
    const e = elm({ kind: 'rail', params: { phaseShift: Math.PI / 2 } });
    expect(fieldValue(e, field('rail', 'phaseShift'))).toBeCloseTo(90, 12);
    const { calls, actions } = recorder();
    applyFieldChange(e, field('rail', 'phaseShift'), -90, actions);
    expect(calls).toEqual([['setParam', 1, 'phaseShift', (3 * Math.PI) / 2]]);
  });

  it('the duty row shows percent within a 0..100 range', () => {
    const f = field('voltage', 'dutyCycle');
    expect(f.min).toBe(0);
    expect(f.max).toBe(100);
    expect(f.scale).toBe(100);
    expect(fieldValue(elm({ kind: 'voltage', params: { dutyCycle: 0.25 } }), f)).toBeCloseTo(25, 12);
  });

  it('committing percent stores hundredths with the boundaries preserved', () => {
    const commit = (v: number) => {
      const { calls, actions } = recorder();
      applyFieldChange(
        elm({ kind: 'voltage', params: { dutyCycle: 0.5 } }),
        field('voltage', 'dutyCycle'),
        v,
        actions,
      );
      return (calls[0] as [string, number, string, number])[3];
    };
    // Upstream commits ei.value * .01 with no clamp (:660), so 0 and 100 are
    // the pass-through boundaries of the range.
    expect(commit(50)).toBe(0.5);
    expect(commit(38)).toBeCloseTo(0.38, 12);
    expect(commit(0)).toBe(0);
    expect(commit(100)).toBe(1);
  });

  it('displaying the rows never rewrites the stored truth', () => {
    // Opening the dialog resolves every visible row; the radians and the
    // fraction must come out exactly as they went in, so a save after merely
    // looking is byte-for-byte.
    const params = { waveform: 5, frequency: 125, phaseShift: 1.5707963267948966, dutyCycle: 0.56 };
    const e = elm({ kind: 'voltage', params });
    fieldRows(e);
    expect(e.params.phaseShift).toBe(1.5707963267948966);
    expect(e.params.dutyCycle).toBe(0.56);
  });
});

describe('Specify As toggling', () => {
  it('sets and clears bit 32 through updateElement and swaps the rows', () => {
    const base = elm({ kind: 'voltage', params: { waveform: 5 } });
    const specify = field('voltage', 'specifyAs');

    const { calls, actions } = recorder();
    applyFieldChange(base, specify, 1, actions);
    expect(calls).toEqual([['updateElement', 1, { flags: VOLTAGE_TIME_SPEC }]]);

    const on = elm({ kind: 'voltage', flags: VOLTAGE_TIME_SPEC, params: { waveform: 5 } });
    expect(fieldRows(on).map((r) => r.field.name)).toContain('highTime');
    expect(fieldRows(on).map((r) => r.field.name)).toContain('lowTime');
    expect(fieldRows(on).map((r) => r.field.name)).not.toContain('frequency');
    expect(fieldRows(on).map((r) => r.field.name)).not.toContain('dutyCycle');

    const { calls: off, actions: offActions } = recorder();
    applyFieldChange(on, specify, 0, offActions);
    expect(off).toEqual([['updateElement', 1, { flags: 0 }]]);
    expect(fieldRows(base).map((r) => r.field.name)).toContain('frequency');
    expect(fieldRows(base).map((r) => r.field.name)).toContain('dutyCycle');
  });
});

describe('field visible/get/apply mechanisms', () => {
  it('visibleFields drops the rows whose predicate the element fails', () => {
    const fields: FieldDef[] = [
      { name: 'always', label: 'Always' },
      { name: 'onlyHigh', label: 'Only High', visible: (e) => e.params.high === 1 },
    ];
    expect(visibleFields(elm({ kind: 'resistor', params: { high: 1 } }), fields).map((f) => f.name)).toEqual([
      'always',
      'onlyHigh',
    ]);
    expect(visibleFields(elm({ kind: 'resistor', params: { high: 0 } }), fields).map((f) => f.name)).toEqual(['always']);
  });

  it('fieldValue consults get before the params binding', () => {
    const f: FieldDef = { name: 'ratio', label: 'Ratio', get: (e) => e.params.a / e.params.b };
    // A stored `ratio` param is ignored: the row is a derived view.
    expect(fieldValue(elm({ kind: 'resistor', params: { a: 3, b: 4, ratio: 999 } }), f)).toBe(0.75);
  });

  it('applyFieldChange runs apply on a draft and dispatches one setParam per change', () => {
    const f: FieldDef = {
      name: 'pair',
      label: 'Pair',
      apply: (e, v) => {
        e.params.x = v;
        e.params.y = v * 2;
      },
    };
    const { calls, actions } = recorder();
    applyFieldChange(elm({ kind: 'resistor', params: { x: 1, y: 1 } }), f, 5, actions);
    expect(calls).toEqual([
      ['setParam', 1, 'x', 5],
      ['setParam', 1, 'y', 10],
    ]);
  });

  it('applyFieldChange never mutates the store element, only its draft', () => {
    const f: FieldDef = { name: 'pair', label: 'Pair', apply: (e, v) => { e.params.x = v; } };
    const e = elm({ kind: 'resistor', params: { x: 1 } });
    applyFieldChange(e, f, 5, recorder().actions);
    expect(e.params.x).toBe(1);
  });

  it('fieldLabel resolves a function label per element', () => {
    const f: FieldDef = { name: 'a', label: (e) => (e.params.on ? 'On' : 'Off') };
    expect(fieldLabel(elm({ kind: 'resistor', params: { on: 1 } }), f)).toBe('On');
    expect(fieldLabel(elm({ kind: 'resistor', params: { on: 0 } }), f)).toBe('Off');
  });
});

describe('source amplitude label', () => {
  it('labels the row Voltage for DC and Max Voltage otherwise', () => {
    const dc = fieldRows(elm({ kind: 'voltage', params: { waveform: 0 } }));
    expect(dc.find((r) => r.field.name === 'maxVoltage')?.label).toBe('Voltage');
    const sine = fieldRows(elm({ kind: 'voltage', params: { waveform: 1 } }));
    expect(sine.find((r) => r.field.name === 'maxVoltage')?.label).toBe('Max Voltage');
  });
});

describe('rail rows', () => {
  it('equal the voltage rows minus Circle Symbol for each waveform and flag set', () => {
    for (const wf of [0, 1, 2, 3, 4, 5, 6]) {
      for (const flags of [0, VOLTAGE_TIME_SPEC]) {
        const v = elm({ kind: 'voltage', flags, params: { waveform: wf, frequency: 125, dutyCycle: 0.25 } });
        const r = elm({ kind: 'rail', flags, params: { waveform: wf, frequency: 125, dutyCycle: 0.25 } });
        const want = fieldRows(v)
          .map((row) => row.field.name)
          .filter((n) => n !== 'circleSymbol')
          // The rail's Show Voltage row is hidden on the DC waveform, where
          // the label always draws and bit 64 does nothing (VoltageElm.java:
          // 541).
          .filter((n) => !(wf === 0 && n === 'showVoltage'));
        expect(
          fieldRows(r).map((row) => row.field.name),
          `waveform ${wf}, flags ${flags}`,
        ).toEqual(want);
      }
    }
  });

  it('hides the Show Voltage row for the DC waveform but shows it otherwise', () => {
    for (const wf of [1, 2, 3, 4, 5, 6]) {
      const rows = fieldRows(elm({ kind: 'rail', params: { waveform: wf } })).map(
        (row) => row.field.name,
      );
      expect(rows, `waveform ${wf}`).toContain('showVoltage');
    }
    const dc = fieldRows(elm({ kind: 'rail', params: { waveform: 0 } })).map(
      (row) => row.field.name,
    );
    expect(dc).not.toContain('showVoltage');
    // The voltage source keeps the row on every waveform, DC included.
    for (const wf of [0, 1]) {
      const rows = fieldRows(elm({ kind: 'voltage', params: { waveform: wf } })).map(
        (row) => row.field.name,
      );
      expect(rows, `waveform ${wf}`).toContain('showVoltage');
    }
  });
});

describe('Safari checkbox and select baseline fallback', () => {
  it('an unarmed change arms the baseline itself', () => {
    // Safari never focuses a checkbox or select on click, so the change is
    // the first event of the edit: the caller must take the undo baseline
    // before applying the value.
    expect(changeArmsBaseline(false)).toEqual({ arm: true, armed: true });
  });

  it('a focus-armed session stays armed through the change', () => {
    // Chromium and Firefox deliver focus first; the caller must not commit
    // twice (the dedup would make that harmless but the intent stands).
    expect(changeArmsBaseline(true)).toEqual({ arm: false, armed: true });
  });

  it('a self-armed session counts as armed for the next click', () => {
    // Repeated clicks group into one undo step exactly as they do under a
    // held focus on other browsers.
    const first = changeArmsBaseline(false);
    expect(changeArmsBaseline(first.armed)).toEqual({ arm: false, armed: true });
  });
});
