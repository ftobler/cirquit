import { describe, expect, it, vi } from 'vitest';
import { calcLeads, interp, makeTheme, rectCorners, ZIGZAG_HS, zigzagPoints } from '../render/draw';
import {
  axisConstrained,
  constrainPostDrag,
  dominantAxisSnap,
  ELEMENT_DEFS,
  PLACEMENT_BY_CHAR,
  TOOLBOX,
  defFor,
  opAmpInputAnchors,
  opAmpLabelAnchors,
  opampInputSign,
  postCountOf,
  postsOf,
  transistorBarContacts,
} from './registry';
import { mirrorElement } from './transform';
import { DIODE_DEF } from './registry/elements/diode';
import { FULL_ADDER_BITS } from './registry/elements/fullAdder';
import { ZENER_DEF } from './registry/elements/zener';
import { FUSE_DEF } from './registry/elements/fuse';
import { LAMP_DEF } from './registry/elements/lamp';
import { OPAMP_DEF } from './registry/elements/opamp';
import { THREE_PHASE_MOTOR_DEF } from './registry/elements/threePhaseMotor';
import { snap } from '../state/helpers';
import { GRID_SIZE } from './types';
import type { CircuitElement, DrawContext, ElementDef, Point } from './types';

const element = (
  kind: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  flags = 0,
  params: Record<string, number> = {},
): CircuitElement => ({ id: 1, kind, x1, y1, x2, y2, flags, params });

interface CtxStub {
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  lineCap: string;
  lineJoin: string;
  font: string;
  textAlign: string;
  textBaseline: string;
  createLinearGradient: ReturnType<typeof vi.fn>;
  beginPath: ReturnType<typeof vi.fn>;
  moveTo: ReturnType<typeof vi.fn>;
  lineTo: ReturnType<typeof vi.fn>;
  stroke: ReturnType<typeof vi.fn>;
  arc: ReturnType<typeof vi.fn>;
  fill: ReturnType<typeof vi.fn>;
  closePath: ReturnType<typeof vi.fn>;
  fillText: ReturnType<typeof vi.fn>;
  setLineDash: ReturnType<typeof vi.fn>;
  measureText: (text: string) => { width: number };
}

/** A recorded gradient, mirroring the live CanvasGradient's axis and stops. */
interface GradientRecord {
  stops: { offset: number; color: string }[];
  addColorStop(offset: number, color: string): void;
}

/** Minimal canvas stub, recording geometry calls so a draw can be asserted on.
 *  `strokes` captures the strokeStyle at each stroke and `fills` the fillStyle
 *  at each fill, in draw order, which is how a gradient body or a filled bulb
 *  is asserted on. `grads` captures the gradients the draw created, so the
 *  ramp stops can be checked. The closures read the same object the draw
 *  layer writes to (`context` hands this stub to `def.draw` unchanged), so a
 *  spread copy would never see the live colour. */
const mkCtx = (): CtxStub & { strokes: (string | CanvasGradient)[]; fills: string[]; grads: GradientRecord[] } => {
  const strokes: (string | CanvasGradient)[] = [];
  const fills: string[] = [];
  const grads: GradientRecord[] = [];
  const stub = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    lineCap: '',
    lineJoin: '',
    font: '',
    textAlign: '',
    textBaseline: '',
    createLinearGradient: vi.fn(() => {
      const grad: GradientRecord = { stops: [], addColorStop: () => {} };
      grad.addColorStop = (offset: number, color: string) => grad.stops.push({ offset, color });
      grads.push(grad);
      return grad;
    }),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(() => strokes.push(stub.strokeStyle)),
    arc: vi.fn(),
    fill: vi.fn(() => fills.push(stub.fillStyle)),
    closePath: vi.fn(),
    fillText: vi.fn(),
    setLineDash: vi.fn(),
    measureText: (text: string) => ({ width: text.length * 6 }),
  } as CtxStub;
  return Object.assign(stub, { strokes, fills, grads });
};

const context = (ctx: CtxStub, overrides: Partial<DrawContext> = {}): DrawContext => ({
  ctx: ctx as unknown as CanvasRenderingContext2D,
  theme: makeTheme(),
  voltages: [0, 0, 0],
  current: 1e-3,
  voltage: 0,
  power: 0,
  value: 0,
  state: 0,
  wave: [],
  dotPhase: 0,
  postCurrents: [],
  postDotPhases: [],
  showCurrent: false,
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
  ...overrides,
});

/** Signed distance of `p` from the element's axis; the sign is the side. */
const axisSide = (e: CircuitElement, p: Point): number =>
  (e.x2 - e.x1) * (p.y - e.y1) - (e.y2 - e.y1) * (p.x - e.x1);

