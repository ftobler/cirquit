import { describe, expect, it, vi } from 'vitest';
import type {
  PlotMeasurements,
  Scope,
  ScopePlot,
  ScopeValue,
  SimEngine,
} from '../engine/simulator';
import type { ThemeColors } from '../model/types';
import { makeTheme } from '../render/draw';
import { nextModScale, pruneScaleStates, scaleStateFor } from './scale';
import { PHASE_COLOR } from './spectrum';
import {
  advanceFadeCounter,
  assignColor,
  clearXYPersistence,
  DIVERGED_CAPTION,
  divergedCaption,
  drawGridLines,
  drawScope,
  emptyCursor,
  isDrawable,
  PLOT_COLORS,
  plotColors,
  sameUnits,
  trailFadeAlpha,
  trailSliderToSteps,
  trailStepsToSlider,
  triggerTimeAnchor,
  visiblePlotsOf,
  xyBrightnessAlpha,
  xyColorChannel,
  xyCrossColors,
  xyPairFor,
  type DrawablePlot,
  type PlotTransform,
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
  plotX: 0,
  plotY: 1,
  plotBrightness: -1,
  plotColorR: -1,
  plotColorG: -1,
  plotColorB: -1,
  showPhaseAngle: false,
  trailPersistence: 0,
  showElmInfo: false,
  showI: true,
  showV: true,
  scaleV: 20,
  scaleA: 0.05,
  trigger: { mode: 'freeRun', edge: 'rising', level: 0 },
  ...overrides,
});

/** A fixture plot. A sampled value makes the fixture drawable, matching
 *  draw.ts's DrawablePlot; only a null-value plot is ever not drawable, and it
 *  stays a bare ScopePlot because it is never registered as a trace. */
function plot(id: number, value: null): ScopePlot;
function plot(id: number, value: ScopeValue): DrawablePlot;
function plot(id: number, value: ScopePlot['value']): ScopePlot {
  return {
    id,
    elementId: id,
    value,
    manScale: null,
    manVPosition: 0,
    acCoupled: false,
    measurements: null,
  };
}

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

/** Minimal canvas stub recording every drawn text, enough for drawScope. The
 *  `canvas` stub carries the width the manual-scale header measures its
 *  bullets against. */
