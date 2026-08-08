import { describe, expect, it, vi } from 'vitest';
import { calcLeads, makeTheme, rectCorners, ZIGZAG_HS, zigzagPoints } from '../render/draw';
import {
  ELEMENT_DEFS,
  defFor,
  opAmpInputAnchors,
  opAmpLabelAnchors,
  opampInputSign,
  postsOf,
  transistorBarContacts,
} from './registry';
import { mirrorElement } from './transform';
import { DIODE_DEF } from './registry/elements/diode';
import { ZENER_DEF } from './registry/elements/zener';
import type { CircuitElement, DrawContext, Point } from './types';

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
  beginPath: ReturnType<typeof vi.fn>;
  moveTo: ReturnType<typeof vi.fn>;
  lineTo: ReturnType<typeof vi.fn>;
  stroke: ReturnType<typeof vi.fn>;
  arc: ReturnType<typeof vi.fn>;
  fill: ReturnType<typeof vi.fn>;
  closePath: ReturnType<typeof vi.fn>;
  fillText: ReturnType<typeof vi.fn>;
}

/** Minimal canvas stub, recording geometry calls so a draw can be asserted on. */
const mkCtx = (): CtxStub => {
  return {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    lineCap: '',
    lineJoin: '',
    font: '',
    textAlign: '',
    textBaseline: '',
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    closePath: vi.fn(),
    fillText: vi.fn(),
  };
};

const context = (ctx: CtxStub, overrides: Partial<DrawContext> = {}): DrawContext => ({
  ctx: ctx as unknown as CanvasRenderingContext2D,
  theme: makeTheme(),
  voltages: [0, 0, 0],
  current: 1e-3,
  voltage: 0,
  power: 0,
  value: 0,
  dotPhase: 0,
  showCurrent: false,
  showValues: false,
  showVoltageColor: false,
  showPowerColor: false,
  conventional: true,
  euroResistors: true,
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
      'forwardVoltage',
      'seriesResistance',
      'emissionCoefficient',
      'breakdownVoltage',
    ]);
  });

  it('copies the diode field definitions exactly, in the diode order', () => {
    expect(ZENER_DEF.fields).toHaveLength((DIODE_DEF.fields ?? []).length + 1);
    for (let i = 0; i < (DIODE_DEF.fields ?? []).length; i++) {
      expect(ZENER_DEF.fields?.[i]).toEqual(DIODE_DEF.fields?.[i]);
    }
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
        // A text or keyShortcut field is bound to a top-level field of
        // `e` (e.text / e.keyShortcut), not to a param, so there is nothing
        // in parse/dump/defaults for it to match.
        if (f.target === 'text' || f.target === 'keyShortcut') continue;
        // A flag field is bound to a bit of `e.flags`, not to a param, so
        // there is nothing in parse/dump/defaults for it to match.
        if (f.flag !== undefined) continue;
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
    expect(axisSide(m, inPost)).toBeGreaterThan(0);  // sanity: post off the axis
    expect(axisSide(m, inLead) * axisSide(m, inPost)).toBeGreaterThan(0);
    expect(axisSide(m, minus) * axisSide(m, inPost)).toBeGreaterThan(0);
  });

  it('keeps the transistor collector and emitter leads on their posts side', () => {
    const t = element('transistor', 0, 0, 160, 0, 0, { pnp: 1 });
    const m = mirrorElement(t);
    const posts = postsOf(m);
    const [collLead, emitLead] = transistorBarContacts(m);
    expect(axisSide(m, posts[1])).toBeGreaterThan(0);  // sanity: collector off the axis
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
  it.each([32, 48, 64, 96, 160, 224])(
    'keeps the plates centred for length %i',
    (len) => {
      const cap = element('capacitor', 0, 0, len, 0);
      const [lead1, lead2] = calcLeads(cap, 6);
      // The plate-gap centre is the element midpoint exactly, and both plates
      // are equidistant from it: this pins the "not 100% centered" report
      // against the interp rounding change.
      expect((lead1.x + lead2.x) / 2).toBe(len / 2);
      expect(lead2.x - len / 2).toBe(len / 2 - lead1.x);
    },
  );
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
    expect(axisSide(op, posts[0])).not.toBe(0);  // sanity: post off the axis
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