/** Param names a parse or dump function reads or writes, whatever its shape. */
function referencedParams(fn: unknown): Set<string> {
  const names = new Set<string>();
  if (typeof fn !== 'function') return names;
  const src = fn.toString();
  for (const m of src.matchAll(/\.params\.(\w+)/g)) names.add(m[1]);
  // readParams(t, e, ['a', 'b']) and writeParams(['a', 'b']) both pass their
  // names in an array literal; quoted strings elsewhere in a dump are harmless
  // extras that never make a check fail. Vitest transpiles to double quotes,
  // so accept either quote style.
  for (const m of src.matchAll(/\[([^\]]*)\]/g)) {
    for (const n of m[1].matchAll(/(['"])([^'"]+)\1/g)) names.add(n[2]);
  }
  return names;
}

describe('zener fields', () => {
  it('exposes the diode model fields plus its own breakdown voltage', () => {
    const names = (ZENER_DEF.fields ?? []).map((f) => f.name);
    expect(names).toEqual([
      'modelName',
      'forwardVoltage',
      'seriesResistance',
      'emissionCoefficient',
      'breakdownVoltage',
    ]);
  });

  it('copies the diode field definitions exactly, in the diode order', () => {
    expect(ZENER_DEF.fields).toHaveLength((DIODE_DEF.fields ?? []).length + 1);
    for (let i = 1; i < (DIODE_DEF.fields ?? []).length; i++) {
      expect(ZENER_DEF.fields?.[i]).toEqual(DIODE_DEF.fields?.[i]);
    }
    // The one deliberate divergence: the zener's model row carries the
    // breakdown filter, so its picker hides the zero-breakdown models the
    // diode keeps showing (DiodeModel.java:193-194).
    expect(ZENER_DEF.fields?.[0]).toEqual({
      name: 'modelName',
      label: 'Model',
      type: 'modelChoice',
      target: 'modelName',
      modelFamily: 'diode',
      zenerBreakdown: true,
    });
  });
});

describe('text field metadata', () => {
  it('declares both fields on the text element, the text one targeting e.text', () => {
    const def = ELEMENT_DEFS.find((d) => d.kind === 'decoration');
    expect(def?.fields).toEqual([
      { name: 'text', label: 'Text', type: 'text', target: 'text' },
      { name: 'size', label: 'Size', unit: 'px' },
    ]);
  });

  it('gives the labeled node, another e.text label, the same text field', () => {
    const def = ELEMENT_DEFS.find((d) => d.kind === 'labeledNode');
    expect(def?.fields).toEqual([{ name: 'text', label: 'Text', type: 'text', target: 'text' }]);
  });

  it('the custom logic model name is a text field, and its posts follow the model', () => {
    const def = ELEMENT_DEFS.find((d) => d.kind === 'customLogic');
    expect(def?.dumpCode).toBe('208');
    // The only editable is the model name, which lives in `e.text` like the
    // labeled node's, because the model fixes the pin count.
    expect(def?.fields).toEqual([
      { name: 'modelName', label: 'Model Name', type: 'text', target: 'text' },
    ]);
    // No model: the fallback 4-input / 2-output body.
    const fresh = element('customLogic', 0, 0, 96, 0);
    expect(postsOf(fresh)).toHaveLength(6);
    // A resolved model widens the body to its pin table.
    const loaded = {
      ...fresh,
      model: {
        name: 'eq',
        flags: 0,
        inputs: ['A', 'B'],
        outputs: ['C', 'D', 'E'],
        infoText: '',
        rules: '',
        rulesLeft: ['aa'],
        rulesRight: ['10'],
        triState: false,
      },
    };
    expect(postsOf(loaded)).toHaveLength(5);
  });

  it('keeps every flag field a checkbox', () => {
    // A `flag` field toggles a bit of `e.flags`; the panel only renders that
    // as a checkbox under `type: 'bool'`, and any other type would silently
    // write the bit as if it were a number.
    for (const def of ELEMENT_DEFS) {
      for (const f of def.fields ?? []) {
        if (f.flag !== undefined) expect(f.type, `${def.kind}.${f.name}`).toBe('bool');
      }
    }
  });

  it('keeps every target text field a text field', () => {
    // `target: 'keyShortcut'` reads/writes a top-level element field like
    // `text` does, so it must render as a text input too.
    for (const def of ELEMENT_DEFS) {
      for (const f of def.fields ?? []) {
        if (f.target === 'text' || f.target === 'keyShortcut') expect(f.type).toBe('text');
      }
    }
  });

  it('binds every field name to something the element reads or writes', () => {
    for (const def of ELEMENT_DEFS) {
      const bound = new Set([
        ...Object.keys(def.defaults ?? {}),
        ...referencedParams(def.parse),
        ...referencedParams(def.dump),
      ]);
      for (const f of def.fields ?? []) {
        // A text, keyShortcut or modelName field is bound to a top-level
        // field of `e` (e.text / e.keyShortcut / e.modelName), not to a
        // param, so there is nothing in parse/dump/defaults for it to match.
        if (
          f.target === 'text' ||
          f.target === 'keyShortcut' ||
          f.target === 'modelName'
        )
          continue;
        // A flag field is bound to a bit of `e.flags`, not to a param, so
        // there is nothing in parse/dump/defaults for it to match.
        if (f.flag !== undefined) continue;
        // A download field binds no value at all: it is a button that pulls
        // the recorded samples from the engine on demand (the data recorder's
        // export), never a param the element reads or writes.
        if (f.type === 'download') continue;
        expect(bound.has(f.name), `${def.kind} field '${f.name}' is bound to nothing`).toBe(true);
      }
    }
  });
});

describe('mirrored drawing geometry', () => {
  // A mirror must move the drawn leads and labels onto the same side of the
  // body as the posts they connect to; a lead that does not would cross the
  // symbol and the minus glyph would sit on the non-inverting input.
  it('keeps the op-amp inverting lead and its minus glyph on the inverting post side', () => {
    const a = element('opamp', 0, 0, 160, 0);
    const m = mirrorElement(a);
    const [inPost] = postsOf(m);
    const [inLead] = opAmpInputAnchors(m);
    const [minus] = opAmpLabelAnchors(m);
    expect(axisSide(m, inPost)).toBeGreaterThan(0); // sanity: post off the axis
    expect(axisSide(m, inLead) * axisSide(m, inPost)).toBeGreaterThan(0);
    expect(axisSide(m, minus) * axisSide(m, inPost)).toBeGreaterThan(0);
  });

  it('keeps the transistor collector and emitter leads on their posts side', () => {
    const t = element('transistor', 0, 0, 160, 0, 0, { pnp: 1 });
    const m = mirrorElement(t);
    const posts = postsOf(m);
    const [collLead, emitLead] = transistorBarContacts(m);
    expect(axisSide(m, posts[1])).toBeGreaterThan(0); // sanity: collector off the axis
    expect(axisSide(m, collLead) * axisSide(m, posts[1])).toBeGreaterThan(0);
    expect(axisSide(m, emitLead) * axisSide(m, posts[2])).toBeGreaterThan(0);
  });
});

describe('transistor posts', () => {
  const t = (x1: number, y1: number, x2: number, y2: number, flags = 0, pnp = 1) =>
    element('transistor', x1, y1, x2, y2, flags, { pnp, beta: 100 });

  it('puts the collector above a left-to-right NPN', () => {
    expect(postsOf(t(0, 0, 32, 0))).toEqual([
      { x: 0, y: 0 },
      { x: 32, y: -16 },
      { x: 32, y: 16 },
    ]);
  });

  it('keeps the collector above when drawn right-to-left', () => {
    // Without dsign the collector would land below the line, which is the bug
    // this case pins.
    expect(postsOf(t(0, 0, -32, 0))).toEqual([
      { x: 0, y: 0 },
      { x: -32, y: -16 },
      { x: -32, y: 16 },
    ]);
  });

  it('puts the collector on the +x side of an upward NPN', () => {
    expect(postsOf(t(0, 0, 0, -32))).toEqual([
      { x: 0, y: 0 },
      { x: 16, y: -32 },
      { x: -16, y: -32 },
    ]);
  });

  it('FLAG_FLIP swaps the collector and emitter sides', () => {
    expect(postsOf(t(0, 0, 32, 0, 1))).toEqual([
      { x: 0, y: 0 },
      { x: 32, y: 16 },
      { x: 32, y: -16 },
    ]);
  });

  it('flips the collector below for a PNP', () => {
    // hs2 = hs*dsign*pnp with pnp = -1 (TransistorElm.java:220).
    expect(postsOf(t(0, 0, 32, 0, 0, -1))).toEqual([
      { x: 0, y: 0 },
      { x: 32, y: 16 },
      { x: 32, y: -16 },
    ]);
  });
});

describe('mosfet posts', () => {
  const m = (x1: number, y1: number, x2: number, y2: number, flags = 0) =>
    element('mosfet', x1, y1, x2, y2, flags, { pnp: 1, beta: 0.02, threshold: 1.5 });

  it('puts the source below a left-to-right N-channel', () => {
    expect(postsOf(m(0, 0, 32, 0))).toEqual([
      { x: 0, y: 0 },
      { x: 32, y: 16 },
      { x: 32, y: -16 },
    ]);
  });

  it('keeps the source below when drawn right-to-left', () => {
    // Without dsign the source would land above the line, the same bug class
    // the transistor case pins.
    expect(postsOf(m(0, 0, -32, 0))).toEqual([
      { x: 0, y: 0 },
      { x: -32, y: 16 },
      { x: -32, y: -16 },
    ]);
  });

  it('FLAG_FLIP swaps the source and drain sides', () => {
    expect(postsOf(m(0, 0, 32, 0, 8))).toEqual([
      { x: 0, y: 0 },
      { x: 32, y: -16 },
      { x: 32, y: 16 },
    ]);
  });

  it('draws both channel types and the flipped body without throwing', () => {
    const draw = (flags: number, pnp: number) => {
      const ctx = mkCtx();
      const mos = element('mosfet', 0, 0, 160, 0, flags, { pnp, beta: 0.02, threshold: 1.5 });
      expect(() => defFor('mosfet')?.draw(context(ctx), mos)).not.toThrow();
      return ctx;
    };
    draw(0, 1);
    draw(8, 1);
    draw(0, -1);
    draw(9, -1);
  });

  it('dsign mirrors the source onto the -x flank of an upward element', () => {
    expect(postsOf(m(0, 0, 0, -32))).toEqual([
      { x: 0, y: 0 },
      { x: -16, y: -32 },
      { x: 16, y: -32 },
    ]);
  });
});

describe('ota draw', () => {
  it('draws the OTA body without throwing', () => {
    const ctx = mkCtx();
    const ota = element('ota', 0, 0, 112, 0, 0, { posVolt: 9, negVolt: -9 });
    expect(() => defFor('ota')?.draw(context(ctx), ota)).not.toThrow();
    // The plus and minus glyphs are part of the symbol.
    expect(ctx.fillText).toHaveBeenCalled();
  });
});

describe('op-amp posts', () => {
  const op = (x1: number, y1: number, x2: number, y2: number, flags = 0) =>
    element('opamp', x1, y1, x2, y2, flags);

  it('spaces the default-size inputs 16 from the axis', () => {
    // Default size is 2, so inputs sit at ±16, not the small-variant ±8.
    expect(postsOf(op(0, 0, 26, 0))).toEqual([
      { x: 0, y: -16 },
      { x: 0, y: 16 },
      { x: 26, y: 0 },
    ]);
  });

  it('FLAG_SMALL uses the 8-unit half separation', () => {
    expect(postsOf(op(0, 0, 13, 0, 2))).toEqual([
      { x: 0, y: -8 },
      { x: 0, y: 8 },
      { x: 13, y: 0 },
    ]);
  });

  it('FLAG_SWAP swaps the two inputs', () => {
    expect(postsOf(op(0, 0, 26, 0, 1))).toEqual([
      { x: 0, y: 16 },
      { x: 0, y: -16 },
      { x: 26, y: 0 },
    ]);
  });

  it('dsign mirrors the inputs on a right-to-left element', () => {
    expect(postsOf(op(0, 0, -26, 0))).toEqual([
      { x: 0, y: -16 },
      { x: 0, y: 16 },
      { x: -26, y: 0 },
    ]);
  });
});

describe('pot posts', () => {
  const pot = (x1: number, y1: number, x2: number, y2: number, flags = 0) =>
    element('potentiometer', x1, y1, x2, y2, flags);

  it('puts the wiper 16 above the axis of a left-to-right pot', () => {
    expect(postsOf(pot(0, 0, 32, 0))).toEqual([
      { x: 0, y: 0 },
      { x: 32, y: 0 },
      { x: 16, y: -16 },
    ]);
  });

  it('FLAG_FLIP_OFFSET drops the wiper below instead', () => {
    expect(postsOf(pot(0, 0, 32, 0, 4))).toEqual([
      { x: 0, y: 0 },
      { x: 32, y: 0 },
      { x: 16, y: 16 },
    ]);
  });

  it('normalizes a diagonal drag to the axis', () => {
    // The far post snaps to the axis-aligned (32,0) and the drag delta dy
    // becomes the wiper offset, so it sits below (PotElm.java:190-192).
    expect(postsOf(pot(0, 0, 32, 16))).toEqual([
      { x: 0, y: 0 },
      { x: 32, y: 0 },
      { x: 16, y: 16 },
    ]);
  });

  it('takes the vertical branch with the wiper on the +x side', () => {
    expect(postsOf(pot(0, 0, 16, 32))).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 32 },
      { x: 16, y: 16 },
    ]);
  });
});

