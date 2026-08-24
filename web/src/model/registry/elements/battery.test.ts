import { describe, expect, it, vi } from 'vitest';
import { overlayLiveState } from '../../../io/liveState';
import { parseCircuit, serializeCircuit } from '../../../io/netlist';
import { applyFieldChange, fieldRows, fieldValue } from '../../../ui/elementFields';
import { makeElement } from '../../../state/helpers';
import { DEFAULT_SETTINGS } from '../../types';
import {
  BATTERY_DEF,
  batteryTypeTables,
  getVoltageForSoc,
  interpSocTable,
  normalizeSocTable,
  parseSocTable,
} from './battery';
import { BATTERY_SHOW_SOC, BATTERY_SHOW_VOLTAGE } from '../flags';
import type { CircuitElement, DrawContext, FieldDef } from '../../types';

function mk(): CircuitElement {
  return {
    id: 1,
    kind: 'battery',
    x1: 0,
    y1: 0,
    x2: 64,
    y2: 0,
    flags: 0,
    params: { ...(BATTERY_DEF.defaults ?? {}) },
    model: batteryTypeTables[1],
  };
}

/** Minimal canvas stub recording only the text the caption draws. */
function mkCtx() {
  return {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    lineCap: '',
    lineJoin: '',
    font: '',
    textAlign: '',
    textBaseline: '',
    createLinearGradient: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    closePath: vi.fn(),
    fillText: vi.fn(),
    setLineDash: vi.fn(),
    measureText: (text: string) => ({ width: text.length * 6 }),
  };
}

const context = (ctx: ReturnType<typeof mkCtx>, overrides: Partial<DrawContext> = {}): DrawContext => ({
  ctx: ctx as unknown as CanvasRenderingContext2D,
  theme: { text: '#fff' } as never,
  voltages: [0, 0],
  current: 0,
  voltage: 0,
  power: 0,
  value: 0,
  state: 0.5,
  wave: [],
  dotPhase: 0,
  postCurrents: [],
  postDotPhases: [],
  showCurrent: false,
  showValues: true,
  showVoltageColor: false,
  showPowerColor: false,
  conventional: true,
  euroResistors: true,
  euroGates: false,
  selected: false,
  hovered: false,
  onHighlightedNet: false,
  voltageRange: 5,
  powerRange: 50,
  scale: 1,
  valueDigits: 1,
  valueFontSize: 12,
  ...overrides,
});

const captions = (flags: number, state = 0.5): string[] => {
  const ctx = mkCtx();
  const e = { ...mk(), flags, model: batteryTypeTables[0] };
  BATTERY_DEF.draw(context(ctx, { state }), e);
  return ctx.fillText.mock.calls.map((a: unknown[]) => String(a[0]));
};

