import {
  COIL_LOOPS,
  currentDots,
  dsign,
  endpoints,
  gradientCoil,
  interp,
  lead,
  line,
  voltageColor,
} from '../../../render/draw';
import {
  IND_BACK_EULER,
  TAPPED_FLIP,
  TRANSFORMER_FLIP,
  TRANSFORMER_REVERSE,
  TRANSFORMER_VERTICAL,
} from '../flags';
import { readParams, boxOfPoints } from '../shared';
import type { CircuitElement, DrawContext, ElementDef, Point } from '../../types';

const WIDTH = 32;  // primary/secondary spacing (TransformerElm.java:38, CustomTransformerElm.java:51)

// ─── Basic transformer (T) ────────────────────────────────────────────────────

interface BasicGeometry {
  p1: Point;
  p2: Point;
  ptEnds: Point[];
  ptCoil: Point[];
  ptCore: Point[];
  dots: Point[] | null;
  width: number;
  flip: number;
  d: number;
  vertical: boolean;
}

/** Port of TransformerElm.setPoints (:150-183). The axis is horizontal unless
 *  FLAG_VERTICAL is set; width is the perpendicular secondary offset, stored
 *  as the drag delta in the file. A vertical transformer is always stored with
 *  FLAG_VERTICAL, but a freshly placed one has no flags, so `x1 == x2` stands
 *  in for it. Under FLAG_REVERSE the secondary's two posts swap, which is what
 *  reverses its polarity in the circuit. */
function basicGeometry(e: CircuitElement): BasicGeometry {
  const [p1, raw] = endpoints(e);
  const vertical =
    (e.flags & TRANSFORMER_VERTICAL) !== 0 || (p1.x === raw.x && p1.y !== raw.y);
  let width: number;
  let p2: Point;
  if (vertical) {
    width = -Math.max(WIDTH, Math.abs(raw.x - p1.x));
    p2 = { x: p1.x, y: raw.y };
  } else {
    width = Math.max(WIDTH, Math.abs(raw.y - p1.y));
    p2 = { x: raw.x, y: p1.y };
  }
  const d = dsign(p1, p2);
  const flip = (e.flags & TRANSFORMER_FLIP) !== 0 ? -1 : 1;
  const off = -d * width * flip;
  const ptEnds = [p1, p2, interp(p1, p2, 0, off), interp(p1, p2, 1, off)];
  const dn = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  const ce = 0.5 - 12 / dn;
  const cd = 0.5 - 2 / dn;
  const ptCoil: Point[] = [];
  const ptCore: Point[] = [];
  for (let i = 0; i < 4; i += 2) {
    ptCoil[i] = interp(ptEnds[i], ptEnds[i + 1], ce);
    ptCoil[i + 1] = interp(ptEnds[i], ptEnds[i + 1], 1 - ce);
    ptCore[i] = interp(ptEnds[i], ptEnds[i + 1], cd);
    ptCore[i + 1] = interp(ptEnds[i], ptEnds[i + 1], 1 - cd);
  }
  let dots: Point[] | null = null;
  if ((e.flags & TRANSFORMER_REVERSE) !== 0) {
    // Phase dots on the reversed secondary, and the secondary post swap that
    // flips its polarity in the circuit (TransformerElm.java:173-183).
    const vsign = vertical ? -1 : 1;
    const dotp = Math.abs(7 / width);
    dots = [
      interp(ptCoil[0], ptCoil[2], dotp, -7 * d * vsign * flip),
      interp(ptCoil[3], ptCoil[1], dotp, -7 * d * vsign * flip),
    ];
    const x = ptEnds[1];
    ptEnds[1] = ptEnds[3];
    ptEnds[3] = x;
    const y = ptCoil[1];
    ptCoil[1] = ptCoil[3];
    ptCoil[3] = y;
  }
  return { p1, p2, ptEnds, ptCoil, ptCore, dots, width, flip, d, vertical };
}

const basicPosts = (e: CircuitElement): Point[] => basicGeometry(e).ptEnds;