describe('SPDT switch posts', () => {
  const spdt = (throwCount: number, flags = 0, state = 0) =>
    ({ ...element('switch2', 0, 0, 32, 0, flags, { throwCount }), state }) as CircuitElement;

  it('lands throw 0 at +16 and throw 1 at -16', () => {
    // Java integer division: (2-1)/2 is 0, so the special case is the whole
    // spacing (Switch2Elm.java:76-78). Today the second throw lands at -8.
    expect(postsOf(spdt(2))).toEqual([
      { x: 0, y: 0 },
      { x: 32, y: -16 },
      { x: 32, y: 16 },
    ]);
  });

  it('uses integer division for the throw spacing', () => {
    // Java's (4-1)/2 is 1, so the offsets are +16, 0, -16, -32, which read
    // as (32,-16),(32,0),(32,16),(32,32) with the up-is-negative-y screen
    // convention. The float division in the old code put every even throw
    // count off the grid.
    expect(postsOf(spdt(4))).toEqual([
      { x: 0, y: 0 },
      { x: 32, y: -16 },
      { x: 32, y: 0 },
      { x: 32, y: 16 },
      { x: 32, y: 32 },
    ]);
  });

  it('center-off position 2 draws the lever to the pole instead of crashing', () => {
    const ctx = mkCtx();
    const sw = { ...element('switch2', 0, 0, 100, 0, 1, { throwCount: 2 }), state: 2 };
    expect(() => defFor('switch2')?.draw(context(ctx), sw)).not.toThrow();
    // The lever rests on the centre pole, where the throws fan out: `lead2`
    // from calcLeads(32), at 66 for a 100-long element, not an out-of-range
    // throw post (Switch2Elm.java:82,108-109).
    const lineTos = ctx.lineTo.mock.calls.map((a) => ({ x: a[0], y: a[1] }));
    expect(lineTos).toContainEqual({ x: 66, y: 0 });
  });
});

describe('European resistor symbol draw paths', () => {
  const draw = (kind: string, euro: boolean, params: Record<string, number> = {}) => {
    const ctx = mkCtx();
    const e = element(kind, 0, 0, 160, 0, 0, params);
    defFor(kind)?.draw(context(ctx, { euroResistors: euro }), e);
    return ctx;
  };
  const lineTos = (ctx: CtxStub) => ctx.lineTo.mock.calls.map((a) => ({ x: a[0], y: a[1] }));

  // The resistor and pot scale their zigzag to the taller 8-unit ZIGZAG_HS;
  // the thermistor and LDR reuse their box half-height (6) for both symbols
  // (ThermistorNTCElm.java:134, LDRElm.java:106).
  const zigzagHeight = (kind: string): number =>
    kind === 'resistor' || kind === 'potentiometer' ? ZIGZAG_HS : 6;

  it.each(['resistor', 'potentiometer', 'thermistor', 'ldr'])(
    '%s draws the zigzag body when euroResistors is off',
    (kind) => {
      const ctx = draw(kind, false);
      const e = element(kind, 0, 0, 160, 0);
      const [lead1, lead2] = calcLeads(e, 32);
      // polyline moves to the first point, so every peak and the far lead
      // land as a lineTo call; each must be painted.
      const peaks = zigzagPoints(lead1, lead2, zigzagHeight(kind)).slice(1);
      const drawn = lineTos(ctx);
      for (const p of peaks) expect(drawn).toContainEqual(p);
    },
  );

  it.each(['resistor', 'potentiometer', 'thermistor', 'ldr'])(
    '%s draws the box body when euroResistors is on',
    (kind) => {
      const ctx = draw(kind, true);
      const e = element(kind, 0, 0, 160, 0);
      const [lead1, lead2] = calcLeads(e, 32);
      // bodyRect closes its loop by repeating the first corner, so the four
      // distinct corners of rectCorners must all be painted. The euro box
      // half-height is 6 for all four elements.
      const corners = rectCorners(lead1, lead2, 6);
      const drawn = lineTos(ctx);
      for (const p of corners) expect(drawn).toContainEqual(p);
    },
  );

  it.each([
    ['potentiometer', 2],
    ['dFlipFlop', 1],
  ] as const)('%s strokes a genuinely closed body outline', (kind, closeCount) => {
    // The euro box callers and the chip housing all repeat their first corner
    // in the point list; closePath is what makes the corner where the loop
    // starts and ends a real join instead of a nicked, butt-capped pair of
    // stroke ends. The count is exact so the potentiometer's arrowhead
    // triangle cannot mask an open body: its fill also calls closePath, so
    // reverting the box to a plain polyline would drop the count to 1. The
    // resistor, thermistor and ldr euro boxes are absent on purpose: they
    // gradient per segment now and no longer close (see the ramp test below).
    const ctx = draw(kind, true);
    expect(ctx.closePath).toHaveBeenCalledTimes(closeCount);
  });

  it.each(['resistor', 'thermistor', 'ldr'])(
    '%s euro box shades from post 0 to post 1 along the body',
    (kind) => {
      // The gradient box is one closed outline stroked once with a real
      // gradient: the ramp reaches post 0's colour at the lead1 edge (the
      // box's left side) and post 1's at the lead2 edge (the right side),
      // while the four corners are still all painted.
      const ctx = mkCtx();
      const e = element(kind, 0, 0, 160, 0);
      defFor(kind)?.draw(context(ctx, { showVoltageColor: true, voltages: [10, 0, 0] }), e);
      expect(ctx.strokes.length).toBeGreaterThan(2);
      expect(ctx.strokes[0]).toBe('rgb(0,255,0)'); // lead at post 0, clamped positive
      const body = ctx.grads[ctx.grads.length - 1];
      const colors = body.stops.map((s) => s.color);
      expect(colors).toContain('rgb(128,128,128)'); // neutral at 0 V, the box's lead2 edge
      expect(new Set(colors).size).toBeGreaterThan(1);
      const [lead1, lead2] = calcLeads(e, 32);
      const drawn = lineTos(ctx);
      for (const p of rectCorners(lead1, lead2, 6)) expect(drawn).toContainEqual(p);
    },
  );

  it('the resistor and pot zigzag is taller than the thermistor and ldr one', () => {
    // Pins the height split outright: the American resistor/pot peaks reach
    // ZIGZAG_HS (8) while the thermistor/ldr peaks stay at their box height
    // (6), the regression the review caught.
    const maxPeakY = (kind: string): number => {
      const e = element(kind, 0, 0, 160, 0);
      const [lead1, lead2] = calcLeads(e, 32);
      return Math.max(...zigzagPoints(lead1, lead2, zigzagHeight(kind)).map((p) => Math.abs(p.y)));
    };
    expect(maxPeakY('resistor')).toBe(ZIGZAG_HS);
    expect(maxPeakY('potentiometer')).toBe(ZIGZAG_HS);
    expect(maxPeakY('thermistor')).toBe(6);
    expect(maxPeakY('ldr')).toBe(6);
  });
});

