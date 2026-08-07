import { describe, expect, it, vi } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import {
  CANVAS_FONT_FAMILY,
  canvasFont,
  currentDots,
  currentDotsPath,
  formatValue,
  makeTheme,
  powerColor,
  powerColorT,
  powerMult,
  strokeStyle,
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
  selected: false,
  hovered: false,
  onHighlightedNet: false,
  voltageRange: 5,
  powerRange: 50,
  scale: 1,
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

  it('sets butt caps and miter joins on every stroke', () => {
    // Pins the crisp-line regression: round caps and joins would bulge wire
    // ends and soften polygon corners.
    const { ctx } = mkCtx();
    strokeStyle(context(ctx, 0), '#ffffff');
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
    // Dark-theme neutral #6e7781 to negative #ff5555 at t = 0.5. The light
    // theme does not exist yet; when it lands this endpoint colour moves.
    expect(powerColor(powerContext({ showPowerColor: true }), half)).toBe('rgb(183,102,107)');
  });

  it('colours dissipated power red and generated power green', () => {
    const g = powerContext({ showPowerColor: true });
    // The ramp blends the theme colours, so the endpoints come back as rgb
    // strings: dark-theme neutral #6e7781, negative #ff5555, positive #3fb950.
    expect(powerColor(g, 0)).toBe('rgb(110,119,129)');
    expect(powerColor(g, 1e6)).toBe('rgb(255,85,85)');
    expect(powerColor(g, -1e6)).toBe('rgb(63,185,80)');
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
