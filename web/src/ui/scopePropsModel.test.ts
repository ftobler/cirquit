import { describe, expect, it } from 'vitest';
import type { PlotMeasurements, Scope, ScopePlot, ScopeValue } from '../engine/scopeModel';
import {
  SCOPE_PROPS_SECTIONS,
  channelLetter,
  clampDialogOffset,
  nextEnabledIndex,
  shouldCommit,
  channelRows,
  effectiveReadoutTarget,
  initialReadoutTarget,
  parseDivisions,
  parseManScale,
  parseValue,
  scopeDisplayName,
} from './scopePropsModel';

function plot(id: number, value: ScopeValue | null, elementId: number | null = 5): ScopePlot {
  return {
    id,
    elementId,
    value,
    manScale: null,
    manVPosition: 0,
    acCoupled: false,
    measurements: null,
    origValueToken: null,
    origElementIndex: null,
  };
}

function scopeOf(plots: ScopePlot[], patch: Partial<Scope> = {}): Scope {
  return {
    id: 1,
    raw: null,
    plots,
    speed: 64,
    position: 0,
    manualScale: false,
    maxScale: false,
    label: '',
    manDivisions: 8,
    showScale: true,
    showMax: true,
    showMin: false,
    showP2P: false,
    showFreq: false,
    showRMS: false,
    showAverage: false,
    showDutyCycle: false,
    fftPlot: false,
    logSpectrum: false,
    plotXY: false,
    showPhaseAngle: false,
    trailPersistence: 0,
    plotX: 0,
    plotY: 1,
    plotBrightness: -1,
    plotColorR: -1,
    plotColorG: -1,
    plotColorB: -1,
    showElmInfo: false,
    showI: true,
    showV: true,
    scaleV: 20,
    scaleA: 0.05,
    trigger: { mode: 'freeRun', edge: 'rising', level: 0 },
    ...patch,
  };
}

const allOn: PlotMeasurements = {
  showScale: true,
  showMax: true,
  showMin: true,
  showP2P: true,
  showFreq: true,
  showRMS: true,
  showAverage: true,
  showDutyCycle: true,
  showPhaseAngle: true,
};

