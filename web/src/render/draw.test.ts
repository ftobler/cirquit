import { describe, expect, it, vi } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import {
  CANVAS_FONT_FAMILY,
  canvasFont,
  currentDots,
  currentDotsPath,
  formatValue,
  makeTheme,
  strokeStyle,
} from './draw';
import { TOO_FAST } from './dots';
import type { DrawContext } from '../model/types';

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
    value: 0,
    dotPhase,
    showCurrent: true,
    showValues: false,
    showVoltageColor: false,
    conventional: true,
    selected: false,
    voltageRange: 5,
    scale: 1,
  });

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
