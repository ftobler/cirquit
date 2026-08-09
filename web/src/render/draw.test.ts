import { describe, expect, it, vi } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import {
  CANVAS_FONT_FAMILY,
  axisColor,
  axisVoltage,
  bodyRect,
  canvasFont,
  closedPolyline,
  currentDots,
  currentDotsPath,
  drawLeads,
  formatValue,
  gradientPolyline,
  line,
  makeTheme,
  polyline,
  powerColor,
  powerColorT,
  powerMult,
  rectCorners,
  strokeStyle,
  voltageColor,
  ZIGZAG_HS,
  zigzagPoints,
} from './draw';
import { RESISTOR_DEF } from '../model/registry/elements/resistor';
import { INDUCTOR_DEF } from '../model/registry/elements/inductor';
import { RELAY_DEF } from '../model/registry/elements/relay';
import { TRANSFORMER_DEF } from '../model/registry/elements/transformer';
import { MOSFET_DEF } from '../model/registry/elements/mosfet';
import { RAIL_DEF } from '../model/registry/elements/rail';
import { VOLTAGE_DEF } from '../model/registry/elements/voltage';
import { TOO_FAST, dotPhaseStep } from './dots';
import {
  CHIP_FLIP_X,
  CHIP_FLIP_Y,
  CHIP_FLIP_XY,
  CHIP_SMALL,
  drawChip,
  type ChipPinDef,
} from '../model/registry/elements/dFlipFlop';
import type { CircuitElement, DrawContext, Point } from '../model/types';

interface CtxStub {
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  lineCap: string;
  lineJoin: string;
  globalAlpha: number;
  font: string;
  textAlign: string;
  textBaseline: string;
  beginPath: ReturnType<typeof vi.fn>;
  moveTo: ReturnType<typeof vi.fn>;
  lineTo: ReturnType<typeof vi.fn>;
  closePath: ReturnType<typeof vi.fn>;
  stroke: ReturnType<typeof vi.fn>;
  arc: ReturnType<typeof vi.fn>;
  fill: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
  restore: ReturnType<typeof vi.fn>;
  setLineDash: ReturnType<typeof vi.fn>;
  fillText: ReturnType<typeof vi.fn>;
  measureText: (text: string) => { width: number };
}

interface TextRecord {
  text: string;
  x: number;
  y: number;
  font: string;
  align: string;
  baseline: string;
}

const mkCtx = (): {
  ctx: CanvasRenderingContext2D;
  stub: CtxStub;
  calls: string[];
  arcs: { x: number; y: number }[];
  texts: TextRecord[];
  paths: { x: number; y: number }[][];
  strokes: { style: string; width: number; join: string }[];
} => {
  const calls: string[] = [];
  const arcs: { x: number; y: number }[] = [];
  const texts: TextRecord[] = [];
  const paths: { x: number; y: number }[][] = [];
  const strokes: { style: string; width: number; join: string }[] = [];
  const record = (name: string) => vi.fn(() => calls.push(name));
  const stub: CtxStub = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    lineCap: '',
    lineJoin: '',
    globalAlpha: 1,
    font: '',
    textAlign: '',
    textBaseline: '',
    beginPath: record('beginPath'),
    moveTo: vi.fn((x: number, y: number) => {
      calls.push('moveTo');
      paths.push([{ x, y }]);
    }),
    lineTo: vi.fn((x: number, y: number) => {
      calls.push('lineTo');
      if (paths.length > 0) paths[paths.length - 1].push({ x, y });
    }),
    closePath: record('closePath'),
    stroke: vi.fn(() => {
      calls.push('stroke');
      // The colour, width and join at stroke time, in draw order: how a
      // per-segment gradient body is asserted on, and how the coil's bevel
      // joins are told apart from a polygon's miter ones.
      strokes.push({ style: stub.strokeStyle, width: stub.lineWidth, join: stub.lineJoin });
    }),
    arc: vi.fn((x: number, y: number) => {
      calls.push('arc');
      arcs.push({ x, y });
    }),
    fill: record('fill'),
    save: record('save'),
    restore: record('restore'),
    setLineDash: record('setLineDash'),
    fillText: vi.fn((text: string, x: number, y: number) => {
      calls.push('fillText');
      texts.push({ text, x, y, font: stub.font, align: stub.textAlign, baseline: stub.textBaseline });
    }),
    // The same heuristic the SVG recorder uses, `length * size * 0.6`, so the
    // font-shrink loop terminates headlessly like it does on a real canvas.
    measureText: (text: string) => {
      const m = /^(\d+(?:\.\d+)?)px/.exec(stub.font);
      const size = m ? Number(m[1]) : 10;
      return { width: text.length * size * 0.6 };
    },
  };
  return { ctx: stub as unknown as CanvasRenderingContext2D, stub, calls, arcs, texts, paths, strokes };
};

const context = (ctx: CanvasRenderingContext2D, dotPhase: number): DrawContext => ({
  ctx,
  theme: makeTheme(),
  voltages: [],
  current: 1e-3,
  voltage: 0,
  power: 0,
  value: 0,
  dotPhase,
  showCurrent: true,
  showValues: false,
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
});

describe('value formatting', () => {
  it('uses engineering prefixes', () => {
    expect(formatValue(4700, 'Ω')).toBe('4.7k Ω');
    expect(formatValue(0.000001, 'F')).toBe('1µ F');
    expect(formatValue(1e6, 'Ω')).toBe('1M Ω');
    expect(formatValue(0.05, 'A')).toBe('50m A');
  });

  it('handles zero and non-finite values', () => {
    expect(formatValue(0, 'V')).toBe('0 V');
    expect(formatValue(NaN)).toBe('--');
  });

  it('keeps the sign', () => {
    expect(formatValue(-2.5, 'V')).toBe('-2.5 V');
  });

  it('honours the fraction-digit count, the upstream ####.# pattern', () => {
    // toPrecision(1) would render 55.5 as "6e+1"; the fraction-digit pattern
    // must give "55.5m" and "55.6m" (CircuitElm.java:163-167).
    expect(formatValue(0.0555, 'V', 1)).toBe('55.5m V');
    expect(formatValue(0.05556, 'V', 1)).toBe('55.6m V');
    expect(formatValue(4700, 'Ω', 0)).toBe('5k Ω');
    // A three-digit scaled value above 100 no longer forces integers: the
    // pattern keeps the fraction digits (upstream renders the same).
    expect(formatValue(123456, 'V', 3)).toBe('123.456k V');
  });

  it('keeps the default three-digit behaviour after the toFixed change', () => {
    expect(formatValue(0.0555, 'V')).toBe('55.5m V');
    expect(formatValue(4700, 'Ω')).toBe('4.7k Ω');
    expect(formatValue(0.000001, 'F')).toBe('1µ F');
  });
});