describe('battery', () => {
  it('uses dump code 438, the port-assigned code for an XML-only class', () => {
    expect(BATTERY_DEF.dumpCode).toBe('438');
    expect(BATTERY_DEF.kind).toBe('battery');
    expect(BATTERY_DEF.category).toBe('Sources');
  });

  it('a fresh part is a lithium battery with its table and caption flags', () => {
    const e = makeElement('battery', 0, 0, 64, 0);
    expect(e.params.batteryType).toBe(1);
    expect(e.model).toBe(batteryTypeTables[1]);
    expect(e.flags & (BATTERY_SHOW_VOLTAGE | BATTERY_SHOW_SOC)).toBe(
      BATTERY_SHOW_VOLTAGE | BATTERY_SHOW_SOC,
    );
  });

  it('round-trips an escaped multi-line table byte-for-byte', () => {
    // A three-row custom table: the file carries it as ONE escaped token so
    // the line-oriented parser never sees the newlines (the plan's format
    // risk).
    const table = '0=0.8\n10=0.95\n40=1.18\n';
    const e = { ...mk(), model: table, params: { ...mk().params, r0: 0.5, initialSoc: 0.5 } };
    const line = serializeCircuit([e], DEFAULT_SETTINGS);
    const batteryLine = line.split('\n').find((l) => l.startsWith('438 '))!;
    expect(batteryLine).toContain('\\n');
    expect(batteryLine).not.toContain('\n'); // no raw newline inside the line
    const [back] = parseCircuit(line).elements;
    expect(back.model).toBe(table);
    expect(back.params.r0).toBe(0.5);
    expect(back.params.initialSoc).toBe(0.5);
  });

  it('parses the port stream: r0, r1, c1, capacityAh, initialSocPercent, batteryType, table', () => {
    const src =
      '438 0 0 64 0 3 0.15 0.25 1500 2.5 50 0 0=0.8\\n10=0.95\\n40=1.18\\n';
    const [back] = parseCircuit(src).elements;
    expect(back.kind).toBe('battery');
    expect(back.params.r0).toBe(0.15);
    expect(back.params.r1).toBe(0.25);
    expect(back.params.c1).toBe(1500);
    expect(back.params.capacityAh).toBe(2.5);
    expect(back.params.initialSoc).toBe(0.5); // percent token becomes the 0..1 fraction
    expect(back.params.batteryType).toBe(0);
    expect(back.model).toBe('0=0.8\n10=0.95\n40=1.18\n');
  });

  it('clamps the initial SOC percent token into 0..100 before converting', () => {
    const [over] = parseCircuit('438 0 0 64 0 0 0.01 0.02 2000 2 150 1 0=3\\n').elements;
    expect(over.params.initialSoc).toBe(1);
    const [under] = parseCircuit('438 0 0 64 0 0 0.01 0.02 2000 2 -5 1 0=3\\n').elements;
    expect(under.params.initialSoc).toBe(0);
  });

  it('an over-discharged percent token floors only the config, not the saved charge', () => {
    // The one percent token doubles as the saved running charge, which
    // over-discharge drives below zero. Like upstream's undump
    // (BatteryElm.java:115-122) the config slot clamps to 0..1 while the
    // seeded soc keeps the negative, so a reload resumes empty-but-drained
    // instead of silently recharging to 0%.
    const [back] = parseCircuit('438 0 0 64 0 0 0.01 0.02 2000 2 -5 1 20\\q3.5\\n').elements;
    expect(back.params.initialSoc).toBe(0);
    expect(back.params.soc).toBe(-0.05);
    // And the round trip back out keeps it negative.
    const resaved = parseCircuit(serializeCircuit([back], DEFAULT_SETTINGS)).elements[0];
    expect(resaved.params.soc).toBe(-0.05);
  });

  it('interpolates the alkaline table at 50% and extrapolates below 0%', () => {
    const alkaline = batteryTypeTables[0];
    expect(interpSocTable(alkaline, 50)).toBeCloseTo(1.23, 12);
    expect(interpSocTable(alkaline, 0)).toBeCloseTo(0.8, 12);
    // Over-discharge: v0 + slope*3*socPct, slope from the 0..10% pair.
    expect(getVoltageForSoc(alkaline, -0.05)).toBeCloseTo(0.575, 12);
    expect(getVoltageForSoc(alkaline, -0.1)).toBeCloseTo(0.35, 12);
  });

  it('an empty table falls back to the flat 3.7 V', () => {
    expect(interpSocTable('', 0.5)).toBe(3.7);
  });

  it('choosing a preset applies the chemistry defaults and swaps the table', () => {
    const e = mk();
    const setParam = vi.fn();
    const updateElement = vi.fn();
    const actions = {
      setParam,
      setText: vi.fn(),
      setKeyShortcut: vi.fn(),
      setModelName: vi.fn(),
      updateElement,
    };
    const field = BATTERY_DEF.fields!.find((f) => f.name === 'batteryType')!;
    applyFieldChange(e, field, 0, actions); // switch to alkaline
    expect(setParam).toHaveBeenCalledWith(e.id, 'batteryType', 0);
    expect(setParam).toHaveBeenCalledWith(e.id, 'capacityAh', 2.5);
    expect(setParam).toHaveBeenCalledWith(e.id, 'r0', 0.15);
    expect(setParam).toHaveBeenCalledWith(e.id, 'r1', 0.25);
    expect(setParam).toHaveBeenCalledWith(e.id, 'c1', 1500);
    expect(updateElement).toHaveBeenCalledWith(e.id, { model: batteryTypeTables[0] });
  });

  it('switching to Custom keeps the current values and the table', () => {
    const e = mk();
    const setParam = vi.fn();
    const updateElement = vi.fn();
    const actions = {
      setParam,
      setText: vi.fn(),
      setKeyShortcut: vi.fn(),
      setModelName: vi.fn(),
      updateElement,
    };
    const field = BATTERY_DEF.fields!.find((f) => f.name === 'batteryType')!;
    applyFieldChange(e, field, -1, actions);
    expect(setParam).toHaveBeenCalledWith(e.id, 'batteryType', -1);
    // No defaults applied, no table swap: the user's values stay editable.
    expect(setParam).toHaveBeenCalledTimes(1);
    expect(updateElement).not.toHaveBeenCalled();
  });

  it('the SOC table row shows only on a custom battery', () => {
    const custom = { ...mk(), params: { ...mk().params, batteryType: -1 } };
    const preset = { ...mk(), params: { ...mk().params, batteryType: 0 } };
    const customRows = fieldRows(custom);
    const presetRows = fieldRows(preset);
    expect(customRows.find((r) => r.field.name === 'socTable')).toBeDefined();
    expect(presetRows.find((r) => r.field.name === 'socTable')).toBeUndefined();
  });

  it('the SOC table field is a multiline textarea, so the rows survive', () => {
    const field = BATTERY_DEF.fields!.find((f) => f.name === 'socTable')!;
    expect(field.type).toBe('text');
    expect(field.multiline).toBe(true);
  });

  it('fieldValue reads the battery model as its table text', () => {
    const e = { ...mk(), model: '0=0.8\n10=0.95\n' };
    const field = BATTERY_DEF.fields!.find((f) => f.name === 'socTable')! as FieldDef;
    expect(fieldValue(e, field)).toBe('0=0.8\n10=0.95\n');
  });

  it('the Initial State of Charge row shows percent and commits the fraction', () => {
    // The param is a 0..1 fraction (the engine and the SOC token work in
    // fractions); the row displays and edits whole percent, upstream's
    // `initialSoc * 100` edit row (BatteryElm.java:353).
    const e = { ...mk(), params: { ...mk().params, initialSoc: 0.5 } };
    const field = BATTERY_DEF.fields!.find((f) => f.name === 'initialSoc')! as FieldDef;
    expect(field.min).toBe(0);
    expect(field.max).toBe(100);
    expect(field.scale).toBe(100);
    expect(fieldValue(e, field)).toBe(50);

    const setParam = vi.fn();
    const actions = {
      setParam,
      setText: vi.fn(),
      setKeyShortcut: vi.fn(),
      setModelName: vi.fn(),
      updateElement: vi.fn(),
    };
    applyFieldChange(e, field, 75, actions);
    expect(setParam).toHaveBeenCalledWith(e.id, 'initialSoc', 0.75);
  });

  it('committing Initial SOC also moves the live soc, so the next save carries it', () => {
    // The running soc is what the dump prefers, so an Initial SOC edit that
    // moved only the config would be dropped by the very next save. The
    // commit dispatches both params, like the derived rows' apply hook
    // (elementFields.ts diffs the draft and sends one setParam per change).
    const e = { ...mk(), params: { ...mk().params, initialSoc: 1, soc: 0.42 } };
    const field = BATTERY_DEF.fields!.find((f) => f.name === 'initialSoc')!;
    const calls: { name: string; v: number }[] = [];
    const actions = {
      setParam: (_id: number, name: string, v: number) => calls.push({ name, v }),
      setText: vi.fn(),
      setKeyShortcut: vi.fn(),
      setModelName: vi.fn(),
      updateElement: vi.fn(),
    };
    applyFieldChange(e, field, 75, actions);

    // Replay the dispatched calls onto a copy the way the store does.
    const edited = { ...e, params: { ...e.params } as Record<string, number> };
    for (const { name, v } of calls) edited.params[name] = v;
    expect(edited.params.initialSoc).toBe(0.75);
    expect(edited.params.soc).toBe(0.75);

    // So the saved percent token is the typed value, not the stale 42.
    const tokens = serializeCircuit([edited], DEFAULT_SETTINGS)
      .split('\n')
      .find((l) => l.startsWith('438 '))!
      .split(' ');
    expect(tokens[10]).toBe('75');
  });

  it('the Show Voltage and Show SOC flags gate the caption halves', () => {
    // Alkaline at soc 0.5: the voltage caption is the interpolated 1.23 V and
    // the SOC caption the whole percent 50% (BatteryElm.java:298-310).
    const both = BATTERY_SHOW_VOLTAGE | BATTERY_SHOW_SOC;
    expect(captions(both)).toEqual(['1.2V 50%']);
    expect(captions(BATTERY_SHOW_VOLTAGE)).toEqual(['1.2V']);
    expect(captions(BATTERY_SHOW_SOC)).toEqual(['50%']);
    expect(captions(0)).toEqual([]);
  });

  it('the SOC caption tracks the live state and the SOC round percentage', () => {
    expect(captions(BATTERY_SHOW_SOC, 0.496)).toEqual(['50%']);
    expect(captions(BATTERY_SHOW_SOC, 0.501)).toEqual(['50%']);
  });

  it('a mid-discharge save carries the live soc token, not the stale initial', () => {
    // overlayLiveState merges the engine's live soc fraction into params at
    // save time; the dump must prefer it over the configured initialSoc or
    // every save (Ctrl+S, autosave, crash recovery) restarts the battery full
    // on reload. Both fields are 0..1 fractions, so one * 100 covers both.
    const e = { ...mk(), params: { ...mk().params, initialSoc: 0.75 } };
    const out = serializeCircuit(overlayLiveState([e], { 1: { soc: 0.42 } }), DEFAULT_SETTINGS);
    const tokens = out.split('\n').find((l) => l.startsWith('438 '))!.split(' ');
    expect(tokens[10]).toBe('42');
  });

  it('a battery never built by the engine still dumps its configured initialSoc', () => {
    // Before any build there is no live soc token to overlay, so the dump
    // falls back to the configured fraction.
    const e = { ...mk(), params: { ...mk().params, initialSoc: 0.3 } };
    const tokens = serializeCircuit([e], DEFAULT_SETTINGS)
      .split('\n')
      .find((l) => l.startsWith('438 '))!
      .split(' ');
    expect(tokens[10]).toBe('30');
  });

  it('sorts an out-of-order SOC table ascending on load', () => {
    // The engine sorts its copy at construction (battery.rs), so a hand-typed
    // out-of-order table must parse sorted or the saved file disagrees with
    // what the simulation reads.
    const src = '438 0 0 64 0 0 0.01 0.02 2000 2 50 -1 50=3.7\\n20=3.5\\n100=4.2\\n';
    const [back] = parseCircuit(src).elements;
    expect(back.model).toBe('20=3.5\n50=3.7\n100=4.2\n');
    const out = serializeCircuit([back], DEFAULT_SETTINGS)
      .split('\n')
      .find((l) => l.startsWith('438 '))!;
    // The writer escapes `=` as \q inside the token, so the saved table reads
    // in ascending SOC order.
    expect(out.endsWith('20\\q3.5\\n50\\q3.7\\n100\\q4.2\\n')).toBe(true);
  });

  it('keeps duplicate SOC entries in parse order, like the engine sort', () => {
    const pairs = parseSocTable('10=1.1\n10=1.2\n0=1.0\n');
    expect(pairs.map((p) => `${p.pct}=${p.volt}`)).toEqual(['0=1', '10=1.1', '10=1.2']);
  });

  it('re-slots only the valid rows and pins every other line in place', () => {
    // Blank and malformed lines carry no SOC to sort by, so they keep their
    // slots while the valid lines move around them: a load/save cycle must
    // never lose or reorder file text the table parser merely tolerates.
    expect(normalizeSocTable('50=3.7\njunk\n20=3.5')).toBe('20=3.5\njunk\n50=3.7');
    expect(normalizeSocTable('\n50=3.7\n\n20=3.5\n')).toBe('\n20=3.5\n\n50=3.7\n');
    expect(normalizeSocTable('50=x\n')).toBe('50=x\n');
    expect(normalizeSocTable('')).toBe('');
  });

  it('interpolates the caption from the segment the sorted engine table uses', () => {
    // At 35% the sorted table interpolates between (20,3.5) and (50,3.7);
    // reading the raw order would clamp at the first pair and show 3.7 V.
    const ctx = mkCtx();
    const e = {
      ...mk(),
      flags: BATTERY_SHOW_VOLTAGE | BATTERY_SHOW_SOC,
      model: '50=3.7\n20=3.5\n100=4.2\n',
    };
    BATTERY_DEF.draw(context(ctx, { state: 0.35 }), e);
    expect(ctx.fillText.mock.calls.map((a: unknown[]) => String(a[0]))).toEqual(['3.6V 35%']);
  });

  it('saves an already-sorted table byte-for-byte', () => {
    // The canonical written form escapes `=` as \q and newlines as \n inside
    // the one token; a file whose table already ascends must round-trip
    // untouched.
    const line = '438 0 0 64 0 0 0.01 0.02 2000 2 50 -1 20\\q3.5\\n50\\q3.7\\n100\\q4.2\\n';
    const [back] = parseCircuit(line).elements;
    expect(back.model).toBe('20=3.5\n50=3.7\n100=4.2\n');
    expect(serializeCircuit([back], DEFAULT_SETTINGS).split('\n').find((l) => l.startsWith('438 '))).toBe(line);
  });
});