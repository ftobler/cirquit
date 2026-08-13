import { describe, expect, it, vi } from 'vitest';
import { TOOLBOX } from '../model/registry';
import { makeTheme } from './draw';
import { renderToolIcon, TOOL_ICON_SIZE, type ToolIconSurface } from './toolIcon';

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
  createLinearGradient: ReturnType<typeof vi.fn>;
  setTransform: ReturnType<typeof vi.fn>;
  scale: ReturnType<typeof vi.fn>;
  translate: ReturnType<typeof vi.fn>;
  beginPath: ReturnType<typeof vi.fn>;
  moveTo: ReturnType<typeof vi.fn>;
  lineTo: ReturnType<typeof vi.fn>;
  closePath: ReturnType<typeof vi.fn>;
  stroke: ReturnType<typeof vi.fn>;
  arc: ReturnType<typeof vi.fn>;
  rect: ReturnType<typeof vi.fn>;
  fill: ReturnType<typeof vi.fn>;
  fillRect: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
  restore: ReturnType<typeof vi.fn>;
  setLineDash: ReturnType<typeof vi.fn>;
  fillText: ReturnType<typeof vi.fn>;
  measureText: (text: string) => { width: number };
}

/** The mkCtx fake of draw.test.ts, extended with the transform calls
 *  `renderToolIcon` makes, a record of every fill, and the closed paths the
 *  symbol emits, so the background paint, the strokes and the drawn geometry
 *  are all assertable. */
const mkCtx = (): {
  canvas: ToolIconSurface;
  stub: CtxStub;
  calls: string[];
  fills: { style: string; x: number; y: number; w: number; h: number }[];
  subpaths: { x: number; y: number }[][];
} => {
  const calls: string[] = [];
  const fills: { style: string; x: number; y: number; w: number; h: number }[] = [];
  // One entry per closed path (beginPath ... stroke/fill), each a list of the
  // points its vertices cover. The background fillRect is a direct call, never
  // inside a path, so it stays out of the subpaths and the geometry test
  // asserts on the symbol alone.
  const subpaths: { x: number; y: number }[][] = [];
  let current: { x: number; y: number }[] | null = null;
  const close = () => {
    if (current !== null && current.length > 0) subpaths.push(current);
    current = null;
  };
  const point = (x: number, y: number) => {
    if (current === null) current = [];
    current.push({ x, y });
  };
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
    createLinearGradient: vi.fn(() => {
      calls.push('createLinearGradient');
      return { addColorStop: () => {} } as unknown as CanvasGradient;
    }),
    setTransform: record('setTransform'),
    scale: record('scale'),
    translate: record('translate'),
    beginPath: vi.fn(() => {
      calls.push('beginPath');
      close();
      current = [];
    }),
    moveTo: vi.fn((x: number, y: number) => {
      calls.push('moveTo');
      point(x, y);
    }),
    lineTo: vi.fn((x: number, y: number) => {
      calls.push('lineTo');
      point(x, y);
    }),
    closePath: record('closePath'),
    // A circle spans both axes from its centre, so the bounding corners carry
    // its extent; a current-dot arc (radius ~2) and a coil arc (radius ~8)
    // both land on their real sizes.
    arc: vi.fn((x: number, y: number, radius: number) => {
      calls.push('arc');
      point(x - radius, y - radius);
      point(x + radius, y + radius);
    }),
    rect: vi.fn((x: number, y: number, w: number, h: number) => {
      calls.push('rect');
      point(x, y);
      point(x + w, y);
      point(x, y + h);
      point(x + w, y + h);
    }),
    stroke: vi.fn(() => {
      calls.push('stroke');
      close();
    }),
    fill: vi.fn(() => {
      calls.push('fill');
      close();
    }),
    fillRect: vi.fn((x: number, y: number, w: number, h: number) => {
      calls.push('fillRect');
      fills.push({ style: stub.fillStyle, x, y, w, h });
    }),
    save: record('save'),
    restore: record('restore'),
    setLineDash: record('setLineDash'),
    fillText: record('fillText'),
    measureText: () => ({ width: 10 }),
  };
  return {
    canvas: { getContext: () => stub as unknown as CanvasRenderingContext2D },
    stub,
    calls,
    fills,
    subpaths,
  };
};

