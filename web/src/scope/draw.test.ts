import { describe, expect, it } from 'vitest';
import type { Scope, ScopePlot, SimEngine } from '../engine/simulator';
import { isDrawable, triggerTimeAnchor, visiblePlotsOf } from './draw';

/** A minimal scope over the given plots, with the visibility flags to test. */
const scopeOf = (plots: ScopePlot[], overrides: Partial<Scope> = {}): Scope => ({
  id: 1,
  raw: null,
  plots,
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
  showElmInfo: false,
  showI: true,
  showV: true,
  scaleV: 20,
  scaleA: 0.05,
  trigger: { mode: 'freeRun', edge: 'rising', level: 0 },
  ...overrides,
});

const plot = (id: number, value: ScopePlot['value']): ScopePlot => ({
  id,
  elementId: id,
  value,
  manScale: null,
  manVPosition: 0,
  acCoupled: false,
});

describe('visiblePlotsOf', () => {
  it('shows every plot when showV and showI are on', () => {
    const scope = scopeOf([plot(1, 'voltage'), plot(2, 'current'), plot(3, 'power')]);
    expect(visiblePlotsOf(scope).map((p) => p.id)).toEqual([1, 2, 3]);
  });

  it('hides voltage plots when showV is off and current plots when showI is off', () => {
    const scope = scopeOf([plot(1, 'voltage'), plot(2, 'current'), plot(3, 'power')], {
      showV: false,
    });
    expect(visiblePlotsOf(scope).map((p) => p.id)).toEqual([2, 3]);
    expect(visiblePlotsOf({ ...scope, showV: true, showI: false }).map((p) => p.id)).toEqual([
      1, 3,
    ]);
  });

  it('always shows power and charge plots, whatever the flags', () => {
    const scope = scopeOf([plot(1, 'voltage'), plot(2, 'power'), plot(3, 'charge')], {
      showV: false,
      showI: false,
    });
    expect(visiblePlotsOf(scope).map((p) => p.id)).toEqual([2, 3]);
  });

  it('shows every plot in X-Y mode, like upstream calcVisiblePlots 2D branch', () => {
    const scope = scopeOf([plot(1, 'voltage'), plot(2, 'current')], {
      plotXY: true,
      showV: false,
    });
    expect(visiblePlotsOf(scope).map((p) => p.id)).toEqual([1, 2]);
  });

  it('a visible-list index does not alias a plot hidden by showV', () => {
    // The manual-scale drag stores the selectPlotAt result, an index into the
    // visible list, and must resolve it back through that same list: indexing
    // the full `scope.plots` would grab the hidden voltage trace instead.
    const scope = scopeOf([plot(1, 'voltage'), plot(2, 'current')], { showV: false });
    const visible = visiblePlotsOf(scope).filter(isDrawable);
    expect(visible[0].id).toBe(2);
    expect(scope.plots[0].id).toBe(1);
  });
});

/** Minimal engine facade: scopeIndexOf and a triggerInfo that records the
 *  index it was asked for, so the anchor test can see which trace anchored. */
const anchorEngine = (
  indexOf: (plotId: number) => number | undefined,
): { engine: SimEngine; called: number[] } => {
  const called: number[] = [];
  const engine = {
    scopeIndexOf: indexOf,
    triggerInfo: (index: number) => {
      called.push(index);
      return { triggered: true, time: 42, free: () => {} };
    },
  } as unknown as SimEngine;
  return { engine, called };
};

describe('triggerTimeAnchor', () => {
  it('returns null for a free-run scope without touching the engine', () => {
    const { engine, called } = anchorEngine(() => 0);
    const scope = scopeOf([plot(1, 'voltage')]);
    expect(triggerTimeAnchor(engine, scope, 100)).toBeNull();
    expect(called).toEqual([]);
  });

  it('anchors off the first visible plot, not scope.plots[0], when plot 0 is hidden', () => {
    // plot 0 is a voltage trace hidden by showV; the anchored window is drawn
    // from the visible current trace (id 2), whose engine index is 0.
    const { engine, called } = anchorEngine((id) => (id === 1 ? 5 : 0));
    const scope = scopeOf([plot(1, 'voltage'), plot(2, 'current')], {
      showV: false,
      trigger: { mode: 'normal', edge: 'rising', level: 0 },
    });
    expect(triggerTimeAnchor(engine, scope, 100)).toEqual({ time: 42 });
    expect(called).toEqual([0]);
  });

  it('skips a null-value plot that is never drawable', () => {
    // The null-value trace is preserved via its raw line only, so it is never
    // registered; the anchor must land on the first drawable trace after it.
    const { engine, called } = anchorEngine((id) => (id === 2 ? 0 : undefined));
    const scope = scopeOf([plot(1, null), plot(2, 'voltage'), plot(3, 'current')], {
      trigger: { mode: 'normal', edge: 'rising', level: 0 },
    });
    expect(scope.plots[0].id).toBe(1);
    expect(triggerTimeAnchor(engine, scope, 100)).toEqual({ time: 42 });
    expect(called).toEqual([0]);
  });
});
