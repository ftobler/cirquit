import { describe, expect, it } from 'vitest';
import type { Scope, ScopePlot, ScopeTrigger, ScopeValue } from './scopeModel';
import {
  PLOT_MEASUREMENT_KEYS,
  anyPlotOverrides,
  defaultWidth,
  effectiveMeasurements,
  frameStatsOf,
  measurementsFromScope,
  plotOverridesScope,
  scopeParamsFingerprint,
  scopePlotsToSpecs,
  sharedPlotElement,
} from './scopeModel';

const trigger = (mode: ScopeTrigger['mode'] = 'freeRun'): ScopeTrigger => ({
  mode,
  edge: 'rising',
  level: 0,
});

function makeScope(over: Partial<Scope> = {}): Scope {
  return {
    id: 1,
    raw: null,
    plots: [],
    speed: 64,
    position: 0,
    manualScale: false,
    maxScale: false,
    label: '',
    manDivisions: 4,
    showScale: true,
    showMax: false,
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
    scaleV: 1,
    scaleA: 1,
    trigger: trigger(),
    ...over,
  };
}

function makePlot(over: Partial<ScopePlot> = {}): ScopePlot {
  return {
    id: 1,
    elementId: 10,
    value: 'voltage' as ScopeValue,
    manScale: null,
    manVPosition: 0,
    acCoupled: false,
    measurements: null,
    origValueToken: null,
    origElementIndex: null,
    ...over,
  };
}