/** The coil arcs between the core bars, alternating the bulge side per
 *  winding like upstream's `drawCoil` csign (TransformerElm.java:126-132). The
 *  ramp follows the winding's own two terminal voltages, `v0`/`v1`, in the
 *  order the `csign` swap draws them: the from/to flip that reverses the coil
 *  direction reverses the gradient too. Each loop strokes as its own arc with
 *  flat ends (`gradientCoil`), so the semicircles read as distinct primitives. */
function drawCoilBetween(g: DrawContext, a: Point, b: Point, csign: number, v0: number, v1: number): void {
  const [from, to] = csign > 0 ? [a, b] : [b, a];
  const [vf, vt] = csign > 0 ? [v0, v1] : [v1, v0];
  gradientCoil(g, from, to, COIL_LOOPS, { v0: vf, v1: vt });
}

function drawBasicTransformer(g: DrawContext, e: CircuitElement): void {
  const geo = basicGeometry(e);
  const { ptEnds, ptCoil, ptCore, dots, d, flip, vertical } = geo;
  const polarity = (e.flags & TRANSFORMER_REVERSE) !== 0 ? -1 : 1;

  for (let i = 0; i < 4; i++) {
    lead(g, ptEnds[i], ptCoil[i], voltageColor(g, g.voltages[i]));
  }
  for (let i = 0; i < 2; i++) {
    let csign = d * (i === 1 ? -6 * polarity : 6) * flip;
    if (vertical) csign *= -1;
    // Winding i spans posts i and i+2 (its own coil, not the element's axis).
    drawCoilBetween(g, ptCoil[i], ptCoil[i + 2], csign, g.voltages[i], g.voltages[i + 2]);
  }
  line(g, ptCore[0], ptCore[2], g.theme.text);
  line(g, ptCore[1], ptCore[3], g.theme.text);
  if (dots !== null) {
    g.ctx.fillStyle = g.theme.text;
    for (const dot of dots) {
      g.ctx.beginPath();
      g.ctx.arc(dot.x, dot.y, 2, 0, Math.PI * 2);
      g.ctx.fill();
    }
  }
  currentDots(g, ptEnds[0], ptCoil[0], g.current);
  currentDots(g, ptCoil[2], ptEnds[2], g.current);
}

export const TRANSFORMER_DEF: ElementDef = {
  kind: 'transformer',
  label: 'Transformer',
  category: 'Basics',
  dumpCode: 'T',
  shortcut: 'T',  // TransformerElm.java
  postCount: 4,
  posts: basicPosts,
  noDiagonal: true,  // TransformerElm.java:40
  canMirror: true,
  defaults: {
    inductance: 4,
    ratio: 1,
    current0: 0,
    current1: 0,
    couplingCoef: 0.999,
    saturationCurrent: 0,
  },
  // The optional couplingCoef and saturationCurrent tokens are deleted when
  // absent, so a short line round-trips without inventing tokens, exactly like
  // the transistor's optional model name. Upstream's own dump() writes the
  // full list, which is what a fresh element saves.
  parse: (t, e) => {
    readParams(t, e, ['inductance', 'ratio', 'current0', 'current1']);
    if (t[4] !== undefined) e.params.couplingCoef = Number(t[4]);
    else delete e.params.couplingCoef;
    if (t[5] !== undefined) e.params.saturationCurrent = Number(t[5]);
    else delete e.params.saturationCurrent;
  },
  dump: (e) => {
    const out: (string | number)[] = [
      e.params.inductance ?? 4,
      e.params.ratio ?? 1,
      e.params.current0 ?? 0,
      e.params.current1 ?? 0,
    ];
    if (e.params.couplingCoef !== undefined) out.push(e.params.couplingCoef);
    if (e.params.saturationCurrent !== undefined) out.push(e.params.saturationCurrent);
    return out;
  },
  fields: [
    { name: 'inductance', label: 'Primary inductance', unit: 'H' },
    { name: 'ratio', label: 'Turns ratio (N2/N1)' },
    { name: 'couplingCoef', label: 'Coupling coefficient', min: 0, max: 1 },
    { name: 'saturationCurrent', label: 'Saturation current (0 = none)', unit: 'A' },
    { name: 'backEuler', label: 'Backward Euler', type: 'bool', flag: IND_BACK_EULER },
    { name: 'reverse', label: 'Swap secondary polarity', type: 'bool', flag: TRANSFORMER_REVERSE },
  ],
  // The two windings and the core bars span the four corner posts, the whole
  // symbol a solid pick zone (TransformerElm.java:147).
  bodyRect: (e) => boxOfPoints(basicGeometry(e).ptEnds),
  draw: drawBasicTransformer,
};