describe('theme colour overrides', () => {
  it('makeTheme overlays exactly the five mutable keys and keeps the rest', () => {
    const theme = makeTheme(false, {
      positiveColor: '#ff0000',
      negativeColor: '#00ff00',
      neutralColor: '#0000ff',
      selectionColor: '#ff00ff',
      currentColor: '#00ffff',
    });
    expect(theme.positive).toBe('#ff0000');
    expect(theme.negative).toBe('#00ff00');
    expect(theme.neutral).toBe('#0000ff');
    expect(theme.selection).toBe('#ff00ff');
    expect(theme.currentDot).toBe('#00ffff');
    // The other nine theme keys come from the palette, untouched.
    expect(theme.background).toBe('#ffffff');
    expect(theme.grid).toBe('#d0d7de');
    expect(theme.wire).toBe('#000000');
  });

  it('makeTheme without a settings argument is the stock palette', () => {
    const theme = makeTheme(false);
    expect(theme.positive).toBe('#1a7f37');
    expect(theme.negative).toBe('#cf222e');
    expect(theme.neutral).toBe('#6e7781');
    expect(theme.selection).toBe('#0969da');
    expect(theme.currentDot).toBe('#9a6700');
    expect(theme.background).toBe('#ffffff');
  });

  it('a null colour keeps the palette value', () => {
    const theme = makeTheme(true, {
      positiveColor: null,
      negativeColor: null,
      neutralColor: null,
      selectionColor: null,
      currentColor: '#123456',
    });
    expect(theme.positive).toBe('#00ff00');
    expect(theme.currentDot).toBe('#123456');
  });

  it('dark theme colour-scale roles match upstream exactly', () => {
    // The dark theme is the parity-exact palette: the five colour-scale roles
    // are upstream's Color constants (CircuitElm.java:200-205, Color.java:
    // 26-37). A future palette tweak has to argue with this claim. The light
    // theme is a deliberate legibility divergence and is not covered here.
    const theme = makeTheme();
    expect(theme.positive).toBe('#00ff00');  // Color.green
    expect(theme.negative).toBe('#ff0000');  // Color.red
    expect(theme.neutral).toBe('#808080');   // Color.gray
    expect(theme.currentDot).toBe('#ffff00');  // Color.yellow
    expect(theme.selection).toBe('#00ffff');  // Color.cyan
  });
});

describe('current dots', () => {
  it('draws a translucent flow line with shimmering dots when too fast', () => {
    const { ctx, calls } = mkCtx();
    currentDots(context(ctx, TOO_FAST), { x: 0, y: 0 }, { x: 100, y: 0 }, 1e-3);
    expect(calls).toContain('stroke');
    expect(calls).toContain('arc');
  });

  it('keeps drawing dots for a finite phase', () => {
    const { ctx, calls } = mkCtx();
    currentDots(context(ctx, 2), { x: 0, y: 0 }, { x: 100, y: 0 }, 1e-3);
    expect(calls).toContain('arc');
    expect(calls).not.toContain('stroke');
  });

  it('spaces dots 16 apart along a segment', () => {
    // One dot every DOT_SPACING from the phase offset; with spacing 8 there
    // would be 13 of them instead of the 7 here.
    const { ctx, arcs } = mkCtx();
    currentDots(context(ctx, 0), { x: 0, y: 0 }, { x: 100, y: 0 }, 1e-3);
    expect(arcs.map((a) => a.x)).toEqual([0, 16, 32, 48, 64, 80, 96]);
  });

  it('keeps the stream and shimmering dots on every segment of a too-fast path', () => {
    // A path whose phase is TOO_FAST must draw the translucent flow line on
    // each segment. Before dotPhaseAfter passed the sentinel through, the
    // chained phase after the first segment became NaN, so only the first
    // segment drew anything.
    const { ctx, arcs, calls } = mkCtx();
    currentDotsPath(
      context(ctx, TOO_FAST),
      [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 200, y: 0 }],
      1e-3,
    );
    // One flow line per segment, not just the first.
    expect(calls.filter((c) => c === 'stroke')).toHaveLength(2);
    // Each segment still gets its own shimmering dots; the segments span the
    // x-axis in order, so one dot must land in each half.
    expect(arcs.some((a) => a.x < 100)).toBe(true);
    expect(arcs.some((a) => a.x > 100)).toBe(true);
  });

  it('chains phase across segments so dots keep 16-unit spacing', () => {
    // A two-segment path with no dots at the joints: the phase carries over by
    // segment length, so arcs land at path distances 0, 16 and 32. Drawing
    // every segment from the same raw phase would add arcs at 8 and 24.
    const { ctx, arcs } = mkCtx();
    currentDotsPath(context(ctx, 0), [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 40, y: 0 }], 1e-3);
    expect(arcs.map((a) => a.x)).toEqual([0, 16, 32]);
  });

  it('uses the electron colour when conventional motion is off', () => {
    const { ctx } = mkCtx();
    currentDots(
      { ...context(ctx, 2), conventional: false },
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      1e-3,
    );
    expect(ctx.fillStyle).toBe(makeTheme().currentDotElectron);
  });
});

describe('stroke caps', () => {
  it('defaults to butt caps and miter joins', () => {
    // Pins the crisp-line decision: symbol ends stay flush and polygon corners
    // stay sharp. Wires opt into round caps explicitly.
    const { ctx } = mkCtx();
    strokeStyle(context(ctx, 0), '#ffffff');
    expect(ctx.lineCap).toBe('butt');
    expect(ctx.lineJoin).toBe('miter');
  });

  it('line() with a round cap sets round and leaves miter joins', () => {
    const { ctx } = mkCtx();
    line(context(ctx, 0), { x: 0, y: 0 }, { x: 32, y: 0 }, '#ffffff', 3, 'round');
    expect(ctx.lineCap).toBe('round');
    expect(ctx.lineJoin).toBe('miter');
  });

  it('line() without a cap still sets butt', () => {
    const { ctx } = mkCtx();
    line(context(ctx, 0), { x: 0, y: 0 }, { x: 32, y: 0 }, '#ffffff');
    expect(ctx.lineCap).toBe('butt');
    expect(ctx.lineJoin).toBe('miter');
  });

  it('polyline() keeps butt caps and miter joins so polygon corners stay sharp', () => {
    // Regression guard for the crisp-line intent: a polygonal body (the zigzag
    // resistor, the bodyRect loop) must not soften its corners. The coil opts
    // out through its own bevel join argument, asserted in the coil tests.
    const { ctx } = mkCtx();
    polyline(context(ctx, 0), [{ x: 0, y: 0 }, { x: 16, y: 8 }, { x: 32, y: 0 }], '#ffffff');
    expect(ctx.lineCap).toBe('butt');
    expect(ctx.lineJoin).toBe('miter');
  });
});