describe('capacitor centering', () => {
  it.each([32, 48, 64, 96, 160, 224])('keeps the plates centred for length %i', (len) => {
    const cap = element('capacitor', 0, 0, len, 0);
    // 8 is the plate gap upstream's `f = (dn/2-4)/dn` produces
    // (CapacitorElm.java:100), so the leads stop 4 short of the midpoint
    // each side.
    const [lead1, lead2] = calcLeads(cap, 8);
    // The plate-gap centre is the element midpoint exactly, and both plates
    // are equidistant from it: this pins the "not 100% centered" report
    // against the interp rounding change.
    expect((lead1.x + lead2.x) / 2).toBe(len / 2);
    expect(lead2.x - len / 2).toBe(len / 2 - lead1.x);
  });
});

describe('op-amp swapped inputs', () => {
  it('opampInputSign scales with size, dsign and FLAG_SWAP', () => {
    const p1 = { x: 0, y: 0 };
    const p2 = { x: 26, y: 0 };
    expect(opampInputSign(element('opamp', 0, 0, 26, 0, 0), p1, p2)).toBe(16);
    expect(opampInputSign(element('opamp', 0, 0, 26, 0, 1), p1, p2)).toBe(-16);
    expect(opampInputSign(element('opamp', 0, 0, 26, 0, 2), p1, p2)).toBe(8);
    expect(opampInputSign(element('opamp', 0, 0, 26, 0, 3), p1, p2)).toBe(-8);
  });

  it('keeps the inverting lead on the inverting post side of the drawn body', () => {
    // The regression that catches re-hardcoding ±OPAMP_HEIGHT in the draw:
    // the first line painted is the inverting input lead, posts[0] to the
    // triangle base, and both its endpoints must sit on the post's side.
    const ctx = mkCtx();
    const op = element('opamp', 0, 0, 26, 0, 1);
    defFor('opamp')?.draw(context(ctx), op);
    const posts = postsOf(op);
    const moveTos = ctx.moveTo.mock.calls.map((a) => ({ x: a[0], y: a[1] }));
    const lineTos = ctx.lineTo.mock.calls.map((a) => ({ x: a[0], y: a[1] }));
    expect(axisSide(op, posts[0])).not.toBe(0); // sanity: post off the axis
    expect(axisSide(op, moveTos[0]) * axisSide(op, posts[0])).toBeGreaterThan(0);
    expect(axisSide(op, lineTos[0]) * axisSide(op, posts[0])).toBeGreaterThan(0);
  });
});

describe('transformer posts', () => {
  // Terminal coordinates must match upstream's getPost exactly or wires in
  // loaded circuits will not connect. These assert the corpus layouts.
  const t = (x1: number, y1: number, x2: number, y2: number, flags = 0) =>
    element('transformer', x1, y1, x2, y2, flags);

  it('places the basic secondary 32 below a horizontal primary (transformer.txt:4)', () => {
    expect(postsOf(t(272, 192, 352, 192))).toEqual([
      { x: 272, y: 192 },
      { x: 352, y: 192 },
      { x: 272, y: 224 },
      { x: 352, y: 224 },
    ]);
  });

  it('normalizes a diagonal drag to the axis, width from the drag delta (tesla.txt:5)', () => {
    // The file stores y2 = 304, off the axis; the secondary hangs at that
    // offset from the normalized horizontal body.
    expect(postsOf(t(240, 256, 320, 304, 2))).toEqual([
      { x: 240, y: 256 },
      { x: 320, y: 256 },
      { x: 240, y: 304 },
      { x: 320, y: 304 },
    ]);
  });

  it('FLAG_REVERSE swaps the secondary posts, reversing its polarity', () => {
    expect(postsOf(t(272, 192, 352, 192, 4))).toEqual([
      { x: 272, y: 192 },
      { x: 352, y: 224 },
      { x: 272, y: 224 },
      { x: 352, y: 192 },
    ]);
  });

  it('tapped secondary hangs at 32 and 64 from the axis (ringmod.txt:6)', () => {
    const el = { ...element('tappedTransformer', 144, 144, 208, 144) };
    expect(postsOf(el)).toEqual([
      { x: 144, y: 144 },
      { x: 144, y: 208 },
      { x: 208, y: 144 },
      { x: 208, y: 176 },
      { x: 208, y: 208 },
    ]);
  });

  it('tapped posts mirror onto the other side for a left-pointing body (ringmod.txt:8)', () => {
    const el = { ...element('tappedTransformer', 496, 208, 432, 208) };
    expect(postsOf(el)).toEqual([
      { x: 496, y: 208 },
      { x: 496, y: 144 },
      { x: 432, y: 208 },
      { x: 432, y: 176 },
      { x: 432, y: 144 },
    ]);
  });

  it('a custom 1,1:1 description has six posts in two columns', () => {
    const el: CircuitElement = {
      ...element('customTransformer', 160, 128, 240, 128),
      text: '1,1:1',
    };
    expect(postsOf(el)).toEqual([
      { x: 160, y: 128 },
      { x: 160, y: 160 },
      { x: 160, y: 176 },
      { x: 160, y: 208 },
      { x: 240, y: 128 },
      { x: 240, y: 208 },
    ]);
  });

  it('a malformed custom description falls back to the engine default layout', () => {
    // The engine's `new_custom` re-parses a description that fails to parse as
    // the constructor default `1,1:1`, so its post count is always six. The
    // frontend must mirror that fallback, or `set_circuit` sees the engine's
    // six posts against the frontend's zero and bricks the file.
    for (const bad of ['x:1', '0,1', '1::1', '1&1', '']) {
      const el: CircuitElement = {
        ...element('customTransformer', 160, 128, 240, 128),
        text: bad,
      };
      expect(postsOf(el)).toHaveLength(6);
    }
  });
});

describe('counter2 posts', () => {
  // Terminal coordinates must match upstream's setupPins/getPost exactly or
  // wires in loaded circuits will not connect. For bits = 4 the chip is 7
  // rows tall: CLR and LOAD sit at row bitsY+1 = 5, EnP and EnT at bitsY+2 = 6
  // (Counter2Elm.java:70-94), so on a horizontal body the row offset is 32 px
  // per row and all four land inside the 208 px bottom edge, never off-chip.
  it('places the control pins one row inside the body bottom edge', () => {
    const e = element('counter2', 0, 0, 96, 0, 0, { bits: 4 });
    expect(postsOf(e)).toEqual([
      { x: 96, y: 32 },  // Q3 (MSB)
      { x: 96, y: 64 },  // Q2
      { x: 96, y: 96 },  // Q1
      { x: 96, y: 128 }, // Q0 (LSB)
      { x: 0, y: 32 },   // I3
      { x: 0, y: 64 },   // I2
      { x: 0, y: 96 },   // I1
      { x: 0, y: 128 },  // I0
      { x: 0, y: 0 },    // clk
      { x: 0, y: 160 },  // CLR, row sizeY-2
      { x: 0, y: 192 },  // EnP, row sizeY-1
      { x: 96, y: 0 },   // RCO
      { x: 96, y: 160 }, // LOAD, row sizeY-2
      { x: 96, y: 192 }, // EnT, row sizeY-1
    ]);
  });
});

describe('full adder posts', () => {
  // Terminal coordinates must match upstream's setupPins/getPost exactly or
  // wires in loaded circuits will not connect. For bits = 2 the chip is 5
  // rows tall: A0 and B0 sit at the bottom of their west rows, the S outputs
  // two rows inside the east edge, and the carry pair closes the table as Cin
  // on the west bottom row and C on the east top row (FullAdderElm.java:
  // 47-54), so on a horizontal body the row offset is 32 px per row.
  it('orders the carry-in before the carry-out like upstream setupPins', () => {
    // The bits token only exists under FLAG_BITS (FullAdderElm.java:36), so
    // the test part must set it for the geometry to see bits = 2.
    const e = element('fullAdder', 0, 0, 96, 0, FULL_ADDER_BITS, { bits: 2 });
    expect(postsOf(e)).toEqual([
      { x: 0, y: 32 },   // A0
      { x: 0, y: 0 },    // A1
      { x: 0, y: 96 },   // B0
      { x: 0, y: 64 },   // B1
      { x: 96, y: 96 },  // S0
      { x: 96, y: 64 },  // S1
      { x: 0, y: 128 },  // Cin, post 3*bits
      { x: 96, y: 0 },   // C, post 3*bits+1
    ]);
  });
});

