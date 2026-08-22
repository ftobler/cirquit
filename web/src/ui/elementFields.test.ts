import { describe, expect, it, beforeEach } from 'vitest';
import { defFor } from '../model/registry';
import { clearUserModels, putUserModel } from '../model/deviceModels';
import { SRAM_HEX_DISPLAY } from '../model/registry/elements/sram';
import type { CircuitElement, FieldDef } from '../model/types';
import {
  applyFieldChange,
  clampInteger,
  commitContentsField,
  deviceModelButtons,
  fieldRows,
  fieldValue,
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

  it('drops a field whose when-predicate the element fails', () => {
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
