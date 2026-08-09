import { describe, expect, it, vi } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import {
  CANVAS_FONT_FAMILY,
  canvasFont,
  currentDots,
  currentDotsPath,
  formatValue,
  line,
  makeTheme,
  polyline,
  powerColor,
  powerColorT,
  powerMult,
  strokeStyle,
  ZIGZAG_HS,
  zigzagPoints,
} from './draw';
import { TOO_FAST } from './dots';
import type { DrawContext } from '../model/types';

interface CtxStub {
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  lineCap: string;
  lineJoin: string;
  globalAlpha: number;
  beginPath: ReturnType<typeof vi.fn>;
  moveTo: ReturnType<typeof vi.fn>;
  lineTo: ReturnType<typeof vi.fn>;
  stroke: ReturnType<typeof vi.fn>;
  arc: ReturnType<typeof vi.fn>;
  fill: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
  restore: ReturnType<typeof vi.fn>;
}

const mkCtx = (): {
  ctx: CanvasRenderingContext2D;
  calls: string[];
  arcs: { x: number; y: number }[];
} => {
  const calls: string[] = [];
  const arcs: { x: number; y: number }[] = [];
  const record = (name: string) => vi.fn(() => calls.push(name));
  const stub: CtxStub = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    lineCap: '',
    lineJoin: '',
    globalAlpha: 1,
    beginPath: record('beginPath'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    stroke: record('stroke'),
    arc: vi.fn((x: number, y: number) => {
      calls.push('arc');
      arcs.push({ x, y });
    }),
    fill: record('fill'),
    save: record('save'),
    restore: record('restore'),
  };
  return { ctx: stub as unknown as CanvasRenderingContext2D, calls, arcs };
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
    line(context(ctx, 0), { x: 0, y: 0 }, { x: 32, y: 0 }, '#ffffff', 2, 'round');
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
    // resistor, the coil, the bodyRect loop) must not soften its corners.
    const { ctx } = mkCtx();
    polyline(context(ctx, 0), [{ x: 0, y: 0 }, { x: 16, y: 8 }, { x: 32, y: 0 }], '#ffffff');
    expect(ctx.lineCap).toBe('butt');
    expect(ctx.lineJoin).toBe('miter');
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