describe('memory chip posts', () => {
  // The address and data banks run MSB first (makeBitPins reversed), so the
  // MSB sits on the top row of its bank and A0/D0 on the bottom
  // (SRAMElm.java:120-121). For 2 bits sizeY is 3 rows.
  it('puts the SRAM WE and OE at the top and the MSBs above the LSBs', () => {
    const e = element('sram', 0, 0, 96, 0, 0, { addressBits: 2, dataBits: 2 });
    expect(postsOf(e)).toEqual([
      { x: 0, y: 0 },   // WE
      { x: 96, y: 0 },  // OE
      { x: 0, y: 32 },  // A1 (MSB)
      { x: 0, y: 64 },  // A0 (LSB)
      { x: 96, y: 32 }, // D1 (MSB)
      { x: 96, y: 64 }, // D0 (LSB)
    ]);
  });

  it('gives the ROM the single OE pin at the top-left', () => {
    const e = element('rom', 0, 0, 96, 0, 0, { addressBits: 2, dataBits: 2 });
    expect(postsOf(e)).toEqual([
      { x: 0, y: 0 },   // OE
      { x: 0, y: 32 },  // A1 (MSB)
      { x: 0, y: 64 },  // A0 (LSB)
      { x: 96, y: 32 }, // D1 (MSB)
      { x: 96, y: 64 }, // D0 (LSB)
    ]);
  });
});

describe('bus splitter posts', () => {
  it('shares one bus node and fans the individual pins down the east', () => {
    const e = element('busSplitter', 0, 0, 96, 0, 0, { bits: 2 });
    expect(postsOf(e)).toEqual([
      { x: 0, y: 0 },  // bus bit 0
      { x: 0, y: 0 },  // bus bit 1 shares the node
      { x: 96, y: 32 }, // individual 0, row bits-1
      { x: 96, y: 0 },  // individual 1, row 0
    ]);
  });
});

describe('analog mux posts', () => {
  it('places the select pins across the south and Z at the east top', () => {
    // 2 select bits means 4 inputs and a 5-row body: the selects sit at rows
    // 1 and 2 on the south edge (AnalogMuxElm.java:94), 32 px below the body
    // bottom (AnalogMuxElm.java:88).
    const e = element('analogMux', 0, 0, 96, 0, 0, { selectBitCount: 2 });
    expect(postsOf(e)).toEqual([
      { x: 0, y: 0 },   // I0
      { x: 0, y: 32 },  // I1
      { x: 0, y: 64 },  // I2
      { x: 0, y: 96 },  // I3
      { x: 64, y: 160 }, // S0
      { x: 96, y: 160 }, // S1
      { x: 128, y: 0 }, // Z
    ]);
  });
});

describe('logic gate draw paths', () => {
  const draw = (kind: string, euro: boolean, params: Record<string, number> = {}, flags = 0) => {
    const ctx = mkCtx();
    const e = element(kind, 0, 0, 96, 0, flags, params);
    defFor(kind)?.draw(context(ctx, { euroGates: euro }), e);
    return ctx;
  };
  const lineTos = (ctx: CtxStub) => ctx.lineTo.mock.calls.map((a) => ({ x: a[0], y: a[1] }));

  it.each(['andGate', 'orGate', 'xorGate', 'nandGate', 'norGate', 'xnorGate'])(
    '%s draws the IEC rectangle with the glyph inside when euroGates is on',
    (kind) => {
      const ctx = draw(kind, true);
      // The rectangle corners land as lineTo calls (the loop closes by
      // repeating the first corner), all four must be painted.
      const [lead1, lead2] = calcLeads(element(kind, 0, 0, 96, 0), 28 * 2);
      const corners = [
        interp(lead1, lead2, 0, 28),
        interp(lead1, lead2, 0, -28),
        interp(lead1, lead2, 1, -28),
        interp(lead1, lead2, 1, 28),
      ];
      const drawn = lineTos(ctx);
      for (const p of corners) expect(drawn).toContainEqual(p);
      expect(ctx.fillText).toHaveBeenCalled();
    },
  );

  it.each(['andGate', 'orGate', 'xorGate', 'inverter', 'triState', 'schmitt', 'invertingSchmitt'])(
    '%s draws its ANSI body without the IEC text when euroGates is off',
    (kind) => {
      const ctx = draw(kind, false);
      expect(ctx.fillText).not.toHaveBeenCalled();
      expect(ctx.lineTo.mock.calls.length).toBeGreaterThan(0);
    },
  );

  it('a vertical AND bulges sideways by the full hs2, not a squashed front', () => {
    // A downward AND at (0,0)-(0,96): ww = 28, hs2 = 28, leads at (0,20) and
    // (0,76). Upstream swaps the ellipse radii for dx == 0 (rx = hs2,
    // AndGateElm.java:46-49), so the arc wings reach x = +-28 at the body
    // midpoint height; an along-axis squash would leave them near the axis.
    const ctx = mkCtx();
    const gate = element('andGate', 0, 0, 0, 96);
    defFor('andGate')?.draw(context(ctx, { euroGates: false }), gate);
    const drawn = lineTos(ctx);
    expect(drawn).toContainEqual({ x: 28, y: 48 });
    expect(drawn).toContainEqual({ x: -28, y: 48 });
    // And the front still lands on the output lead.
    expect(drawn).toContainEqual({ x: 0, y: 76 });
  });
});

describe('tri-state posts and mirror', () => {
  const tri = (x1: number, y1: number, x2: number, y2: number, flags = 0) =>
    element('triState', x1, y1, x2, y2, flags);

  it('hangs the control post below a left-to-right tri-state', () => {
    // point3 = interp(lead1, lead2, .5, sign*16) with sign = -1 by default
    // (TriStateElm.java:122-123), and the port's perpendicular puts -16 below.
    expect(postsOf(tri(0, 0, 32, 0))).toEqual([
      { x: 0, y: 0 },
      { x: 32, y: 0 },
      { x: 16, y: 16 },
    ]);
  });

  it('FLAG_FLIP moves the control post above the axis', () => {
    expect(postsOf(tri(0, 0, 32, 0, 1))).toEqual([
      { x: 0, y: 0 },
      { x: 32, y: 0 },
      { x: 16, y: -16 },
    ]);
  });

  it('a horizontal mirror toggles FLAG_FLIP; the reversed orientation keeps the control side', () => {
    // The control offset is absolute (TriStateElm.java:122), so the mirror
    // must toggle the flag; on a horizontal part the reversed perpendicular
    // then cancels it, exactly as upstream's flipX + setPoints produce
    // (TriStateElm.java:319-322).
    const m = mirrorElement(tri(0, 0, 32, 0));
    expect(m.x1).toBe(32);
    expect(m.x2).toBe(0);
    expect(m.flags & 1).toBe(1);
    const mirrored = postsOf(m);
    expect(mirrored[0]).toEqual({ x: 32, y: 0 });
    expect(mirrored[1]).toEqual({ x: 0, y: 0 });
    expect(mirrored[2]).toEqual({ x: 16, y: 16 });
  });

  it('a vertical mirror moves the control to the other side', () => {
    // Downward part, control on the -x flank by default; the mirror keeps the
    // axis vertical, so toggling FLAG_FLIP swings the control to +x.
    const down = tri(16, 0, 16, 32);
    expect(postsOf(down)[2]).toEqual({ x: 0, y: 16 });
    const m = mirrorElement(down);
    expect(m.flags & 1).toBe(1);
    expect(postsOf(m)[2]).toEqual({ x: 32, y: 16 });
  });
});

describe('stem-bearing one-post symbol draw', () => {
  it('a diagonal rail centres its waveform circle on the free end', () => {
    const ctx = mkCtx();
    // WF_AC (waveform 1) is the branch that draws the circle, anchored on p2
    // (RailElm.java:55), so the diagonal stem must put the symbol at (32,32).
    defFor('rail')?.draw(context(ctx), element('rail', 0, 0, 32, 32, 0, { waveform: 1 }));
    const arcs = ctx.arc.mock.calls.map((a) => ({ x: a[0], y: a[1] }));
    expect(arcs).toContainEqual({ x: 32, y: 32 });
  });

  it('a diagonal logic input centres its bold glyph on the free end', () => {
    const ctx = mkCtx();
    defFor('logicInput')?.draw(context(ctx), element('logicInput', 0, 0, 32, 32));
    // The L/H glyph is drawn at (x2,y2) (LogicInputElm.java:79-81), which is
    // where the stem's far end lands on a diagonal placement.
    expect(ctx.fillText).toHaveBeenCalledWith('L', 32, 32);
  });
});

