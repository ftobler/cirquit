/**
 * Realistic op-amp (OpAmpRealElm.java, dump 409): the transistor-level op-amp,
 * built as a composite inside the engine. The model selector (`modelType`) picks
 * the LM741 or the LM324v2 netlist; the frontend draws the larger op-amp symbol
 * with the two supply rails. A file naming the old LM324 (modelType 1) still
 * loads and round-trips, and simulates its own netlist, but the picker offers
 * it to nobody fresh: upstream hides it the same way (OpAmpRealElm.java:
 * 270-281), because its follower's DC operating point collapses the input
 * stage.
 *
 * Token layout after the common fields is the plain numeric pair
 * `slewRate capValue currentLimit modelType` (OpAmpRealElm.java:79-86): the
 * slew rate, the compensation capacitor's saved charge, the output current
 * limit and the model selector. A loaded modelType token round-trips untouched
 * (OpAmpRealElm.java:82-86 keeps the 741 when the token is absent or
 * unparseable).
 *
 * The input-swap flag is bit 1 (OPAMPREAL_SWAP, OpAmpRealElm.java:65), the
 * composite's escape flag being bit 0. The swap reaches the input posts, their
 * leads and the +/- glyphs only: upstream negates hs into hsswap for in1p,
 * in2p and textp alone (OpAmpRealElm.java:222-238), while the supply rails
 * and the triangle keep the plain hs, so posts 3/4 sit at the same ends of
 * the rails whether the flag is set or not.
 */

import {
  canvasFont,
  closedPolyline,
  currentDots,
  dsign,
  elementLength,
  endpoints,
  interp,
  interp2,
  lead,
  voltageColor,
} from '../../../render/draw';
import { GRID_SIZE } from '../../types';
import { OPAMPREAL_SWAP } from '../flags';
import { readParams, writeParams, boxOfPoints } from '../shared';
import type { CircuitElement, DrawContext, ElementDef, Point } from '../../types';

/** Symbol geometry constants (OpAmpRealElm.java:58-59). */
const OPHEIGHT = 16;
const OPWIDTH = 32;

function opBodyLeads(e: CircuitElement): [Point, Point] {
  const [p1, p2] = endpoints(e);
  const dn = elementLength(e);
  const ww = Math.min(OPWIDTH, dn / 2);
  const f = (dn - ww * 2) / (2 * dn);
  return [interp(p1, p2, f), interp(p1, p2, 1 - f)];
}

/** Signed perpendicular of the triangle body: `opheight*dsign`, never
 *  negated. The rails and the outline hang off this side whatever the swap
 *  says (OpAmpRealElm.java:222-242), which is what keeps posts 3/4 fixed. */
function bodySide(e: CircuitElement): number {
  const [p1, p2] = endpoints(e);
  return OPHEIGHT * dsign(p1, p2);
}

/** Signed perpendicular of the inverting input, negated by FLAG_SWAP
 *  (OpAmpRealElm.java:222-225). Only the input side: the input posts, their
 *  leads and the +/- glyphs track it; the rails and triangle use bodySide. */
function inputSide(e: CircuitElement): number {
  let hs = bodySide(e);
  if ((e.flags & OPAMPREAL_SWAP) !== 0) hs = -hs;
  return hs;
}

/** The rail attachment points, `railPos` nudged so the rails sit on the grid
 *  (OpAmpRealElm.java:236-238). Plain hs, so the swap never moves them. */
function railAnchors(e: CircuitElement): [Point, Point, Point, Point] {
  const [lead1, lead2] = opBodyLeads(e);
  const dn = elementLength(e);
  const ww = Math.min(OPWIDTH, dn / 2);
  const hs = bodySide(e);
  // `(dn/2) % gridSize` upstream's grid-fit nudge: the fraction of the
  // half-length that does not land on the grid moves the rails off-centre.
  const railPos = 0.5 - ((dn / 2) % GRID_SIZE) / (ww * 2);
  const [rail1a, rail2a] = interp2(lead1, lead2, railPos, hs * 2);
  const [rail1b, rail2b] = interp2(lead1, lead2, railPos, hs * 2 * (1 - railPos));
  return [rail1a, rail2a, rail1b, rail2b];
}

function opAmpRealPosts(e: CircuitElement): Point[] {
  const [p1, p2] = endpoints(e);
  const hs = inputSide(e);
  const [rail1, rail2] = railAnchors(e);
  // Posts: V-, V+, out, V+ supply, V- supply (OpAmpRealElm.java:244-248).
  return [interp(p1, p2, 0, hs), interp(p1, p2, 0, -hs), p2, rail1, rail2];
}