describe('scope properties model', () => {
  it('lists the sections in rail order with unique ids', () => {
    const ids = SCOPE_PROPS_SECTIONS.map((s) => s.id);
    expect(ids).toEqual(['traces', 'vertical', 'timebase', 'readouts', 'display']);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('letters each quantity', () => {
    expect(channelLetter('voltage')).toBe('V');
    expect(channelLetter('current')).toBe('I');
    expect(channelLetter('vce')).toBe('Vce');
    expect(channelLetter(null)).toBe('?');
  });

  it('builds one row per drawn channel with its unit, colour and gates', () => {
    const v = plot(10, 'voltage');
    const i = plot(11, 'current');
    const scope = scopeOf([v, i]);
    const rows = channelRows(
      scope,
      [v, i],
      (id) => (id === 5 ? 'Resistor' : null),
      (id) => (id === 10 ? '#00ff00' : undefined),
      '#ffffff',
    );
    expect(rows.map((r) => r.name)).toEqual(['CH 1', 'CH 2']);
    expect(rows.map((r) => r.unit)).toEqual(['V', 'A']);
    expect(rows.map((r) => r.color)).toEqual(['#00ff00', '#ffffff']);
    expect(rows[0].source).toBe('Resistor');
    // AC coupling filters voltage samples only.
    expect(rows.map((r) => r.acAllowed)).toEqual([true, false]);
    expect(rows.every((r) => r.removable)).toBe(true);
    expect(rows.map((r) => r.overrides)).toEqual([false, false]);
  });

  it('flags a channel whose own readouts differ from the scope', () => {
    const v = plot(10, 'voltage');
    const i = { ...plot(11, 'current'), measurements: allOn };
    const rows = channelRows(scopeOf([v, i]), [v, i], () => 'R', () => undefined, '#fff');
    expect(rows.map((r) => r.overrides)).toEqual([false, true]);
  });

  it('never offers to remove the last or a raw-only plot', () => {
    const only = plot(10, 'voltage');
    expect(channelRows(scopeOf([only]), [only], () => 'R', () => undefined, '#fff')[0].removable).toBe(
      false,
    );
    const raw = plot(12, null, null);
    const v = plot(10, 'voltage');
    const rows = channelRows(scopeOf([v, raw]), [v, raw], () => null, () => undefined, '#fff');
    expect(rows[1].removable).toBe(false);
    expect(rows[1].source).toBe('missing element');
  });

  it('names a scope by its label, else by its place in the list', () => {
    const a = scopeOf([plot(10, 'voltage')], { id: 1, label: '' });
    const b = scopeOf([plot(11, 'voltage')], { id: 2, label: '  out  ' });
    expect(scopeDisplayName([a, b], a)).toBe('Scope 1');
    expect(scopeDisplayName([a, b], b)).toBe('out');
  });

  it('parses values with the edit dialog suffixes', () => {
    expect(parseValue('10m')).toBeCloseTo(0.01);
    expect(parseValue('2k2')).toBeCloseTo(2200);
    expect(parseValue('-1.5')).toBe(-1.5);
    expect(parseValue('')).toBeNull();
    expect(parseValue('abc')).toBeNull();
  });

  it('accepts whole divisions in range only', () => {
    expect(parseDivisions('8')).toBe(8);
    expect(parseDivisions('7.6')).toBe(8);
    expect(parseDivisions('0')).toBeNull();
    expect(parseDivisions('400')).toBeNull();
    expect(parseDivisions('x')).toBeNull();
  });

  it('accepts only a positive manual scale', () => {
    expect(parseManScale('500m')).toBeCloseTo(0.5);
    expect(parseManScale('0')).toBeNull();
    expect(parseManScale('-1')).toBeNull();
  });

  it('opens Readouts on the first overriding channel, else on all traces', () => {
    const v = plot(10, 'voltage');
    const i = { ...plot(11, 'current'), measurements: allOn };
    const scope = scopeOf([v, i]);
    expect(initialReadoutTarget(scope, [v, i])).toBe(11);
    expect(initialReadoutTarget(scopeOf([v, plot(11, 'current')]), [v, plot(11, 'current')])).toBe(
      'all',
    );
    // A single channel has nothing to tell apart.
    expect(initialReadoutTarget(scopeOf([i]), [i])).toBe('all');
  });

  it('falls back to all traces when the targeted channel goes', () => {
    const v = plot(10, 'voltage');
    const i = plot(11, 'current');
    expect(effectiveReadoutTarget(11, [v, i])).toBe(11);
    expect(effectiveReadoutTarget(12, [v, i])).toBe('all');
    expect(effectiveReadoutTarget(10, [v])).toBe('all');
  });
});

describe('dialog drag clamp', () => {
  const view = { w: 1000, h: 800 };
  const rect = { left: 300, top: 200, width: 400 };

  it('moves freely inside the viewport', () => {
    expect(clampDialogOffset({ x: 0, y: 0 }, rect, 50, -30, view)).toEqual({ x: 50, y: -30 });
  });

  it('keeps the header on screen and a slice of the dialog sideways', () => {
    expect(clampDialogOffset({ x: 0, y: 0 }, rect, 0, -500, view).y).toBe(-200);
    expect(clampDialogOffset({ x: 0, y: 0 }, rect, 0, 5000, view).y).toBe(800 - 40 - 200);
    expect(clampDialogOffset({ x: 0, y: 0 }, rect, -5000, 0, view).x).toBe(120 - 400 - 300);
    expect(clampDialogOffset({ x: 10, y: 0 }, rect, 5000, 0, view).x).toBe(10 + 1000 - 120 - 300);
  });
});

describe('field commit rule', () => {
  it('commits a changed draft that parses, nothing else', () => {
    expect(shouldCommit('5m', '1m', parseValue)).toBe(true);
    expect(shouldCommit('1m', '1m', parseValue)).toBe(false);
    expect(shouldCommit('abc', '1m', parseValue)).toBe(false);
    // Zero is a value, not a refusal.
    expect(shouldCommit('0', '1m', parseValue)).toBe(true);
  });
});

describe('segmented arrow keys', () => {
  it('moves to the next enabled option, wrapping', () => {
    expect(nextEnabledIndex([false, false, false], 0, 1)).toBe(1);
    expect(nextEnabledIndex([false, false, false], 2, 1)).toBe(0);
    expect(nextEnabledIndex([false, false, false], 0, -1)).toBe(2);
    expect(nextEnabledIndex([false, true, false], 0, 1)).toBe(2);
    expect(nextEnabledIndex([false, true], 0, 1)).toBe(0);
  });
});