describe('renderToolIcon', () => {
  it('draws every toolbox icon against the fake context without throwing', () => {
    // ~130 defs under an empty context: any draw that indexes live sim data
    // (voltages, postCurrents, wave) or divides by a missing default would
    // throw here and is a defect in the def, not in the icon helper.
    for (const t of TOOLBOX) {
      const { canvas } = mkCtx();
      expect(() => renderToolIcon(t.id, canvas, true), t.id).not.toThrow();
    }
  });

  it('fills the whole canvas with the theme background before drawing', () => {
    const { canvas, fills, calls } = mkCtx();
    renderToolIcon('resistor', canvas, true);
    // The background paint is the first drawing call, at the identity
    // transform, covering the full icon.
    expect(calls.indexOf('fillRect')).toBe(1);
    expect(fills[0]).toEqual({
      style: makeTheme(true).background,
      x: 0,
      y: 0,
      w: TOOL_ICON_SIZE,
      h: TOOL_ICON_SIZE,
    });
  });

  it('runs the def draw, so the resistor body and leads are stroked', () => {
    const { canvas, calls } = mkCtx();
    renderToolIcon('resistor', canvas, true);
    expect(calls).toContain('beginPath');
    expect(calls).toContain('stroke');
    expect(calls).toContain('setTransform');
  });

  it('flips the background fill with the theme', () => {
    const dark = mkCtx();
    renderToolIcon('resistor', dark.canvas, true);
    expect(dark.fills[0].style).toBe(makeTheme(true).background);

    const light = mkCtx();
    renderToolIcon('resistor', light.canvas, false);
    expect(light.fills[0].style).toBe(makeTheme(false).background);
    expect(light.fills[0].style).not.toBe(dark.fills[0].style);
  });

  it('stubs the split semiconductors with their own defaults, not the kind defaults', () => {
    // The PNP flavour must draw the pnp-transistor arrow, which the icon
    // helper reaches only by applying the entry's defaults (makeToolElement).
    const { canvas, calls } = mkCtx();
    expect(() => renderToolIcon('pnp', canvas, true)).not.toThrow();
    expect(calls).toContain('stroke');
  });

  it('does nothing for an unknown tool id', () => {
    const { canvas, calls } = mkCtx();
    expect(() => renderToolIcon('zzzznope', canvas, true)).not.toThrow();
    expect(calls).toEqual([]);
  });

  it('paints real geometry for every icon, not a collapsed dot', () => {
    // A kind without `defaultLength` used to stub a zero-length axis, and
    // `interp` ignores its perpendicular offset when the segment length is 0
    // (draw.ts:45-55), so every body built from interp points collapsed to a
    // ~3 px dot. Assert each icon emits at least one subpath spanning more
    // than 8 circuit units in one axis. A wire is a straight line and
    // legitimately spans only x; only a collapsed symbol fails on both.
    //
    // The text tool is the one deliberate exclusion: it paints a pure glyph
    // with `fillText`, never path geometry, so there is nothing to span.
    const degenerate = new Set(['decoration']);
    for (const t of TOOLBOX) {
      if (degenerate.has(t.id)) continue;
      const { canvas, subpaths } = mkCtx();
      renderToolIcon(t.id, canvas, true);
      const span = subpaths.reduce((best, p) => {
        const xs = p.map((c) => c.x);
        const ys = p.map((c) => c.y);
        const s = Math.max(
          Math.max(...xs) - Math.min(...xs),
          Math.max(...ys) - Math.min(...ys),
        );
        return Math.max(best, s);
      }, 0);
      expect(span, t.id).toBeGreaterThan(8);
    }
  });
});