describe('coil bevel joins', () => {
  // Every coil body strokes through gradientPolyline with join 'bevel': the
  // loop junctions drop back to the axis at near-zero angles, where a miter
  // spikes and the canvas silently clamps at miterLimit. A resistor's zigzag
  // and every other polyline keep miter.
  const drawCtx = (ctx: CanvasRenderingContext2D, voltages: number[]): DrawContext => ({
    ...context(ctx, 0),
    voltages,
  });

  it('gradientPolyline passes a bevel join through to its per-segment strokes', () => {
    const { ctx, strokes } = mkCtx();
    gradientPolyline(drawCtx(ctx, [10, 0]), [{ x: 0, y: 0 }, { x: 32, y: 0 }], {
      cap: 'round',
      join: 'bevel',
    });
    expect(strokes.length).toBeGreaterThan(0);
    expect(strokes.every((s) => s.join === 'bevel')).toBe(true);
  });

  it('the inductor body strokes bevel while its leads stay miter', () => {
    const { ctx, strokes } = mkCtx();
    INDUCTOR_DEF.draw(drawCtx(ctx, [0, 0]), {
      id: 1,
      kind: 'inductor',
      x1: 0,
      y1: 0,
      x2: 64,
      y2: 0,
      flags: 0,
      params: {},
    });
    // Two lead lines first, then the coil's per-segment gradient strokes.
    expect(strokes[0].join).toBe('miter');
    expect(strokes[1].join).toBe('miter');
    expect(strokes.length).toBeGreaterThan(2);
    expect(strokes.slice(2).every((s) => s.join === 'bevel')).toBe(true);
  });

  it('the relay coil strokes bevel, at its own body weight', () => {
    const { ctx, strokes } = mkCtx();
    RELAY_DEF.draw(drawCtx(ctx, [0, 0, 0, 0, 0]), {
      id: 1,
      kind: 'relay',
      x1: 0,
      y1: 0,
      x2: 64,
      y2: 0,
      flags: 0,
      params: {},
    });
    const bevels = strokes.filter((s) => s.join === 'bevel');
    expect(bevels.length).toBeGreaterThan(0);
    expect(bevels.every((s) => s.width === 3)).toBe(true);  // the coil's body weight
  });

  it('both transformer windings stroke bevel, not the leads or core bars', () => {
    const { ctx, strokes } = mkCtx();
    TRANSFORMER_DEF.draw(drawCtx(ctx, [10, 0, 0, 10]), {
      id: 1,
      kind: 'transformer',
      x1: 0,
      y1: 0,
      x2: 64,
      y2: 0,
      flags: 0,
      params: {},
    });
    // Four leads first, then the primary and secondary coils, then the two
    // core bars. The coil bevels sit between the miter leads and bars.
    expect(strokes.slice(0, 4).every((s) => s.join === 'miter')).toBe(true);
    expect(strokes.slice(-2).every((s) => s.join === 'miter')).toBe(true);
    const bevels = strokes.filter((s) => s.join === 'bevel');
    expect(bevels.length).toBeGreaterThan(0);
    expect(bevels.every((s) => s.width === 3)).toBe(true);  // the winding's body weight
  });

  it('a resistor body keeps every stroke miter', () => {
    const { ctx, strokes } = mkCtx();
    RESISTOR_DEF.draw(drawCtx(ctx, [0, 0]), {
      id: 1,
      kind: 'resistor',
      x1: 0,
      y1: 0,
      x2: 64,
      y2: 0,
      flags: 0,
      params: { resistance: 1000 },
    });
    expect(strokes.length).toBeGreaterThan(0);
    expect(strokes.every((s) => s.join === 'miter')).toBe(true);
  });
});

describe('stroke widths', () => {
  // The port maps upstream's two weights onto the one default: bodies and
  // leads stroke at `drawThickLine`'s 3 (CircuitElm.java:1007-1021), while
  // fine detail that upstream strokes with a plain `g.drawLine` passes 1.
  it('line() defaults to the 3-unit body weight', () => {
    const { ctx } = mkCtx();
    line(context(ctx, 0), { x: 0, y: 0 }, { x: 32, y: 0 }, '#ffffff');
    expect(ctx.lineWidth).toBe(3);
  });

  it('polyline() and closedPolyline() default to the same 3-unit weight', () => {
    const { ctx } = mkCtx();
    polyline(context(ctx, 0), [{ x: 0, y: 0 }, { x: 16, y: 8 }, { x: 32, y: 0 }], '#ffffff');
    expect(ctx.lineWidth).toBe(3);
    closedPolyline(
      context(ctx, 0),
      [{ x: 0, y: 0 }, { x: 16, y: 8 }, { x: 32, y: 0 }, { x: 0, y: 0 }],
      '#ffffff',
    );
    expect(ctx.lineWidth).toBe(3);
  });

  it('strokes the resistor body at 3, upstream setLineWidth(3.0)', () => {
    // ResistorElm.java:73 sets 3.0 before the zigzag path; the port's body is
    // a polyline over the same zigzagPoints, so it must inherit the default.
    const { ctx } = mkCtx();
    polyline(context(ctx, 0), zigzagPoints({ x: 0, y: 0 }, { x: 32, y: 0 }, ZIGZAG_HS), '#ffffff');
    expect(ctx.lineWidth).toBe(3);
  });

  it('strokes a lead through drawLeads at 3, upstream draw2Leads/drawThickLine', () => {
    // CircuitElm.java:460-467: both leads are drawThickLine at width 3.
    const { ctx } = mkCtx();
    drawLeads(
      context(ctx, 0),
      { id: 1, kind: 'resistor', x1: 0, y1: 0, x2: 64, y2: 0, flags: 0, params: {} },
      { x: 8, y: 0 },
      { x: 56, y: 0 },
    );
    expect(ctx.lineWidth).toBe(3);
  });

  it('an explicit width argument still wins, so fine detail can pass 1', () => {
    // The fine end of the mapping: switch IEC symbols (SwitchElm.java:147-159),
    // chip clock markers (ChipElm.java:117-120) and the chip lineOver bars
    // (ChipElm.java:149-151) are plain g.drawLine/g.drawPolyline calls upstream
    // and pass 1 here.
    const { ctx } = mkCtx();
    line(context(ctx, 0), { x: 0, y: 0 }, { x: 32, y: 0 }, '#ffffff', 1);
    expect(ctx.lineWidth).toBe(1);
  });

  it('a chip housing strokes at 3, matching drawThickPolygon', () => {
    // ChipElm.java:159 draws the housing with drawThickPolygon (width 3), the
    // same default the port's shared drawChip relies on.
    const { ctx } = mkCtx();
    closedPolyline(
      context(ctx, 0),
      [{ x: 0, y: 0 }, { x: 32, y: 0 }, { x: 32, y: 16 }, { x: 0, y: 16 }, { x: 0, y: 0 }],
      '#ffffff',
    );
    expect(ctx.lineWidth).toBe(3);
  });
});

describe('closed outlines', () => {
  it('closedPolyline emits closePath before the stroke, so the start corner is a join', () => {
    // With a wide stroke the missing corner of an open returning polyline is
    // two butt-capped ends stopping flush: the outer corner square is simply
    // unpainted. closePath must land between the last lineTo and the stroke.
    const { ctx, calls } = mkCtx();
    closedPolyline(
      context(ctx, 0),
      [{ x: 0, y: -6 }, { x: 32, y: -6 }, { x: 32, y: 6 }, { x: 0, y: 6 }, { x: 0, y: -6 }],
      '#ffffff',
      3,
    );
    expect(calls).toEqual([
      'beginPath',
      'moveTo',
      'lineTo',
      'lineTo',
      'lineTo',
      'lineTo',
      'closePath',
      'stroke',
    ]);
  });

  it('a plain polyline stays open even when it repeats its first point', () => {
    // Only the closed helper must close. A caller that deliberately retraces
    // (the fuse sine, the XOR gate's second curve) must not gain a join.
    const { ctx, calls } = mkCtx();
    polyline(context(ctx, 0), [{ x: 0, y: 0 }, { x: 16, y: 8 }, { x: 0, y: 0 }], '#ffffff');
    expect(calls).not.toContain('closePath');
  });

  it('bodyRect paints the four distinct corners and closes the box', () => {
    // The explicit repeated corner is kept so the geometry tests can assert
    // the four corners; the close is what makes the loop genuinely closed.
    const { ctx, stub, calls } = mkCtx();
    bodyRect(context(ctx, 0), { x: 0, y: 0 }, { x: 32, y: 0 }, 6, '#ffffff');
    const moves = stub.moveTo.mock.calls.map((a) => ({ x: a[0], y: a[1] }));
    const lines = stub.lineTo.mock.calls.map((a) => ({ x: a[0], y: a[1] }));
    const [a1, b1, b2, a2] = rectCorners({ x: 0, y: 0 }, { x: 32, y: 0 }, 6);
    expect(moves).toEqual([a1]);
    expect(lines).toEqual([b1, b2, a2, a1]);
    expect(new Set([a1, b1, b2, a2].map((p) => `${p.x},${p.y}`)).size).toBe(4);
    expect(calls.indexOf('closePath')).toBeLessThan(calls.indexOf('stroke'));
  });
});

