import { describe, expect, it } from 'vitest';
import type { Scope, ScopeDrawSource, ScopePlot } from '../engine/scopeModel';
import {
  combineMath,
  derivativeMath,
  mathOpLabel,
  mathScopeSource,
  mathSourceCount,
} from './math';

function plot(over: Partial<ScopePlot> = {}): ScopePlot {
  return {
    id: 1,
    elementId: 5,
    value: 'voltage',
    manScale: null,
    manVPosition: 0,
    acCoupled: false,
    measurements: null,
    origValueToken: null,
    origElementIndex: null,
    ...over,
  };
}

function scopeWith(plots: ScopePlot[]): Scope {
  return {
    id: 1,
    raw: null,
    plots,
    speed: 10,
    position: 0,
    manualScale: false,
    maxScale: false,
    label: '',
    manDivisions: 8,
    showScale: false,
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
    trigger: { mode: 'freeRun', edge: 'rising', level: 0, holdoff: 0, sourcePlotId: null },
  };
}

/** Interleaved rings: one [min, max] pair per column. */
const ring = (...pairs: [number, number][]) => new Float32Array(pairs.flat());

describe('math trace arithmetic', () => {
  const a = ring([0, 2], [-1, 1]);
  const b = ring([1, 3], [-2, 0]);

  it('sums and differences keep the envelope', () => {
    expect(Array.from(combineMath('add', a, b))).toEqual([1, 5, -3, 1]);
    // A's low minus B's high, A's high minus B's low.
    expect(Array.from(combineMath('sub', a, b))).toEqual([-3, 1, -1, 3]);
  });

  it('multiplies the four corner products for the true extremes', () => {
    // Column 0 corners: 0, 0, 2, 6 -> [0, 6].
    // Column 1 corners: 2, 0, -2, 0 -> [-2, 2].
    expect(Array.from(combineMath('mul', a, b))).toEqual([0, 6, -2, 2]);
  });

  it('stops at the shorter ring', () => {
    expect(combineMath('add', a, ring([1, 1])).length).toBe(2);
  });

  it('differentiates the midline per second, starting on the axis', () => {
    const d = derivativeMath(ring([0, 2], [1, 3], [5, 5]), 0.5);
    // Midlines 1, 2, 5: slopes 2 and 6 per second.
    expect(Array.from(d)).toEqual([0, 0, 2, 2, 6, 6]);
  });

  it('reports the operation names and source counts', () => {
    expect(mathOpLabel('add')).toBe('A+B');
    expect(mathOpLabel('derivative')).toBe('d/dt');
    expect(mathSourceCount('derivative')).toBe(1);
    expect(mathSourceCount('mul')).toBe(2);
  });
});

describe('math draw source', () => {
  const aPlot = plot({ id: 10 });
  const bPlot = plot({ id: 11, value: 'current' });
  const math = plot({
    id: 12,
    elementId: null,
    math: { op: 'add', a: 10, b: 11 },
    value: 'voltage',
  });
  const delegate: ScopeDrawSource = {
    time: 0,
    scopeIndexOf: (id) => (id === 10 ? 0 : id === 11 ? 1 : undefined),
    scopeData: (i) =>
      i === 0 ? ring([0, 1], [2, 3]) : i === 1 ? ring([1, 1], [1, 1]) : new Float32Array(),
    scopeDiverged: () => false,
    triggerInfo: () => ({
      columns: 0,
      snapshot_start: 0,
      start_index: 0,
      state: 0,
      time: 0,
      triggered: false,
      valid_count: 0,
      waiting: false,
      written: 0,
      free: () => {},
    }),
    recentSamples: () => new Float32Array(0),
  };

  it('returns the delegate untouched when there are no math plots', () => {
    const plain = scopeWith([aPlot, bPlot]);
    expect(mathScopeSource(delegate, plain, 1e-5)).toBe(delegate);
  });

  it('gives a math plot a synthetic index and the combined ring', () => {
    const source = mathScopeSource(delegate, scopeWith([aPlot, bPlot, math]), 1e-5);
    expect(source.scopeIndexOf(10)).toBe(0);
    const index = source.scopeIndexOf(12);
    expect(index).toBeGreaterThanOrEqual(1_000_000_000);
    expect(Array.from(source.scopeData(index!))).toEqual([1, 2, 3, 4]);
    expect(source.scopeDiverged(index!)).toBe(false);
    expect(source.recentSamples(index!).length).toBe(0);
    expect(source.triggerInfo(index!, 100).triggered).toBe(false);
  });

  it('derives a derivative from one source', () => {
    const d = plot({ id: 13, elementId: null, math: { op: 'derivative', a: 10, b: -1 }, value: 'voltage' });
    const source = mathScopeSource(delegate, scopeWith([aPlot, d]), 1);
    const data = source.scopeData(source.scopeIndexOf(13)!)!;
    // Midlines 0.5 and 2.5: a slope of 2 per second at timeStep 1 with speed 10
    // means seconds per column 10, so just 0.2.
    expect(data[0]).toBe(0);
    expect(data[2]).toBeCloseTo(0.2, 6);
  });
});