// ─── Tapped transformer (169) ─────────────────────────────────────────────────

function tappedPosts(e: CircuitElement): Point[] {
  const [p1, p2] = endpoints(e);
  const flip = (e.flags & TAPPED_FLIP) !== 0 ? -1 : 1;
  const hs = WIDTH * flip;
  // Port of TappedTransformerElm.setPoints (:131-156): the primary spans posts
  // 0-1 on the axis, the secondary hangs posts 2-3-4 at 32 and 64 units.
  return [
    p1,
    interp(p1, p2, 0, -hs * 2),
    p2,
    interp(p1, p2, 1, -hs),
    interp(p1, p2, 1, -hs * 2),
  ];
}

function drawTappedTransformer(g: DrawContext, e: CircuitElement): void {
  const [p1, p2] = endpoints(e);
  const flip = (e.flags & TAPPED_FLIP) !== 0 ? -1 : 1;
  const hs = WIDTH * flip;
  const ptEnds = tappedPosts(e);
  const dn = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  const ce = 0.5 - 12 / dn;
  const cd = 0.5 - 2 / dn;
  const ptCoil = [
    interp(p1, p2, ce, 0),
    interp(p1, p2, ce, -hs * 2),
    interp(p1, p2, 1 - ce, 0),
    interp(p1, p2, 1 - ce, -hs),
    interp(p1, p2, 1 - ce, -hs * 2),
  ];
  const ptCore = [
    interp(p1, p2, cd, 0),
    interp(p1, p2, cd, -hs * 2),
    interp(p1, p2, 1 - cd, 0),
    interp(p1, p2, 1 - cd, -hs * 2),
  ];

  for (let i = 0; i < 5; i++) {
    lead(g, ptEnds[i], ptCoil[i], voltageColor(g, g.voltages[i]));
  }
  for (let i = 0; i < 4; i++) {
    if (i === 1) continue;  // the tap has no coil of its own (TappedTransformerElm.java:102-103)
    // Each coil spans its own adjacent post pair.
    drawCoilBetween(g, ptCoil[i], ptCoil[i + 1], i > 1 ? -6 * flip : 6 * flip, g.voltages[i], g.voltages[i + 1]);
  }
  line(g, ptCore[0], ptCore[1], g.theme.text);
  line(g, ptCore[2], ptCore[3], g.theme.text);
  currentDots(g, ptEnds[0], ptCoil[0], g.current);
  currentDots(g, ptCoil[1], ptEnds[1], g.current);
}

