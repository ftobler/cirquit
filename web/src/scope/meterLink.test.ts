import { describe, expect, it } from 'vitest';
import type { Scope, ScopePlot } from '../engine/scopeModel';
import { makeTheme } from '../render/draw';
import { MAX_METER_TRACES, meterTracesByElement } from './meterLink';

function plot(over: Partial<ScopePlot> = {}): ScopePlot {
  return {
    id: 1,
    elementId: 7,
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

function scopeOf(over: Partial<Scope> = {}): Scope {
  return {
    id: 1,
    raw: null,
    plots: [plot()],
    speed: 64,
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
    ...over,
  };
}

const theme = makeTheme();

describe('meter link markers', () => {
  it('maps each reading trace to its element in scope order', () => {
    const a = scopeOf({
      id: 1,
      label: 'Supply',
      plots: [plot({ id: 10, elementId: 7, value: 'voltage' })],
    });
    const b = scopeOf({
      id: 2,
      plots: [
        plot({ id: 20, elementId: 7, value: 'current' }),
        plot({ id: 21, elementId: 9, value: 'voltage' }),
      ],
    });
    const map = meterTracesByElement([a, b], theme);
    expect(map.get(7)?.map((t) => [t.plotId, t.scopeId])).toEqual([
      [10, 1],
      [20, 2],
    ]);
    expect(map.get(7)?.[0].label).toBe('Supply');
    expect(map.get(7)?.[0].unit).toBe('V');
    expect(map.get(7)?.[1].unit).toBe('A');
    expect(map.get(9)?.map((t) => t.plotId)).toEqual([21]);
    // The fallback label numbers the scope in dock order.
    expect(map.get(7)?.[1].label).toBe('Scope 2');
  });

  it('uses the trace colour, including a per-trace override', () => {
    const scope = scopeOf({
      plots: [plot({ id: 10, colorOverride: '#123456', elementId: 7 })],
    });
    expect(meterTracesByElement([scope], theme).get(7)?.[0].color).toBe('#123456');
  });

  it('skips hidden, raw-only and math plots and caps the stack', () => {
    const scope = scopeOf({
      showV: false,
      plots: [
        plot({ id: 1, elementId: 7, value: 'voltage' }),
        plot({ id: 2, elementId: 7, value: null }),
        { ...plot({ id: 3, elementId: null, value: 'voltage' }), math: { op: 'add', a: 1, b: 1 } },
        plot({ id: 4, elementId: 7, value: 'power' }),
      ],
    });
    expect(meterTracesByElement([scope], theme).get(7)?.map((t) => t.plotId)).toEqual([4]);

    const many = scopeOf({
      plots: Array.from({ length: 7 }, (_, i) =>
        plot({ id: i + 1, elementId: 7, value: 'power' }),
      ),
    });
    expect(meterTracesByElement([many], theme).get(7)).toHaveLength(MAX_METER_TRACES);
  });
});
