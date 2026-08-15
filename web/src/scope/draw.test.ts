import { describe, expect, it, vi } from 'vitest';
import type { Scope, ScopePlot, SimEngine } from '../engine/simulator';
import { makeTheme } from '../render/draw';
import {
  DIVERGED_CAPTION,
  divergedCaption,
  drawScope,
  emptyCursor,
  isDrawable,
  triggerTimeAnchor,
  visiblePlotsOf,
  type ScopeCursor,
} from './draw';

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

/** An engine facade answering the diverged flag per trace index, for the
 *  caption tests. */
const flagEngine = (diverged: (index: number) => boolean): SimEngine =>
  ({
    scopeIndexOf: (plotId: number) => (plotId === 1 ? 0 : 1),
    scopeDiverged: diverged,
  }) as unknown as SimEngine;

describe('divergedCaption', () => {
  it('returns the warning when any visible trace reports the flag', () => {
    const engine = flagEngine((index) => index === 0);
    const scope = scopeOf([plot(1, 'voltage'), plot(2, 'current')]);
    expect(divergedCaption(engine, scope)).toBe(DIVERGED_CAPTION);
  });

  it('returns null when no visible trace reports the flag', () => {
    expect(divergedCaption(flagEngine(() => false), scopeOf([plot(1, 'voltage')]))).toBeNull();
  });

  it('ignores a diverged trace hidden by showV', () => {
    // The caption maps only the plots that would actually draw: a voltage
    // trace hidden by showV is not on the canvas, so its flag stays silent.
    const engine = flagEngine((index) => index === 0);
    const scope = scopeOf([plot(1, 'voltage'), plot(2, 'current')], { showV: false });
    expect(divergedCaption(engine, scope)).toBeNull();
  });

  it('skips a plot the engine never registered', () => {
    const engine = {
      scopeIndexOf: () => undefined,
      scopeDiverged: () => true,
    } as unknown as SimEngine;
    expect(divergedCaption(engine, scopeOf([plot(1, 'voltage')]))).toBeNull();
  });
});

/** Minimal canvas stub recording every drawn text, enough for drawScope. */
const mkCtx = (): { ctx: CanvasRenderingContext2D; texts: string[] } => {
  const texts: string[] = [];
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    lineCap: '',
    lineJoin: '',
    globalAlpha: 1,
    font: '',
    textAlign: '',
    textBaseline: '',
    fillRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    arc: vi.fn(),
    setLineDash: vi.fn(),
    fillText: vi.fn((text: string) => {
      texts.push(text);
    }),
    measureText: (text: string) => ({ width: text.length * 6 }),
  } as unknown as CanvasRenderingContext2D;
  return { ctx, texts };
};

/** A free-run scope over one voltage plot, plus an engine that answers the
 *  diverged flag from `scopeData`-shaped traces. */
const captionEngine = (diverged: boolean): SimEngine =>
  ({
    scopeIndexOf: () => 0,
    scopeData: () => new Float32Array([1, 1, 2, 2]),
    scopeDiverged: () => diverged,
  }) as unknown as SimEngine;

describe('drawScope diverged caption', () => {
  const scope = scopeOf([plot(1, 'voltage')]);

  it('draws the warning caption when the engine reports a diverged trace', () => {
    const { ctx, texts } = mkCtx();
    drawScope(ctx, captionEngine(true), scope, 200, 120, emptyCursor(), 0, 5e-6, false, 3);
    expect(texts).toContain(DIVERGED_CAPTION);
  });

  it('does not caption a healthy trace', () => {
    const { ctx, texts } = mkCtx();
    drawScope(ctx, captionEngine(false), scope, 200, 120, emptyCursor(), 0, 5e-6, false, 3);
    expect(texts).not.toContain(DIVERGED_CAPTION);
  });
});

/** Runs `drawScope` while recording the stroke style of every stroke call, so
 *  a test can assert the colour of the last-drawn overlay. */
const strokeColorsOf = (
  engine: SimEngine,
  scope: Scope,
  w: number,
  h: number,
  cursor: ScopeCursor,
): { ctx: CanvasRenderingContext2D; colors: string[] } => {
  const { ctx } = mkCtx();
  const colors: string[] = [];
  const stroke = ctx.stroke;
  ctx.stroke = vi.fn(() => {
    colors.push(ctx.strokeStyle as string);
    stroke();
  }) as unknown as CanvasRenderingContext2D['stroke'];
  drawScope(ctx, engine, scope, w, h, cursor, 0, 5e-6, false, 3);
  return { ctx, colors };
};

/** Whether the settings wheel's circle was drawn: an arc of radius 5 centred
 *  on (18, h-18). No other overlay uses that radius at that corner. */
const wheelDrawn = (ctx: CanvasRenderingContext2D, h: number): boolean =>
  (ctx.arc as ReturnType<typeof vi.fn>).mock.calls.some(
    (call) => call[0] === 18 && call[1] === h - 18 && call[2] === 5,
  );

describe('drawScope settings wheel', () => {
  const scope = scopeOf([plot(1, 'voltage')]);
  const engine = captionEngine(false);

  it('draws a radius-5 circle at the bottom-left corner with eight spokes', () => {
    const { ctx } = strokeColorsOf(engine, scope, 200, 150, emptyCursor());
    const cx = 18;
    const cy = 150 - 18;
    expect(wheelDrawn(ctx, 150)).toBe(true);
    // The spoke start points: four axial out to 8 px, four diagonal to 6 px
    // (Scope.java:526-549).
    const starts = [
      [cx - 8, cy],
      [cx + 8, cy],
      [cx, cy - 8],
      [cx, cy + 8],
      [cx - 6, cy - 6],
      [cx + 6, cy - 6],
      [cx - 6, cy + 6],
      [cx + 6, cy + 6],
    ];
    const moves = (ctx.moveTo as ReturnType<typeof vi.fn>).mock.calls.map((c) => [c[0], c[1]]);
    for (const s of starts) expect(moves).toContainEqual(s);
  });

  it('uses the muted colour normally and the selection colour when hovered', () => {
    const rest = strokeColorsOf(engine, scope, 200, 150, emptyCursor());
    expect(rest.colors[rest.colors.length - 1]).toBe(makeTheme(false).muted);
    const cursor = emptyCursor();
    cursor.hoverSettingsWheel = true;
    const hovered = strokeColorsOf(engine, scope, 200, 150, cursor);
    expect(hovered.colors[hovered.colors.length - 1]).toBe(makeTheme(false).selection);
  });

  it('skips the wheel when the canvas is too small', () => {
    const { ctx } = strokeColorsOf(engine, scope, 80, 80, emptyCursor());
    expect(wheelDrawn(ctx, 80)).toBe(false);
  });
});