export const TAPPED_TRANSFORMER_DEF: ElementDef = {
  kind: 'tappedTransformer',
  label: 'Tapped transformer',
  category: 'Basics',
  dumpCode: '169',
  postCount: 5,
  posts: tappedPosts,
  noDiagonal: true,  // TappedTransformerElm.java:51
  canMirror: true,
  defaults: {
    inductance: 4,
    ratio: 1,
    current0: 0,
    current1: 0,
    current2: 0,
    couplingCoef: 0.99,
  },
  // The current2 and couplingCoef tokens are optional; deleting them when
  // absent keeps a four-token ringmod line at four tokens.
  parse: (t, e) => {
    readParams(t, e, ['inductance', 'ratio', 'current0', 'current1']);
    if (t[4] !== undefined) e.params.current2 = Number(t[4]);
    else delete e.params.current2;
    if (t[5] !== undefined) e.params.couplingCoef = Number(t[5]);
    else delete e.params.couplingCoef;
  },
  dump: (e) => {
    const out: (string | number)[] = [
      e.params.inductance ?? 4,
      e.params.ratio ?? 1,
      e.params.current0 ?? 0,
      e.params.current1 ?? 0,
    ];
    if (e.params.current2 !== undefined) out.push(e.params.current2);
    if (e.params.couplingCoef !== undefined) out.push(e.params.couplingCoef);
    return out;
  },
  fields: [
    { name: 'inductance', label: 'Primary inductance', unit: 'H' },
    { name: 'ratio', label: 'Turns ratio (N2/N1)' },
    { name: 'couplingCoef', label: 'Coupling coefficient', min: 0, max: 1 },
    { name: 'backEuler', label: 'Backward Euler', type: 'bool', flag: IND_BACK_EULER },
  ],
  // The windings and tap hang over the five posts, the whole symbol a solid
  // pick zone (TappedTransformerElm.java:131-156).
  bodyRect: (e) => boxOfPoints(tappedPosts(e)),
  draw: drawTappedTransformer,
};

// ─── Custom transformer (406) ─────────────────────────────────────────────────

/** Port policy ceiling on a custom transformer's coil count, shared by
 *  convention with the engine's MAX_CUSTOM_COILS
 *  (engine/core/src/elements/transformer.rs), which rejects a well-formed
 *  description above the cap at build time. Below the cap the two sides must
 *  agree on the post layout; above it, this side renders nothing so no
 *  unbounded geometry is ever laid out. */
export const MAX_CUSTOM_COILS = 32;

export interface CustomCoil {
  /** Node number of the coil's first post; the second is `start + 1`. */
  start: number;
  /** Turns ratio to the base inductance coil, signed by winding direction. */
  turns: number;
}

/** Parses a custom description, or null when malformed, per
 *  CustomTransformerElm.parseDescription (:118-222). A number is a coil, `:`
 *  splits primary from secondary, `,` separates unconnected coils and `+`
 *  shares the previous coil's far node (tapped). */
export function parseCustomDescription(desc: string): {
  coils: CustomCoil[];
  nodeCount: number;
  primaryCoils: number;
} | null {
  const tokens: string[] = [];
  let cur = '';
  for (const ch of desc) {
    if (ch === ',' || ch === ':' || ch === '+') {
      if (cur !== '') {
        tokens.push(cur);
        cur = '';
      }
      tokens.push(ch);
    } else {
      cur += ch;
    }
  }
  if (cur !== '') tokens.push(cur);

  const coils: CustomCoil[] = [];
  let nodeNum = 0;
  let primaryCoils = 0;
  let secondary = false;
  let i = 0;
  while (i < tokens.length) {
    const n = Number(tokens[i]);
    if (!Number.isFinite(n) || n === 0) return null;
    coils.push({ start: nodeNum, turns: n });
    nodeNum += 2;
    if (!secondary) primaryCoils = coils.length;
    i += 1;
    if (i >= tokens.length) break;
    if (tokens[i] === ',') {
      i += 1;
      continue;
    }
    if (tokens[i] === '+') {
      nodeNum -= 1;
      i += 1;
      continue;
    }
    if (tokens[i] === ':') {
      if (secondary) return null;
      secondary = true;
      i += 1;
      continue;
    }
    return null;
  }
  if (coils.length === 0) return null;
  return { coils, nodeCount: nodeNum, primaryCoils };
}

function customDesc(e: CircuitElement): string {
  return e.text && e.text.length > 0 ? e.text : '1,1:1';
}

interface CustomGeometry {
  p1: Point;
  axis: Point;
  nodePoints: Point[];
  nodeTaps: Point[];
  ptCore: Point[];
  dots: Point[] | null;
  coils: CustomCoil[];
  nodeCount: number;
  primaryCoils: number;
}