describe('fuse draw and the live melt state', () => {
  it('a fuse past the blown threshold draws the leads only, no body', () => {
    const ctx = mkCtx();
    FUSE_DEF.draw(context(ctx, { state: 2 }), element('fuse', 0, 0, 160, 0));
    // Two lead strokes and no sine body: the 16-segment filament polyline
    // would add a third stroke and sixteen more lineTo calls.
    expect(ctx.strokes).toHaveLength(2);
    expect(ctx.lineTo.mock.calls).toHaveLength(2);
  });

  it('an intact fuse draws the sine body, heat-tinted', () => {
    const ctx = mkCtx();
    // State 0.5 = half the i2t rating: still whole, warming toward the pop.
    FUSE_DEF.draw(context(ctx, { state: 0.5 }), element('fuse', 0, 0, 160, 0));
    expect(ctx.strokes).toHaveLength(3);
    expect(ctx.lineTo.mock.calls).toHaveLength(18); // 2 leads + 16 sine segments
    // The body is the flat heat colour of the second ramp band, not the wire
    // colour and not a per-segment gradient.
    expect(ctx.strokes[2]).toBe('rgb(255,127,0)');
  });

  it('the file still draws an intact body for a default element (state 0)', () => {
    const ctx = mkCtx();
    FUSE_DEF.draw(context(ctx), element('fuse', 0, 0, 160, 0));
    expect(ctx.strokes).toHaveLength(3);
  });
});

describe('lamp draw and the live temperature state', () => {
  const fillOf = (state: number): string => {
    const ctx = mkCtx();
    LAMP_DEF.draw(context(ctx, { state }), element('lamp', 0, 0, 160, 0));
    expect(ctx.fills).toHaveLength(1); // only the bulb disc is filled
    return ctx.fills[0];
  };

  it('fills the bulb near black at room temperature', () => {
    expect(fillOf(300)).toBe('rgb(0,0,0)');
  });

  it('fills the bulb orange at a hot filament', () => {
    expect(fillOf(1500)).toBe('rgb(255,153,0)');
  });

  it('fills the bulb white well above the top band breakpoint', () => {
    expect(fillOf(3000)).toBe('rgb(255,255,255)');
  });
});

describe('op-amp body fill', () => {
  // The triangle is filled with the panel colour only while idle: the fill is
  // a port addition upstream never paints (OpAmpElm strokes the triangle),
  // so on hover or selection it must drop out and leave the outline alone,
  // instead of turning the whole body into a solid highlight block.

  const opamp = () => element('opamp', 0, 0, 64, 0);
  const draw = (overrides: Partial<DrawContext> = {}) => {
    const ctx = mkCtx();
    OPAMP_DEF.draw(context(ctx, overrides), opamp());
    return ctx;
  };

  it('fills the triangle in the panel colour when idle', () => {
    expect(draw().fills).toEqual([makeTheme().panel]);
  });

  it('drops the triangle fill on hover, keeping the highlighted outline', () => {
    const ctx = draw({ hovered: true });
    expect(ctx.fills).toEqual([]);
    expect(ctx.strokes).toContain(makeTheme().highlight);
  });

  it('drops the triangle fill when selected, keeping the selection outline', () => {
    const ctx = draw({ selected: true });
    expect(ctx.fills).toEqual([]);
    expect(ctx.strokes).toContain(makeTheme().selection);
  });

  it('drops the triangle fill on the shift-highlighted net', () => {
    expect(draw({ onHighlightedNet: true }).fills).toEqual([]);
  });
});

describe('lamp bulb fill on highlight', () => {
  const lamp = () => element('lamp', 0, 0, 160, 0);
  const draw = (overrides: Partial<DrawContext> = {}) => {
    const ctx = mkCtx();
    LAMP_DEF.draw(context(ctx, { state: 2000, ...overrides }), lamp());
    return ctx;
  };

  it('keeps the temperature fill while idle', () => {
    const ctx = draw();
    expect(ctx.fills).toHaveLength(1); // only the bulb disc is filled
    expect(ctx.fills[0]).toBe('rgb(255,255,109)');
  });

  it('drops the disc fill on hover, keeping the highlighted outline', () => {
    const ctx = draw({ hovered: true });
    expect(ctx.fills).toEqual([]);
    expect(ctx.strokes).toContain(makeTheme().highlight);
  });

  it('drops the disc fill when selected, keeping the selection outline', () => {
    const ctx = draw({ selected: true });
    expect(ctx.fills).toEqual([]);
    expect(ctx.strokes).toContain(makeTheme().selection);
  });
});

describe('three-phase motor body fill', () => {
  // The outer body and the hub are filled discs while idle; on hover or
  // selection the fills drop out and the two circles read as outlines.

  const motor = () => element('threePhaseMotor', 0, 0, 144, 0);
  const draw = (overrides: Partial<DrawContext> = {}) => {
    const ctx = mkCtx();
    THREE_PHASE_MOTOR_DEF.draw(
      context(ctx, { voltages: [0, 0, 0, 0, 0, 0], ...overrides }),
      motor(),
    );
    return ctx;
  };

  it('fills the outer body and the hub while idle', () => {
    expect(draw().fills).toHaveLength(2);
  });

  it('drops both fills on hover, keeping the highlighted outlines', () => {
    const ctx = draw({ hovered: true });
    expect(ctx.fills).toEqual([]);
    expect(ctx.strokes).toContain(makeTheme().highlight);
  });

  it('drops both fills when selected, keeping the selection outlines', () => {
    const ctx = draw({ selected: true });
    expect(ctx.fills).toEqual([]);
    expect(ctx.strokes).toContain(makeTheme().selection);
  });
});

describe('the switch placement chars', () => {
  it('s arms the SPST and S the SPDT, each bound exactly once', () => {
    // The map is keyed by char and last write wins, so a duplicate shortcut
    // would silently re-arm a key to the later def or toolbox entry. The
    // s/S pair is the one the owner reported on, so pin both the binding and
    // the declaration count; either failing would re-arm 's' behind the
    // matcher's back.
    expect(PLACEMENT_BY_CHAR.get('s')).toBe('switch');
    expect(PLACEMENT_BY_CHAR.get('S')).toBe('switch2');
    const declared = (ch: string): number =>
      [...ELEMENT_DEFS, ...TOOLBOX].filter((d) => d.shortcut === ch).length;
    expect(declared('s')).toBe(1);
    expect(declared('S')).toBe(1);
  });
});

describe('multi-post elements stay on the 90-degree axis', () => {
  // A fresh element with the def's defaults and flags, the state a toolbar
  // placement hands the geometry, so posts() and postCountOf() see real
  // params and not the empty default object.
  const fresh = (def: ElementDef): CircuitElement =>
    element(def.kind, 0, 0, 32, 0, def.defaultFlags ?? 0, { ...(def.defaults ?? {}) });

  // The owner's rule covers every element with more than two connectable
  // terminals. The one-post stems (ground, rail, logic inputs, antenna, am,
  // fm, audioOutput, audioInput, dataInput, noise, sweep, extVoltage,
  // varRail, probe, box, line, decoration) hang their symbol off x2,y2
  // instead of a terminal, so they count two or fewer posts here and drop out
  // of the sweep.
  const MULTI_POST = ELEMENT_DEFS.filter((d) => postCountOf(fresh(d)) > 2);

  it.each(MULTI_POST)('place %s diagonally snaps to the dominant axis', (def) => {
    // The canvas place drag runs exactly this: the far end snaps to the grid,
    // then an axis-locked element snaps to the dominant axis
    // (useCanvasInteractions.ts, CircuitElm.java:560-566).
    const e = fresh(def);
    const anchor = { x: 0, y: 0 };
    let x2 = snap(32, GRID_SIZE);
    let y2 = snap(32, GRID_SIZE);
    if (axisConstrained(e)) {
      const snapped = dominantAxisSnap(anchor, x2, y2);
      x2 = snapped.x;
      y2 = snapped.y;
    }
    const placed = { ...e, x2, y2 };
    expect(placed.x1 === placed.x2 || placed.y1 === placed.y2).toBe(true);
  });

  it.each(MULTI_POST)('moving a placed %s keeps it on the 90-degree axis', (def) => {
    // Place axis-aligned, then drag the far endpoint to a diagonal grid point,
    // the free-end move after placement that used to leave the element
    // off-axis. The canvas dragpost constrains an axis-locked part to stretch
    // only along its body (CircuitElm.java:661-666); the axis and the grid
    // alignment of the posts must both survive.
    const e = fresh(def);
    let x = snap(32, GRID_SIZE);
    let y = snap(32, GRID_SIZE);
    if (axisConstrained(e)) {
      const constrained = constrainPostDrag(e, 2, x, y);
      x = constrained.x;
      y = constrained.y;
    }
    const moved = { ...e, x2: x, y2: y };
    expect(moved.x1 === moved.x2 || moved.y1 === moved.y2).toBe(true);
    for (const p of postsOf(moved)) {
      expect(Number.isInteger(p.x) && Number.isInteger(p.y), `${def.kind} post`).toBe(true);
    }
  });
});

