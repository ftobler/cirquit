/**
 * The seven basic logic gates, one drawing family per shape: AND (straight
 * back, semicircular front), OR (curved back, convex front) and XOR (OR plus
 * a second back curve), with NAND/NOR/XNOR adding the output bubble and
 * FLAG_INVERT_INPUTS adding one per input. IEC mode swaps the shapes for the
 * rectangle with the function glyph inside (GateElm.java:192-222).
 */

import {
  calcLeads,
  canvasFont,
  circle,
  closedPolyline,
  currentDots,
  elementLength,
  endpoints,
  interp,
  interpPrecise,
  line,
  polyline,
  voltageColor,
} from '../../../render/draw';
import { GATE_INVERT_INPUTS, GATE_SCHMITT, GATE_SMALL } from '../flags';
import { readParams, writeParams } from '../shared';
import type { CircuitElement, DrawContext, ElementDef, Point } from '../../types';

/** The IEC glyph for each gate; the inverting variants keep their parent's
 *  glyph and let the output bubble say "inverted" (AndGateElm.java:31,
 *  OrGateElm.java:104, XorGateElm.java:29). */
const GATE_TEXT: Record<string, string> = {
  andGate: '&',
  nandGate: '&',
  orGate: '\u22651',
  norGate: '\u22651',
  xorGate: '=1',
  xnorGate: '=1',
};

/** The inverting gate kinds, whose output bubble inverts the function. */
function gateInverting(kind: string): boolean {
  return kind === 'nandGate' || kind === 'norGate' || kind === 'xnorGate';
}

/** Whether the kind draws the OR-family shield and its double back curve. */
function isOrFamily(kind: string): boolean {
  return kind === 'orGate' || kind === 'norGate' || kind === 'xorGate' || kind === 'xnorGate';
}

/** gsize, the size scale: 2 normally, 1 under FLAG_SMALL (GateElm.java:69-76). */
function gateSize(e: CircuitElement): number {
  return (e.flags & GATE_SMALL) !== 0 ? 1 : 2;
}

function gateInputCount(e: CircuitElement): number {
  const n = Math.round(e.params.inputCount ?? 2);
  return Math.max(1, Math.min(8, n));
}

/** The editable input count, clamped to upstream's 1..8 range. */
function clampInputCount(_e: CircuitElement, value: number): number {
  const n = Math.round(value);
  if (n < 1) return 1;
  if (n > 8) return 8;
  return Number.isFinite(n) ? n : 2;
}

/**
 * The gate body's leads, half-width and half-height, from `setPoints`
 * (GateElm.java:132-165): the body is `2*ww` long between the leads, and an
 * inverting gate shrinks it to leave room for the output bubble.
 */
function gateBody(e: CircuitElement): { lead1: Point; lead2: Point; ww: number; hs2: number } {
  const dn = Math.max(1, elementLength(e));
  let ww = 14 * gateSize(e);
  if (ww > dn / 2) ww = dn / 2;
  if (gateInverting(e.kind) && ww + 8 > dn / 2) ww = dn / 2 - 8;
  const [lead1, lead2] = calcLeads(e, ww * 2);
  const hs2 = 7 * gateSize(e) * (Math.floor(gateInputCount(e) / 2) + 1);
  return { lead1, lead2, ww, hs2 };
}

/** Input terminal coordinates: back-edge posts at `hs*i0` spacing with the
 *  even-input-count skip over the axis (GateElm.java:152-156). */
function gatePosts(e: CircuitElement): Point[] {
  const [p1, p2] = endpoints(e);
  const n = gateInputCount(e);
  const hs = 8 * gateSize(e);
  const posts: Point[] = [];
  let i0 = -Math.floor(n / 2);
  for (let i = 0; i < n; i++) {
    if (i0 === 0 && n % 2 === 0) i0++;
    posts.push(interp(p1, p2, 0, hs * i0));
    i0++;
  }
  posts.push(p2);
  return posts;
}

/**
 * The OR-family lead shift that fans the outer input leads inward on wide
 * gates (OrGateElm.java:50-59); upstream returns 0 in IEC mode.
 */
function orLeadAdjustment(g: DrawContext, kind: string, ix: number, n: number): number {
  if (g.euroGates || !isOrFamily(kind)) return 0;
  if (n > 3 && (ix === 0 || ix === n - 1)) return -0.05;
  if (n > 7 && (ix === 1 || ix === n - 2)) return -0.05;
  if (n >= 12 && (ix === 2 || ix === n - 3)) return -0.05;
  return 0;
}

/** A quadratic Bezier from `a` through `ctrl` to `b`, endpoints included. */
function quadBezier(a: Point, ctrl: Point, b: Point, steps: number): Point[] {
  const pts: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    pts.push({
      x: u * u * a.x + 2 * u * t * ctrl.x + t * t * b.x,
      y: u * u * a.y + 2 * u * t * ctrl.y + t * t * b.y,
    });
  }
  return pts;
}