/** Port of CustomTransformerElm.setPoints (:270-321), always horizontal. The
 *  winding offsets accumulate down the left (primary) and right (secondary)
 *  columns as the description's coils stack. A description that does not parse
 *  renders as the constructor default `1,1:1`, mirroring the engine's
 *  `new_custom` fallback, so a malformed `406` line still gets its six posts
 *  and loads instead of bricking on "expects 6 posts, got 0". The text itself
 *  is left untouched and round-trips byte-for-byte. */
function customGeometry(e: CircuitElement): CustomGeometry | null {
  const [p1, raw] = endpoints(e);
  const axis = { x: raw.x, y: p1.y };
  const flip = (e.flags & TAPPED_FLIP) !== 0 ? -1 : 1;
  const parsed =
    parseCustomDescription(customDesc(e)) ??
    // The engine's `new_custom` falls back to the constructor default when the
    // description does not parse; mirror it here so a malformed `406` line
    // still gets its six posts instead of bricking set_circuit. The text is
    // left untouched and round-trips byte-for-byte.
    parseCustomDescription('1,1:1');
  if (parsed === null) return null;
  // A past-cap description gets the malformed treatment: geometry null,
  // posts [], draw a no-op, so nothing hangs laying out thousands of coils
  // before the engine's build rejection names the count.
  if (parsed.coils.length > MAX_CUSTOM_COILS) return null;
  const { coils, nodeCount, primaryCoils } = parsed;
  const dn = Math.abs(axis.x - p1.x);
  if (dn < 1) return null;
  const ce = 0.5 - 12 / dn;
  const cd = 0.5 - 2 / dn;
  const primaryNodes = primaryCoils === coils.length ? nodeCount : coils[primaryCoils].start;
  const nodePoints: Point[] = new Array(nodeCount);
  const nodeTaps: Point[] = new Array(nodeCount);
  let maxWidth = 0;
  for (let step = 0; step < 2; step++) {
    let c = 0;
    let offset = 0;
    for (let i = 0; i < nodeCount; i++) {
      if (i === primaryNodes) offset = 0;
      if (step === 1) {
        if (i === primaryNodes - 1 || i === nodeCount - 1) offset = maxWidth;
        nodePoints[i] = interp(p1, axis, i < primaryNodes ? 0 : 1, -offset * flip);
        nodeTaps[i] = interp(p1, axis, i < primaryNodes ? ce : 1 - ce, -offset * flip);
      }
      maxWidth = Math.max(maxWidth, offset);
      const nn = c < coils.length ? coils[c].start : -1;
      if (nn === i) {
        c += 1;
        offset += WIDTH;
      } else {
        offset += 16;
      }
    }
  }
  const ptCore: Point[] = [];
  for (let i = 0; i < 4; i += 2) {
    const h = i === 2 ? -maxWidth * flip : 0;
    ptCore[i] = interp(p1, axis, cd, h);
    ptCore[i + 1] = interp(p1, axis, 1 - cd, h);
  }
  const needDots = coils.some((c) => c.turns < 0);
  let dots: Point[] | null = null;
  if (needDots) {
    dots = [];
    const dotp = Math.abs(7 / WIDTH);
    for (let i = 0; i < coils.length; i++) {
      const n = coils[i].start;
      dots.push(
        interp(
          nodeTaps[n],
          nodeTaps[n + 1],
          coils[i].turns > 0 ? dotp : 1 - dotp,
          i < primaryCoils ? -7 : 7,
        ),
      );
    }
  }
  return { p1, axis, nodePoints, nodeTaps, ptCore, dots, coils, nodeCount, primaryCoils };
}

function customPosts(e: CircuitElement): Point[] {
  return customGeometry(e)?.nodePoints ?? [];
}