describe('wattmeter geometry', () => {
  const watt = (width: number, flags = 0): CircuitElement =>
    element('wattmeter', 0, 0, 64, 0, flags, { width, meter: 0 });

  it('posts match upstream setPoints for a horizontal body', () => {
    // ds = sign(dx) = +1 for a left-to-right body, so the bottom stubs are
    // -width below the axis and the posts order is p3, p4, point1, point2
    // (WattmeterElm.java:95-114).
    expect(postsOf(watt(32))).toEqual([
      { x: 0, y: 32 },
      { x: 64, y: 32 },
      { x: 0, y: 0 },
      { x: 64, y: 0 },
    ]);
  });

  it('posts keep the stored width for a vertical body', () => {
    // ds = -sign(dy) = -1 for a body drawn downward, so the stubs sit at
    // +width to the right of the axis.
    const e = element('wattmeter', 0, 0, 0, 64, 0, { width: 16, meter: 0 });
    expect(postsOf(e)).toEqual([
      { x: 16, y: 0 },
      { x: 16, y: 64 },
      { x: 0, y: 0 },
      { x: 0, y: 64 },
    ]);
  });

  it('dragParams takes the weaker drag component as the width', () => {
    const def = defFor('wattmeter');
    // A mostly-horizontal drag: the horizontal component is the axis, the
    // vertical one the width.
    expect(def?.dragParams?.({ x: 0, y: 0 }, { x: 160, y: 32 })).toEqual({ width: 32 });
    // A mostly-vertical drag: the vertical component is the axis.
    expect(def?.dragParams?.({ x: 0, y: 0 }, { x: 32, y: 160 })).toEqual({ width: 32 });
    // A pure axis drag has no perpendicular component; the grid-size floor
    // applies (WattmeterElm.java:78-79).
    expect(def?.dragParams?.({ x: 0, y: 0 }, { x: 0, y: 160 })).toEqual({ width: 16 });
  });
});

describe('batch I instrument draws', () => {
  const draw = (kind: string, overrides: Partial<DrawContext> = {}, e?: CircuitElement) => {
    const ctx = mkCtx();
    defFor(kind)?.draw(
      context(ctx, overrides),
      e ?? element(kind, 0, 0, 64, 0, 0, kind === 'wattmeter' ? { width: 16, meter: 0 } : {}),
    );
    return ctx;
  };

  const texts = (ctx: CtxStub): string[] => ctx.fillText.mock.calls.map((c) => String(c[0]));

  it('ohmmeter draws the Ω circle and the reading caption only under current', () => {
    const running = draw('ohmmeter', { current: 0.01, value: 4700, showValues: true });
    expect(running.arc).toHaveBeenCalled();
    expect(texts(running)).toContain('Ω');
    expect(texts(running)).toContain('4.7k');
    const idle = draw('ohmmeter', { current: 0, value: Number.POSITIVE_INFINITY, showValues: true });
    expect(texts(idle)).not.toContain('4.7k');
  });

  it('test point draws the label and the selected value', () => {
    const ctx = draw(
      'testPoint',
      { value: 7.07 },
      element('testPoint', 0, 0, 64, 0, 0, { meter: 1 }),
    );
    expect(texts(ctx)).toContain('TP');
    expect(texts(ctx)).toContain('7.1V(rms)');
  });

  it('test point with a custom label draws it', () => {
    const ctx = draw(
      'testPoint',
      { value: 0 },
      { ...element('testPoint', 0, 0, 64, 0, 1, { meter: 3 }), text: 'SIG' },
    );
    expect(texts(ctx)).toContain('SIG');
  });

  it('test point file-only meter modes draw their upstream units', () => {
    // The UI only offers meters 0,1,10,2,3,4,5, but a loaded file can carry
    // 6 (FRQ), 7 (PER), 8 (PWI) or 9 (DUT). Upstream draws Hz, seconds and a
    // bare duty-cycle number; TP_PER leaves the value string unset
    // (TestPointElm.java:201-213), so it keeps the plain V fallback.
    const frq = draw(
      'testPoint',
      { value: 1000 },
      element('testPoint', 0, 0, 64, 0, 0, { meter: 6 }),
    );
    expect(texts(frq)).toContain('1kHz');
    const pwi = draw(
      'testPoint',
      { value: 0.002 },
      element('testPoint', 0, 0, 64, 0, 0, { meter: 8 }),
    );
    expect(texts(pwi)).toContain('2ms');
    const dut = draw(
      'testPoint',
      { value: 0.5 },
      element('testPoint', 0, 0, 64, 0, 0, { meter: 9 }),
    );
    expect(texts(dut)).toContain('500m');
    const per = draw(
      'testPoint',
      { value: 0.002 },
      element('testPoint', 0, 0, 64, 0, 0, { meter: 7 }),
    );
    expect(texts(per)).toContain('2mV');
  });

  it('wattmeter draws its rectangle body and the power text', () => {
    const ctx = draw('wattmeter', { value: 0.5 });
    expect(texts(ctx)).toContain('500mW');
    // The rectangle body is a stroked closed quad: four stub leads plus the
    // four-segment body polyline.
    expect(ctx.strokes.length).toBeGreaterThan(4);
  });

  it('data recorder draws the export label at the free end', () => {
    const ctx = draw('dataRecorder', {});
    expect(texts(ctx)).toContain('export');
  });

  it('stop trigger draws the trigger label and highlights while stopped', () => {
    const idle = draw('stopTrigger', {});
    expect(texts(idle)).toContain('trigger');
    const stopped = draw('stopTrigger', { state: 1 });
    expect(stopped.strokes).toContain(makeTheme().selection);
  });
});