/** The AND gate's semicircular front, sampled from the top of the ellipse
 *  (theta = pi/2) around the front to the bottom (theta = -pi/2). The sample
 *  is frame-independent: the along-axis half-diameter is `ww` and the
 *  perpendicular one `hs2`, which is exactly upstream's rx/ry pair for a
 *  horizontal body and its swapped rx=hs2/ry=ww for a vertical one
 *  (AndGateElm.drawGatePolygon, AndGateElm.java:41-52). A vertical AND
 *  therefore bulges sideways by `hs2`, never a squashed along-axis front. */
function gateArc(lead1: Point, lead2: Point, hs2: number): Point[] {
  const pts: Point[] = [];
  const steps = 12;
  for (let i = 0; i <= steps; i++) {
    const theta = Math.PI * (0.5 - i / steps);
    pts.push(interpPrecise(lead1, lead2, 0.5 + Math.cos(theta) / 2, hs2 * Math.sin(theta)));
  }
  return pts;
}

/** The hysteresis Z drawn over a gate body under FLAG_SCHMITT
 *  (getSchmittPolygon, CircuitElm.java:1057-1069). */
function schmittPolygon(lead1: Point, lead2: Point, gsize: number, ctr: number): Point[] {
  const hs = 3 * gsize;
  const h1 = 3 * gsize;
  const h2 = 2 * h1;
  const len = Math.hypot(lead2.x - lead1.x, lead2.y - lead1.y) || 1;
  return [
    interp(lead1, lead2, ctr - h2 / len, hs),
    interp(lead1, lead2, ctr + h1 / len, hs),
    interp(lead1, lead2, ctr + h1 / len, -hs),
    interp(lead1, lead2, ctr + h2 / len, -hs),
    interp(lead1, lead2, ctr - h1 / len, -hs),
    interp(lead1, lead2, ctr - h1 / len, hs),
  ];
}

/** The ANSI distinctive body shapes (GateElm.java's subclasses' setPoints). */
function drawGateShape(
  g: DrawContext,
  e: CircuitElement,
  lead1: Point,
  lead2: Point,
  ww: number,
  hs2: number,
  dn: number,
): void {
  const color = g.theme.wire;
  if (!isOrFamily(e.kind)) {
    // AND/NAND: back edge plus the semicircular front (AndGateElm.java:67-71).
    const topLeft = interp(lead1, lead2, 0, hs2);
    const bottomLeft = interp(lead1, lead2, 0, -hs2);
    closedPolyline(g, [bottomLeft, topLeft, ...gateArc(lead1, lead2, hs2), bottomLeft], color);
    return;
  }
  // OR/NOR/XOR/XNOR: the shield with quadratic-bezier curves
  // (OrGateElm.java:68-92).
  const p0 = interp(lead1, lead2, -0.05, hs2);
  const p1 = interp(lead1, lead2, 0.3, hs2);
  const p2 = interp(lead1, lead2, 0.7, hs2 * 0.81);
  const p3 = lead2;
  const p4 = interp(lead1, lead2, 0.7, -hs2 * 0.81);
  const p5 = interp(lead1, lead2, 0.3, -hs2);
  const p6 = interp(lead1, lead2, -0.05, -hs2);
  const p7 = interp(lead1, lead2, 0.08);
  const steps = 8;
  closedPolyline(
    g,
    [
      p0,
      p1,
      ...quadBezier(p1, p2, p3, steps).slice(1),
      ...quadBezier(p3, p4, p5, steps).slice(1),
      p6,
      ...quadBezier(p6, p7, p0, steps).slice(1),
      p0,
    ],
    color,
  );
  if (e.kind === 'xorGate' || e.kind === 'xnorGate') {
    // XOR/XNOR add a second, further-back curve for the "exclusive" mark
    // (XorGateElm, OrGateElm.java:90-95).
    const ww2 = ww > 0 ? ww * 2 : Math.max(dn, 1) * 2;
    const p8 = interp(lead1, lead2, -0.05 - 5 / ww2, hs2);
    const p9 = interp(lead1, lead2, -0.05 - 5 / ww2, -hs2);
    const p10 = interp(lead1, lead2, 0.08 - 5 / ww2);
    polyline(g, [p8, ...quadBezier(p8, p10, p9, steps).slice(1), p9], color);
  }
}