function drawCustomTransformer(g: DrawContext, e: CircuitElement): void {
  const geo = customGeometry(e);
  if (geo === null) return;
  const { nodePoints, nodeTaps, ptCore, dots } = geo;

  for (let i = 0; i < nodePoints.length; i++) {
    lead(g, nodePoints[i], nodeTaps[i], voltageColor(g, g.voltages[i]));
  }
  for (let i = 0; i < geo.coils.length; i++) {
    const n = geo.coils[i].start;
    drawCoilBetween(g, nodeTaps[n], nodeTaps[n + 1], i < geo.primaryCoils ? 6 : -6, g.voltages[n], g.voltages[n + 1]);
  }
  line(g, ptCore[0], ptCore[2], g.theme.text);
  line(g, ptCore[1], ptCore[3], g.theme.text);
  if (dots !== null) {
    g.ctx.fillStyle = g.theme.text;
    for (const dot of dots) {
      g.ctx.beginPath();
      g.ctx.arc(dot.x, dot.y, 2, 0, Math.PI * 2);
      g.ctx.fill();
    }
  }
  currentDots(g, nodePoints[0], nodeTaps[0], g.current);
}

export const CUSTOM_TRANSFORMER_DEF: ElementDef = {
  kind: 'customTransformer',
  label: 'Custom transformer',
  category: 'Basics',
  dumpCode: '406',
  postCount: 6,
  posts: customPosts,
  noDiagonal: true,  // CustomTransformerElm.java:52
  canMirror: true,
  defaults: {
    inductance: 4,
    couplingCoef: 0.999,
    coilCount: 3,
    coilCurrent0: 0,
    coilCurrent1: 0,
    coilCurrent2: 0,
  },
  // The description is one escaped token (CustomLogicModel.escape), already
  // unescaped on load and re-escaped on save by the netlist layer; the coil
  // currents follow the coilCount token.
  parse: (t, e) => {
    readParams(t, e, ['inductance', 'couplingCoef']);
    if (t[2] !== undefined) e.text = t[2];
    else e.text = '1,1:1';
    // Only a legitimate count is kept: a token above the cap belongs to a
    // document the engine refuses, so it is dropped and any stale slots with
    // it, bounding both this read loop and any later dump without ever
    // looping over an unbounded claim. Legitimate files keep their exact
    // token and every current value.
    const claimed = Number(t[3]);
    if (Number.isFinite(claimed) && claimed >= 0 && claimed <= MAX_CUSTOM_COILS) {
      e.params.coilCount = claimed;
      for (let i = 0; i < claimed; i++) {
        e.params[`coilCurrent${i}`] = t[4 + i] !== undefined ? Number(t[4 + i]) : 0;
      }
    } else {
      delete e.params.coilCount;
      // The description is the authority on coil structure and linear to
      // scan, so even a refused document keeps every current it carried.
      const n = customCoilCount(e.text);
      for (let i = 0; i < n; i++) {
        e.params[`coilCurrent${i}`] = t[4 + i] !== undefined ? Number(t[4 + i]) : 0;
      }
    }
  },
  dump: (e) => {
    const desc = customDesc(e);
    // Bounded by construction: a stored count token is cap-checked at parse,
    // and the description-derived fallback is linear in the line itself.
    const n = e.params.coilCount ?? customCoilCount(desc);
    const out: (string | number)[] = [
      e.params.inductance ?? 4,
      e.params.couplingCoef ?? 0.999,
      desc,
      n,
    ];
    for (let i = 0; i < n; i++) out.push(e.params[`coilCurrent${i}`] ?? 0);
    return out;
  },
  fields: [
    { name: 'inductance', label: 'Base inductance', unit: 'H' },
    { name: 'couplingCoef', label: 'Coupling coefficient', min: 0, max: 1 },
    { name: 'text', label: 'Description', type: 'text', target: 'text' },
    { name: 'backEuler', label: 'Backward Euler', type: 'bool', flag: IND_BACK_EULER },
  ],
  // The stacked windings span the node points, the whole symbol a solid pick
  // zone (CustomTransformerElm.java:270-321).
  bodyRect: (e) => boxOfPoints(customGeometry(e)?.nodePoints ?? []),
  draw: drawCustomTransformer,
};

/** Number of coils a description describes, or 0 when malformed. */
export function customCoilCount(desc: string): number {
  return parseCustomDescription(desc)?.coils.length ?? 0;
}