describe('batch E electromechanical draws', () => {
  const draw = (kind: string, overrides: Partial<DrawContext> = {}, e?: CircuitElement) => {
    const ctx = mkCtx();
    defFor(kind)?.draw(
      context(ctx, overrides),
      e ?? element(kind, 0, 0, 96, 0, 0, kind === 'timeDelayRelay' ? {} : { position: 0 }),
    );
    return ctx;
  };

  const lineTos = (ctx: CtxStub): { x: number; y: number }[] =>
    ctx.lineTo.mock.calls.map((a) => ({ x: a[0], y: a[1] }));

  it('the DC motor draws a grey body, a dark hub and three spokes', () => {
    const ctx = draw('dcMotor', { voltages: [0, 0] }, element('dcMotor', 0, 0, 96, 0, 0, { K: 0.15 }));
    // Two filled discs (body and hub) when idle, plus the three spoke lines
    // and the two leads.
    expect(ctx.fills).toHaveLength(2);
    expect(ctx.lineTo.mock.calls.length).toBeGreaterThanOrEqual(5);
  });

  it('the DC motor drops its fills on hover like the three-phase motor', () => {
    const ctx = draw('dcMotor', { hovered: true });
    expect(ctx.fills).toEqual([]);
  });

  it('the DC motor rotates its spokes with the live angle', () => {
    // The spoke lines move with the engine's display_state (the angle); two
    // different angles must paint different spoke endpoints.
    const a = draw('dcMotor', { state: 0 });
    const b = draw('dcMotor', { state: 1.5 });
    expect(lineTos(a)).not.toEqual(lineTos(b));
  });

  it('the time delay relay draws the chip housing and its four pin labels', () => {
    const ctx = draw('timeDelayRelay', {}, element('timeDelayRelay', 0, 0, 96, 0, 0, {}));
    const texts = ctx.fillText.mock.calls.map((c) => String(c[0]));
    expect(texts).toContain('Vin');
    expect(texts).toContain('gnd');
    expect(texts).toContain('in');
    expect(texts).toContain('out');
    // The housing is a stroked closed quad plus the four pin stubs.
    expect(ctx.strokes.length).toBeGreaterThan(4);
  });

  it('the MBB draws both levers in the make-before-break positions', () => {
    // Position 1 (both) paints the lever to both throws; position 0 (pole A
    // only) paints only the first.
    const both = draw('mbbSwitch', {}, element('mbbSwitch', 0, 0, 96, 0, 0, { position: 1 }));
    const single = draw('mbbSwitch', {}, element('mbbSwitch', 0, 0, 96, 0, 0, { position: 0 }));
    // The contact stroke is one line per lever: both has one more thick lever
    // stroke than single.
    expect(both.strokes.length).toBe(single.strokes.length + 1);
  });

  it('the DPDT draws a lever per pole and the ganged line between poles', () => {
    const ctx = draw('dpdtSwitch', {}, element('dpdtSwitch', 0, 0, 96, 0, 0, { poleCount: 2 }));
    // Two poles each draw their own lever and leads; the ganged line uses the
    // dashed setLineDash call, so that path ran.
    expect(ctx.setLineDash).toHaveBeenCalled();
  });

  it('the DPDT pole posts sit at 48-unit offsets with throws at ±16', () => {
    const e = element('dpdtSwitch', 0, 0, 96, 0, 0, { poleCount: 2 });
    // Positive perpendicular is up on screen, so the poles stack downward at
    // (0,0) and (0,48) and pole 1's throws at +64/+32, the upstream offsets
    // `-i*48` and `offset ± 16` (DPDTSwitchElm.java:89-95).
    expect(postsOf(e)).toEqual([
      { x: 0, y: 0 }, // pole 0
      { x: 96, y: 16 },
      { x: 96, y: -16 },
      { x: 0, y: 48 }, // pole 1
      { x: 96, y: 64 },
      { x: 96, y: 32 },
    ]);
  });

  it('the MBB posts put the common pole first and throws at ±16', () => {
    const e = element('mbbSwitch', 0, 0, 96, 0);
    expect(postsOf(e)).toEqual([
      { x: 0, y: 0 },
      { x: 96, y: -16 },
      { x: 96, y: 16 },
    ]);
  });
});

describe('batch C composite draws and posts', () => {
  const draw = (kind: string, overrides: Partial<DrawContext> = {}, e?: CircuitElement) => {
    const ctx = mkCtx();
    defFor(kind)?.draw(context(ctx, overrides), e ?? element(kind, 0, 0, 96, 0));
    return ctx;
  };

  it('the comparator posts put V- and V+ on the input sides and the output last', () => {
    // Default size 2 gives the 16-unit half separation, plus signs negated by
    // FLAG_SWAP (ComparatorElm.java:34-39, 77-79, 86-88).
    const e = element('comparator', 0, 0, 96, 0);
    expect(postsOf(e)).toEqual([
      { x: 0, y: -16 },
      { x: 0, y: 16 },
      { x: 96, y: 0 },
    ]);
    expect(postsOf(element('comparator', 0, 0, 96, 0, 2))).toEqual([
      { x: 0, y: -8 },
      { x: 0, y: 8 },
      { x: 96, y: 0 },
    ]);
    // FLAG_SWAP (bit 4) swaps which input hangs where.
    expect(postsOf(element('comparator', 0, 0, 96, 0, 4))).toEqual([
      { x: 0, y: 16 },
      { x: 0, y: -16 },
      { x: 96, y: 0 },
    ]);
  });

  it('the comparator draws its triangle, glyphs and ≥? caption', () => {
    const ctx = draw('comparator');
    const texts = ctx.fillText.mock.calls.map((c) => String(c[0]));
    expect(texts).toContain('−');
    expect(texts).toContain('+');
    expect(texts).toContain('≥?');
  });

  it('the comparator minus glyph stays on the V- post side under FLAG_SWAP', () => {
    // The glyphs sit at `interpPoint2(lead1, lead2, .2, hs*sgn)` where hs is
    // already negated by the swap (ComparatorElm.java:77-80), so they must
    // track the swapped V- post. The old extra `* sgn` cancelled the swap and
    // drew the minus on the V+ side.
    const minusGlyph = (flags: number): Point => {
      const ctx = mkCtx();
      const e = element('comparator', 0, 0, 96, 0, flags);
      defFor('comparator')?.draw(context(ctx), e);
      const call = ctx.fillText.mock.calls.find((c) => c[0] === '−');
      expect(call).toBeDefined();
      return { x: call![1] as number, y: call![2] as number };
    };
    const post = postsOf(element('comparator', 0, 0, 96, 0))[0];
    const postSwapped = postsOf(element('comparator', 0, 0, 96, 0, 4))[0];
    const glyph = minusGlyph(0);
    const glyphSwapped = minusGlyph(4);
    expect(axisSide(element('comparator', 0, 0, 96, 0), glyph) * axisSide(element('comparator', 0, 0, 96, 0), post)).toBeGreaterThan(0);
    expect(axisSide(element('comparator', 0, 0, 96, 0), glyphSwapped) * axisSide(element('comparator', 0, 0, 96, 0), postSwapped)).toBeGreaterThan(0);
    // The swap moved both the post and the glyph to the other side together.
    expect(glyph.y * glyphSwapped.y).toBeLessThan(0);
  });

  it('the realistic op-amp rail posts sit at the far rail end, not the inner one', () => {
    // Posts 3/4 are the outer rail ends, `rail1p[0] = interpPoint2(lead1,
    // lead2, railPos, hs*2)` at 32 px from the axis; the inner point
    // `hs*2*(1-railPos)` is only the lead target drawn inward from it
    // (OpAmpRealElm.java:236-238, 247-248). On a 96 px body railPos = 0.5, so
    // the rails land on the body midpoint at +/-32, the exact coordinates the
    // old sign-only test could not distinguish from the +/-16 inner pair.
    const e = element('opampReal', 0, 0, 96, 0);
    expect(postsOf(e)).toEqual([
      { x: 0, y: -16 },  // V-
      { x: 0, y: 16 },   // V+
      { x: 96, y: 0 },   // out
      { x: 48, y: -32 }, // V+ supply, the far outer rail end
      { x: 48, y: 32 },  // V- supply
    ]);
    // FLAG_SWAP (bit 1) moves the minus side and with it the rail pair.
    expect(postsOf(element('opampReal', 0, 0, 96, 0, 2))).toEqual([
      { x: 0, y: 16 },
      { x: 0, y: -16 },
      { x: 96, y: 0 },
      { x: 48, y: 32 },
      { x: 48, y: -32 },
    ]);
  });

  it('the optocoupler posts sit at the four fixed chip corners', () => {
    // A fixed 2x2 body anchored at point1 (OptocouplerElm.java:125-148).
    const e = element('optocoupler', 80, 64, 208, 64);
    expect(postsOf(e)).toEqual([
      { x: 80, y: 64 },
      { x: 80, y: 96 },
      { x: 176, y: 64 },
      { x: 176, y: 96 },
    ]);
    // FLAG_FLIP_X (1<<10) mirrors the body about the point1+32 axis.
    const flipped = element('optocoupler', 80, 64, 208, 64, 1 << 10);
    expect(postsOf(flipped)).toEqual([
      { x: 176, y: 64 },
      { x: 176, y: 96 },
      { x: 80, y: 64 },
      { x: 80, y: 96 },
    ]);
  });

  it('the crystal posts are exactly the two endpoints', () => {
    const e = element('crystal', 80, 64, 208, 64);
    expect(postsOf(e)).toEqual([
      { x: 80, y: 64 },
      { x: 208, y: 64 },
    ]);
  });

  it('the four composites draw without throwing', () => {
    for (const kind of ['comparator', 'opampReal', 'optocoupler', 'crystal']) {
      expect(() => draw(kind)).not.toThrow();
    }
  });
});