describe('power colouring', () => {
  const powerContext = (overrides: Partial<DrawContext> = {}): DrawContext => ({
    ...context(mkCtx().ctx, 0),
    ...overrides,
  });

  it('computes the brightness multiplier from the powerRange token', () => {
    // The formula is the file's token 6, upstream's powerBar
    // (UIManager.java:630). Pin against the expression itself so a future
    // refactor that changes the scale fails loudly.
    expect(powerMult(50)).toBeCloseTo(Math.exp(50 / 4.762 - 7), 10);
    expect(powerMult(0)).toBeCloseTo(Math.exp(-7), 10);
    expect(powerMult(100)).toBeCloseTo(Math.exp(100 / 4.762 - 7), 6);
  });

  it('clamps the ramp position to [-1, 1] with 0 at neutral', () => {
    // -0 * powerMult is -0; the strict equality is what upstream's 0 index
    // amounts to either way.
    expect(powerColorT(0, 50) === 0).toBe(true);
    expect(powerColorT(1e6, 50)).toBe(-1);
    expect(powerColorT(-1e6, 50)).toBe(1);
    expect(powerColorT(NaN, 50)).toBe(0);
    expect(powerColorT(Infinity, 50)).toBe(0);
    expect(powerColorT(0.02, 50)).toBeGreaterThanOrEqual(-1);
    expect(powerColorT(-0.02, 50)).toBeLessThanOrEqual(1);
  });

  it('never doubles back as power rises', () => {
    // The ramp must be strictly monotone decreasing: more dissipated power
    // always reads further toward the red end.
    const samples = [-1e-3, -1e-4, 0, 1e-4, 1e-3];
    for (let i = 1; i < samples.length; i++) {
      expect(powerColorT(samples[i - 1], 50)).toBeGreaterThan(powerColorT(samples[i], 50));
    }
  });

  it('hits the exact midpoint between neutral and negative at half scale', () => {
    const half = 0.5 / powerMult(50);
    expect(powerColorT(half, 50)).toBeCloseTo(-0.5, 10);
    // Dark-theme neutral #808080 to negative #ff0000 at t = 0.5, the upstream
    // constants (CircuitElm.java:200-205, Color.java:26-37).
    expect(powerColor(powerContext({ showPowerColor: true }), half)).toBe('rgb(192,64,64)');
  });

  it('colours dissipated power red and generated power green', () => {
    const g = powerContext({ showPowerColor: true });
    // The ramp blends the theme colours, so the endpoints come back as rgb
    // strings: dark-theme neutral #808080, negative #ff0000, positive #00ff00.
    expect(powerColor(g, 0)).toBe('rgb(128,128,128)');
    expect(powerColor(g, 1e6)).toBe('rgb(255,0,0)');
    expect(powerColor(g, -1e6)).toBe('rgb(0,255,0)');
  });

  it('returns the wire colour when the mode is off', () => {
    expect(powerColor(powerContext(), 1e6)).toBe(makeTheme().wire);
  });

  it('raises the ramp slope as brightness increases', () => {
    // For a fixed power, a higher powerRange means a larger |ramp position|;
    // both are negative here, so the value decreases.
    expect(powerColorT(0.02, 40)).toBeGreaterThan(powerColorT(0.02, 60));
  });
});

describe('zigzag resistor body', () => {
  /** Signed perpendicular distance of `p` from the `a`-`b` axis. */
  const signedDistance = (a: { x: number; y: number }, b: { x: number; y: number }, p: { x: number; y: number }): number =>
    ((b.y - a.y) * (p.x - a.x) - (b.x - a.x) * (p.y - a.y)) /
    Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));

  it('alternates eight +hs/-hs peaks between the two leads', () => {
    const pts = zigzagPoints({ x: 0, y: 0 }, { x: 32, y: 0 }, ZIGZAG_HS);
    // Start on one lead, eight excursions, end on the other.
    expect(pts).toHaveLength(10);
    expect(pts[0]).toEqual({ x: 0, y: 0 });
    expect(pts[pts.length - 1]).toEqual({ x: 32, y: 0 });
    expect(pts.slice(1, -1).map((p) => p.y)).toEqual([
      // The port's perpendicular unit vector is the negation of upstream's
      // (see the thermistor/LDR comments), so the first peak lands on the
      // -hs side; the alternating zigzag is symmetric, so the orientation
      // reads identically.
      -ZIGZAG_HS, ZIGZAG_HS, -ZIGZAG_HS, ZIGZAG_HS, -ZIGZAG_HS, ZIGZAG_HS, -ZIGZAG_HS, ZIGZAG_HS,
    ]);
    // The peaks land on the odd 1/16 fractions upstream strokes (ResistorElm.
    // java:85-91): 2, 6, 10, ..., 30 for a 32-unit body.
    expect(pts.slice(1, -1).map((p) => p.x)).toEqual([2, 6, 10, 14, 18, 22, 26, 30]);
  });

  it('keeps the peaks perpendicular to a diagonal axis', () => {
    const pts = zigzagPoints({ x: 0, y: 0 }, { x: 16, y: 16 }, ZIGZAG_HS);
    const dists = pts.slice(1, -1).map((p) => signedDistance({ x: 0, y: 0 }, { x: 16, y: 16 }, p));
    // Exact float math: each excursion sits 8 off the axis, alternating sides.
    expect(dists.map((d) => Math.round(d))).toEqual([
      8, -8, 8, -8, 8, -8, 8, -8,
    ]);
  });

  it('degenerates to the endpoints when the leads coincide', () => {
    const a = { x: 10, y: 10 };
    expect(zigzagPoints(a, { x: 10, y: 10 }, ZIGZAG_HS)).toEqual([a, { x: 10, y: 10 }]);
  });

  it('scales the peaks with the caller-supplied half-height', () => {
    // The thermistor and LDR reuse their 6-unit box height for the zigzag,
    // while the resistor and pot pass ZIGZAG_HS (8): the half-height is the
    // caller's choice, so the helper must honour it exactly.
    expect(zigzagPoints({ x: 0, y: 0 }, { x: 32, y: 0 }, 6).slice(1, -1).map((p) => p.y)).toEqual([
      -6, 6, -6, 6, -6, 6, -6, 6,
    ]);
    expect(zigzagPoints({ x: 0, y: 0 }, { x: 32, y: 0 }, 6).slice(1, -1).map((p) => p.y)).not.toContain(8);
  });
});