function drawGate(g: DrawContext, e: CircuitElement): void {
  const [p1, p2] = endpoints(e);
  const dn = Math.max(1, elementLength(e));
  const n = gateInputCount(e);
  const s = gateSize(e);
  const hs = 8 * s;
  const inverting = gateInverting(e.kind);
  const { lead1, lead2, ww, hs2 } = gateBody(e);
  const posts = gatePosts(e);

  // Input leads from the back-edge posts to the body, with the invert-input
  // bubbles pushed just outside (GateElm.java:157-159, :217-218).
  let i0 = -Math.floor(n / 2);
  for (let i = 0; i < n; i++) {
    if (i0 === 0 && n % 2 === 0) i0++;
    const adj = orLeadAdjustment(g, e.kind, i, n);
    const inGate = interp(
      lead1,
      lead2,
      (e.flags & GATE_INVERT_INPUTS) !== 0 ? -8 / (2 * ww) + adj : adj,
      hs * i0,
    );
    line(g, posts[i], inGate, voltageColor(g, g.voltages[i]));
    if ((e.flags & GATE_INVERT_INPUTS) !== 0) {
      circle(g, interp(lead1, lead2, -4 / (2 * ww), hs * i0), 3, g.theme.wire, false, 3);
    }
    i0++;
  }

  // The output bubble (for the inverting kinds) pushes the output lead out
  // past the body (AndGateElm.java:73-76, OrGateElm.java:82-85).
  let outLead = lead2;
  if (inverting) {
    outLead = interp(p1, p2, 0.5 + (ww + 8) / dn);
    circle(g, interp(p1, p2, 0.5 + (ww + 4) / dn), 3, g.theme.wire, false, 3);
  }
  line(g, outLead, p2, voltageColor(g, g.voltages[n]));

  const color = g.theme.wire;
  if (g.euroGates) {
    // IEC rectangle spanning the body, with the function glyph centred just
    // above the axis (GateElm.java:178-183, :201-205).
    closedPolyline(
      g,
      [
        interp(lead1, lead2, 0, hs2),
        interp(lead1, lead2, 0, -hs2),
        interp(lead1, lead2, 1, -hs2),
        interp(lead1, lead2, 1, hs2),
        interp(lead1, lead2, 0, hs2),
      ],
      color,
    );
    const center = interp(p1, p2, 0.5);
    g.ctx.fillStyle = g.theme.text;
    g.ctx.font = canvasFont(12);
    g.ctx.textAlign = 'center';
    g.ctx.textBaseline = 'middle';
    g.ctx.fillText(GATE_TEXT[e.kind], center.x, center.y - 6 * s);
  } else {
    drawGateShape(g, e, lead1, lead2, ww, hs2, dn);
  }

  if ((e.flags & GATE_SCHMITT) !== 0) {
    polyline(g, schmittPolygon(lead1, lead2, s, 0.47), color, 2);
  }
  currentDots(g, outLead, p2, g.current);
}

/** One registry entry per gate kind, sharing every field but the kind. */
function gateDef(
  kind: string,
  dumpCode: string,
  label: string,
  defaults: Record<string, number>,
): ElementDef {
  return {
    kind,
    label,
    category: 'Logic',
    dumpCode,
    postCount: 3,
    posts: gatePosts,
    noDiagonal: true,   // GateElm.java:40
    defaultLength: 6,   // getDragLength() = 96
    defaults,
    parse: (t, e) => {
      readParams(t, e, ['inputCount', 'lastOutputVoltage', 'highVoltage']);
      if (e.params.inputCount !== undefined) e.params.inputCount = clampInputCount(e, e.params.inputCount);
    },
    dump: writeParams(['inputCount', 'lastOutputVoltage', 'highVoltage']),
    fields: [
      { name: 'inputCount', label: '# of Inputs', min: 1, max: 8 },
      { name: 'highVoltage', label: 'High logic voltage', unit: 'V' },
      { name: 'schmitt', label: 'Schmitt inputs', type: 'bool', flag: GATE_SCHMITT },
      { name: 'invertInputs', label: 'Invert inputs', type: 'bool', flag: GATE_INVERT_INPUTS },
    ],
    draw: drawGate,
  };
}

const GATE_DEFAULTS = { inputCount: 2, lastOutputVoltage: 0, highVoltage: 5 };

export const AND_GATE_DEF = gateDef('andGate', '150', 'AND gate', GATE_DEFAULTS);
export const NAND_GATE_DEF = gateDef('nandGate', '151', 'NAND gate', GATE_DEFAULTS);
export const OR_GATE_DEF = gateDef('orGate', '152', 'OR gate', GATE_DEFAULTS);
export const NOR_GATE_DEF = gateDef('norGate', '153', 'NOR gate', GATE_DEFAULTS);
export const XOR_GATE_DEF = gateDef('xorGate', '154', 'XOR gate', GATE_DEFAULTS);
export const XNOR_GATE_DEF = gateDef('xnorGate', '431', 'XNOR gate', GATE_DEFAULTS);

export { gateInputCount, gateInverting, gatePosts };