describe('scopeModel pure helpers', () => {
  it('PLOT_MEASUREMENT_KEYS lists all nine readouts in per-plot bit order', () => {
    expect(PLOT_MEASUREMENT_KEYS).toEqual([
      'showScale',
      'showMax',
      'showMin',
      'showP2P',
      'showFreq',
      'showRMS',
      'showAverage',
      'showDutyCycle',
      'showPhaseAngle',
    ]);
    expect(PLOT_MEASUREMENT_KEYS).toHaveLength(9);
  });

  it('measurementsFromScope mirrors the scope-level readout flags', () => {
    const scope = makeScope({
      showScale: true,
      showMax: true,
      showMin: false,
      showP2P: true,
      showFreq: false,
      showRMS: true,
      showAverage: false,
      showDutyCycle: true,
      showPhaseAngle: true,
    });
    expect(measurementsFromScope(scope)).toEqual({
      showScale: true,
      showMax: true,
      showMin: false,
      showP2P: true,
      showFreq: false,
      showRMS: true,
      showAverage: false,
      showDutyCycle: true,
      showPhaseAngle: true,
    });
  });

  it('effectiveMeasurements prefers the plot mask but inherits the scope word', () => {
    const scope = makeScope({ showMax: true, showRMS: false });
    const inherited = effectiveMeasurements(scope, makePlot({ measurements: null }));
    expect(inherited.showMax).toBe(true);
    expect(inherited.showRMS).toBe(false);

    const own: ScopePlot['measurements'] = {
      showScale: false,
      showMax: false,
      showMin: false,
      showP2P: false,
      showFreq: false,
      showRMS: true,
      showAverage: false,
      showDutyCycle: false,
      showPhaseAngle: false,
    };
    const masked = effectiveMeasurements(scope, makePlot({ measurements: own }));
    expect(masked.showMax).toBe(false);
    expect(masked.showRMS).toBe(true);
  });

  it('plotOverridesScope is false when inheriting and only when a bit differs', () => {
    const scope = makeScope({ showScale: true });
    expect(plotOverridesScope(scope, makePlot({ measurements: null }))).toBe(false);

    // A mask equal to the inherited word earns no badge.
    const equal = measurementsFromScope(scope);
    expect(plotOverridesScope(scope, makePlot({ measurements: equal }))).toBe(false);

    const differ = { ...equal, showRMS: !equal.showRMS };
    expect(plotOverridesScope(scope, makePlot({ measurements: differ }))).toBe(true);
  });

  it('anyPlotOverrides reports whether any trace differs from the scope word', () => {
    const base = makeScope({ showMax: true });
    const inherited = makePlot({ measurements: null });
    const same = makePlot({ measurements: measurementsFromScope(base) });
    const differ = makePlot({
      measurements: { ...measurementsFromScope(base), showMin: true },
    });

    expect(anyPlotOverrides(makeScope({ showMax: true, plots: [inherited] }))).toBe(false);
    // A mask equal to its own scope word earns no badge.
    expect(anyPlotOverrides(makeScope({ showMax: true, plots: [same] }))).toBe(false);
    expect(anyPlotOverrides(makeScope({ showMax: true, plots: [inherited, differ] }))).toBe(true);
  });

  it('sharedPlotElement returns the common element or null when plots mix', () => {
    const a = makePlot({ elementId: 7 });
    const b = makePlot({ elementId: 7 });
    const c = makePlot({ elementId: 9 });
    expect(sharedPlotElement([a, b])).toBe(7);
    // A raw-only plot (elementId null) carries no opinion.
    expect(sharedPlotElement([a, { ...b, elementId: null }])).toBe(7);
    expect(sharedPlotElement([a, c])).toBe(null);
    expect(sharedPlotElement([])).toBe(null);
  });

  describe('frameStatsOf', () => {
    it('reads a wasm frame result into plain stats', () => {
      let freed = false;
      const result = {
        steps: 3,
        iterations: 12,
        time: 0.0005,
        converged: true,
        error: null,
        failingElementIds: () => new Uint32Array([1, 2, 3]),
        free: () => {
          freed = true;
        },
      };
      const stats = frameStatsOf(result);
      expect(stats).toEqual({
        steps: 3,
        iterations: 12,
        time: 0.0005,
        converged: true,
        error: undefined,
        failingElementIds: [1, 2, 3],
      });
      expect(freed).toBe(true);
    });

    it('converts a wasm panic into an error flag and still frees', () => {
      let freed = false;
      const result = {
        steps: 0,
        iterations: 0,
        time: 0,
        converged: true,
        failingElementIds: () => {
          throw new Error('wasm panic');
        },
        free: () => {
          freed = true;
        },
      };
      const stats = frameStatsOf(result);
      expect(stats.converged).toBe(false);
      expect(stats.error).toContain('wasm panic');
      expect(stats.failingElementIds).toEqual([]);
      expect(freed).toBe(true);
    });
  });

  describe('scopePlotsToSpecs', () => {
    it('emits one spec per resolvable plot in store order', () => {
      const scope = makeScope({
        plots: [
          makePlot({ id: 100, elementId: 1, value: 'voltage' }),
          makePlot({ id: 101, elementId: null, value: 'current' }),
          makePlot({ id: 102, elementId: 2, value: null }),
          makePlot({ id: 103, elementId: 3, value: 'power' }),
        ],
      });
      const specs = scopePlotsToSpecs([scope], {} as never);
      expect(specs.map((s) => s.plotId)).toEqual([100, 103]);
    });

    it('uses scopeSpeed and the resolved width for the ring, doubling when triggered', () => {
      const widthOf = (id: number) => (id === 1 ? 300 : undefined);
      const free = makeScope({
        id: 1,
        speed: 64,
        trigger: trigger('freeRun'),
        plots: [makePlot({ id: 10, elementId: 1, value: 'voltage' })],
      });
      const trig = makeScope({
        id: 2,
        speed: 64,
        trigger: trigger('normal'),
        plots: [makePlot({ id: 20, elementId: 2, value: 'current' })],
      });
      const specs = scopePlotsToSpecs([free, trig], {} as never, widthOf);
      // 300 -> next pow2 512; 500 default -> 512.
      expect(specs[0].columns).toBe(512);
      expect(specs[0].stepsPerColumn).toBe(64);
      // Triggered scope doubles the ring, clamped at 8192.
      expect(specs[1].columns).toBe(1024);
    });

    it('round-trips the static spec fields from each plot', () => {
      const scope = makeScope({
        speed: 128,
        plots: [makePlot({ id: 5, elementId: 42, value: 'current', acCoupled: true })],
      });
      const [spec] = scopePlotsToSpecs([scope], {} as never, () => 500);
      expect(spec).toMatchObject({
        plotId: 5,
        elementId: 42,
        value: 'current',
        stepsPerColumn: 128,
        acCoupled: true,
        displayWidth: 500,
      });
      expect(spec.trigger).toEqual(trigger('freeRun'));
    });
  });

  describe('scopeParamsFingerprint', () => {
    it('encodes id, speed, column count and per-plot coupling', () => {
      const scope = makeScope({
        id: 3,
        speed: 64,
        plots: [
          makePlot({ id: 1, acCoupled: false }),
          makePlot({ id: 2, acCoupled: true }),
        ],
      });
      // 500 -> 512 columns, coupling "01".
      expect(scopeParamsFingerprint([scope], () => 500)).toBe('3:64:512:01');
    });

    it('changes when an acCoupled flag flips', () => {
      const base = makeScope({
        id: 3,
        speed: 64,
        plots: [makePlot({ acCoupled: false }), makePlot({ acCoupled: false })],
      });
      const flipped = makeScope({
        id: 3,
        speed: 64,
        plots: [makePlot({ acCoupled: false }), makePlot({ acCoupled: true })],
      });
      const a = scopeParamsFingerprint([base], () => 500);
      const b = scopeParamsFingerprint([flipped], () => 500);
      expect(a).toBe('3:64:512:00');
      expect(b).toBe('3:64:512:01');
      expect(a).not.toBe(b);
    });

    it('separates scopes with a semicolon and reflects speed', () => {
      const s1 = makeScope({ id: 1, speed: 32, plots: [makePlot()] });
      const s2 = makeScope({ id: 2, speed: 256, plots: [makePlot()] });
      expect(scopeParamsFingerprint([s1, s2], () => 500)).toBe('1:32:512:0;2:256:512:0');
    });
  });

  it('defaultWidth is the fallback scope width', () => {
    expect(defaultWidth(99)).toBe(500);
  });
});