describe('body voltage gradient', () => {
  /** A DrawContext on a given stub with the two posts at 10 V and 0 V;
   *  overrides win. The stub is the caller's, so its recorded strokes and the
   *  drawn colours come from the same object. */
  const g = (ctx: CanvasRenderingContext2D, overrides: Partial<DrawContext> = {}): DrawContext => ({
    ...context(ctx, 0),
    voltages: [10, 0],
    ...overrides,
  });

  const element = (params: Record<string, number> = {}): CircuitElement => ({
    id: 1,
    kind: 'resistor',
    x1: 0,
    y1: 0,
    x2: 64,
    y2: 0,
    flags: 0,
    params: { resistance: 1000, ...params },
  });

  it('axisVoltage interpolates linearly between the two posts', () => {
    const gg = g(mkCtx().ctx);
    expect(axisVoltage(gg, 0)).toBe(10);
    expect(axisVoltage(gg, 0.25)).toBe(7.5);
    expect(axisVoltage(gg, 0.5)).toBe(5);
    expect(axisVoltage(gg, 1)).toBe(0);
  });

  it('axisVoltage clamps at the ends', () => {
    const gg = g(mkCtx().ctx);
    expect(axisVoltage(gg, -0.5)).toBe(10);
    expect(axisVoltage(gg, 2)).toBe(0);
  });

  it('axisVoltage honours an explicit post pair', () => {
    const gg = g(mkCtx().ctx);
    expect(axisVoltage(gg, 0.5, 6, 4)).toBe(5);
    expect(axisVoltage(gg, 1.5, 6, 4)).toBe(4);  // still clamped to the pair
  });

  it('axisColor falls back to the flat power colour under Show Power', () => {
    // Upstream's `else` branch: with the voltage toggle off, the body takes
    // the power colour and the ramp disappears entirely (ResistorElm.java:80).
    const gg = g(mkCtx().ctx, { showPowerColor: true, showVoltageColor: false, power: 1e6 });
    const colour = axisColor(gg, 0);
    expect(colour).toBe('rgb(255,0,0)');  // dissipated power saturates the negative end
    expect(axisColor(gg, 1)).toBe(colour);
  });

  it('axisColor is the voltage colour at the interpolated voltage', () => {
    const gg = g(mkCtx().ctx, { showVoltageColor: true });
    expect(axisColor(gg, 0.5)).toBe(voltageColor(gg, 5));
  });

  it('a v0=10, v1=0 body ramps its strokes from positive to neutral', () => {
    const { ctx, strokes } = mkCtx();
    const gg = g(ctx, { showVoltageColor: true });
    gradientPolyline(gg, [{ x: 16, y: 0 }, { x: 48, y: 0 }]);
    // One 32-unit edge, cut into 16 two-unit sub-segments, each stroked in
    // the ramp colour at its own midpoint fraction (k + 0.5) / 16.
    expect(strokes).toHaveLength(16);
    const expected = (k: number) => voltageColor(gg, 10 * (1 - (k + 0.5) / 16));
    strokes.forEach((s, k) => expect(s.style).toBe(expected(k)));
    expect(strokes[0].style).toBe('rgb(0,255,0)');  // clamped positive at the 10 V end
    // The last segment is near the neutral 0 V end, so the ramp moved.
    expect(strokes[strokes.length - 1].style).not.toBe('rgb(0,255,0)');
  });

  it('the ramp is monotonic across the body', () => {
    // A small drop inside the colour scale, so every segment is a distinct
    // blend: the red channel must climb strictly from the positive end (low
    // red) to the negative end (high red) with no doubling back.
    const { ctx, strokes } = mkCtx();
    const gg = g(ctx, { showVoltageColor: true, voltages: [2, -2] });
    gradientPolyline(gg, [{ x: 16, y: 0 }, { x: 48, y: 0 }]);
    const red = (s: string) => Number(/rgb\((\d+),/.exec(s)?.[1]);
    expect(red(strokes[0].style)).toBeLessThan(red(strokes[strokes.length - 1].style));
    for (let i = 1; i < strokes.length; i++) {
      expect(red(strokes[i].style)).toBeGreaterThan(red(strokes[i - 1].style));
    }
  });

  it('a no-drop body is one uniform colour, no banding', () => {
    const { ctx, strokes } = mkCtx();
    const gg = g(ctx, { showVoltageColor: true, voltages: [5, 5] });
    gradientPolyline(gg, [{ x: 16, y: 0 }, { x: 48, y: 0 }]);
    expect(new Set(strokes.map((s) => s.style)).size).toBe(1);
    expect(strokes[0].style).toBe('rgb(0,255,0)');
  });

  it('swapping the posts reverses the colour order exactly', () => {
    // The geometry is unchanged and mirrors about the body centre, so the
    // sub-segment at fraction f under [0,10] meets the same voltage as the
    // one at 1-f under [10,0]: an exact reversal, not an approximation.
    const draw = (voltages: number[]): string[] => {
      const { ctx, strokes } = mkCtx();
      const gg = g(ctx, { showVoltageColor: true, voltages, euroResistors: false });
      RESISTOR_DEF.draw(gg, element());
      return strokes.map((s) => s.style).slice(2);  // drop the two leads
    };
    const forward = draw([10, 0]);
    const backward = draw([0, 10]);
    expect(backward[0]).toBe(forward[forward.length - 1]);
    expect(backward[backward.length - 1]).toBe(forward[0]);
    forward.forEach((c, k) => expect(backward[forward.length - 1 - k]).toBe(c));
  });

  it('a resistor with a drop strokes its first body segment positive and its last near neutral', () => {
    const { ctx, strokes } = mkCtx();
    const gg = g(ctx, { showVoltageColor: true, euroResistors: false });
    RESISTOR_DEF.draw(gg, element());
    // Two leads first, then the zigzag body: the ramp runs from the lead1 end
    // (10 V, clamped positive) to the lead2 end (0 V, near neutral).
    const body = strokes.slice(2).map((s) => s.style);
    expect(body.length).toBeGreaterThan(2);
    expect(body[0]).toBe('rgb(0,255,0)');
    expect(body[body.length - 1]).not.toBe('rgb(0,255,0)');
  });

  it('a no-drop resistor body is one uniform colour', () => {
    const { ctx, strokes } = mkCtx();
    const gg = g(ctx, { showVoltageColor: true, voltages: [5, 5], euroResistors: false });
    RESISTOR_DEF.draw(gg, element());
    expect(new Set(strokes.map((s) => s.style)).size).toBe(1);
  });

  it('Show Power flattens the resistor body to the power colour', () => {
    // Upstream's `else` branch: the body takes the flat power colour, no
    // ramp, while the leads keep their plain node colours (drawLeads), so the
    // two lead strokes are wire and only the body is uniform.
    const { ctx, strokes } = mkCtx();
    const gg = g(ctx, { showPowerColor: true, showVoltageColor: false, power: 1e6, euroResistors: false });
    RESISTOR_DEF.draw(gg, element());
    expect(strokes).toHaveLength(2 + 64);  // two leads plus the 64 zigzag cuts
    const body = strokes.slice(2).map((s) => s.style);
    expect(new Set(body).size).toBe(1);
    expect(body[0]).toBe('rgb(255,0,0)');
  });

  it('gradientPolyline strokes coils with round caps', () => {
    // drawCoil sets LineCap.ROUND upstream (CircuitElm.java:989); the helper
    // passes the cap through to its per-segment strokes so the angled coil
    // joints stay covered.
    const { ctx, strokes } = mkCtx();
    gradientPolyline(g(ctx, { showVoltageColor: true }), [{ x: 0, y: 0 }, { x: 32, y: 0 }], {
      cap: 'round',
    });
    expect(strokes).toHaveLength(16);
    expect(strokes[0].width).toBe(3);  // the body stroke weight
    expect(ctx.lineCap).toBe('round');
  });

  it('a transformer winding shades across its own two posts', () => {
    // The primary spans posts 0 and 2, the secondary posts 1 and 3: each coil
    // must ramp between its own pair, not the element's posts 0/1. Four leads
    // come first, then the primary coil (10 V -> 0 V), then the secondary
    // (0 V -> 10 V), then the text-coloured core bars.
    const { ctx, strokes } = mkCtx();
    const gg = g(ctx, { showVoltageColor: true, voltages: [10, 0, 0, 10] });
    TRANSFORMER_DEF.draw(gg, {
      id: 1,
      kind: 'transformer',
      x1: 0,
      y1: 0,
      x2: 64,
      y2: 0,
      flags: 0,
      params: {},
    });
    expect(strokes.length).toBeGreaterThan(6);
    expect(strokes[4].style).toBe('rgb(0,255,0)');  // primary coil starts at its 10 V end
    const coils = strokes.slice(4, strokes.length - 2);  // drop the leads and core bars
    expect(new Set(coils.map((s) => s.style)).size).toBeGreaterThan(1);  // it ramps
  });
});

describe('canvas font', () => {
  it('composes a font string at a given size', () => {
    expect(canvasFont(11)).toBe(`11px ${CANVAS_FONT_FAMILY}`);
  });

  it('names Roboto in the family', () => {
    expect(canvasFont(10)).toContain('Roboto');
  });

  it('keeps a generic sans-serif fallback', () => {
    // A canvas font string with no generic fallback is silently ignored by
    // some browsers.
    expect(CANVAS_FONT_FAMILY).toMatch(/sans-serif$/);
  });

  // The source scan reads files off disk, which the node vitest environment
  // permits; paths resolve from this file's URL so the check works no matter
  // where vitest is invoked from.
  it('keeps raw font families out of every call site', async () => {
    const files: Record<string, string> = {
      draw: new URL('./draw.ts', import.meta.url).pathname,
      scope: new URL('../ui/ScopePanel.tsx', import.meta.url).pathname,
    };
    // The registry is one file per element type, so scan the whole directory.
    for (const f of await readdir(new URL('../model/registry', import.meta.url))) {
      if (f.endsWith('.ts')) files[`registry/${f}`] = new URL(`../model/registry/${f}`, import.meta.url).pathname;
    }
    for (const f of await readdir(new URL('../model/registry/elements', import.meta.url))) {
      if (f.endsWith('.ts')) files[`registry/elements/${f}`] = new URL(`../model/registry/elements/${f}`, import.meta.url).pathname;
    }
    const offenders: string[] = [];
    for (const [name, path] of Object.entries(files)) {
      const src = await readFile(path, 'utf8');
      for (const [i, line] of src.split('\n').entries()) {
        // The canvasFont definition itself is the one allowed builder.
        if (/\.font\s*=\s*[`'"]/.test(line) && !line.includes('canvasFont')) {
          offenders.push(`${name}:${i + 1}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the CSS body shorthand in step with the canvas family', async () => {
    const css = await readFile(new URL('../styles.css', import.meta.url), 'utf8');
    expect(css).toMatch(/font:\s*[^;}]*Roboto/);
  });
});

describe('chip pin labels inside the housing', () => {
  const chip = (flags = 0): CircuitElement => ({
    id: 1,
    kind: 'dFlipFlop',
    x1: 0,
    y1: 0,
    x2: 96,
    y2: 0,
    flags,
    params: {},
  });

  /** The label's horizontal box from the recorded fillText and its font, the
   *  same measure the stub reported. */
  const labelBox = (t: TextRecord): { min: number; max: number } => {
    const m = /^(\d+(?:\.\d+)?)px/.exec(t.font);
    const sw = t.text.length * (m ? Number(m[1]) : 10) * 0.6;
    if (t.align === 'left') return { min: t.x, max: t.x + sw };
    if (t.align === 'right') return { min: t.x - sw, max: t.x };
    return { min: t.x - sw / 2, max: t.x + sw / 2 };
  };

  /** The drawn body rectangle: drawChip strokes the housing last, so the last
   *  recorded path is the closed polyline of its four corners. */
  const housingRect = (paths: { x: number; y: number }[][]): { minX: number; maxX: number; minY: number; maxY: number } => {
    const p = paths[paths.length - 1];
    return {
      minX: Math.min(...p.map((q) => q.x)),
      maxX: Math.max(...p.map((q) => q.x)),
      minY: Math.min(...p.map((q) => q.y)),
      maxY: Math.max(...p.map((q) => q.y)),
    };
  };

  const draw = (flags: number, sizeX: number, sizeY: number, pins: ChipPinDef[]) => {
    const { ctx, texts, paths } = mkCtx();
    drawChip(context(ctx, 0), chip(flags), sizeX, sizeY, pins);
    return { texts, paths };
  };

  it('keeps a W and an E label strictly inside the body rectangle', () => {
    const { texts, paths } = draw(0, 2, 3, [
      { side: 'W', pos: 0, text: 'D' },
      { side: 'E', pos: 0, text: 'Q' },
    ]);
    const body = housingRect(paths);
    for (const t of texts) {
      const box = labelBox(t);
      expect(box.min).toBeGreaterThan(body.minX);
      expect(box.max).toBeLessThan(body.maxX);
    }
    // W reads inward from just inside the left edge, E from the right edge.
    const [w, e] = texts;
    expect(w.align).toBe('left');
    expect(w.x).toBe(21);  // textloc.x (32) - (cspc - 5)
    expect(e.align).toBe('right');
    expect(e.x).toBe(75);  // textloc.x (64) + (cspc - 5)
  });

  it('keeps labels inside on a FLAG_SMALL chip, where the margin is tightest', () => {
    const { texts, paths } = draw(CHIP_SMALL, 2, 3, [
      { side: 'W', pos: 0, text: 'D' },
      { side: 'E', pos: 0, text: 'Q' },
    ]);
    const body = housingRect(paths);
    for (const t of texts) {
      const box = labelBox(t);
      expect(box.min).toBeGreaterThan(body.minX);
      expect(box.max).toBeLessThan(body.maxX);
    }
    const [w, e] = texts;
    expect(w.x).toBe(13);  // textloc.x (16) - (cspc - 5)
    expect(e.x).toBe(35);  // textloc.x (32) + (cspc - 5)
  });

  it('shrinks a long label until it fits the space available', () => {
    const { texts } = draw(0, 2, 3, [{ side: 'W', pos: 0, text: 'ABCDEFG' }]);
    const [t] = texts;
    const box = labelBox(t);
    expect(box.max - box.min).toBeLessThanOrEqual(24);  // cspc*2 - 8
    expect(box.max - box.min).toBeLessThan(84);  // the unsqueezed width at font 20
  });

  it('grants a wider budget on a wide chip with no vertical pins', () => {
    const narrow = draw(0, 2, 3, [{ side: 'W', pos: 0, text: 'ABCDEFG' }]).texts[0];
    const wide = draw(0, 3, 3, [{ side: 'W', pos: 0, text: 'ABCDEFG' }]).texts[0];
    const fontPx = (font: string) => Number(/^(\d+)px/.exec(font)?.[1]);
    expect(fontPx(wide.font)).toBeGreaterThan(fontPx(narrow.font));
    expect(labelBox(wide).max - labelBox(wide).min).toBeLessThanOrEqual(40);  // cspc*2.5 + cspc*(sizeX-3)
  });

  it('keeps the narrow budget when a vertical pin could collide', () => {
    const { texts } = draw(0, 4, 4, [
      { side: 'W', pos: 0, text: 'ABCDEFG' },
      { side: 'S', pos: 1, text: 'e' },
    ]);
    // hasVertical suppresses the wide-chip branch even on a wide chip, so the
    // label must fit the one-pin-cell width like a narrow chip.
    const [t] = texts;
    expect(labelBox(t).max - labelBox(t).min).toBeLessThanOrEqual(24);
  });

  it('swaps the W/E alignment under CHIP_FLIP_X so each label hugs its real edge', () => {
    const { texts } = draw(CHIP_FLIP_X, 2, 3, [
      { side: 'W', pos: 0, text: 'D' },
      { side: 'E', pos: 0, text: 'Q' },
    ]);
    // Flipping X moves the W pin's anchor to the east edge, so its label
    // right-aligns there; the E pin mirrors to the west.
    const [w, e] = texts;
    expect(w.align).toBe('right');
    expect(w.x).toBe(75);
    expect(e.align).toBe('left');
    expect(e.x).toBe(21);
  });

  it('keeps W/E labels inside under every flip flag', () => {
    const layouts: ChipPinDef[] = [
      { side: 'W', pos: 0, text: 'D' },
      { side: 'E', pos: 0, text: 'Q' },
    ];
    for (const flags of [CHIP_FLIP_X, CHIP_FLIP_Y, CHIP_FLIP_XY, CHIP_FLIP_X | CHIP_FLIP_Y]) {
      const { texts, paths } = draw(flags, 2, 3, layouts);
      const body = housingRect(paths);
      for (const t of texts) {
        const box = labelBox(t);
        expect(box.min).toBeGreaterThan(body.minX);
        expect(box.max).toBeLessThan(body.maxX);
      }
    }
  });

  it('keeps a vertical pin label centred under the flip flags', () => {
    const { texts } = draw(CHIP_FLIP_XY, 2, 3, [{ side: 'W', pos: 0, text: 'D' }]);
    // Under FLAG_FLIP_XY a W pin becomes an N pin, which stays centred.
    const [t] = texts;
    expect(t.align).toBe('center');
    expect(t.x).toBe(32);
  });

  it('keeps every label inside for representative chip families', () => {
    const layouts: { sizeX: number; sizeY: number; pins: ChipPinDef[] }[] = [
      // dFlipFlop: D on the west, Q and /Q on the east, a lineOver label.
      {
        sizeX: 2,
        sizeY: 3,
        pins: [
          { side: 'W', pos: 0, text: 'D' },
          { side: 'E', pos: 0, text: 'Q' },
          { side: 'E', pos: 2, text: 'Q', lineOver: true },
          { side: 'W', pos: 1, text: '', clock: true },
        ],
      },
      // adc: the bit outputs on the east, In and V+ on the west, no vertical pins.
      {
        sizeX: 2,
        sizeY: 4,
        pins: [
          { side: 'E', pos: 3, text: 'D0' },
          { side: 'E', pos: 2, text: 'D1' },
          { side: 'E', pos: 1, text: 'D2' },
          { side: 'E', pos: 0, text: 'D3' },
          { side: 'W', pos: 0, text: 'In' },
          { side: 'W', pos: 3, text: 'V+' },
        ],
      },
      // sevenSeg: segments a-d on the west, e-g on the south.
      {
        sizeX: 4,
        sizeY: 4,
        pins: [
          { side: 'W', pos: 0, text: 'a' },
          { side: 'W', pos: 1, text: 'b' },
          { side: 'W', pos: 2, text: 'c' },
          { side: 'W', pos: 3, text: 'd' },
          { side: 'S', pos: 1, text: 'e' },
          { side: 'S', pos: 2, text: 'f' },
          { side: 'S', pos: 3, text: 'g' },
        ],
      },
    ];
    for (const { sizeX, sizeY, pins } of layouts) {
      const { texts, paths } = draw(0, sizeX, sizeY, pins);
      const body = housingRect(paths);
      expect(texts.length).toBeGreaterThan(0);
      for (const t of texts) {
        const box = labelBox(t);
        expect(box.min).toBeGreaterThan(body.minX);
        expect(box.max).toBeLessThan(body.maxX);
        expect(t.y).toBeGreaterThan(body.minY);
        expect(t.y).toBeLessThan(body.maxY);
      }
    }
  });

  it('draws the lineOver bar from the label metrics on both sides', () => {
    // The bar sits at textloc.y - asc + asc/3, the label's baseline minus its
    // font size, and spans exactly the measured label width sw, not the
    // hardcoded -5 offset the old code used. The W and E pins anchor the bar
    // from opposite ends, so both are covered.
    for (const side of ['W', 'E'] as const) {
      const pin: ChipPinDef = { side, pos: side === 'E' ? 2 : 0, text: 'Q', lineOver: true };
      const { texts, paths } = draw(0, 2, 3, [pin]);
      const [t] = texts;
      const asc = Number(/^(\d+(?:\.\d+)?)px/.exec(t.font)?.[1]);
      const sw = t.text.length * asc * 0.6;
      // The y and the exact span single the bar out from the pin stubs, which
      // are also horizontal two-point lines.
      const bars = paths.filter((p) => {
        if (p.length !== 2 || p[0].y !== p[1].y) return false;
        return (
          Math.abs(p[0].y - (t.y - asc)) < 1e-9 &&
          Math.abs(Math.abs(p[1].x - p[0].x) - sw) < 1e-9
        );
      });
      expect(bars).toHaveLength(1);
      const [p0, p1] = bars[0];
      expect(p0.y).toBeCloseTo(t.y - asc, 9);
      expect(Math.abs(p1.x - p0.x)).toBeCloseTo(sw, 9);
      // The bar spans exactly the label's own box.
      const box = labelBox(t);
      expect(Math.min(p0.x, p1.x)).toBe(box.min);
      expect(Math.max(p0.x, p1.x)).toBe(box.max);
    }
  });
});

describe('current dot direction', () => {
  // The animated dots must advance from post A toward post B on a circuit
  // with a known current loop, sampled two frames apart. The engine reports
  // a 5 V source and a series resistor both as +5 mA (see the circuits.rs
  // convention tests), and the render layer advances the per-element phase by
  // `current * currentMult` (dotPhaseStep), so a positive current moves dots
  // in the positive segment direction every frame. Each test draws the
  // element at phase 0 and phase 2 and asserts that the leading dot sits at
  // the path head and then advances two units along it, pinning the segment
  // direction each draw uses.
  //
  // The step is deliberately small. Sampling at half DOT_SPACING (phase 8)
  // does not discriminate direction: a dot 8 units from the run start wraps
  // past the first dot's spacing, so the dot nearest the head is a different
  // dot in the second frame and its distance from the head grows whether the
  // run points toward or away from it. A 2-unit step keeps the same dot on
  // the same run, so the test asserts directly where it is: the correct run
  // starts at the path head, so a dot sits there at phase 0 and 2 units
  // further along at phase 2, while a reversed run starts at the path tail
  // (or mid-path) and has no dot at the head at all.

  interface Arc {
    x: number;
    y: number;
    r: number;
  }

  /** A stub whose arcs record their radius, so the 2-unit current dots can be
   *  told apart from the symbol circles (radius 12 or 17). */
  const dotCtx = (): { ctx: CanvasRenderingContext2D; arcs: Arc[] } => {
    const arcs: Arc[] = [];
    const stub: CtxStub = {
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 0,
      lineCap: '',
      lineJoin: '',
      globalAlpha: 1,
      font: '',
      textAlign: '',
      textBaseline: '',
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      closePath: vi.fn(),
      stroke: vi.fn(),
      arc: vi.fn((x: number, y: number, r: number) => {
        arcs.push({ x, y, r });
      }),
      fill: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      setLineDash: vi.fn(),
      fillText: vi.fn(),
      measureText: (text: string) => ({ width: text.length * 6 }),
    };
    return { ctx: stub as unknown as CanvasRenderingContext2D, arcs };
  };

  /** The current-dot arcs (radius 2) a draw produced. */
  const dots = (arcs: Arc[]): Point[] => arcs.filter((a) => a.r === 2);

  /** Unit vector along `p`. */
  const unit = (p: Point): Point => {
    const len = Math.hypot(p.x, p.y);
    return len === 0 ? { x: 0, y: 0 } : { x: p.x / len, y: p.y / len };
  };

  /** Whether any dot sits within epsilon of `p`. */
  const hasDot = (pts: Point[], p: Point): boolean =>
    pts.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < 0.01);

  /** Draw `def` at `phase`, returning the dot arcs. */
  const drawAt = (def: { draw(g: DrawContext, e: CircuitElement): void }, e: CircuitElement, phase: number, conventional = true): Point[] => {
    const { ctx, arcs } = dotCtx();
    def.draw({ ...context(ctx, phase), current: 0.01, voltages: [5, 0, 0], conventional }, e);
    return dots(arcs);
  };

  /** Asserts the dots advance along `path`: a dot sits exactly at the path
   *  head at phase 0, and at phase 2 that same dot is 2 units further along
   *  the first segment. A run drawn the other way starts at the path tail (or
   *  mid-path), so no dot sits at the head and the first check fails; a run
   *  that starts at the head but points away fails the second. Both checks
   *  therefore fail on the mirrored draw. */
  const expectAdvances = (def: { draw(g: DrawContext, e: CircuitElement): void }, e: CircuitElement, path: Point[]): void => {
    const dir = unit({ x: path[1].x - path[0].x, y: path[1].y - path[0].y });
    expect(hasDot(drawAt(def, e, 0), path[0])).toBe(true);
    expect(
      hasDot(drawAt(def, e, 2), {
        x: path[0].x + 2 * dir.x,
        y: path[0].y + 2 * dir.y,
      }),
    ).toBe(true);
  };

  it('a resistor draws dots from post 0 toward post 1', () => {
    // The control: current enters post 0 and leaves post 1
    // (ResistorElm.java:109), so a positive reported current must march the
    // dots along the post-0-to-post-1 axis.
    expectAdvances(
      RESISTOR_DEF,
      { id: 1, kind: 'resistor', x1: 0, y1: 0, x2: 100, y2: 0, flags: 0, params: {} },
      [{ x: 0, y: 0 }, { x: 100, y: 0 }],
    );
  });

  it('a DC source draws dots from the negative post toward the positive post', () => {
    // Delivering 10 mA, the dots enter the symbol on the negative side and
    // leave the symbol toward the positive post: the whole path advances from
    // post 0 (negative, (0,100)) to post 1 (positive, (0,0)), matching
    // VoltageElm.draw's `drawDots(point1, lead1, ...)` and
    // `drawDots(point2, lead2, -curcount)` split (VoltageElm.java:328-330).
    expectAdvances(
      VOLTAGE_DEF,
      { id: 1, kind: 'voltage', x1: 0, y1: 100, x2: 0, y2: 0, flags: 0, params: { waveform: 0 } },
      [{ x: 0, y: 100 }, { x: 0, y: 0 }],
    );
  });

  it('a rail draws dots from the symbol end toward the post', () => {
    // A delivering rail measures +current and RailElm.draw negates it for its
    // stem (`updateDotCount(-current, ...)`, RailElm.java:61), so the dots
    // run from the symbol at (100,0) back to the post at (0,0). The dot run
    // itself starts at the stem's lead, one circle radius short of the symbol
    // (railLead, RailElm.java:43), so the path head is (83,0).
    expectAdvances(
      RAIL_DEF,
      { id: 1, kind: 'rail', x1: 0, y1: 0, x2: 100, y2: 0, flags: 0, params: { waveform: 0, maxVoltage: 5 } },
      [{ x: 83, y: 0 }, { x: 0, y: 0 }],
    );
  });

  // The mosfet draw code is identical for both channel types (the source and
  // drain labels swap with the channel but the geometry and the dot runs do
  // not), so both tests assert the same coordinate motion. What differs is the
  // label meaning: for an N-channel the +16 unit post is the drain and the
  // dots flow drain-to-source; for a P-channel it is the source and the same
  // flow is source-to-drain. The reported channel current `ids` is positive
  // drain-to-source in the device frame for both (MosfetElm.java:642-644),
  // and the draw reverses each segment against it (MosfetElm.java:315-319),
  // so a positive `g.current` marches the dots from the (100,-16) post toward
  // the (100,16) post.
  const mosfet = (pnp: number): CircuitElement => ({
    id: 1,
    kind: 'mosfet',
    x1: 0,
    y1: 0,
    x2: 100,
    y2: 0,
    flags: 0,
    params: { pnp },
  });

  it('an N-MOSFET channel draws dots from the drain toward the source', () => {
    expectAdvances(MOSFET_DEF, mosfet(1), [
      { x: 100, y: -16 },
      { x: 78, y: -16 },
      { x: 78, y: 16 },
      { x: 100, y: 16 },
    ]);
  });

  it('a P-MOSFET channel draws dots from the source toward the drain', () => {
    expectAdvances(MOSFET_DEF, mosfet(-1), [
      { x: 100, y: -16 },
      { x: 78, y: -16 },
      { x: 78, y: 16 },
      { x: 100, y: 16 },
    ]);
  });

  it('electron-flow mode reverses every direction and changes nothing else', () => {
    // The conventional-current toggle flips the phase step sign in
    // `dotPhaseStep` (dots.ts: `return conventional ? cadd : -cadd`), so the
    // per-element phase *decreases* each frame in electron-flow mode. The draw
    // itself is untouched by the toggle except for the dot colour: the same
    // phase produces the same dot geometry either way, and a *lower* phase
    // means the dots are behind where a conventional frame would have put
    // them. Together those two facts are the flip: every direction reverses,
    // nothing else changes.
    const current = 0.01;
    const dt = 1 / 60;
    const stepC = dotPhaseStep(current, 50, dt, true);
    const stepE = dotPhaseStep(current, 50, dt, false);
    expect(stepC).toBeGreaterThan(0);
    expect(stepE).toBeCloseTo(-stepC, 12);
    const cases: Array<{ def: { draw(g: DrawContext, e: CircuitElement): void }; e: CircuitElement; path: Point[] }> = [
      {
        def: RESISTOR_DEF,
        e: { id: 1, kind: 'resistor', x1: 0, y1: 0, x2: 100, y2: 0, flags: 0, params: {} },
        path: [{ x: 0, y: 0 }, { x: 100, y: 0 }],
      },
      {
        def: RAIL_DEF,
        e: { id: 1, kind: 'rail', x1: 0, y1: 0, x2: 100, y2: 0, flags: 0, params: { waveform: 0, maxVoltage: 5 } },
        path: [{ x: 83, y: 0 }, { x: 0, y: 0 }],
      },
      {
        def: MOSFET_DEF,
        e: mosfet(1),
        path: [{ x: 100, y: -16 }, { x: 78, y: -16 }, { x: 78, y: 16 }, { x: 100, y: 16 }],
      },
    ];
    for (const { def, e, path } of cases) {
      // Same geometry at the same phase whether the toggle is on or off: the
      // conventional flag only reaches the draw as the dot colour.
      const conventional = drawAt(def, e, 2, true);
      const electron = drawAt(def, e, 2, false);
      expect(electron.map((p) => `${p.x},${p.y}`).sort()).toEqual(
        conventional.map((p) => `${p.x},${p.y}`).sort(),
      );
      // The dot advances from the head as the phase rises (asserted by the
      // direction tests), so the *negative* electron step, which drives the
      // phase down, moves every dot the other way: the dot that a
      // conventional frame has 2 units along the path sits back at the head
      // in the preceding electron frame.
      const dir = unit({ x: path[1].x - path[0].x, y: path[1].y - path[0].y });
      expect(hasDot(drawAt(def, e, 0), path[0])).toBe(true);
      expect(
        hasDot(drawAt(def, e, 2), {
          x: path[0].x + 2 * dir.x,
          y: path[0].y + 2 * dir.y,
        }),
      ).toBe(true);
    }
  });
});
