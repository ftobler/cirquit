import { describe, expect, it, vi } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import {
  CANVAS_FONT_FAMILY,
  axisColor,
  axisVoltage,
  bodyRect,
  canvasFont,
  closedPolyline,
  COIL_LOOPS,
  currentDots,
  currentDotsPath,
  dragpostHandlesFrom,
  drawLeads,
  elementLength,
  formatValue,
  formatValueShort,
  gradientPolyline,
  interp,
  lead,
  line,
  makeTheme,
  polyline,
  powerColor,
  powerColorT,
  powerMult,
  rectCorners,
  strokeStyle,
  voltageColor,
  fuseColor,
  tempColor,
  ZIGZAG_HS,
  zigzagPoints,
} from './draw';
import { RESISTOR_DEF } from '../model/registry/elements/resistor';
import { MEMRISTOR_DEF } from '../model/registry/elements/memristor';
import { GROUND_DEF } from '../model/registry/elements/ground';
import { TRANSISTOR_DEF, transistorBarContacts } from '../model/registry/elements/transistor';
import { INDUCTOR_DEF } from '../model/registry/elements/inductor';
import { RELAY_DEF, RELAY_CONTACT_DEF } from '../model/registry/elements/relay';
import { SWITCH_DEF } from '../model/registry/elements/switch';
import { SWITCH2_DEF } from '../model/registry/elements/switch2';
import { CROSS_SWITCH_DEF } from '../model/registry/elements/crossSwitch';
import { ANALOG_SWITCH_DEF } from '../model/registry/elements/analogSwitch';
import { ANALOG_SWITCH2_DEF } from '../model/registry/elements/analogSwitch2';
import { SWEEP_DEF } from '../model/registry/elements/sweep';
import { AM_DEF } from '../model/registry/elements/am';
import { FM_DEF } from '../model/registry/elements/fm';
import { AUDIO_INPUT_DEF } from '../model/registry/elements/audioInput';
import { DATA_INPUT_DEF } from '../model/registry/elements/dataInput';
import { DELAY_BUFFER_DEF } from '../model/registry/elements/delayBuffer';
import { OUTPUT_DEF, outputText } from '../model/registry/elements/output';
import { CONTACT_STROKE_WIDTH } from '../model/registry/shared';
import { TRANSFORMER_DEF } from '../model/registry/elements/transformer';
import { MOSFET_DEF } from '../model/registry/elements/mosfet';
import { RAIL_DEF } from '../model/registry/elements/rail';
import { VOLTAGE_DEF } from '../model/registry/elements/voltage';
import { CAPACITOR_DEF } from '../model/registry/elements/capacitor';
import { LAMP_DEF } from '../model/registry/elements/lamp';
import { WIRE_DEF } from '../model/registry/elements/wire';
import { TRANSMISSION_LINE_DEF } from '../model/registry/elements/transmissionLine';
import { SCR_DEF, scrGeometry } from '../model/registry/elements/scr';
import { TRIAC_DEF, triacGeometry } from '../model/registry/elements/triac';
import { MIN_CURRENT_FLOW, TOO_FAST, dotPhaseStep } from './dots';
import {
  OUTPUT_SHOW_VOLTAGE,
  SWITCH_IEC,
  VOLTAGE_CIRCLE_SYMBOL,
  WIRE_SHOW_CURRENT,
  WIRE_SHOW_VOLTAGE,
} from '../model/registry/flags';
import {
  CHIP_FLIP_X,
  CHIP_FLIP_Y,
  CHIP_FLIP_XY,
  CHIP_SMALL,
  drawChip,
  type ChipPinDef,
} from '../model/registry/elements/dFlipFlop';
import { DEFAULT_SETTINGS } from '../model/types';
import type { CircuitElement, DrawContext, ElementDef, Point } from '../model/types';

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
  beginPath: ReturnType<typeof vi.fn>;
  moveTo: ReturnType<typeof vi.fn>;
  lineTo: ReturnType<typeof vi.fn>;
  closePath: ReturnType<typeof vi.fn>;
  stroke: ReturnType<typeof vi.fn>;
  arc: ReturnType<typeof vi.fn>;
  fill: ReturnType<typeof vi.fn>;
  fillRect: ReturnType<typeof vi.fn>;
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

/** A recorded gradient: the axis the body ramps along and the stops the draw
 *  added, mirroring the real CanvasGradient the live context hands back. */
interface GradientRecord {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  stops: { offset: number; color: string }[];
  addColorStop(offset: number, color: string): void;
}

const mkCtx = (): {
  ctx: CanvasRenderingContext2D;
  stub: CtxStub;
  calls: string[];
  arcs: { x: number; y: number }[];
  rects: { x: number; y: number; w: number; h: number }[];
  texts: TextRecord[];
  paths: { x: number; y: number }[][];
  strokes: { style: string | CanvasGradient; width: number; join: string; cap: string }[];
  grads: GradientRecord[];
} => {
  const calls: string[] = [];
  const arcs: { x: number; y: number }[] = [];
  const rects: { x: number; y: number; w: number; h: number }[] = [];
  const texts: TextRecord[] = [];
  const paths: { x: number; y: number }[][] = [];
  const strokes: { style: string | CanvasGradient; width: number; join: string; cap: string }[] = [];
  const grads: GradientRecord[] = [];
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
    createLinearGradient: vi.fn((x0: number, y0: number, x1: number, y1: number) => {
      calls.push('createLinearGradient');
      const grad: GradientRecord = {
        x0,
        y0,
        x1,
        y1,
        stops: [],
        addColorStop: (offset, color) => grad.stops.push({ offset, color }),
      };
      grads.push(grad);
      return grad;
    }),
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
      // The colour, width, cap and join at stroke time, in draw order: how a
      // per-segment gradient body is asserted on, how the coil's bevel
      // joins are told apart from a polygon's miter ones, and how a symbol's
      // stem cap is pinned against the conductor round caps.
      strokes.push({
        style: stub.strokeStyle,
        width: stub.lineWidth,
        cap: stub.lineCap,
        join: stub.lineJoin,
      });
    }),
    arc: vi.fn((x: number, y: number) => {
      calls.push('arc');
      arcs.push({ x, y });
    }),
    fill: record('fill'),
    fillRect: vi.fn((x: number, y: number, w: number, h: number) => {
      calls.push('fillRect');
      rects.push({ x, y, w, h });
    }),
    save: record('save'),
    restore: record('restore'),
    setLineDash: record('setLineDash'),
    fillText: vi.fn((text: string, x: number, y: number) => {
      calls.push('fillText');
      texts.push({
        text,
        x,
        y,
        font: stub.font,
        align: stub.textAlign,
        baseline: stub.textBaseline,
      });
    }),
    // The same heuristic the SVG recorder uses, `length * size * 0.6`, so the
    // font-shrink loop terminates headlessly like it does on a real canvas.
    measureText: (text: string) => {
      const m = /^(\d+(?:\.\d+)?)px/.exec(stub.font);
      const size = m ? Number(m[1]) : 10;
      return { width: text.length * size * 0.6 };
    },
  };
  return {
    ctx: stub as unknown as CanvasRenderingContext2D,
    stub,
    calls,
    arcs,
    rects,
    texts,
    paths,
    strokes,
    grads,
  };
};