const mkCtx = (w = 200, h = 150): { ctx: CanvasRenderingContext2D; texts: string[] } => {
  const texts: string[] = [];
  const ctx = {
    canvas: { width: w, height: h },
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
    drawImage: vi.fn(),
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

describe('drawScope auto-scale window', () => {
  // A ring of 2w columns: the older half (off the left edge of a w-wide
  // canvas) holds a 4 V spike, the drawn half holds a flat 0.01 V.
  const ringEngine = (w: number): SimEngine => {
    const columns = 2 * w;
    const data = new Float32Array(columns * 2);
    for (let i = 0; i < columns; i++) {
      const v = i < columns - w ? 4 : 0.01;
      data[i * 2] = v;
      data[i * 2 + 1] = v;
    }
    return {
      scopeIndexOf: () => 0,
      scopeData: () => data,
      scopeDiverged: () => false,
    } as unknown as SimEngine;
  };

  it('lets the scale come down once a spike has scrolled off the left edge', () => {
    // Upstream's reduce-range check walks only the columns it plotted
    // (Scope.java:875-884). Scanning the whole ring instead would let the
    // off-screen 4 V spike pin the scale at 5 V forever.
    const w = 200;
    const h = 150;
    const p = plot(41, 'voltage');
    const scope = scopeOf([p]);
    pruneScaleStates([]);
    const engine = ringEngine(w);
    for (let frame = 0; frame < 12; frame++) {
      const { ctx } = mkCtx();
      drawScope(ctx, engine, scope, w, h, emptyCursor(), 0, 5e-6, false, 3);
    }
    expect(scaleStateFor(p.id, p.value ?? undefined).gridMax).toBeLessThan(0.2);
  });
});

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

/** Records every drawn text with its baseline y, so a test can assert the
 *  Show Extended Info header stacks one line per info entry at the 15 px pitch
 *  upstream uses (ScopeOverlays.java:179-192). */
const mkCtxTextsY = (
  w = 200,
  h = 150,
): { ctx: CanvasRenderingContext2D; entries: { text: string; y: number }[] } => {
  const entries: { text: string; y: number }[] = [];
  const base = mkCtx(w, h);
  const ctx = {
    ...base.ctx,
    fillText: vi.fn((text: string, _x: number, y: number) => {
      entries.push({ text, y });
    }),
  } as unknown as CanvasRenderingContext2D;
  return { ctx, entries };
};

describe('drawScope showElmInfo header', () => {
  const engine = captionEngine(false);

  it('renders one text line per info line at the 15 px pitch', () => {
    const scope = scopeOf([plot(1, 'voltage')], { showElmInfo: true });
    const { ctx, entries } = mkCtxTextsY();
    drawScope(ctx, engine, scope, 200, 120, emptyCursor(), 0, 5e-6, false, 3, undefined,
      (id) => (id === 1 ? ['Source', 'I = 1 A', 'Vd = 2 V'] : null));
    // The three info lines start at y = 4 and step 15 px (drawInfo line.y).
    const ys = entries
      .filter((e) => e.text === 'Source' || e.text === 'I = 1 A' || e.text === 'Vd = 2 V')
      .map((e) => e.y);
    expect(ys).toEqual([4, 19, 34]);
  });

  it('draws nothing extra when Show Extended Info is off', () => {
    const scope = scopeOf([plot(1, 'voltage')], { showElmInfo: false });
    const { ctx, entries } = mkCtxTextsY();
    drawScope(ctx, engine, scope, 200, 120, emptyCursor(), 0, 5e-6, false, 3, undefined,
      (id) => (id === 1 ? ['Source', 'I = 1 A', 'Vd = 2 V'] : null));
    const texts = entries.map((e) => e.text);
    expect(texts).not.toContain('Source');
    expect(texts).not.toContain('I = 1 A');
    expect(texts).not.toContain('Vd = 2 V');
  });

  it('still renders the block for a scope with no drawable trace', () => {
    // The engine never registered the plot, so plots.length === 0; upstream's
    // empty-plot drawElmInfo branch draws the readout anyway.
    const noTrace = { scopeIndexOf: () => undefined, scopeDiverged: () => false } as unknown as SimEngine;
    const scope = scopeOf([plot(1, 'voltage')], { showElmInfo: true });
    const { ctx, entries } = mkCtxTextsY();
    drawScope(ctx, noTrace, scope, 200, 120, emptyCursor(), 0, 5e-6, false, 3, undefined,
      (id) => (id === 1 ? ['Source', 'P = 1 W'] : null));
    const texts = entries.map((e) => e.text);
    expect(texts).toContain('Source');
    expect(texts).toContain('P = 1 W');
  });
});

/** Every drawScope knob a colour test needs to vary. `dark` is the White
 *  Background flag inverted, `themeColors` the user's Other Options overrides,
 *  and `simTime` matters because the time grid and the cursor are both
 *  anchored on it: at t = 0 no vertical gridline and no cursor lands on the
 *  canvas. */
interface DrawOpts {
  dark?: boolean;
  themeColors?: ThemeColors;
  simTime?: number;
}

/** Runs `drawScope` while recording the stroke style of every `stroke()` and
 *  the fill style of every `fill()`/`fillText()`, so a test can assert the
 *  colour of any overlay. */
const recordDraw = (
  engine: SimEngine,
  scope: Scope,
  w: number,
  h: number,
  cursor: ScopeCursor,
  opts: DrawOpts = {},
): { ctx: CanvasRenderingContext2D; strokes: string[]; fills: string[] } => {
  const { ctx } = mkCtx(w, h);
  const strokes: string[] = [];
  const fills: string[] = [];
  const stroke = ctx.stroke;
  ctx.stroke = vi.fn(() => {
    strokes.push(ctx.strokeStyle as string);
    stroke();
  }) as unknown as CanvasRenderingContext2D['stroke'];
  const fill = ctx.fill;
  ctx.fill = vi.fn(() => {
    fills.push(ctx.fillStyle as string);
    fill();
  }) as unknown as CanvasRenderingContext2D['fill'];
  const fillText = ctx.fillText;
  ctx.fillText = vi.fn((text: string, x: number, y: number) => {
    fills.push(ctx.fillStyle as string);
    fillText(text, x, y);
  }) as unknown as CanvasRenderingContext2D['fillText'];
  drawScope(
    ctx,
    engine,
    scope,
    w,
    h,
    cursor,
    opts.simTime ?? 0,
    5e-6,
    opts.dark ?? false,
    3,
    opts.themeColors,
  );
  return { ctx, strokes, fills };
};

const strokeColorsOf = (
  engine: SimEngine,
  scope: Scope,
  w: number,
  h: number,
  cursor: ScopeCursor,
  opts: DrawOpts = {},
): { ctx: CanvasRenderingContext2D; colors: string[] } => {
  const r = recordDraw(engine, scope, w, h, cursor, opts);
  return { ctx: r.ctx, colors: r.strokes };
};

/** Overrides with only `positiveColor` set; the other four keys are required
 *  by `ThemeColors` and a null keeps the palette value. */
const onlyPositive = (color: string): ThemeColors => ({
  positiveColor: color,
  negativeColor: null,
  neutralColor: null,
  selectionColor: null,
  currentColor: null,
});

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

/** An engine answering two traces (voltage at index 0, current at index 1)
 *  with fixed snapshot data, enough for the FFT phase overlay. */
const twoTraceEngine = (vData: number[], iData: number[]): SimEngine =>
  ({
    scopeIndexOf: (id: number) => (id === 1 ? 0 : 1),
    scopeData: (index: number) =>
      index === 0 ? new Float32Array(vData) : new Float32Array(iData),
    scopeDiverged: () => false,
  }) as unknown as SimEngine;

describe('drawScope phase overlay', () => {
  const v = [1, 1, 2, 2, 3, 3, 4, 4];
  const i = [1, 1, 2, 2, 3, 3, 4, 4];

  it('draws phase lines when showPhaseAngle is on and both a V and an I plot exist', () => {
    const scope = scopeOf([plot(1, 'voltage'), plot(2, 'current')], {
      fftPlot: true,
      showPhaseAngle: true,
    });
    const { colors } = strokeColorsOf(twoTraceEngine(v, i), scope, 200, 120, emptyCursor());
    expect(colors).toContain(PHASE_COLOR);
  });

  it('draws phase lines with the spectrum off, like upstream drawPhaseAngle on every frame', () => {
    // The phase band is independent of the Show Spectrum box: upstream calls
    // drawPhaseAngle from ScopeOverlays.draw unconditionally
    // (ScopeOverlays.java:218-219).
    const scope = scopeOf([plot(1, 'voltage'), plot(2, 'current')], {
      showPhaseAngle: true,
    });
    const { colors } = strokeColorsOf(twoTraceEngine(v, i), scope, 200, 120, emptyCursor());
    expect(colors).toContain(PHASE_COLOR);
  });

  it('draws no phase lines with showPhaseAngle off', () => {
    const scope = scopeOf([plot(1, 'voltage'), plot(2, 'current')], { fftPlot: true });
    const { colors } = strokeColorsOf(twoTraceEngine(v, i), scope, 200, 120, emptyCursor());
    expect(colors).not.toContain(PHASE_COLOR);
  });

  it('draws no phase lines when only one of the two plots exists', () => {
    const scope = scopeOf([plot(1, 'voltage')], { fftPlot: true, showPhaseAngle: true });
    const { colors } = strokeColorsOf(twoTraceEngine(v, i), scope, 200, 120, emptyCursor());
    expect(colors).not.toContain(PHASE_COLOR);
  });

  it('draws no phase lines for a near-zero signal, the 1e-8 fundamental guard', () => {
    // All-zero snapshots give an all-zero spectrum, so the fundamental
    // magnitude scan bails and no noise phase lines paint
    // (ScopeFFT.java:149-150).
    const scope = scopeOf([plot(1, 'voltage'), plot(2, 'current')], { showPhaseAngle: true });
    const { colors } = strokeColorsOf(
      twoTraceEngine([0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0]),
      scope,
      200,
      120,
      emptyCursor(),
    );
    expect(colors).not.toContain(PHASE_COLOR);
  });
});

describe('trail persistence', () => {
  it('trailSliderToSteps maps the slider logarithmically', () => {
    expect(trailSliderToSteps(0)).toBe(0);
    expect(trailSliderToSteps(-3)).toBe(0);
    expect(trailSliderToSteps(10)).toBe(10);
    expect(trailSliderToSteps(20)).toBe(100);
  });

  it('trailStepsToSlider inverts the mapping', () => {
    expect(trailStepsToSlider(0)).toBe(0);
    expect(trailStepsToSlider(-5)).toBe(0);
    expect(trailStepsToSlider(10)).toBe(10);
    expect(trailStepsToSlider(100)).toBe(20);
    expect(trailStepsToSlider(trailSliderToSteps(15))).toBe(15);
  });

  it('a zero persistence keeps the legacy hard-coded fade', () => {
    expect(trailFadeAlpha(0, 5e-6, 42, -1)).toEqual({ alpha: 0.01, lastTrailSimTime: -1 });
    expect(trailFadeAlpha(0, 5e-6, 42, 40)).toEqual({ alpha: 0.01, lastTrailSimTime: 40 });
  });

  it('fades one frame in three, upstream cadence', () => {
    // The locus is re-stroked at full brightness every frame, so the fade
    // cadence is what sets the trail length: upstream's alphaCounter lets one
    // frame in three through (ScopePlot2d.java:190-192).
    let counter = 0;
    const faded: number[] = [];
    for (let frame = 1; frame <= 9; frame++) {
      const tick = advanceFadeCounter(counter);
      counter = tick.counter;
      if (tick.fade) faded.push(frame);
    }
    expect(faded).toEqual([3, 6, 9]);
  });

  it('a positive persistence fades with timeConst = persistence * timeStep', () => {
    // elapsed == timeConst: alpha = 1 - 1/e.
    const r = trailFadeAlpha(10, 1e-3, 0.01, 0);
    expect(r.alpha).toBeCloseTo(1 - Math.exp(-1), 9);
    // The fade is visible, so the last-trail time advances to simTime.
    expect(r.lastTrailSimTime).toBe(0.01);
  });

  it('holds the last-trail time back while the fade is sub-pixel', () => {
    // elapsed 1e-6 s against timeConst 0.01 s: alpha ~ 1e-4, below 3/255, so
    // the time stays put and the canvas is not repainted.
    const r = trailFadeAlpha(10, 1e-3, 0.000001, 0);
    expect(r.alpha).toBe(0);
    expect(r.lastTrailSimTime).toBe(0);
  });
});

describe('assignColor', () => {
  const dark = makeTheme();
  const light = makeTheme(false);

  it('gives the first plot of a category its theme colour', () => {
    // ScopePlot.assignColor's count == 0 branch (ScopePlot.java:148-159):
    // voltage takes positiveColor, current yellow, anything else white.
    expect(assignColor('voltage', 0, dark)).toBe('#00ff00');
    expect(assignColor('current', 0, dark)).toBe('#ffff00');
    expect(assignColor('power', 0, dark)).toBe('#ffffff');
    // Upstream's printable branch hardcodes black for the other bucket, which
    // is exactly what the light theme's whiteColor already is.
    expect(assignColor('power', 0, light)).toBe('#000000');
  });

  it('walks the fixed palette from the second plot on, and wraps after eight', () => {
    expect(PLOT_COLORS).toHaveLength(8);
    expect(assignColor('voltage', 1, dark)).toBe('#ff0000');
    expect(assignColor('current', 8, dark)).toBe('#00ffff');
    expect(assignColor('power', 9, dark)).toBe('#ff0000');
  });
});

describe('plotColors', () => {
  const dark = makeTheme();

  it('counts per category, so a second voltage plot does not take the current slot', () => {
    const scope = scopeOf([
      plot(1, 'voltage'),
      plot(2, 'voltage'),
      plot(3, 'current'),
      plot(4, 'voltage'),
      plot(5, 'power'),
    ]);
    const colors = plotColors(scope, dark);
    expect([1, 2, 3, 4, 5].map((id) => colors.get(id))).toEqual([
      '#00ff00',
      '#ff0000',
      '#ffff00',
      '#ff8000',
      '#ffffff',
    ]);
  });

  it('skips hidden plots without disturbing the visible counters', () => {
    // Upstream advances vc/ac/oc only inside the showV/showI branches
    // (Scope.java:293-308), so turning the current trace off must not shift
    // the voltage traces' colours.
    const scope = scopeOf([plot(1, 'voltage'), plot(2, 'current'), plot(3, 'voltage')], {
      showI: false,
    });
    const colors = plotColors(scope, dark);
    expect(colors.has(2)).toBe(false);
    expect(colors.get(1)).toBe('#00ff00');
    expect(colors.get(3)).toBe('#ff0000');
  });

  it('is a function of position, never of the plot id', () => {
    // The regression test for the old `plot.id % 7` palette: plot ids are
    // session-unique handles, so indexing a palette by one repainted the same
    // saved circuit differently on every load.
    const a = plotColors(scopeOf([plot(1, 'voltage'), plot(2, 'power')]), dark);
    const b = plotColors(scopeOf([plot(97, 'voltage'), plot(3, 'power')]), dark);
    expect([...a.values()]).toEqual([...b.values()]);
  });

  it('assigns a colour to every plot in X-Y mode', () => {
    // Upstream's 2D branch skips assignColor and leaves plot.color null
    // (Scope.java:311-314), which its own manual-scale bullets would then
    // draw with; the port assigns over the whole list instead.
    const scope = scopeOf([plot(1, 'voltage'), plot(2, 'current')], {
      plotXY: true,
      showV: false,
    });
    expect(plotColors(scope, dark).size).toBe(2);
  });
});

describe('drawScope trace and grid colours', () => {
  const engine = twoTraceEngine([1, 1, 2, 2], [1, 1, 2, 2]);
  // Far enough into the run that the whole 200 px window has elapsed, so the
  // time gridlines and the cursor both land on the canvas.
  const simTime = 0.064;

  it('draws two voltage plots in green and red, not two greens', () => {
    // drawTrace strokes twice per plot, the midline polyline and the min/max
    // spans, so one green trace is two green strokes.
    const scope = scopeOf([plot(1, 'voltage'), plot(2, 'voltage')]);
    const { colors } = strokeColorsOf(engine, scope, 200, 120, emptyCursor(), { dark: true });
    expect(colors.filter((c) => c === '#00ff00')).toHaveLength(2);
    expect(colors.filter((c) => c === PLOT_COLORS[0])).toHaveLength(2);
  });

  it('draws the scope grid in the light palette with White Background on', () => {
    const scope = scopeOf([plot(1, 'voltage')]);
    const theme = makeTheme(false);
    const { colors } = strokeColorsOf(engine, scope, 200, 120, emptyCursor(), { simTime });
    expect(colors).toContain(theme.scopeGridMinor);
    expect(colors).toContain(theme.scopeGridMajor);
    // The dark-only literals the grid used to carry unconditionally.
    expect(colors).not.toContain('#1b2230');
    expect(colors).not.toContain('#2b3648');
  });
});

describe('drawScope cursor colours', () => {
  const engine = twoTraceEngine([1, 1, 2, 2], [1, 1, 2, 2]);
  const scope = scopeOf([plot(1, 'voltage')]);
  const simTime = 0.064;
  const hovering = (dragStartTime = -1): ScopeCursor => ({
    ...emptyCursor(),
    hover: true,
    cursorTime: 0.032,
    dragStartTime,
  });

  it('strokes the cursor line in whiteColor, so it flips to black on white', () => {
    // Scope.java:1059 draws it in CircuitElm.whiteColor; a hardcoded white
    // line is invisible with White Background on.
    const light = strokeColorsOf(engine, scope, 200, 120, hovering(), { simTime });
    expect(light.colors).toContain('#000000');
    expect(light.colors).not.toContain('#ffffff');
    const dark = strokeColorsOf(engine, scope, 200, 120, hovering(), { simTime, dark: true });
    expect(dark.colors).toContain('#ffffff');
  });

  it('strokes the drag-start line in the theme-dependent lightGray', () => {
    // Upstream's lightGrayColor is black when printable (Scope.java:1024,
    // ImageExporter.java:192). On the light theme it therefore shares the
    // cursor line's black, so the test counts the extra black stroke the drag
    // adds rather than looking for a distinct colour.
    const blacks = (cursor: ScopeCursor) =>
      strokeColorsOf(engine, scope, 200, 120, cursor, { simTime }).colors.filter(
        (c) => c === '#000000',
      ).length;
    expect(blacks(hovering(0.048))).toBe(blacks(hovering()) + 1);
    const dark = { simTime, dark: true };
    expect(strokeColorsOf(engine, scope, 200, 120, hovering(0.048), dark).colors).toContain(
      '#c0c0c0',
    );
    expect(strokeColorsOf(engine, scope, 200, 120, hovering(), dark).colors).not.toContain(
      '#c0c0c0',
    );
  });
});

/** The X-Y trail lives on an offscreen canvas `drawXY` builds through
 *  `document.createElement`. The test environment is node with no DOM, so the
 *  canvas is stubbed and its recorder handed to the body: the locus stroke and
 *  the fade fill land there, never on the visible context. The stub context
 *  itself rides along so a test can watch globalAlpha around each stroke. */
const withTrailCanvas = <T>(
  body: (trail: {
    strokes: string[];
    fills: string[];
    pctx: { globalAlpha: number; stroke: (...args: unknown[]) => void };
  }) => T,
): T => {
  const strokes: string[] = [];
  const fills: string[] = [];
  const pctx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    globalAlpha: 1,
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    fillRect: vi.fn(() => {
      fills.push(pctx.fillStyle);
    }),
    stroke: vi.fn(() => {
      strokes.push(pctx.strokeStyle);
    }),
  };
  const host = globalThis as { document?: unknown };
  const previous = 'document' in host ? host.document : undefined;
  const had = 'document' in host;
  host.document = { createElement: () => ({ width: 0, height: 0, getContext: () => pctx }) };
  try {
    return body({ strokes, fills, pctx });
  } finally {
    if (had) host.document = previous;
    else delete host.document;
  }
};

describe('drawScope X-Y colours', () => {
  const xyEngine = (): SimEngine =>
    ({
      scopeIndexOf: (id: number) => (id === 1 ? 0 : 1),
      scopeData: () => new Float32Array([1, 1, 2, 2]),
      scopeDiverged: () => false,
      recentSamples: (index: number) => new Float32Array(index === 0 ? [0, 1, 2, 3] : [3, 2, 1, 0]),
    }) as unknown as SimEngine;

  const xyScope = () => scopeOf([plot(1, 'voltage'), plot(2, 'voltage')], { plotXY: true });

  it('strokes the locus in whiteColor and fades to the theme background', () => {
    // ScopePlot2d.java:85 and 210-217: the locus and the fade are the black/
    // white pair, so a White Background scope fades to white, not to the dark
    // panel colour the port used to paint over it.
    clearXYPersistence(1);
    const trail = withTrailCanvas((rec) => {
      // The fade runs one frame in three (advanceFadeCounter), so three frames
      // are needed before any background repaint happens.
      for (let frame = 0; frame < 3; frame++) {
        recordDraw(xyEngine(), xyScope(), 200, 150, emptyCursor());
      }
      return rec;
    });
    expect(trail.strokes).toContain('#000000');
    expect(trail.fills).toHaveLength(1);
    // The alpha is time-dependent, so only the colour prefix is pinned.
    expect(trail.fills[0].startsWith('rgba(255, 255, 255')).toBe(true);
  });

  it('draws the centre cross in the positive colour on both axes in X-Y mode', () => {
    clearXYPersistence(1);
    const theme = makeTheme(false);
    const colors = withTrailCanvas(
      () => strokeColorsOf(xyEngine(), xyScope(), 200, 150, emptyCursor()).colors,
    );
    expect(colors.filter((c) => c === theme.positive)).toHaveLength(2);
  });

  it('keeps upstream yellow for the vertical line of the V-vs-I 2D mode', () => {
    // Only reachable through the helper: the port folds upstream's
    // plot2d.enabled and plot2d.plotXY into one flag, so drawScope always
    // takes the X-Y branch (ScopePlot2d.java:226-230).
    const theme = makeTheme(false);
    expect(xyCrossColors(true, theme)).toEqual({
      horizontal: theme.positive,
      vertical: theme.positive,
    });
    expect(xyCrossColors(false, makeTheme())).toEqual({
      horizontal: '#00ff00',
      vertical: '#ffff00',
    });
  });
});

describe('drawScope spectrum colours', () => {
  it('draws the FFT trace and its labels in upstream red', () => {
    // ScopeFFT.java:35-38, 69, 93-98 draw the trace and every label in plain
    // red; the port used a lighter #ff5555.
    const scope = scopeOf([plot(1, 'voltage')], { fftPlot: true });
    const engine = twoTraceEngine([1, 1, 2, 2], [1, 1, 2, 2]);
    const { strokes, fills } = recordDraw(engine, scope, 200, 120, emptyCursor());
    expect(strokes).toContain('#ff0000');
    expect(strokes).not.toContain('#ff5555');
    expect(fills).toContain('#ff0000');
    expect(fills).not.toContain('#ff5555');
  });
});

describe('drawScope colour overrides', () => {
  it('routes a custom positiveColor into both the trace and the header bullet', () => {
    // The manual-scale header bullet used to call the colour helper without
    // the user's overrides, so a custom trace colour got a stock green bullet
    // beside it. Both now read the one per-frame assignment map.
    const scope = scopeOf([plot(1, 'voltage')], { manualScale: true });
    const engine = twoTraceEngine([1, 1, 2, 2], [1, 1, 2, 2]);
    const { strokes, fills } = recordDraw(engine, scope, 200, 150, emptyCursor(), {
      themeColors: onlyPositive('#123456'),
    });
    expect(strokes).toContain('#123456');
    expect(fills).toContain('#123456');
  });
});

describe('xyPairFor', () => {
  const indexById = (id: number) => id - 1;
  const rawOnlyPlot: ScopePlot = {
    id: 99,
    elementId: null,
    value: null,
    manScale: null,
    manVPosition: 0,
    acCoupled: false,
    measurements: null,
  };

  it('defaults to the first two samplable plots', () => {
    const scope = scopeOf([plot(1, 'voltage'), plot(2, 'current')], { plotXY: true });
    const pair = xyPairFor(scope, indexById)!;
    expect(pair.x.plot.id).toBe(1);
    expect(pair.y.plot.id).toBe(2);
  });

  it('swapped plotX/plotY draws the other two traces', () => {
    const scope = scopeOf([plot(1, 'voltage'), plot(2, 'current')], {
      plotXY: true,
      plotX: 1,
      plotY: 0,
    });
    const pair = xyPairFor(scope, indexById)!;
    expect(pair.x.plot.id).toBe(2);
    expect(pair.y.plot.id).toBe(1);
  });

  it('indexes are positions in the full plot list, upstream style', () => {
    const scope = scopeOf([plot(1, 'voltage'), plot(2, 'current'), plot(3, 'power')], {
      plotXY: true,
      plotX: 2,
    });
    const pair = xyPairFor(scope, indexById)!;
    expect(pair.x.plot.value).toBe('power');
    expect(pair.y.plot.id).toBe(2);
  });

  it('defaults draw the first two samplable plots even with a raw-only first plot', () => {
    // The reviewer's case: positions and samplable order disagree, but the
    // untouched defaults must keep drawing exactly the old hardcoded pair,
    // A vs B, not A against itself.
    const raw: ScopePlot = {
      id: 99,
      elementId: null,
      value: null,
      manScale: null,
      manVPosition: 0,
      acCoupled: false,
      measurements: null,
    };
    const scope = scopeOf([raw, plot(1, 'voltage'), plot(2, 'current')], { plotXY: true });
    const pair = xyPairFor(scope, indexById)!;
    expect(pair.x.plot.id).toBe(1);
    expect(pair.y.plot.id).toBe(2);
  });

  it('axes on raw-only plots fall back to the hardcoded samplable pair', () => {
    // A plot whose value token has no engine meaning never registers a trace,
    // so axes parked on those slots fall through to the first two samplable
    // plots rather than drawing nothing.
    const secondRaw: ScopePlot = { ...rawOnlyPlot, id: 98 };
    const scope = scopeOf([rawOnlyPlot, secondRaw, plot(1, 'voltage'), plot(2, 'current')], {
      plotXY: true,
      plotX: 0,
      plotY: 1,
    });
    const pair = xyPairFor(scope, indexById)!;
    expect(pair.x.plot.id).toBe(1);
    expect(pair.y.plot.id).toBe(2);
  });

  it('returns null when nothing can sample', () => {
    const scope = scopeOf([rawOnlyPlot], { plotXY: true });
    expect(xyPairFor(scope, indexById)).toBeNull();
  });
});

describe('X-Y modulators', () => {
  it('nextModScale doubles to contain and never shrinks', () => {
    expect(nextModScale(5, 7)).toBe(10);
    expect(nextModScale(10, 3)).toBe(10);
    expect(nextModScale(5, 20)).toBe(20);
    // A scale that decayed to zero restarts at the default instead of
    // dividing by zero.
    expect(nextModScale(0, 3)).toBe(5);
  });

  it('brightness maps |last| over the grown scale into an alpha', () => {
    expect(xyBrightnessAlpha(-5, 5)).toEqual({ alpha: 1, scale: 5 });
    expect(xyBrightnessAlpha(2.5, 5)).toEqual({ alpha: 0.5, scale: 5 });
    const grown = xyBrightnessAlpha(20, 5);
    expect(grown.scale).toBe(20);
    expect(grown.alpha).toBe(1);
  });

  it('colour channels truncate into 0..255 against their own scale', () => {
    expect(xyColorChannel(5, 5)).toEqual({ channel: 255, scale: 5 });
    // Truncates like upstream's int cast.
    expect(xyColorChannel(2.5, 5)).toEqual({ channel: 127, scale: 5 });
    // Negative samples clamp to black, and an over-range one grows the scale.
    expect(xyColorChannel(-5, 5)).toEqual({ channel: 0, scale: 5 });
    expect(xyColorChannel(20, 5)).toEqual({ channel: 255, scale: 20 });
  });

  it('tints the locus from an RGB modulator plot', () => {
    clearXYPersistence(1);
    const scope = scopeOf([plot(1, 'voltage'), plot(2, 'current')], { plotXY: true });
    scope.plotColorR = 1;
    const engine = {
      scopeIndexOf: (id: number) => (id === 1 ? 0 : 1),
      scopeData: () => new Float32Array([1, 1]),
      scopeDiverged: () => false,
      recentSamples: () => new Float32Array([4, 4]),
    } as unknown as SimEngine;
    const out = withTrailCanvas((rec) => {
      recordDraw(engine, scope, 200, 150, emptyCursor());
      return rec;
    });
    // The modulated stroke is an rgb() triple; the unmodulated default is a
    // hex colour, so the prefix alone tells them apart.
    expect(out.strokes[0]).toMatch(/^rgb\(/);
  });

  it('a set brightness index dims the locus stroke', () => {
    clearXYPersistence(1);
    const scope = scopeOf([plot(1, 'voltage'), plot(2, 'current')], { plotXY: true });
    scope.plotBrightness = 0;
    const engine = {
      scopeIndexOf: () => 0,
      scopeData: () => new Float32Array([1, 1]),
      scopeDiverged: () => false,
      recentSamples: () => new Float32Array([4, 4]),
    } as unknown as SimEngine;
    withTrailCanvas(({ pctx }) => {
      // |last| 4 over the default scale 5 dims to 0.8 during the stroke.
      const seen: number[] = [];
      const orig = pctx.stroke.bind(pctx);
      pctx.stroke = (...args: unknown[]) => {
        seen.push(pctx.globalAlpha);
        orig(...args);
      };
      recordDraw(engine, scope, 200, 150, emptyCursor());
      expect(seen).toContain(0.8);
    });
  });

  it('an out-of-range brightness index leaves the locus fully bright', () => {
    // Upstream's computeAlpha returns 1.0 once the index leaves the plot list
    // (ScopePlot2d.java:171-173); treating the missing sample as 0 would
    // black the whole locus out instead.
    clearXYPersistence(1);
    const scope = scopeOf([plot(1, 'voltage'), plot(2, 'current')], { plotXY: true });
    scope.plotBrightness = 9;
    const engine = {
      scopeIndexOf: () => 0,
      scopeData: () => new Float32Array([1, 1]),
      scopeDiverged: () => false,
      recentSamples: () => new Float32Array([4, 4]),
    } as unknown as SimEngine;
    withTrailCanvas(({ pctx }) => {
      const seen: number[] = [];
      const orig = pctx.stroke.bind(pctx);
      pctx.stroke = (...args: unknown[]) => {
        seen.push(pctx.globalAlpha);
        orig(...args);
      };
      recordDraw(engine, scope, 200, 150, emptyCursor());
      expect(seen).not.toContain(0);
    });
  });
});

/** A measurement mask with every readout off except the named ones. */
const masked = (on: Partial<PlotMeasurements>): PlotMeasurements => ({
  showScale: false,
  showMax: false,
  showMin: false,
  showP2P: false,
  showFreq: false,
  showRMS: false,
  showAverage: false,
  showDutyCycle: false,
  showPhaseAngle: false,
  ...on,
});

describe('drawScope per-trace measurements', () => {
  const sineRing = (period: number, columns = 400): Float32Array => {
    const data = new Float32Array(columns * 2);
    for (let i = 0; i < columns; i++) {
      const v = Math.sin((2 * Math.PI * i) / period);
      data[i * 2] = v;
      data[i * 2 + 1] = v;
    }
    return data;
  };
  // Two voltage traces at different periods, so their frequency strings differ.
  const sineEngine = (): SimEngine =>
    ({
      scopeIndexOf: (id: number) => (id === 1 ? 0 : 1),
      scopeData: (index: number) => (index === 0 ? sineRing(16) : sineRing(24)),
      scopeDiverged: () => false,
    }) as unknown as SimEngine;

  /** Runs drawScope pairing every filled text with its fill style, so a test
   *  can assert which trace colour a readout was painted in. */
  const drawnTexts = (
    engine: SimEngine,
    scope: Scope,
    opts: DrawOpts = {},
  ): { text: string; color: string }[] => {
    const { ctx } = mkCtx(200, 150);
    const out: { text: string; color: string }[] = [];
    const fillText = ctx.fillText;
    ctx.fillText = vi.fn((text: string) => {
      out.push({ text, color: ctx.fillStyle as string });
      (fillText as unknown as (t: string) => void)(text);
    }) as unknown as CanvasRenderingContext2D['fillText'];
    drawScope(
      ctx,
      engine,
      scope,
      200,
      150,
      emptyCursor(),
      opts.simTime ?? 0,
      5e-6,
      opts.dark ?? false,
      3,
      opts.themeColors,
    );
    return out;
  };

  it('draws the Freq readout for plot A alone when only its mask enables it', () => {
    // The user's ask: Freq on the first stacked signal only, not the second.
    const pa = plot(1, 'voltage');
    pa.measurements = masked({ showFreq: true });
    const pb = plot(2, 'voltage');
    const scope = scopeOf([pa, pb], { showMax: false });
    const freqs = drawnTexts(sineEngine(), scope, { dark: true }).filter((e) =>
      e.text.endsWith('Hz'),
    );
    expect(freqs).toHaveLength(1);
    // First voltage trace on the dark theme is green; B's red never appears.
    expect(freqs[0].color).toBe('#00ff00');
  });

  it('a scope-wide flag measures every trace, not just states[0]', () => {
    // The behaviour change this feature makes: both traces now carry their own
    // readouts, each in its own colour and from its own min/max window.
    const scope = scopeOf([plot(1, 'voltage'), plot(2, 'voltage')], {
      showMax: false,
      showFreq: true,
    });
    const freqs = drawnTexts(sineEngine(), scope, { dark: true }).filter((e) =>
      e.text.endsWith('Hz'),
    );
    expect(freqs).toHaveLength(2);
    expect(freqs.map((f) => f.color)).toEqual(['#00ff00', '#ff0000']);
    expect(freqs[0].text).not.toBe(freqs[1].text);
  });

  it('the inherited default Max readout draws per trace with no masks anywhere', () => {
    const scope = scopeOf([plot(1, 'voltage'), plot(2, 'voltage')]);
    const maxes = drawnTexts(sineEngine(), scope, { dark: true }).filter((e) =>
      e.text.startsWith('Max='),
    );
    expect(maxes).toHaveLength(2);
    expect(maxes.map((m) => m.color)).toEqual(['#00ff00', '#ff0000']);
  });

  it('Min keeps its bottom-edge pin inside its own cluster', () => {
    const pa = plot(1, 'voltage');
    pa.measurements = masked({ showMin: true });
    const scope = scopeOf([pa, plot(2, 'voltage')], { showMax: false });
    const mins = drawnTexts(sineEngine(), scope, { dark: true }).filter((e) =>
      e.text.startsWith('Min='),
    );
    expect(mins).toHaveLength(1);
    expect(mins[0].color).toBe('#00ff00');
  });
});

/** A ring engine over `columns` min/max pairs produced by `valueAt`. */
const ringEngine = (valueAt: (i: number) => number, columns = 300): SimEngine => {
  const data = new Float32Array(columns * 2);
  for (let i = 0; i < columns; i++) {
    const v = valueAt(i);
    data[i * 2] = v;
    data[i * 2 + 1] = v;
  }
  return {
    scopeIndexOf: () => 0,
    scopeData: () => data,
    scopeDiverged: () => false,
  } as unknown as SimEngine;
};

describe('drawScope measurement gating', () => {
  const flags = { showMax: false, showRMS: true, showAverage: true, showDutyCycle: true };
  const square = (i: number) => (i % 50 < 25 ? 0 : 1.2);

  it('paints none of the RMS, Average or Duty readouts on a flat DC trace', () => {
    // Upstream draws each readout only when the cycle walk found a span
    // (ScopeOverlays.java:107-108, 120-121, 133-134); a DC line shows nothing.
    const scope = scopeOf([plot(1, 'voltage')], flags);
    const { ctx, texts } = mkCtx();
    drawScope(ctx, ringEngine(() => 1.2), scope, 200, 150, emptyCursor(), 0, 5e-6, false, 3);
    expect(texts.some((t) => t.endsWith('rms'))).toBe(false);
    expect(texts.some((t) => t.endsWith(' average'))).toBe(false);
    expect(texts.some((t) => t.startsWith('Duty cycle'))).toBe(false);
  });

  it('keeps every readout once a real cycle is visible', () => {
    const scope = scopeOf([plot(1, 'voltage')], flags);
    const { ctx, texts } = mkCtx();
    drawScope(ctx, ringEngine(square), scope, 200, 150, emptyCursor(), 0, 5e-6, false, 3);
    expect(texts.some((t) => t.endsWith('rms'))).toBe(true);
    expect(texts.some((t) => t.endsWith(' average'))).toBe(true);
    expect(texts).toContain('Duty cycle 50%');
  });

  it('truncates the duty cycle like upstream int division', () => {
    // Two high columns of three: 200*2/3 = 66.67, printed as 66%.
    const scope = scopeOf([plot(1, 'voltage')], { showMax: false, showDutyCycle: true });
    const { ctx, texts } = mkCtx();
    drawScope(ctx, ringEngine((i) => (i % 3 === 0 ? 0 : 1)), scope, 200, 150, emptyCursor(), 0, 5e-6, false, 3);
    expect(texts).toContain('Duty cycle 66%');
    expect(texts.some((t) => t.includes('67'))).toBe(false);
  });

  it('a power plot degrades RMS to Average, upstream canShowRMS', () => {
    // ScopeOverlays.java:92-98: RMS needs V or A units; anything else falls
    // through to Average instead of printing an X Wrms readout.
    const scope = scopeOf([plot(1, 'power')], { showMax: false, showRMS: true });
    const { ctx, texts } = mkCtx();
    drawScope(ctx, ringEngine(square), scope, 200, 150, emptyCursor(), 0, 5e-6, false, 3);
    expect(texts.some((t) => t.endsWith('rms'))).toBe(false);
    expect(texts.some((t) => t.endsWith(' average'))).toBe(true);
  });

  it('a current plot still shows RMS', () => {
    const scope = scopeOf([plot(1, 'current')], { showMax: false, showRMS: true });
    const { ctx, texts } = mkCtx();
    drawScope(ctx, ringEngine(square), scope, 200, 150, emptyCursor(), 0, 5e-6, false, 3);
    expect(texts.some((t) => t.endsWith('rms'))).toBe(true);
  });
});

describe('drawGridLines visibility', () => {
  const W = 200;
  const H = 150;
  const transform = (): PlotTransform => ({
    gridMid: 0,
    gridMult: 74 / 5,
    gridMax: 5,
    showNegative: true,
    positionOffset: 0,
    stepY: 2,
  });
  // Horizontal gridlines are the only strokes whose moveTo starts at x = 0
  // with y > 0 at simTime 0.
  const horizontalCount = (allSameUnits: boolean, manualScale: boolean): number => {
    const { ctx } = mkCtx(W, H);
    drawGridLines(ctx, transform(), W, H, 0, 64, 5e-6, allSameUnits, manualScale, makeTheme());
    return (ctx.moveTo as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([x, y]) => x === 0 && y > 0,
    ).length;
  };

  it('mixed units in auto scale keeps only the centre line', () => {
    expect(horizontalCount(false, false)).toBe(1);
  });

  it('manual scale shows division lines even on mixed-unit scopes', () => {
    // Scope.java:812: showHGridLines = gridStepY != 0 && (isManualScale() ||
    // allPlotsSameUnits).
    expect(horizontalCount(false, true)).toBeGreaterThan(1);
  });

  it('same-units scopes always get their division lines', () => {
    expect(horizontalCount(true, false)).toBeGreaterThan(1);
  });
});

describe('sameUnits', () => {
  it('groups transistor subvalues with their unit family, like upstream plot.units', () => {
    // Upstream compares ScopePlot.units (Scope.java:657-661), not the plotted
    // value: TransistorElm maps Vbe/Vbc/Vce to UNITS_V and Ib/Ic/Ie to UNITS_A
    // (TransistorElm.java:595-602). A V+Vbe scope must still relocate zero,
    // and an Ib+Ic scope must count as mixed with nothing else.
    expect(sameUnits([plot(1, 'voltage'), plot(2, 'vbe')])).toBe(true);
    expect(sameUnits([plot(1, 'ib'), plot(2, 'ic')])).toBe(true);
    expect(sameUnits([plot(1, 'current'), plot(2, 'ie')])).toBe(true);
    expect(sameUnits([plot(1, 'voltage')])).toBe(true);
    expect(sameUnits([plot(1, 'voltage'), plot(2, 'current')])).toBe(false);
    expect(sameUnits([plot(1, 'power'), plot(2, 'charge')])).toBe(false);
    expect(sameUnits([plot(1, 'ib'), plot(2, 'vce')])).toBe(false);
  });
});
