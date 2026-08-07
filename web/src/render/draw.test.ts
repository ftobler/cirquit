import { describe, expect, it, vi } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import {
  CANVAS_FONT_FAMILY,
  canvasFont,
  currentDots,
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

  const mkCtx = (): { ctx: CanvasRenderingContext2D; calls: string[] } => {
    const calls: string[] = [];
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
      arc: record('arc'),
      fill: record('fill'),
      save: record('save'),
      restore: record('restore'),
    };
    return { ctx: stub as unknown as CanvasRenderingContext2D, calls };
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
    selected: false,
    voltageRange: 5,
    scale: 1,
  });

  it('draws a translucent flow line instead of dots when too fast', () => {
    const { ctx, calls } = mkCtx();
    currentDots(context(ctx, TOO_FAST), { x: 0, y: 0 }, { x: 100, y: 0 }, 1e-3);
    expect(calls).toContain('stroke');
    expect(calls).not.toContain('arc');
  });

  it('keeps drawing dots for a finite phase', () => {
    const { ctx, calls } = mkCtx();
    currentDots(context(ctx, 2), { x: 0, y: 0 }, { x: 100, y: 0 }, 1e-3);
    expect(calls).toContain('arc');
    expect(calls).not.toContain('stroke');
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