function drawOpAmpReal(g: DrawContext, e: CircuitElement): void {
  const p2 = endpoints(e)[1];
  const [lead1, lead2] = opBodyLeads(e);
  const posts = opAmpRealPosts(e);
  const hs = inputSide(e);
  const [rail1, rail2, rail1b, rail2b] = railAnchors(e);

  // The two input leads, the output lead and the two supply rails.
  lead(g, posts[0], interp(lead1, lead2, 0, hs), voltageColor(g, g.voltages[0]));
  lead(g, posts[1], interp(lead1, lead2, 0, -hs), voltageColor(g, g.voltages[1]));
  lead(g, lead2, p2, voltageColor(g, g.voltages[2]));
  lead(g, rail1, rail1b, voltageColor(g, g.voltages[3]));
  lead(g, rail2, rail2b, voltageColor(g, g.voltages[4]));

  // The triangle outline, drawn like the plain op-amp's
  // (OpAmpRealElm.java:196, 240-242). Plain hs, unmoved by the swap. No
  // fill, so the body stays transparent.
  const [t1, t2] = interp2(lead1, lead2, 0, bodySide(e) * 2);
  closedPolyline(g, [t1, t2, lead2, t1], g.theme.wire);

  const [minus, plus] = interp2(lead1, lead2, 0.2, hs);
  g.ctx.fillStyle = g.theme.text;
  g.ctx.font = canvasFont(14);  // plusFont, OpAmpRealElm.java:243
  g.ctx.textAlign = 'center';
  g.ctx.textBaseline = 'middle';
  g.ctx.fillText('−', minus.x, minus.y - 2);
  g.ctx.fillText('+', plus.x, plus.y);

  currentDots(g, p2, lead2, -g.current);
}

export const OPAMP_REAL_DEF: ElementDef = {
  kind: 'opampReal',
  label: 'Realistic Op-Amp',
  category: 'Active',
  dumpCode: '409',
  postCount: 5,
  posts: opAmpRealPosts,
  canMirror: true,  // OpAmpRealElm.java:319-320, canFlipX/canFlipY only
  noDiagonal: true,  // OpAmpRealElm.java:69, 78
  defaults: { slewRate: 0.6, capValue: 0, currentLimit: 0.0231, modelType: 0 },
  parse: (t, e) => readParams(t, e, ['slewRate', 'capValue', 'currentLimit', 'modelType']),
  dump: writeParams(['slewRate', 'capValue', 'currentLimit', 'modelType']),
  fields: [
    {
      name: 'modelType',
      label: 'Model',
      type: 'choice',
      // The netlists a fresh part can take (OpAmpRealElm.java:51-53,
      // :270-281): the LM741 and the LM324v2. The old LM324 (modelType 1) is
      // hidden from fresh parts exactly like upstream hides it ("hide old 324
      // model"): its follower's DC operating point collapses the input stage,
      // so it is only offered to files that already name it, which the choice
      // row still shows as a disabled option (ElementFields.tsx).
      choices: [
        { value: 0, label: 'LM741' },
        { value: 2, label: 'LM324v2' },
      ],
      outOfRangeLabel: 'LM324, old',
    },
    {
      name: 'swap',
      label: 'Swap Inputs',
      type: 'bool',
      flag: OPAMPREAL_SWAP,
    },
    {
      name: 'slewRate',
      label: 'Slew Rate',
      unit: 'V/us',
      // The 324v2's compensation is fixed in its netlist (getCapacitor returns
      // null, OpAmpRealElm.java:149-153), so upstream hides these two rows on
      // it (:288-289); the 741 and the old 324 keep them.
      visible: (e) => e.params.modelType !== 2,
    },
    {
      name: 'currentLimit',
      label: 'Output Current Limit',
      unit: 'A',
      visible: (e) => e.params.modelType !== 2,
    },
  ],
  // The triangle body is a solid pick zone: the base at lead1 grown hs*2, the
  // apex at lead2 (OpAmpRealElm.java:183). Plain hs, like the drawn triangle.
  bodyRect: (e) => {
    const [lead1, lead2] = opBodyLeads(e);
    const hs = bodySide(e);
    const [t1, t2] = interp2(lead1, lead2, 0, hs * 2);
    return boxOfPoints([t1, t2, lead2]);
  },
  draw: drawOpAmpReal,
};