const context = (ctx: CanvasRenderingContext2D, dotPhase: number): DrawContext => ({
  ctx,
  theme: makeTheme(),
  voltages: [],
  current: 1e-3,
  voltage: 0,
  power: 0,
  value: 0,
  state: 0,
  wave: [],
  dotPhase,
  postCurrents: [],
  postDotPhases: [],
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

describe('canvas value formatting (short form)', () => {
  // The on-canvas labels format with formatValueShort: no space between the
  // number and its unit, and no ohm unit at all. The panel and scope keep
  // formatValue, whose unit-space behaviour the block above pins.
  it('keeps the engineering prefix', () => {
    expect(formatValueShort(4700, 'Ω')).toBe('4.7k');
    expect(formatValueShort(1e6, 'Ω')).toBe('1M');
    expect(formatValueShort(0.05, 'A')).toBe('50mA');
  });

  it('drops the ohm unit entirely', () => {
    expect(formatValueShort(4700, 'Ω')).toBe('4.7k');
    expect(formatValueShort(0, 'Ω')).toBe('0');
  });

  it('keeps other units without the space', () => {
    expect(formatValueShort(0.000001, 'F')).toBe('1µF');
    expect(formatValueShort(0.01, 'H')).toBe('10mH');
    expect(formatValueShort(5, 'V')).toBe('5V');
  });

  it('handles zero and non-finite values', () => {
    expect(formatValueShort(0, 'V')).toBe('0V');
    expect(formatValueShort(NaN)).toBe('--');
  });

  it('keeps the sign', () => {
    expect(formatValueShort(-2.5, 'V')).toBe('-2.5V');
  });

  it('honours the fraction-digit count like formatValue', () => {
    expect(formatValueShort(0.0555, 'V', 1)).toBe('55.5mV');
    expect(formatValueShort(4700, 'Ω', 0)).toBe('5k');
  });

  it('keeps a part value intact at the default short-format digit count', () => {
    // The label of a 6.8 µF capacitor must stay "6.8µF" at the default one
    // digit: one *fraction* digit, not one significant figure, which would
    // have rounded the part number away to "7µF".
    expect(formatValueShort(6.8e-6, 'F', DEFAULT_SETTINGS.shortDecimalDigits)).toBe('6.8µF');
    expect(formatValueShort(4.7e3, 'Ω', DEFAULT_SETTINGS.shortDecimalDigits)).toBe('4.7k');
    expect(formatValueShort(2.2e-9, 'F', DEFAULT_SETTINGS.shortDecimalDigits)).toBe('2.2nF');
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
    // The other ten theme keys come from the palette, untouched.
    expect(theme.background).toBe('#ffffff');
    expect(theme.grid).toBe('#d0d7de');
    expect(theme.wire).toBe('#000000');
  });

  it('makeTheme without a settings argument is the stock palette', () => {
    const theme = makeTheme(false);
    expect(theme.positive).toBe('#1a7f37');
    expect(theme.negative).toBe('#cf222e');
    expect(theme.neutral).toBe('#6e7781');
    expect(theme.selection).toBe('#54aeff');
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
    // The dark theme is the parity-exact palette: four of the five colour-scale
    // roles are upstream's Color constants (CircuitElm.java:200-205, Color.java:
    // 26-37). Selection is the deliberate exception: it used to carry upstream's
    // cyan but now matches the hover blue (the owner's call that the hover
    // colour was the right one), so it is pinned to highlight below rather than
    // to cyan. A future palette tweak has to argue with this claim.
    const theme = makeTheme();
    expect(theme.positive).toBe('#00ff00'); // Color.green
    expect(theme.negative).toBe('#ff0000'); // Color.red
    expect(theme.neutral).toBe('#808080'); // Color.gray
    expect(theme.currentDot).toBe('#ffff00'); // Color.yellow
    expect(theme.selection).toBe(theme.highlight); // not Color.cyan any more
  });

  it('pins the scope grid and the theme-dependent lightGray in both themes', () => {
    // The scope draws its own grid, not the schematic's dot grid: upstream's
    // minor/major pair is #404040 / #A0A0A0, and its printable mode swaps in
    // #D0D0D0 / #808080 (Scope.java:798-806). lightGrayText is upstream's
    // CircuitElm.lightGrayColor, which the printable theme flips to black
    // (ImageExporter.java:192-196), unlike the fixed Color.lightGray above.
    const dark = makeTheme();
    expect(dark.scopeGridMinor).toBe('#404040');
    expect(dark.scopeGridMajor).toBe('#a0a0a0');
    expect(dark.lightGrayText).toBe('#c0c0c0');
    const light = makeTheme(false);
    expect(light.scopeGridMinor).toBe('#d0d0d0');
    expect(light.scopeGridMajor).toBe('#808080');
    expect(light.lightGrayText).toBe('#000000');
    // The schematic grid stays its own role in both themes.
    expect(dark.grid).not.toBe(dark.scopeGridMinor);
    expect(light.grid).not.toBe(light.scopeGridMinor);
  });

  it('paints hover and selection identically in both themes', () => {
    // Upstream paints the hovered element, the selection and the highlighted
    // net all in the single selectColor (CircuitElm.needsHighlight:1308-1313
    // and getVoltageColor:1210-1212). The port keeps a separate highlight role
    // so the two can diverge again later, but the owner's call is that the
    // hover blue is the correct one, so selection matches highlight in both
    // themes: a selected element and a hovered one read the same.
    const light = makeTheme(false);
    expect(light.highlight).toBe('#54aeff');
    expect(light.selection).toBe(light.highlight);
    const dark = makeTheme();
    expect(dark.highlight).toBe('#58a6ff');
    expect(dark.selection).toBe(dark.highlight);
  });
});

describe('current dots', () => {
  it('draws a translucent flow line with shimmering dots when too fast', () => {
    const { ctx, calls } = mkCtx();
    currentDots(context(ctx, TOO_FAST), { x: 0, y: 0 }, { x: 100, y: 0 }, 1e-3);
    expect(calls).toContain('stroke');
    expect(calls).toContain('fillRect');
  });

  it('keeps drawing dots for a finite phase', () => {
    const { ctx, calls } = mkCtx();
    currentDots(context(ctx, 2), { x: 0, y: 0 }, { x: 100, y: 0 }, 1e-3);
    expect(calls).toContain('fillRect');
    expect(calls).not.toContain('stroke');
  });

  it('draws nothing below the 0.1 pA flow threshold', () => {
    // A floating node's numerical residue is pico-scale; below the threshold
    // the wire must not show a dot or a flow line. 0.1 pA itself shows.
    const { ctx, calls } = mkCtx();
    currentDots(context(ctx, 0), { x: 0, y: 0 }, { x: 100, y: 0 }, MIN_CURRENT_FLOW - 1e-18);
    expect(calls).not.toContain('fillRect');
    expect(calls).not.toContain('stroke');
    currentDots(context(ctx, 0), { x: 0, y: 0 }, { x: 100, y: 0 }, MIN_CURRENT_FLOW);
    expect(calls).toContain('fillRect');
  });

  it('draws each dot as a 4x4 square centred on the dot position', () => {
    // Upstream's current dot is a filled 4x4 rect, `fillRect(x0-2, y0-2, 4, 4)`
    // (CircuitElm.java:510), never a radius-2 disc.
    const { ctx, rects } = mkCtx();
    currentDots(context(ctx, 0), { x: 0, y: 0 }, { x: 48, y: 0 }, 1e-3);
    expect(rects).toEqual([
      { x: -2, y: -2, w: 4, h: 4 },
      { x: 14, y: -2, w: 4, h: 4 },
      { x: 30, y: -2, w: 4, h: 4 },
    ]);
    expect(rects).toHaveLength(3);
  });

  it('spaces dots 16 apart along a segment', () => {
    // One dot every DOT_SPACING from the phase offset; with spacing 8 there
    // would be 13 of them instead of the 7 here.
    const { ctx, rects } = mkCtx();
    currentDots(context(ctx, 0), { x: 0, y: 0 }, { x: 100, y: 0 }, 1e-3);
    expect(rects.map((a) => a.x)).toEqual([-2, 14, 30, 46, 62, 78, 94]);
  });

  it('keeps the stream and shimmering dots on every segment of a too-fast path', () => {
    // A path whose phase is TOO_FAST must draw the translucent flow line on
    // each segment. Before dotPhaseAfter passed the sentinel through, the
    // chained phase after the first segment became NaN, so only the first
    // segment drew anything.
    const { ctx, rects, calls } = mkCtx();
    currentDotsPath(
      context(ctx, TOO_FAST),
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 200, y: 0 },
      ],
      1e-3,
    );
    // One flow line per segment, not just the first.
    expect(calls.filter((c) => c === 'stroke')).toHaveLength(2);
    // Each segment still gets its own shimmering dots; the segments span the
    // x-axis in order, so one dot must land in each half.
    expect(rects.some((a) => a.x < 100)).toBe(true);
    expect(rects.some((a) => a.x > 100)).toBe(true);
  });

  it('chains phase across segments so dots keep 16-unit spacing', () => {
    // A two-segment path with no dots at the joints: the phase carries over by
    // segment length, so rects land at path distances 0, 16 and 32. Drawing
    // every segment from the same raw phase would add rects at 8 and 24.
    const { ctx, rects } = mkCtx();
    currentDotsPath(
      context(ctx, 0),
      [
        { x: 0, y: 0 },
        { x: 8, y: 0 },
        { x: 40, y: 0 },
      ],
      1e-3,
    );
    expect(rects.map((a) => a.x)).toEqual([-2, 14, 30]);
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

describe('dragpost handles', () => {
  // The selection-colour rects drawn on the dragged element's control points
  // while a post drag is in flight, upstream's CircuitElm.drawHandles
  // (CircuitElm.java:747-761): a 7x7 fill at each stored endpoint, the grabbed
  // one at 9x9, so the moving control point reads distinctly.

  it('fills the grabbed control point at 9x9 and the other at 7x7', () => {
    const { ctx, stub } = mkCtx();
    dragpostHandlesFrom(
      context(ctx, 0),
      [
        { x: 0, y: 0 },
        { x: 64, y: 0 },
      ],
      0,
    );
    // The centre (not the top-left corner) is on the post, hence the
    // fractional anchors: (-4.5, -4.5) for the 9x9, (-3.5, -3.5) for the 7x7.
    expect(stub.fillRect).toHaveBeenCalledWith(-4.5, -4.5, 9, 9);
    expect(stub.fillRect).toHaveBeenCalledWith(60.5, -3.5, 7, 7);
  });

  it('swaps the 9x9 to the other endpoint when that one is grabbed', () => {
    const { ctx, stub } = mkCtx();
    dragpostHandlesFrom(
      context(ctx, 0),
      [
        { x: 0, y: 0 },
        { x: 64, y: 0 },
      ],
      1,
    );
    expect(stub.fillRect).toHaveBeenCalledWith(-3.5, -3.5, 7, 7);
    expect(stub.fillRect).toHaveBeenCalledWith(59.5, -4.5, 9, 9);
  });

  it('fills every rect in the selection colour', () => {
    const { ctx, stub } = mkCtx();
    dragpostHandlesFrom(
      context(ctx, 0),
      [
        { x: 0, y: 0 },
        { x: 64, y: 0 },
      ],
      0,
    );
    expect(stub.fillRect).toHaveBeenCalledTimes(2);
    expect(ctx.fillStyle).toBe(makeTheme().selection);
  });
});

describe('per-post current dots', () => {
  // The ground stem and the transistor's three leads are the two elements that
  // draw per-post runs. The mkCtx stub records every fillRect, and neither
  // symbol draws rects of its own (the stem, bars, base rectangle and arrow
  // are lines and polygons), so every recorded 4x4 rect is a current dot.

  const groundElement = (): CircuitElement => ({
    id: 1,
    kind: 'ground',
    x1: 100,
    y1: 0,
    x2: 100,
    y2: 32,
    flags: 0,
    params: {},
  });

  const transistorElement = (): CircuitElement => ({
    id: 1,
    kind: 'transistor',
    x1: 0,
    y1: 0,
    x2: 100,
    y2: 0,
    flags: 0,
    params: { pnp: 1 },
  });

  /** The current-dot rects as their centres, the point the dot sits on. */
  const centres = (rects: { x: number; y: number; w: number; h: number }[]): Point[] =>
    rects.filter((r) => r.w === 4 && r.h === 4).map((r) => ({ x: r.x + 2, y: r.y + 2 }));

  it('a ground draws a dot run down the stem only when current flows', () => {
    const { ctx, rects } = mkCtx();
    GROUND_DEF.draw({ ...context(ctx, 2), voltages: [0], current: 5e-3 }, groundElement());
    const dots = centres(rects);
    expect(dots.length).toBeGreaterThan(0);
    // The run goes p1 -> p2, so every dot lies on the stem and the first one
    // sits a phase offset from the post.
    expect(dots[0]).toEqual({ x: 100, y: 2 });
    expect(dots.every((a) => a.x === 100 && a.y >= 0 && a.y <= 32)).toBe(true);
  });

  it('a ground draws no dots when its current is zero', () => {
    const { ctx, rects } = mkCtx();
    GROUND_DEF.draw({ ...context(ctx, 2), voltages: [0], current: 0 }, groundElement());
    expect(centres(rects)).toEqual([]);
  });

  it('a transistor draws one run per terminal along its own lead', () => {
    // All three terminal currents non-zero: dots appear on the base lead (the
    // axis), the collector lead (-y side, the port's interp perpendicular is
    // the negation of upstream's) and the emitter lead (+y side), and the
    // counts follow the lead lengths (~84 and ~16 units each at one dot per
    // 16).
    const { ctx, rects } = mkCtx();
    TRANSISTOR_DEF.draw(
      {
        ...context(ctx, 0),
        voltages: [0, 0, 0],
        postCurrents: [-1e-4, -1e-3, 1.1e-3],
        postDotPhases: [0, 0, 0],
      },
      transistorElement(),
    );
    const dots = centres(rects);
    const onBase = dots.filter((a) => Math.abs(a.y) < 1);
    const onCollector = dots.filter((a) => a.y < -2);
    const onEmitter = dots.filter((a) => a.y > 2);
    expect(onBase.length).toBeGreaterThan(0);
    expect(onCollector.length).toBeGreaterThan(0);
    expect(onEmitter.length).toBeGreaterThan(0);
    expect(onBase.length).toBe(6); // 84 units of base lead
    expect(onCollector.length).toBe(2); // 16 units of collector lead
    expect(onEmitter.length).toBe(2); // 16 units of emitter lead
  });

  it('a transistor with a dead collector draws no collector dots', () => {
    // The reported defect: a saturated transistor drives ic to zero while ib
    // stays alive, and the collector must draw nothing while the base and
    // emitter keep their runs.
    const { ctx, rects } = mkCtx();
    TRANSISTOR_DEF.draw(
      {
        ...context(ctx, 0),
        voltages: [0, 0, 0],
        postCurrents: [-1e-4, 0, 1e-4],
        postDotPhases: [0, 0, 0],
      },
      transistorElement(),
    );
    const dots = centres(rects);
    expect(dots.filter((a) => Math.abs(a.y) < 1).length).toBeGreaterThan(0); // base
    expect(dots.filter((a) => a.y > 2).length).toBeGreaterThan(0); // emitter
    expect(dots.filter((a) => a.y < -2)).toEqual([]); // collector dead
  });

  it('draws no dots for either element when showCurrent is off', () => {
    const { ctx: c1, rects: r1 } = mkCtx();
    GROUND_DEF.draw(
      { ...context(c1, 2), voltages: [0], current: 5e-3, showCurrent: false },
      groundElement(),
    );
    expect(centres(r1)).toEqual([]);

    const { ctx: c2, rects: r2 } = mkCtx();
    TRANSISTOR_DEF.draw(
      {
        ...context(c2, 0),
        voltages: [0, 0, 0],
        postCurrents: [-1e-4, -1e-3, 1.1e-3],
        postDotPhases: [0, 0, 0],
        showCurrent: false,
      },
      transistorElement(),
    );
    expect(centres(r2)).toEqual([]);
  });

  it('starts each transistor dot run at its bar contact, body outward', () => {
    // Phase 0 puts the first dot of each run exactly on its anchor: the base
    // run at the bar's back edge and the collector and emitter runs at their
    // bar contacts, all three from the body outward to their posts. The
    // reordering of the base-bar fill must not move these anchors.
    const { ctx, rects } = mkCtx();
    TRANSISTOR_DEF.draw(
      {
        ...context(ctx, 0),
        voltages: [0, 0, 0],
        postCurrents: [-1e-4, -1e-3, 1.1e-3],
        postDotPhases: [0, 0, 0],
      },
      transistorElement(),
    );
    const t = transistorElement();
    const p1 = { x: t.x1, y: t.y1 };
    const p2 = { x: t.x2, y: t.y2 };
    const dn = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const base = interp(p1, p2, 1 - 16 / dn);
    const [c1, e1] = transistorBarContacts(t);
    const dots = centres(rects);
    const onBase = dots.filter((a) => Math.abs(a.y) < 1);
    const onCollector = dots.filter((a) => a.y < -2);
    const onEmitter = dots.filter((a) => a.y > 2);
    expect(onBase[0]).toEqual(base);
    expect(onCollector[0]).toEqual(c1);
    expect(onEmitter[0]).toEqual(e1);
  });

  it('fills the base bar last, over the leads, the arrow and the dots', () => {
    // Upstream fills its rectPoly last (TransistorElm.java:186-188), so the
    // bar covers the inner ends of the C/E leads and the innermost base dots;
    // the port once filled it first, which left the junction reading as two
    // separate shapes. The four-corner bar must be the last fill of the draw.
    const { ctx, calls } = mkCtx();
    TRANSISTOR_DEF.draw(
      {
        ...context(ctx, 0),
        voltages: [0, 0, 0],
        postCurrents: [-1e-4, -1e-3, 1.1e-3],
        postDotPhases: [0, 0, 0],
      },
      transistorElement(),
    );
    expect(calls.slice(-7)).toEqual([
      'beginPath',
      'moveTo',
      'lineTo',
      'lineTo',
      'lineTo',
      'closePath',
      'fill',
    ]);
    const lastFill = calls.lastIndexOf('fill');
    expect(lastFill).toBeGreaterThan(calls.lastIndexOf('stroke'));
    expect(lastFill).toBeGreaterThan(calls.lastIndexOf('arc'));
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

  it('lead() draws the terminal wire at round caps, the wire cap', () => {
    // A lead is a conductor from a post to the element body, so it ends round
    // like the round-capped wires it meets rather than flush like a symbol.
    const { ctx } = mkCtx();
    lead(context(ctx, 0), { x: 0, y: 0 }, { x: 8, y: 0 }, '#ffffff');
    expect(ctx.lineCap).toBe('round');
    expect(ctx.lineJoin).toBe('miter');
    expect(ctx.lineWidth).toBe(3);
  });

  it('ground draws its stem at butt caps, flush like a symbol body', () => {
    // The stem is the whole symbol body, not a lead from a post to a separate
    // body, so it strokes at the port's crisp butt cap like every other
    // symbol body; upstream draws the stem and bars round (UIManager.java:636
    // sets ROUND once per frame). The rectangular-short cap decision makes a
    // floating ground's free end read square, and the base bar covers the far
    // end either way. The first stroke is the stem, then one per bar.
    const { ctx, strokes } = mkCtx();
    GROUND_DEF.draw(
      {
        ...context(ctx, 0),
        voltages: [0],
        current: 0,
        showCurrent: false,
      },
      { id: 1, kind: 'ground', x1: 100, y1: 0, x2: 100, y2: 32, flags: 0, params: {} },
    );
    expect(strokes[0].cap).toBe('butt');
    expect(strokes[0].width).toBe(3);
    // The bars hang off the same cap policy, so every stroke is butt.
    expect(strokes.slice(1).every((s) => s.cap === 'butt')).toBe(true);
  });

  it('polyline() keeps butt caps and miter joins so polygon corners stay sharp', () => {
    // Regression guard for the crisp-line intent: a polygonal body (the zigzag
    // resistor, the bodyRect loop) must not soften its corners. The coil opts
    // out through its own bevel join argument, asserted in the coil tests.
    const { ctx } = mkCtx();
    polyline(
      context(ctx, 0),
      [
        { x: 0, y: 0 },
        { x: 16, y: 8 },
        { x: 32, y: 0 },
      ],
      '#ffffff',
    );
    expect(ctx.lineCap).toBe('butt');
    expect(ctx.lineJoin).toBe('miter');
  });
});

describe('output element readout', () => {
  // The output (dump O) is a stem-plus-text part like upstream's OutputElm: a
  // post at p1, the readout anchored at p2, and a lead between that stops half
  // a text width plus 8 short of the anchor so the stem never runs under the
  // label (OutputElm.java:71).
  const outputElement = (x2 = 100, flags = 0, params: Record<string, number> = {}): CircuitElement => ({
    id: 1,
    kind: 'output',
    x1: 0,
    y1: 0,
    x2,
    y2: 0,
    flags,
    params,
  });

  it('connects only at the first endpoint, never at the free end', () => {
    expect(OUTPUT_DEF.posts(outputElement(100))).toEqual([{ x: 0, y: 0 }]);
  });

  it('strokes a lead to the text margin and centres the voltage at the anchor', () => {
    const e = outputElement(100, OUTPUT_SHOW_VOLTAGE, { scale: 0 });
    const { ctx, paths, strokes, texts } = mkCtx();
    OUTPUT_DEF.draw({ ...context(ctx, 0), voltages: [5] }, e);
    const text = outputText(5, 0, false, 1);
    // The width the draw itself measured, so the assertion survives a
    // valueFontSize change.
    const w = ctx.measureText(text).width;
    const lead1 = interp({ x: 0, y: 0 }, { x: 100, y: 0 }, 1 - (w / 2 + 8) / elementLength(e));
    expect(paths[0]).toEqual([
      { x: 0, y: 0 },
      { x: lead1.x, y: 0 },
    ]);
    // The stem reads as a conductor, so it strokes round-capped at the lead
    // weight like every terminal lead (draw.ts:784).
    expect(strokes[0]).toMatchObject({ width: 3, cap: 'round' });
    expect(texts[0]).toMatchObject({ text, x: 100, y: 0, align: 'center', baseline: 'middle' });
  });

  it('draws the literal out when the show-voltage flag is clear', () => {
    const { ctx, texts } = mkCtx();
    OUTPUT_DEF.draw({ ...context(ctx, 0), voltages: [5] }, outputElement(100, 0, { scale: 0 }));
    expect(texts.map((t) => t.text)).toEqual(['out']);
  });

  it('a collapsed element draws without dividing by zero', () => {
    // p2 === p1: the stem has no direction to stop along, so the draw must
    // not divide by the zero length and no NaN may land in the stroke path.
    const e = outputElement(0, OUTPUT_SHOW_VOLTAGE, { scale: 0 });
    const { ctx, paths } = mkCtx();
    expect(() => OUTPUT_DEF.draw({ ...context(ctx, 0), voltages: [5] }, e)).not.toThrow();
    for (const seg of paths) {
      for (const pt of seg) {
        expect(Number.isFinite(pt.x)).toBe(true);
        expect(Number.isFinite(pt.y)).toBe(true);
      }
    }
  });
});

describe('output readout text', () => {
  it('uses the engineering-prefix short form at auto scale', () => {
    expect(outputText(0.0555, 0, false, 1)).toBe('55.5mV');
    expect(outputText(5, 0, false, 1)).toBe('5V');
  });

  it('renders the fixed scales at the selected unit', () => {
    expect(outputText(2.5, 1, false, 3)).toBe('2.5V');
    expect(outputText(2.5, 2, false, 3)).toBe('2500mV');
    expect(outputText(0.5, 3, false, 3)).toBe('500000µV');
  });

  it('keeps trailing zeros under fixed precision', () => {
    expect(outputText(2.5, 1, true, 3)).toBe('2.500V');
    expect(outputText(2.5, 2, true, 3)).toBe('2500.000mV');
  });

  it('handles zero and negative values', () => {
    expect(outputText(0, 1, false, 3)).toBe('0V');
    expect(outputText(0, 0, false, 3)).toBe('0V');
    expect(outputText(-2.5, 1, false, 3)).toBe('-2.5V');
    expect(outputText(-0.0555, 0, false, 1)).toBe('-55.5mV');
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

  it('gradientPolyline passes a bevel join through to its single gradient stroke', () => {
    const { ctx, strokes } = mkCtx();
    gradientPolyline(
      drawCtx(ctx, [10, 0]),
      [
        { x: 0, y: 0 },
        { x: 32, y: 0 },
      ],
      {
        cap: 'round',
        join: 'bevel',
      },
    );
    expect(strokes).toHaveLength(1);
    expect(strokes[0].join).toBe('bevel');
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

  it('strokes the inductor coil as three separate round-round arcs', () => {
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
    // Two lead lines first, then one stroke per loop: each arc is its own
    // path primitive, round-capped like upstream's single coil polyline.
    const coil = strokes.slice(2);
    expect(coil).toHaveLength(COIL_LOOPS);
    expect(coil.every((s) => s.cap === 'round')).toBe(true);
    expect(coil.every((s) => s.join === 'bevel')).toBe(true);
    expect(coil.every((s) => s.width === 3)).toBe(true);
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
    expect(bevels.every((s) => s.width === 3)).toBe(true); // the coil's body weight
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
    expect(bevels.every((s) => s.width === 3)).toBe(true); // the winding's body weight
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
    polyline(
      context(ctx, 0),
      [
        { x: 0, y: 0 },
        { x: 16, y: 8 },
        { x: 32, y: 0 },
      ],
      '#ffffff',
    );
    expect(ctx.lineWidth).toBe(3);
    closedPolyline(
      context(ctx, 0),
      [
        { x: 0, y: 0 },
        { x: 16, y: 8 },
        { x: 32, y: 0 },
        { x: 0, y: 0 },
      ],
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
    // CircuitElm.java:460-467: both leads are drawThickLine at width 3. The
    // round cap is the wire cap, so a lead end reads as a continuous
    // conductor rather than a flush symbol end.
    const { ctx } = mkCtx();
    drawLeads(
      context(ctx, 0),
      { id: 1, kind: 'resistor', x1: 0, y1: 0, x2: 64, y2: 0, flags: 0, params: {} },
      { x: 8, y: 0 },
      { x: 56, y: 0 },
    );
    expect(ctx.lineWidth).toBe(3);
    expect(ctx.lineCap).toBe('round');
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
      [
        { x: 0, y: 0 },
        { x: 32, y: 0 },
        { x: 32, y: 16 },
        { x: 0, y: 16 },
        { x: 0, y: 0 },
      ],
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
      [
        { x: 0, y: -6 },
        { x: 32, y: -6 },
        { x: 32, y: 6 },
        { x: 0, y: 6 },
        { x: 0, y: -6 },
      ],
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
    polyline(
      context(ctx, 0),
      [
        { x: 0, y: 0 },
        { x: 16, y: 8 },
        { x: 0, y: 0 },
      ],
      '#ffffff',
    );
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

describe('incandescent temperature colour', () => {
  it('is black below the 800 K lower bound of the first band', () => {
    // LampElm.getTempColor's first band clamps its (temp-800)/400 ramp at 0,
    // so room temperature and anything below 800 K read black (LampElm.java:
    // 102-107). 801 K is 1 K into the ramp, which still truncates to 0.
    expect(tempColor(300)).toBe('rgb(0,0,0)');
    expect(tempColor(799)).toBe('rgb(0,0,0)');
    expect(tempColor(801)).toBe('rgb(0,0,0)');
  });

  it('ramps pure red through the 800..1200 K band', () => {
    expect(tempColor(800)).toBe('rgb(0,0,0)');
    expect(tempColor(1000)).toBe('rgb(127,0,0)');
    expect(tempColor(1199)).toBe('rgb(254,0,0)');
  });

  it('ramps red toward yellow through the 1200..1700 K band', () => {
    expect(tempColor(1200)).toBe('rgb(255,0,0)');
    expect(tempColor(1500)).toBe('rgb(255,153,0)');
    expect(tempColor(1699)).toBe('rgb(255,254,0)');
  });

  it('ramps yellow toward white through the 1700..2400 K band', () => {
    expect(tempColor(1700)).toBe('rgb(255,255,0)');
    expect(tempColor(2000)).toBe('rgb(255,255,109)');
    expect(tempColor(2399)).toBe('rgb(255,255,254)');
  });

  it('is white at and above the 2400 K breakpoint', () => {
    expect(tempColor(2400)).toBe('rgb(255,255,255)');
    expect(tempColor(3000)).toBe('rgb(255,255,255)');
  });
});

describe('lamp symbol colours', () => {
  // The lamp bulb is a filled disc: the fill is the filament temperature via
  // `tempColor(g.state)` (upstream getTempColor), the outline is the white
  // constant (upstream whiteColor), and under Show Power the fill takes the
  // power colour like any other dissipating body. The recorded draw calls pin
  // all three against the helpers the symbol actually calls.

  const lamp = (overrides: Partial<CircuitElement> = {}): CircuitElement => ({
    id: 1,
    kind: 'lamp',
    x1: 0,
    y1: 0,
    x2: 64,
    y2: 0,
    flags: 0,
    params: { temp: 300, nomPower: 100, nomVoltage: 120, warmTime: 0.4, coolTime: 0.4 },
    ...overrides,
  });

  /** Fills the stub's `fill` record with the fillStyle at each fill() call, so
   *  the bulb colour is assertable against the recorded calls. */
  const captureFills = (ctx: CtxStub): string[] => {
    const fills: string[] = [];
    const realFill = ctx.fill;
    ctx.fill = vi.fn(() => {
      fills.push(ctx.fillStyle);
      realFill();
    });
    return fills;
  };

  const draw = (state: number, overrides: Partial<DrawContext> = {}) => {
    const { ctx, stub, strokes } = mkCtx();
    const fills = captureFills(stub);
    // The colour assertions read only the bulb fill, so the current-dot fills
    // (which would otherwise trail it) are switched off.
    LAMP_DEF.draw({ ...context(ctx, 0), showCurrent: false, state, ...overrides }, lamp());
    return { ctx, stub, fills, strokes };
  };

  it('fills the bulb in the temperature colour and outlines it in the white constant', () => {
    // state 2000 K maps to the third band: rgb(255, 255, 109), the yellow
    // toward white (LampElm.java:114-118).
    const { fills, strokes } = draw(2000);
    // The bulb is the only filled shape in the lamp symbol.
    expect(fills).toEqual(['rgb(255,255,109)']);
    // The outline is the white constant of the dark theme, upstream's
    // whiteColor, not the wire grey. The filled circle helper strokes in its
    // own colour too, so what singles the outline out is the white stroke.
    const outline = strokes.find((s) => s.style === makeTheme().whiteColor);
    expect(outline).toBeDefined();
    expect(outline!.width).toBe(3);
    expect(makeTheme().whiteColor).toBe('#ffffff');
    expect(makeTheme().wire).toBe('#c9d1d9');
  });

  it('inverts the bulb outline with the printable theme', () => {
    // Upstream flips whiteColor to black when printing (UIManager.java:578),
    // and the port's light theme carries the same black whiteColor.
    const { ctx, stub, strokes } = mkCtx();
    const fills = captureFills(stub);
    LAMP_DEF.draw(
      { ...context(ctx, 0), showCurrent: false, theme: makeTheme(false), state: 2000 },
      lamp(),
    );
    expect(fills).toEqual(['rgb(255,255,109)']);
    const outline = strokes.find((s) => s.style === makeTheme(false).whiteColor);
    expect(outline).toBeDefined();
    expect(outline!.style).toBe('#000000');
  });

  it('takes the power colour for the bulb fill when Show Power is on', () => {
    // A lamp dissipating a lot reads the saturated negative end of the power
    // ramp, like a resistor body under Show Power (setPowerColor(g, true)
    // before the fill, LampElm.java:131).
    const { fills } = draw(2000, { showPowerColor: true, power: 1e6 });
    expect(fills).toEqual(['rgb(255,0,0)']);
  });

  it('keeps the temperature fill when Show Power is off', () => {
    // The power colour is only applied in power mode; the same hot filament
    // stays the temperature yellow otherwise.
    const { fills } = draw(2000, { showPowerColor: false, power: 1e6 });
    expect(fills).toEqual(['rgb(255,255,109)']);
  });

  it('a cold lamp and a hot lamp draw visibly different fills', () => {
    // Room temperature is black, 2500 K is white: the owner-visible promise
    // of the plan.
    const cold = draw(300);
    const hot = draw(2500);
    expect(cold.fills).toEqual(['rgb(0,0,0)']);
    expect(hot.fills).toEqual(['rgb(255,255,255)']);
    expect(cold.fills[0]).not.toBe(hot.fills[0]);
  });
});

describe('switch lever and relay blade colours', () => {
  // The lever is the one mechanical part that does not carry a terminal
  // voltage. Upstream strokes the switch levers with whiteColor (SwitchElm
  // .java:127-132, Switch2Elm.java:101-104, CrossSwitchElm.java:131-134) and
  // the relay and analog switch blades with Color.lightGray (RelayElm.java:
  // 261-264, RelayContactElm.java:106-109, AnalogSwitchElm.java:120-123,
  // AnalogSwitch2Elm.java:63-65). The port's line() applies the
  // selection/hover swap on top of either role, so a highlighted lever reads
  // as selected without losing its mechanical colour at rest.

  const elm = (kind: string, params: Record<string, number> = {}, flags = 0): CircuitElement => ({
    id: 1,
    kind,
    x1: 0,
    y1: 0,
    x2: 64,
    y2: 0,
    flags,
    params,
  });

  const draw = (def: ElementDef, element: CircuitElement, overrides: Partial<DrawContext> = {}) => {
    const { ctx, strokes } = mkCtx();
    def.draw({ ...context(ctx, 0), voltages: [], ...overrides }, element);
    return strokes;
  };

  const stroked = (
    strokes: { style: string | CanvasGradient; width: number }[],
    color: string,
    width: number,
  ): boolean => strokes.some((s) => s.style === color && s.width === width);

  it('pins the lightGray constant in both themes', () => {
    expect(makeTheme().lightGray).toBe('#c0c0c0'); // Color.lightGray
    expect(makeTheme(false).lightGray).toBe('#c0c0c0');
  });

  it('strokes the SPST lever in whiteColor, at the thicker contact weight', () => {
    const strokes = draw(SWITCH_DEF, elm('switch'));
    expect(stroked(strokes, makeTheme().whiteColor, CONTACT_STROKE_WIDTH)).toBe(true);
    expect(stroked(strokes, makeTheme().wire, 3)).toBe(true);  // the leads stay at body weight
  });

  it('strokes the SPDT lever in whiteColor, at the thicker contact weight', () => {
    const strokes = draw(SWITCH2_DEF, elm('switch2', { position: 0, throwCount: 2 }));
    expect(stroked(strokes, makeTheme().whiteColor, CONTACT_STROKE_WIDTH)).toBe(true);
    expect(stroked(strokes, makeTheme().wire, 3)).toBe(true);  // the throw leads stay at body weight
  });

  it('strokes both cross switch levers in whiteColor', () => {
    const strokes = draw(CROSS_SWITCH_DEF, elm('crossSwitch'));
    expect(strokes.filter((s) => s.style === makeTheme().whiteColor && s.width === 3)).toHaveLength(2);
  });

  it('draws the IEC armature in the lever white, at fine width', () => {
    // Upstream's IEC lines draw in the lever's whiteColor (SwitchElm.java:
    // 147-159); here they follow the lever to fine width 1.
    const strokes = draw(SWITCH_DEF, elm('switch', { position: 0 }, SWITCH_IEC));
    expect(strokes.some((s) => s.style === makeTheme().whiteColor && s.width === 1)).toBe(true);
  });

  it('strokes the relay blade in lightGray, at the thicker contact weight', () => {
    const strokes = draw(RELAY_DEF, elm('relay', { poleCount: 1 }), { voltages: [0, 0, 0, 0, 0] });
    expect(stroked(strokes, makeTheme().lightGray, CONTACT_STROKE_WIDTH)).toBe(true);
    expect(stroked(strokes, makeTheme().wire, 3)).toBe(true);  // the pole leads stay at body weight
  });

  it('strokes the relay contact blade in lightGray', () => {
    const strokes = draw(RELAY_CONTACT_DEF, elm('relayContact', { i_position: 0 }));
    expect(stroked(strokes, makeTheme().lightGray, 3)).toBe(true);
  });

  it('strokes the analog switch bar in lightGray', () => {
    const strokes = draw(ANALOG_SWITCH_DEF, elm('analogSwitch', { threshold: 2.5 }));
    expect(stroked(strokes, makeTheme().lightGray, 3)).toBe(true);
  });

  it('strokes the analog SPDT lever in lightGray', () => {
    const strokes = draw(ANALOG_SWITCH2_DEF, elm('analogSwitch2', { threshold: 2.5 }));
    expect(stroked(strokes, makeTheme().lightGray, 3)).toBe(true);
  });

  it('still swaps the lever colour to selection and hover', () => {
    const selected = draw(SWITCH_DEF, elm('switch'), { selected: true });
    expect(selected.some((s) => s.style === makeTheme().selection)).toBe(true);
    expect(selected.some((s) => s.style === makeTheme().whiteColor)).toBe(false);
    const hovered = draw(SWITCH_DEF, elm('switch'), { hovered: true });
    expect(hovered.some((s) => s.style === makeTheme().highlight)).toBe(true);
  });
});

describe('lamp current-dot carry', () => {
  // Upstream chains the dot phase through the leads and filament, then
  // restarts the last run (lead2 -> point2) at the base curcount rather than
  // continuing the chain (LampElm.java:143-152). A single continuous chain
  // across all six points would drift the last run by the accumulated phase,
  // which on a lamp whose length is a multiple of 32 puts its first dot half a
  // spacing off the pattern on the first run.

  const lamp = (): CircuitElement => ({
    id: 1,
    kind: 'lamp',
    x1: 0,
    y1: 0,
    x2: 64,
    y2: 0,
    flags: 0,
    params: {},
  });

  interface Rect {
    x: number;
    y: number;
    w: number;
    h: number;
  }

  const dotCtx = (): { ctx: CanvasRenderingContext2D; rects: Rect[] } => {
    const rects: Rect[] = [];
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
      createLinearGradient: vi.fn(() => ({ stops: [], addColorStop: vi.fn() })),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      closePath: vi.fn(),
      stroke: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      fillRect: vi.fn((x: number, y: number, w: number, h: number) => {
        rects.push({ x, y, w, h });
      }),
      save: vi.fn(),
      restore: vi.fn(),
      setLineDash: vi.fn(),
      fillText: vi.fn(),
      measureText: (text: string) => ({ width: text.length * 6 }),
    };
    return { ctx: stub as unknown as CanvasRenderingContext2D, rects };
  };

  const dots = (rects: Rect[]): Point[] =>
    rects.filter((r) => r.w === 4 && r.h === 4).map((r) => ({ x: r.x + 2, y: r.y + 2 }));

  const hasDot = (pts: Point[], p: Point): boolean =>
    pts.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < 0.01);

  it('starts the last run at the base curcount, not the carried phase', () => {
    // A 64-unit lamp: lead1 (24,0), lead2 (40,0), filament ends at (24,-24)
    // and (40,-24). At phase 0 the last run (lead2 -> point2, 24 long) puts
    // its first dot exactly on lead2; a continuous chain would have carried
    // the phase 8 into it and started the first dot at (48,0) instead.
    const { ctx, rects } = dotCtx();
    LAMP_DEF.draw({ ...context(ctx, 0), current: 0.01, state: 1000 }, lamp());
    const pts = dots(rects);
    expect(hasDot(pts, { x: 40, y: 0 })).toBe(true);
    expect(hasDot(pts, { x: 48, y: 0 })).toBe(false);
  });
});

describe('fuse melt colour', () => {
  it('blends the voltage colour toward red below a third of the rating', () => {
    // FuseElm.getTempColor's first band fades the post-0 voltage colour out as
    // the heat fraction rises; at zero heat it is the plain voltage colour. A
    // green filament reads olive at half way to the red end.
    const green = 'rgb(0,255,0)';
    expect(fuseColor(green, 0)).toBe('rgb(0,255,0)');
    expect(fuseColor(green, 0.1666)).toBe('rgb(127,128,0)');
    expect(fuseColor(green, 0.3333)).toBe('rgb(255,0,0)');
  });

  it('runs red, yellow, then white as the fraction nears the pop', () => {
    expect(fuseColor('rgb(0,0,0)', 0.5)).toBe('rgb(255,127,0)');
    expect(fuseColor('rgb(0,0,0)', 0.75)).toBe('rgb(255,255,63)');
    expect(fuseColor('rgb(0,0,0)', 1)).toBe('rgb(255,255,255)');
  });
});

describe('zigzag resistor body', () => {
  /** Signed perpendicular distance of `p` from the `a`-`b` axis. */
  const signedDistance = (
    a: { x: number; y: number },
    b: { x: number; y: number },
    p: { x: number; y: number },
  ): number =>
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
      -ZIGZAG_HS,
      ZIGZAG_HS,
      -ZIGZAG_HS,
      ZIGZAG_HS,
      -ZIGZAG_HS,
      ZIGZAG_HS,
      -ZIGZAG_HS,
      ZIGZAG_HS,
    ]);
    // The peaks land on the odd 1/16 fractions upstream strokes (ResistorElm.
    // java:85-91): 2, 6, 10, ..., 30 for a 32-unit body.
    expect(pts.slice(1, -1).map((p) => p.x)).toEqual([2, 6, 10, 14, 18, 22, 26, 30]);
  });

  it('keeps the peaks perpendicular to a diagonal axis', () => {
    const pts = zigzagPoints({ x: 0, y: 0 }, { x: 16, y: 16 }, ZIGZAG_HS);
    const dists = pts.slice(1, -1).map((p) => signedDistance({ x: 0, y: 0 }, { x: 16, y: 16 }, p));
    // Exact float math: each excursion sits 8 off the axis, alternating sides.
    expect(dists.map((d) => Math.round(d))).toEqual([8, -8, 8, -8, 8, -8, 8, -8]);
  });

  it('degenerates to the endpoints when the leads coincide', () => {
    const a = { x: 10, y: 10 };
    expect(zigzagPoints(a, { x: 10, y: 10 }, ZIGZAG_HS)).toEqual([a, { x: 10, y: 10 }]);
  });

  it('scales the peaks with the caller-supplied half-height', () => {
    // The thermistor and LDR reuse their 6-unit box height for the zigzag,
    // while the resistor and pot pass ZIGZAG_HS (8): the half-height is the
    // caller's choice, so the helper must honour it exactly.
    expect(
      zigzagPoints({ x: 0, y: 0 }, { x: 32, y: 0 }, 6)
        .slice(1, -1)
        .map((p) => p.y),
    ).toEqual([-6, 6, -6, 6, -6, 6, -6, 6]);
    expect(
      zigzagPoints({ x: 0, y: 0 }, { x: 32, y: 0 }, 6)
        .slice(1, -1)
        .map((p) => p.y),
    ).not.toContain(8);
  });
});

describe('memristor zigzag body', () => {
  const memristor = (): CircuitElement => ({
    id: 1,
    kind: 'memristor',
    x1: 0,
    y1: 0,
    x2: 64,
    y2: 0,
    flags: 0,
    params: {},
  });

  it('joins each zigzag run peak to the next peak, a square wave of flat tops', () => {
    // A horizontal undoped memristor: leads at (16,0) and (48,0), peak
    // half-height hs = 10 (the default dopeWidth 0 collapses nothing). Every
    // body segment must be axis-aligned: the verticals climb from the axis or
    // a flat top to the next flat top, and each connecting segment spans two
    // consecutive peaks at the SAME offset, a horizontal line. Before the fix
    // the connecting segment started at the low vertex `hs*ox` instead of the
    // peak `hs*nx`, so it read as a diagonal jumping from the axis back into
    // the next peak (MemristorElm.java:98-104 strokes ps1-ps2, both at
    // `hs*nx`).
    const { ctx, paths } = mkCtx();
    MEMRISTOR_DEF.draw(
      { ...context(ctx, 0), voltages: [0, 0], showCurrent: false },
      memristor(),
    );
    const body = paths.slice(2); // the two lead lines come first
    expect(body.length).toBe(13); // 7 verticals plus 6 flat tops
    const tops: number[] = [];
    body.forEach(([a, b], i) => {
      if (i % 2 === 0) {
        expect(a.x).toBe(b.x); // the climb is straight up
      } else {
        expect(a.y).toBe(b.y); // the join runs level between two peaks
        tops.push(a.y);
      }
    });
    // The six flat tops alternate between the two hs rows.
    expect(tops).toEqual([-10, 10, -10, 10, -10, 10]);
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
    expect(axisVoltage(gg, 1.5, 6, 4)).toBe(4); // still clamped to the pair
  });

  it('axisColor falls back to the flat power colour under Show Power', () => {
    // Upstream's `else` branch: with the voltage toggle off, the body takes
    // the power colour and the ramp disappears entirely (ResistorElm.java:80).
    const gg = g(mkCtx().ctx, { showPowerColor: true, showVoltageColor: false, power: 1e6 });
    const colour = axisColor(gg, 0);
    expect(colour).toBe('rgb(255,0,0)'); // dissipated power saturates the negative end
    expect(axisColor(gg, 1)).toBe(colour);
  });

  it('axisColor is the voltage colour at the interpolated voltage', () => {
    const gg = g(mkCtx().ctx, { showVoltageColor: true });
    expect(axisColor(gg, 0.5)).toBe(voltageColor(gg, 5));
  });

  it('a v0=10, v1=0 body ramps its gradient from positive to neutral', () => {
    const { ctx, strokes, grads } = mkCtx();
    const gg = g(ctx, { showVoltageColor: true });
    gradientPolyline(gg, [
      { x: 16, y: 0 },
      { x: 48, y: 0 },
    ]);
    // One 32-unit edge, stroked once with a real gradient: stops at the exact
    // breakpoints of the ramp, 0 and 0.5 at the clamped positive colour (the
    // 10 V end and the v=5 kink both saturate) and 1 at the neutral 0 V end.
    expect(strokes).toHaveLength(1);
    expect(grads[0].stops.map((s) => s.offset)).toEqual([0, 0.5, 1]);
    expect(grads[0].stops[0].color).toBe('rgb(0,255,0)');
    expect(grads[0].stops[1].color).toBe('rgb(0,255,0)');
    expect(grads[0].stops[2].color).toBe(voltageColor(gg, 0));
  });

  it('the ramp is monotonic across the body', () => {
    // A small drop inside the colour scale, so every stop is a distinct
    // blend: the red channel must climb strictly from the positive end (low
    // red) to the negative end (high red) with no doubling back.
    const { ctx, grads } = mkCtx();
    const gg = g(ctx, { showVoltageColor: true, voltages: [2, -2] });
    gradientPolyline(gg, [
      { x: 16, y: 0 },
      { x: 48, y: 0 },
    ]);
    const red = (c: string) => Number(/rgb\((\d+),/.exec(c)?.[1]);
    const colors = grads[0].stops.map((s) => s.color);
    expect(red(colors[0])).toBeLessThan(red(colors[colors.length - 1]));
    for (let i = 1; i < colors.length; i++) {
      expect(red(colors[i])).toBeGreaterThan(red(colors[i - 1]));
    }
  });

  it('a no-drop body is one uniform colour, no banding', () => {
    const { ctx, strokes, grads } = mkCtx();
    const gg = g(ctx, { showVoltageColor: true, voltages: [5, 5] });
    gradientPolyline(gg, [
      { x: 16, y: 0 },
      { x: 48, y: 0 },
    ]);
    // A zero drop has no kinks to stop at, so the two end stops share the one
    // colour and the whole body reads uniform at any zoom.
    expect(strokes).toHaveLength(1);
    expect(new Set(grads[0].stops.map((s) => s.color)).size).toBe(1);
    expect(grads[0].stops[0].color).toBe('rgb(0,255,0)');
  });

  it('swapping the posts reverses the colour order exactly', () => {
    // The geometry is unchanged and mirrors about the body centre, so the stop
    // at fraction f under [0,10] meets the same voltage as the one at 1-f under
    // [10,0]: an exact reversal, not an approximation.
    const draw = (voltages: number[]): string[] => {
      const { ctx, grads } = mkCtx();
      const gg = g(ctx, { showVoltageColor: true, voltages, euroResistors: false });
      RESISTOR_DEF.draw(gg, element());
      return grads[0].stops.map((s) => s.color);
    };
    const forward = draw([10, 0]);
    const backward = draw([0, 10]);
    expect(backward).toEqual([...forward].reverse());
  });

  it('a resistor with a drop ramps its body from positive to neutral', () => {
    const { ctx, strokes, grads } = mkCtx();
    const gg = g(ctx, { showVoltageColor: true, euroResistors: false });
    RESISTOR_DEF.draw(gg, element());
    // Two leads first, then the zigzag body stroked once with a gradient: the
    // ramp runs from the lead1 end (10 V, clamped positive) to the lead2 end
    // (0 V, neutral).
    expect(strokes).toHaveLength(3);
    expect(grads[0].stops[0].color).toBe('rgb(0,255,0)');
    expect(grads[0].stops[grads[0].stops.length - 1].color).toBe('rgb(128,128,128)');
  });

  it('a no-drop resistor body is one uniform colour', () => {
    const { ctx, grads } = mkCtx();
    const gg = g(ctx, { showVoltageColor: true, voltages: [5, 5], euroResistors: false });
    RESISTOR_DEF.draw(gg, element());
    expect(new Set(grads[0].stops.map((s) => s.color)).size).toBe(1);
  });

  it('Show Power flattens the resistor body to the power colour', () => {
    // Upstream's `else` branch: the body takes the flat power colour, no
    // ramp, while the leads keep their plain node colours (drawLeads), so the
    // two lead strokes are wire and only the body gradient is uniform.
    const { ctx, strokes, grads } = mkCtx();
    const gg = g(ctx, {
      showPowerColor: true,
      showVoltageColor: false,
      power: 1e6,
      euroResistors: false,
    });
    RESISTOR_DEF.draw(gg, element());
    expect(strokes).toHaveLength(3); // two leads plus the one body gradient stroke
    expect(new Set(grads[0].stops.map((s) => s.color)).size).toBe(1);
    expect(grads[0].stops[0].color).toBe('rgb(255,0,0)');
  });

  it('gradientPolyline passes a round cap through to its stroke', () => {
    // The cap option is generic passthrough, not just for coils: whatever the
    // caller asks for reaches the single gradient stroke.
    const { ctx, strokes } = mkCtx();
    gradientPolyline(
      g(ctx, { showVoltageColor: true }),
      [
        { x: 0, y: 0 },
        { x: 32, y: 0 },
      ],
      {
        cap: 'round',
      },
    );
    expect(strokes).toHaveLength(1);
    expect(strokes[0].width).toBe(3); // the body stroke weight
    expect(ctx.lineCap).toBe('round');
  });

  it('a transformer winding shades across its own two posts', () => {
    // Each winding spans its own post pair, not the element's posts 0/1, and
    // the csign flip that reverses the coil direction swaps v0/v1 to match:
    // both coils run from their 10 V end (green) to their 0 V end (neutral).
    // Four leads come first, then the primary coil gradient, then the
    // secondary, then the text-coloured core bars.
    const { ctx, strokes, grads } = mkCtx();
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
    expect(grads).toHaveLength(2);
    for (const stops of grads.map((grad) => grad.stops)) {
      expect(stops[0].color).toBe('rgb(0,255,0)'); // each winding starts at its 10 V end
      expect(stops[stops.length - 1].color).toBe('rgb(128,128,128)'); // and ends at 0 V
    }
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
      if (f.endsWith('.ts'))
        files[`registry/${f}`] = new URL(`../model/registry/${f}`, import.meta.url).pathname;
    }
    for (const f of await readdir(new URL('../model/registry/elements', import.meta.url))) {
      if (f.endsWith('.ts'))
        files[`registry/elements/${f}`] = new URL(
          `../model/registry/elements/${f}`,
          import.meta.url,
        ).pathname;
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
  const housingRect = (
    paths: { x: number; y: number }[][],
  ): { minX: number; maxX: number; minY: number; maxY: number } => {
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
    expect(w.x).toBe(21); // textloc.x (32) - (cspc - 5)
    expect(e.align).toBe('right');
    expect(e.x).toBe(75); // textloc.x (64) + (cspc - 5)
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
    expect(w.x).toBe(13); // textloc.x (16) - (cspc - 5)
    expect(e.x).toBe(35); // textloc.x (32) + (cspc - 5)
  });

  it('shrinks a long label until it fits the space available', () => {
    const { texts } = draw(0, 2, 3, [{ side: 'W', pos: 0, text: 'ABCDEFG' }]);
    const [t] = texts;
    const box = labelBox(t);
    expect(box.max - box.min).toBeLessThanOrEqual(24); // cspc*2 - 8
    expect(box.max - box.min).toBeLessThan(84); // the unsqueezed width at font 20
  });

  it('grants a wider budget on a wide chip with no vertical pins', () => {
    const narrow = draw(0, 2, 3, [{ side: 'W', pos: 0, text: 'ABCDEFG' }]).texts[0];
    const wide = draw(0, 3, 3, [{ side: 'W', pos: 0, text: 'ABCDEFG' }]).texts[0];
    const fontPx = (font: string) => Number(/^(\d+)px/.exec(font)?.[1]);
    expect(fontPx(wide.font)).toBeGreaterThan(fontPx(narrow.font));
    expect(labelBox(wide).max - labelBox(wide).min).toBeLessThanOrEqual(40); // cspc*2.5 + cspc*(sizeX-3)
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
          Math.abs(p[0].y - (t.y - asc)) < 1e-9 && Math.abs(Math.abs(p[1].x - p[0].x) - sw) < 1e-9
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

describe('transmission line body wave', () => {
  const tl = (): CircuitElement => ({
    id: 1,
    kind: 'transmissionLine',
    x1: 0,
    y1: 0,
    x2: 400,
    y2: 0,
    flags: 0,
    params: { width: 32 },
  });

  it('draws one strip per sample, spanning the inner edges end to end', () => {
    const { ctx, paths, strokes } = mkCtx();
    // Four samples at quarter fractions: `segf = 1/4` is exact in binary, so
    // the first boundary lands exactly on inner[0]/inner[2] and the last band
    // exactly on inner[3]. Geometry: posts are (0,32),(400,32),(0,0),(400,0),
    // inner (0,24),(400,24),(0,8),(400,8), the body between y=8 and y=24.
    TRANSMISSION_LINE_DEF.draw(
      { ...context(ctx, 0), voltages: [0, 0, 0, 0], showVoltageColor: true, wave: [5, 0, -5, 0] },
      tl(),
    );
    // The four lead strokes come first, then the strips: each draws a thin
    // boundary line (width 1) and a thick band (the default 3) in the strip's
    // own voltage colour, then the far edge. The first boundary spans
    // inner[0] -> inner[2], the last band ends on inner[3].
    expect(paths[4][0]).toEqual({ x: 0, y: 24 });
    expect(paths[4][1]).toEqual({ x: 0, y: 8 });
    expect(paths[11][0]).toEqual({ x: 400, y: 8 });
    // Colours come straight from voltageColor: +5 V green, 0 V neutral,
    // -5 V red, with the two weights per strip.
    expect(strokes[4].style).toBe('rgb(0,255,0)');
    expect(strokes[4].width).toBe(1);
    expect(strokes[5].style).toBe('rgb(0,255,0)');
    expect(strokes[5].width).toBe(3);
    expect(strokes[6].style).toBe('rgb(128,128,128)');
    expect(strokes[7].style).toBe('rgb(128,128,128)');
    expect(strokes[8].style).toBe('rgb(255,0,0)');
    expect(strokes[9].style).toBe('rgb(255,0,0)');
  });

  it('falls back to the flat body when the wave array is empty', () => {
    const { ctx, calls, strokes } = mkCtx();
    TRANSMISSION_LINE_DEF.draw({ ...context(ctx, 0), voltages: [0, 0, 0, 0], wave: [] }, tl());
    // The four leads and the far edge only: no per-strip strokes appear.
    expect(calls.filter((c) => c === 'stroke').length).toBe(5);
    expect(strokes.length).toBe(5);
  });
});

describe('sweep symbol', () => {
  // Upstream SweepElm.draw strokes only the stem, the circle and the sine
  // glyph (SweepElm.java:79-112); the glyph alone tells the sweep apart from
  // the plain AC source. A direction arrowhead on the glyph's side would be
  // the only filled shape in the draw, a `fill` with no stroke.

  const sweep = (): CircuitElement => ({
    id: 1,
    kind: 'sweep',
    x1: 0,
    y1: 0,
    x2: 64,
    y2: 0,
    flags: 2, // FLAG_BIDIR (SweepElm.java:35)
    params: { minF: 20, maxF: 4000, maxV: 5, sweepTime: 0.1 },
  });

  it('strokes the sine glyph but no direction arrowhead', () => {
    const { ctx, calls, paths } = mkCtx();
    SWEEP_DEF.draw({ ...context(ctx, 0), voltages: [0], showCurrent: false }, sweep());
    // The waveform glyph is a 25-point sine polyline inside the circle
    // (shared.ts:181-224): one moveTo then 24 lineTo.
    expect(paths.some((p) => p.length === 25)).toBe(true);
    // The arrowhead would fill a triangle, and nothing else in the draw fills.
    expect(calls).not.toContain('fill');
  });
});

describe('AM and FM source symbols', () => {
  // Both sources draw one stem to a circled caption at the free end
  // (AMElm.java:86-103, FMElm.java:96-113): the circle sits on x2,y2, the
  // label names the modulation, and nothing else fills.
  const source = (kind: 'am' | 'fm'): CircuitElement => ({
    id: 1,
    kind,
    x1: 0,
    y1: 0,
    x2: 32,
    y2: 32,
    flags: 0,
    params: {},
  });

  it('centres the circled AM caption on the free end', () => {
    const { ctx, texts, arcs, calls } = mkCtx();
    AM_DEF.draw({ ...context(ctx, 0), voltages: [0] }, source('am'));
    expect(texts).toContainEqual(expect.objectContaining({ text: 'AM', x: 32, y: 32 }));
    expect(arcs).toContainEqual({ x: 32, y: 32 });
    expect(calls).not.toContain('fill');
  });

  it('centres the circled FM caption on the free end', () => {
    const { ctx, texts, arcs } = mkCtx();
    FM_DEF.draw({ ...context(ctx, 0), voltages: [0] }, source('fm'));
    expect(texts).toContainEqual(expect.objectContaining({ text: 'FM', x: 32, y: 32 }));
    expect(arcs).toContainEqual({ x: 32, y: 32 });
  });
});

describe('delay buffer symbol', () => {
  const buffer = (): CircuitElement => ({
    id: 1,
    kind: 'delayBuffer',
    x1: 0,
    y1: 0,
    x2: 32,
    y2: 0,
    flags: 0,
    params: { delay: 0.01, threshold: 2.5, highVoltage: 5 },
  });

  it('draws the IEC rectangle with the "1" glyph inside', () => {
    // The euro body is a closed four-corner rectangle with the "1" text raised
    // one glyph height (DelayBufferElm.java:70-73, :85-91); the two leads make
    // the first two paths, so the third is the body.
    const { ctx, texts, paths } = mkCtx();
    DELAY_BUFFER_DEF.draw({ ...context(ctx, 0), euroGates: true }, buffer());
    expect(texts).toContainEqual(expect.objectContaining({ text: '1', y: -6 }));
    expect(paths[2]).toHaveLength(5);
  });

  it('draws the ANSI triangle without a glyph when euroGates is off', () => {
    const { ctx, texts, paths } = mkCtx();
    DELAY_BUFFER_DEF.draw(context(ctx, 0), buffer());
    expect(texts).not.toContainEqual(expect.objectContaining({ text: '1' }));
    expect(paths[2]).toHaveLength(4);
  });
});

describe('audio and data input rail labels', () => {
  const rail = (kind: 'audioInput' | 'dataInput', text?: string): CircuitElement => ({
    id: 1,
    kind,
    x1: 0,
    y1: 0,
    x2: 32,
    y2: 0,
    flags: 0,
    params: { maxVoltage: 5 },
    text,
  });

  it.each(['audioInput', 'dataInput'] as const)(
    '%s shows "No file" before any file is loaded',
    (kind) => {
      const { ctx, texts } = mkCtx();
      (kind === 'audioInput' ? AUDIO_INPUT_DEF : DATA_INPUT_DEF).draw(
        { ...context(ctx, 0), voltages: [0] },
        rail(kind),
      );
      expect(texts).toContainEqual(expect.objectContaining({ text: 'No file' }));
    },
  );

  it.each(['audioInput', 'dataInput'] as const)(
    '%s labels the stem with the loaded filename',
    (kind) => {
      const { ctx, texts } = mkCtx();
      (kind === 'audioInput' ? AUDIO_INPUT_DEF : DATA_INPUT_DEF).draw(
        { ...context(ctx, 0), voltages: [0] },
        rail(kind, 'mysong'),
      );
      expect(texts).toContainEqual(expect.objectContaining({ text: 'mysong' }));
    },
  );
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

  interface Rect {
    x: number;
    y: number;
    w: number;
    h: number;
  }

  /** A stub whose rects record their size, so the 4x4 current dots can be told
   *  apart from the symbol fills (which never go through fillRect). */
  const dotCtx = (): { ctx: CanvasRenderingContext2D; rects: Rect[] } => {
    const rects: Rect[] = [];
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
      createLinearGradient: vi.fn(() => ({ stops: [], addColorStop: vi.fn() })),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      closePath: vi.fn(),
      stroke: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      fillRect: vi.fn((x: number, y: number, w: number, h: number) => {
        rects.push({ x, y, w, h });
      }),
      save: vi.fn(),
      restore: vi.fn(),
      setLineDash: vi.fn(),
      fillText: vi.fn(),
      measureText: (text: string) => ({ width: text.length * 6 }),
    };
    return { ctx: stub as unknown as CanvasRenderingContext2D, rects };
  };

  /** The current-dot rects (4x4) a draw produced, as their centres. */
  const dots = (rects: Rect[]): Point[] =>
    rects.filter((r) => r.w === 4 && r.h === 4).map((r) => ({ x: r.x + 2, y: r.y + 2 }));

  /** Unit vector along `p`. */
  const unit = (p: Point): Point => {
    const len = Math.hypot(p.x, p.y);
    return len === 0 ? { x: 0, y: 0 } : { x: p.x / len, y: p.y / len };
  };

  /** Whether any dot sits within epsilon of `p`. */
  const hasDot = (pts: Point[], p: Point): boolean =>
    pts.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < 0.01);

  /** Draw `def` at `phase`, returning the dot rects. */
  const drawAt = (
    def: { draw(g: DrawContext, e: CircuitElement): void },
    e: CircuitElement,
    phase: number,
    conventional = true,
  ): Point[] => {
    const { ctx, rects } = dotCtx();
    def.draw({ ...context(ctx, phase), current: 0.01, voltages: [5, 0, 0], conventional }, e);
    return dots(rects);
  };

  /** Asserts the dots advance along `path`: a dot sits exactly at the path
   *  head at phase 0, and at phase 2 that same dot is 2 units further along
   *  the first segment. A run drawn the other way starts at the path tail (or
   *  mid-path), so no dot sits at the head and the first check fails; a run
   *  that starts at the head but points away fails the second. Both checks
   *  therefore fail on the mirrored draw. */
  const expectAdvances = (
    def: { draw(g: DrawContext, e: CircuitElement): void },
    e: CircuitElement,
    path: Point[],
  ): void => {
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
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
      ],
    );
  });

  it('a DC source draws dots from the negative post toward the positive post', () => {
    // Delivering 10 mA, the dots enter the symbol on the negative side and
    // leave the symbol toward the positive post: the whole path advances from
    // post 0 (negative, (0,100)) to post 1 (positive, (0,0)). A plain DC
    // battery draws a single run across the whole span, through the plate
    // gap (`drawDots(point1, point2, curcount)`, VoltageElm.java:325-326);
    // only the circled variant splits into two per-lead runs (:328-330).
    expectAdvances(
      VOLTAGE_DEF,
      { id: 1, kind: 'voltage', x1: 0, y1: 100, x2: 0, y2: 0, flags: 0, params: { waveform: 0 } },
      [
        { x: 0, y: 100 },
        { x: 0, y: 0 },
      ],
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
      {
        id: 1,
        kind: 'rail',
        x1: 0,
        y1: 0,
        x2: 100,
        y2: 0,
        flags: 0,
        params: { waveform: 0, maxVoltage: 5 },
      },
      [
        { x: 83, y: 0 },
        { x: 0, y: 0 },
      ],
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

  it('the transmission line draws four runs, each port flowing the upstream way', () => {
    // The four runs mirror TransLineElm.java:154-160: both of a port's runs
    // carry that port's own source current, with the inner-post run reversed
    // by swapping its endpoints. Geometry: posts (0,32),(400,32),(0,0),(400,0),
    // inner (0,24),(400,24),(0,8),(400,8). With positive port currents, the
    // heads sit at inner[0], posts[2], inner[1], posts[3], and every run
    // advances toward its far end (all four point downward here).
    const drawTl = (phase: number): Point[] => {
      const { ctx, rects } = dotCtx();
      TRANSMISSION_LINE_DEF.draw(
        {
          ...context(ctx, 0),
          voltages: [0, 0, 0, 0],
          postCurrents: [0.01, 0.01, 0, 0],
          postDotPhases: [phase, phase, 0, 0],
        },
        {
          id: 1,
          kind: 'transmissionLine',
          x1: 0,
          y1: 0,
          x2: 400,
          y2: 0,
          flags: 0,
          params: { width: 32 },
        },
      );
      return dots(rects);
    };
    const heads = [
      { x: 0, y: 24 },
      { x: 0, y: 0 },
      { x: 400, y: 24 },
      { x: 400, y: 0 },
    ];
    for (const head of heads) {
      expect(hasDot(drawTl(0), head)).toBe(true);
    }
    const advanced = [
      { x: 0, y: 26 },
      { x: 0, y: 2 },
      { x: 400, y: 26 },
      { x: 400, y: 2 },
    ];
    for (const p of advanced) {
      expect(hasDot(drawTl(2), p)).toBe(true);
    }
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
    const cases: Array<{
      def: { draw(g: DrawContext, e: CircuitElement): void };
      e: CircuitElement;
      path: Point[];
    }> = [
      {
        def: RESISTOR_DEF,
        e: { id: 1, kind: 'resistor', x1: 0, y1: 0, x2: 100, y2: 0, flags: 0, params: {} },
        path: [
          { x: 0, y: 0 },
          { x: 100, y: 0 },
        ],
      },
      {
        def: RAIL_DEF,
        e: {
          id: 1,
          kind: 'rail',
          x1: 0,
          y1: 0,
          x2: 100,
          y2: 0,
          flags: 0,
          params: { waveform: 0, maxVoltage: 5 },
        },
        path: [
          { x: 83, y: 0 },
          { x: 0, y: 0 },
        ],
      },
      {
        def: MOSFET_DEF,
        e: mosfet(1),
        path: [
          { x: 100, y: -16 },
          { x: 78, y: -16 },
          { x: 78, y: 16 },
          { x: 100, y: 16 },
        ],
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

  it('a transistor collector run still advances from the post toward the body', () => {
    // The collector run flipped its endpoints (post, contact -> contact, post)
    // and negated its current (g.current -> -ic through current_into_node);
    // the two cancel, so the dots must still travel from the collector post
    // toward the body contact. The per-post phase integrates the negated
    // current, so it *decreases* each frame; draw at 0 and -2 and assert the
    // dot train shifts toward the contact (c1), not the post.
    const e = {
      id: 1,
      kind: 'transistor',
      x1: 0,
      y1: 0,
      x2: 100,
      y2: 0,
      flags: 0,
      params: { pnp: 1 },
    };
    const drawAt = (phase: number): Point[] => {
      const { ctx, rects } = dotCtx();
      TRANSISTOR_DEF.draw(
        {
          ...context(ctx, 0),
          voltages: [0, 0, 0],
          current: 1e-4,
          postCurrents: [0, -1e-4, 0],
          postDotPhases: [0, phase, 0],
        },
        e,
      );
      return dots(rects);
    };
    const post = TRANSISTOR_DEF.posts(e)[1];
    const [c1] = transistorBarContacts(e);
    const dir = unit({ x: post.x - c1.x, y: post.y - c1.y });
    const project = (p: Point): number => (p.x - c1.x) * dir.x + (p.y - c1.y) * dir.y;
    const at0 = drawAt(0).map(project);
    const atNeg = drawAt(-2).map(project);
    // At phase 0 the leading dot sits at the post end (the full lead length);
    // two negated steps pull the whole train toward the body contact.
    expect(Math.max(...at0)).toBeGreaterThan(15);
    expect(Math.max(...atNeg)).toBeLessThan(Math.max(...at0));
  });

  // The SCR and triac share the thyristor dot layout: one run per main
  // terminal on that post's own current and phase, plus the gate train across
  // both segments. Both elements get the same assertions, so one fixture
  // parameterized by def keeps them DRY. The SCR fixture carries the gate-fix
  // flag (SCR_GATE_FIX=1, its default), which makes it measure the axis length
  // for the leads; the triac always does. Both land on the same geometry: lead2
  // (58,0), p1 (0,0), p2 (100,0), gate0 (84,-26), gate1 (80,-32).
  const thyristorCases: Array<{
    def: { draw(g: DrawContext, e: CircuitElement): void };
    e: CircuitElement;
    geo: { p1: Point; p2: Point; lead2: Point; gate0: Point; gate1: Point };
  }> = [
    {
      def: SCR_DEF,
      e: { id: 1, kind: 'scr', x1: 0, y1: 0, x2: 100, y2: 0, flags: 1, params: {} },
      geo: scrGeometry({ id: 1, kind: 'scr', x1: 0, y1: 0, x2: 100, y2: 0, flags: 1, params: {} }),
    },
    {
      def: TRIAC_DEF,
      e: { id: 1, kind: 'triac', x1: 0, y1: 0, x2: 100, y2: 0, flags: 0, params: {} },
      geo: triacGeometry({
        id: 1,
        kind: 'triac',
        x1: 0,
        y1: 0,
        x2: 100,
        y2: 0,
        flags: 0,
        params: {},
      }),
    },
  ];

  /** Draw with explicit per-post currents and phases (the shared `drawAt`
   *  only sets the scalar `current`). The scalar current is 0 so a test that
   *  animates a terminal proves it runs on `postCurrents`, not on `g.current`.
   */
  const drawThyristor = (
    def: { draw(g: DrawContext, e: CircuitElement): void },
    e: CircuitElement,
    postCurrents: number[],
    postDotPhases: number[],
  ): Point[] => {
    const { ctx, rects } = dotCtx();
    def.draw(
      {
        ...context(ctx, 0),
        voltages: [0, 0, 0],
        current: 0,
        postCurrents,
        postDotPhases,
      },
      e,
    );
    return dots(rects);
  };

  /** Signed distance of `p` along the `from`-`to` axis, for tracking which
   *  way a dot train shifts between two sampled phases. */
  const project = (p: Point, from: Point, to: Point): number => {
    const dir = unit({ x: to.x - from.x, y: to.y - from.y });
    return (p.x - from.x) * dir.x + (p.y - from.y) * dir.y;
  };

  it('an SCR cathode or triac MT1 run draws even when the scalar current is zero', () => {
    // The regression the fix targets: both main-terminal runs used to animate
    // on the scalar `g.current` (the anode/MT2 current), so a conducting
    // cathode/MT1 with zero scalar current drew nothing at all. The fixed draw
    // animates each post on its own current, so postCurrents[1] = +1mA puts
    // the dots on the lead2->p2 run regardless of the scalar current.
    for (const { def, e, geo } of thyristorCases) {
      const pts = drawThyristor(def, e, [0, 1e-3, 0], [0, 0, 0]);
      expect(pts.length).toBeGreaterThan(0);
      // The run lies on the horizontal lead2->p2 segment, the cathode/MT1 lead.
      for (const p of pts) {
        expect(p.y).toBe(0);
        expect(p.x).toBeGreaterThanOrEqual(geo.lead2.x);
        expect(p.x).toBeLessThanOrEqual(geo.p2.x);
      }
    }
  });

  it('an SCR anode or triac MT2 run is anchored at the post and crawls into the body', () => {
    // The anchoring fix: the run starts at the post, so at phase 0 its leading
    // dot sits exactly on p1, the same residue a connecting wire's run uses
    // (the old lead2-anchored run put it a residue inside the body instead).
    // postCurrents[0] = -ia/-i2 (current entering the device) drives the
    // per-post phase down each frame, so the draw passes the negated phase and
    // the train moves from the post end back to the body: the leading dot's
    // projection on the lead2->p1 axis shrinks between phase 0 and phase -2,
    // the mirror of the transistor collector test above.
    for (const { def, e, geo } of thyristorCases) {
      expect(hasDot(drawThyristor(def, e, [-1e-3, 0, 0], [0, 0, 0]), geo.p1)).toBe(true);
      const draw = (phase: number): number[] =>
        drawThyristor(def, e, [-1e-3, 0, 0], [phase, 0, 0]).map((p) =>
          project(p, geo.lead2, geo.p1),
        );
      const at0 = draw(0);
      const atNeg = draw(-2);
      // At phase 0 the leading dot sits on the post (all 58 units of the run);
      // two negated steps pull the whole train toward the body.
      expect(Math.max(...at0)).toBeGreaterThan(40);
      expect(Math.max(...atNeg)).toBeLessThan(Math.max(...at0));
    }
  });

  it('an SCR cathode or triac MT1 run is anchored at the post and crawls out of the body', () => {
    // The anchoring fix, cathode side: at phase 0 the leading dot sits exactly
    // on p2. postCurrents[1] = +ic/+i1 (current leaving the device) drives the
    // per-post phase up each frame, so the draw passes the negated phase and
    // the train moves toward the post: the leading dot's projection on the
    // lead2->p2 axis grows as the phase rises, so the samples are taken at
    // phases -2 and 0 (the drawn phase 2 lands mid-cell and the dot train has
    // wrapped past its own head).
    for (const { def, e, geo } of thyristorCases) {
      expect(hasDot(drawThyristor(def, e, [0, 1e-3, 0], [0, 0, 0]), geo.p2)).toBe(true);
      const draw = (phase: number): number[] =>
        drawThyristor(def, e, [0, 1e-3, 0], [0, phase, 0]).map((p) =>
          project(p, geo.lead2, geo.p2),
        );
      const atNeg = draw(-2);
      const at0 = draw(0);
      // At phase -2 the leading dot sits two units off the post; at phase 0 it
      // reaches it, so the train slides body to post as the phase rises.
      expect(Math.max(...atNeg)).toBeGreaterThan(20);
      expect(Math.max(...at0)).toBeGreaterThan(Math.max(...atNeg));
    }
  });

  it('an SCR or triac gate draws one continuous train anchored at the gate post', () => {
    // postCurrents[2] = -ig (current entering at the gate post) drives the
    // phase down, so the train crawls from the gate post toward the body. The
    // two segments chain into one run: the first starts at the gate post, so
    // at phase 0 its head dot sits on gate1 (the anchoring fix), and the
    // second segment's phase is the first's offset by the first segment's
    // length (dotPhaseAfter), which keeps the spacing continuous across the
    // corner instead of restarting the train at lead2 or gate0.
    for (const { def, e, geo } of thyristorCases) {
      const pts = drawThyristor(def, e, [0, 0, -1e-3], [0, 0, 0]);
      // The head dot lands on the gate post, the same residue a wire on the
      // gate uses.
      expect(hasDot(pts, geo.gate1)).toBe(true);
      // The chained second segment does not restart at the corner or the body:
      // at phase 0 its nearest dot sits part-way along the run (not on gate0)
      // and nothing lands on lead2.
      expect(hasDot(pts, geo.gate0)).toBe(false);
      expect(hasDot(pts, geo.lead2)).toBe(false);
      expect(pts.length).toBeGreaterThan(1);
      // With no gate current the gate draws nothing at all.
      expect(drawThyristor(def, e, [0, 0, 0], [0, 0, 0])).toHaveLength(0);
    }
  });

  it('a degenerate SCR gate (too short for a lead) draws no stray origin run', () => {
    // A span too short for a gate lead makes scrGeometry return the (0,0)
    // sentinel for both gate points (scr.ts:56-60). The dot runs must skip it,
    // or currentDotsFrom(lead2, gate0, ...) would smear dots from the origin
    // into the body. The guard keeps the sentinel-gate deviation from
    // regressing into stray dots.
    const short = { id: 1, kind: 'scr', x1: 0, y1: 0, x2: 20, y2: 0, flags: 1, params: {} };
    expect(scrGeometry(short).gate0).toEqual({ x: 0, y: 0 });
    expect(drawThyristor(SCR_DEF, short, [0, 0, -1e-3], [0, 0, 0])).toHaveLength(0);
  });

  it('the dot train is phase-continuous from a connecting wire into the SCR or triac', () => {
    // The reported symptom, as a regression: a dot entering on a connecting
    // wire vanished at the post and a new out-of-phase dot spawned on the
    // element. Both runs now use the same residue (a dot on the post at phase
    // ≡ 0 mod 16), so at the wire phase that puts a dot on the shared post the
    // element's run puts one there too, and the combined dots read as one
    // train every DOT_SPACING units from the wire's near end through the body.
    // Under the old lead2-anchored run the element's dots landed a residue
    // inside the body (10, 26, 42, 58 here) and the train broke at the post.
    for (const { def, e, geo } of thyristorCases) {
      const { ctx, rects } = dotCtx();
      const wire = { id: 9, kind: 'wire', x1: -48, y1: 0, x2: 0, y2: 0, flags: 0, params: {} };
      // A wire 48 units long at dotPhase 0 (its residue for a dot on the post)
      // puts dots at its near end and every DOT_SPACING to the shared post.
      WIRE_DEF.draw({ ...context(ctx, 0), current: -1e-3, voltages: [0, 0] }, wire);
      // The conducting anode at postDotPhases 0 puts its leading dot on the
      // same post and continues the spacing into the body.
      def.draw(
        {
          ...context(ctx, 0),
          voltages: [0, 0, 0],
          current: 0,
          postCurrents: [-1e-3, 0, 0],
          postDotPhases: [0, 0, 0],
        },
        e,
      );
      const pts = dots(rects);
      // The combined train: -48, -32, -16, 0 (wire), 0, 16, 32, 48 (element).
      for (const x of [-48, -32, -16, 0, 16, 32, 48]) {
        expect(hasDot(pts, { x, y: 0 })).toBe(true);
      }
      expect(hasDot(pts, geo.p1)).toBe(true);
    }
  });
});

describe('value label placement', () => {
  const cap = (x1: number, y1: number, x2: number, y2: number): CircuitElement => ({
    id: 1,
    kind: 'capacitor',
    x1,
    y1,
    x2,
    y2,
    flags: 0,
    params: { capacitance: 1e-5 },
  });

  const draw = (e: CircuitElement): TextRecord => {
    const { ctx, texts } = mkCtx();
    CAPACITOR_DEF.draw({ ...context(ctx, 0), showValues: true, voltages: [0, 0] }, e);
    // The capacitor body emits exactly one fillText, its value caption.
    expect(texts).toHaveLength(1);
    return texts[0];
  };

  it('keeps a horizontal capacitor label above the plate, clear of it', () => {
    // The plates span y = -12 to +12 (CAP_PLATE_HALF_WIDTH, capacitor.ts:23),
    // and the caption's alphabetic baseline sits two units above the top
    // plate edge at y = -12, so the glyphs (only descenders hang below the
    // baseline) stay off the plate.
    const t = draw(cap(0, 0, 160, 0));
    expect(t.align).toBe('center');
    expect(t.y).toBe(-14);
    expect(t.y).toBeLessThan(-12);
  });

  it('keeps a vertical capacitor label beyond the plate, clear of it', () => {
    // A vertical body gets left-aligned text beside it, starting at
    // xc + 12 + 2: the right plate endpoint sits at xc + 12, so the caption
    // is two units clear (CircuitElm.java:937-940).
    const t = draw(cap(0, 0, 0, 160));
    expect(t.align).toBe('left');
    expect(t.x).toBe(14);
    expect(t.x).toBeGreaterThan(12);
  });

  it('draws a voltage source value on the near side, not the far one', () => {
    // Upstream special-cases VoltageElm to the near side of the body
    // (CircuitElm.java:938-939); the port's `label` follows via kind.
    const { ctx, texts } = mkCtx();
    VOLTAGE_DEF.draw({ ...context(ctx, 0), showValues: true, voltages: [0, 0] }, {
      id: 1,
      kind: 'voltage',
      x1: 0,
      y1: 0,
      x2: 0,
      y2: 160,
      flags: 0,
      params: { waveform: 0, maxVoltage: 5 },
    });
    // The battery draw emits a single fillText, its value caption.
    expect(texts).toHaveLength(1);
    const t = texts[texts.length - 1];
    expect(t.text).toContain('V');
    expect(t.align).toBe('left');
    expect(t.x).toBeLessThan(0);
  });
});

describe('DC voltage source battery symbol', () => {
  // A plain DC `v` line (waveform 0, no FLAG_CIRCLE_SYMBOL) renders as the
  // two-plate battery rather than the circled +/− symbol: a short plate at
  // lead1 and a long one at lead2, with the leads 8 units long each side
  // (VoltageElm.java:281-291, :252).

  const voltage = (overrides: Partial<CircuitElement> = {}): CircuitElement => ({
    id: 1,
    kind: 'voltage',
    x1: 0,
    y1: 0,
    x2: 64,
    y2: 0,
    flags: 0,
    params: { waveform: 0 },
    ...overrides,
  });

  /** Every stroked path as its two endpoints. */
  const segments = (paths: { x: number; y: number }[][]): { a: Point; b: Point }[] =>
    paths.filter((p) => p.length === 2).map((p) => ({ a: p[0], b: p[1] }));

  /** Whether a segment of these exact endpoints, in either order, was drawn. */
  const hasSegment = (segs: { a: Point; b: Point }[], a: Point, b: Point): boolean =>
    segs.some(
      (s) =>
        (s.a.x === a.x && s.a.y === a.y && s.b.x === b.x && s.b.y === b.y) ||
        (s.a.x === b.x && s.a.y === b.y && s.b.x === a.x && s.b.y === a.y),
    );

  it('draws a short plate at lead1 and a long plate at lead2, with no circle', () => {
    const { ctx, calls, paths } = mkCtx();
    VOLTAGE_DEF.draw({ ...context(ctx, 0), voltages: [0, 0], showCurrent: false }, voltage());
    // The battery body is two perpendicular bars, never the source circle.
    expect(calls).not.toContain('arc');
    const segs = segments(paths);
    // For a 64-unit horizontal body, calcLeads(8) puts lead1 at (28,0) and
    // lead2 at (36,0); the plates ride those points perpendicular to the axis
    // at half-heights 10 and 16 (VoltageElm.java:284, :290).
    expect(hasSegment(segs, { x: 28, y: -10 }, { x: 28, y: 10 })).toBe(true);
    expect(hasSegment(segs, { x: 36, y: -16 }, { x: 36, y: 16 })).toBe(true);
  });

  it('renders the circled +/− symbol when FLAG_CIRCLE_SYMBOL is set', () => {
    const { ctx, calls, paths } = mkCtx();
    VOLTAGE_DEF.draw(
      { ...context(ctx, 0), voltages: [0, 0], showCurrent: false },
      voltage({ flags: VOLTAGE_CIRCLE_SYMBOL }),
    );
    // The circle is back, and no battery plates: the only paths are the two
    // lead wires.
    expect(calls).toContain('arc');
    expect(paths).toHaveLength(2);
  });

  it('keeps the plates in the post voltage colours under Show Power', () => {
    // Upstream forces the per-post voltage colours onto the plates and off
    // the power ramp (setVoltageColor + setPowerColor(false), VoltageElm.java:
    // 282-291), exactly like the capacitor's plates (capacitor.ts:59-60).
    // With the voltage toggle off that colour is the wire colour; the red
    // power ramp must never reach the plates.
    const { ctx, strokes } = mkCtx();
    VOLTAGE_DEF.draw(
      {
        ...context(ctx, 0),
        voltages: [5, 0],
        showCurrent: false,
        showPowerColor: true,
        power: 1e6,
      },
      voltage(),
    );
    const plates = strokes.slice(2, 4);  // the two lead wires come first
    expect(plates).toHaveLength(2);
    expect(plates.every((s) => s.style === makeTheme().wire)).toBe(true);
    const ramp = powerColor({ ...context(mkCtx().ctx, 0), showPowerColor: true }, 1e6);
    expect(plates.every((s) => s.style !== ramp)).toBe(true);
  });
});

describe('value label text', () => {
  // The on-canvas captions: a resistor draws `4.7k` with no ohm unit and no
  // space, and the capacitor and inductor draw their unit tight against the
  // number. The Properties panel and scopes keep `formatValue`'s spaced unit.
  const valueText = (
    def: { draw(g: DrawContext, e: CircuitElement): void },
    params: Record<string, number>,
  ): string => {
    const { ctx, texts } = mkCtx();
    def.draw(
      { ...context(ctx, 0), showValues: true, voltages: [0, 0] },
      { id: 1, kind: 'resistor', x1: 0, y1: 0, x2: 64, y2: 0, flags: 0, params },
    );
    // The value caption is the only fillText these bodies emit.
    expect(texts).toHaveLength(1);
    return texts[0].text;
  };

  it('draws a resistor value without the ohm unit or a space', () => {
    expect(valueText(RESISTOR_DEF, { resistance: 4700 })).toBe('4.7k');
  });

  it('draws a capacitor value tight against its unit', () => {
    expect(valueText(CAPACITOR_DEF, { capacitance: 1e-6 })).toBe('1µF');
  });

  it('draws an inductor value tight against its unit', () => {
    expect(valueText(INDUCTOR_DEF, { inductance: 0.01 })).toBe('10mH');
  });
});

describe('wire value labels', () => {
  // The Show Current and Show Voltage checkboxes draw the live values beside
  // the wire, current as |I| in amps and voltage in volts, joined with a
  // space (WireElm.java:90-102). Without either flag a wire emits no caption.

  const wire = (flags: number, route?: [number, number][]): CircuitElement => ({
    id: 1,
    kind: 'wire',
    x1: 0,
    y1: 0,
    x2: 64,
    y2: 0,
    flags,
    params: {},
    ...(route !== undefined ? { route } : {}),
  });

  const draw = (e: CircuitElement, overrides: Partial<DrawContext> = {}) => {
    const { ctx, texts } = mkCtx();
    WIRE_DEF.draw(
      { ...context(ctx, 0), showValues: true, voltages: [0, 0], current: 0.05, ...overrides },
      e,
    );
    return texts;
  };

  it('draws no caption without either flag', () => {
    expect(draw(wire(0))).toHaveLength(0);
  });

  it('draws the current as |I| in amps', () => {
    const texts = draw(wire(WIRE_SHOW_CURRENT), { current: 0.05 });
    expect(texts).toHaveLength(1);
    expect(texts[0].text).toBe('50mA');
  });

  it('hides the wire direction with the absolute current', () => {
    const texts = draw(wire(WIRE_SHOW_CURRENT), { current: -0.05 });
    expect(texts[0].text).toBe('50mA');
  });

  it('draws the voltage in volts', () => {
    const texts = draw(wire(WIRE_SHOW_VOLTAGE), { voltages: [5, 5] });
    expect(texts).toHaveLength(1);
    expect(texts[0].text).toBe('5V');
  });

  it('joins current and voltage with a space', () => {
    const texts = draw(wire(WIRE_SHOW_CURRENT | WIRE_SHOW_VOLTAGE), {
      current: 0.05,
      voltages: [5, 5],
    });
    expect(texts).toHaveLength(1);
    expect(texts[0].text).toBe('50mA 5V');
  });

  it('suppresses the caption when the global Show Values toggle is off', () => {
    const { ctx, texts } = mkCtx();
    WIRE_DEF.draw(
      { ...context(ctx, 0), showValues: false, voltages: [0, 0], current: 0.05 },
      wire(WIRE_SHOW_CURRENT | WIRE_SHOW_VOLTAGE),
    );
    expect(texts).toHaveLength(0);
  });

  it('a routed wire labels its longest segment', () => {
    const texts = draw(
      wire(WIRE_SHOW_CURRENT | WIRE_SHOW_VOLTAGE, [
        [0, 0],
        [64, 0],
        [64, 64],
      ]),
      { current: 0.05, voltages: [5, 5] },
    );
    expect(texts).toHaveLength(1);
    expect(texts[0].text).toBe('50mA 5V');
    // The longest segment is the horizontal 0,0-64,0, so the caption centres
    // above its midpoint, the RoutedWireElm placement (RoutedWireElm.java:
    // 318-347).
    expect(texts[0].align).toBe('center');
  });

  it('a routed wire draws no caption without either flag', () => {
    const texts = draw(
      wire(0, [
        [0, 0],
        [64, 0],
        [64, 64],
      ]),
    );
    expect(texts).toHaveLength(0);
  });
});
