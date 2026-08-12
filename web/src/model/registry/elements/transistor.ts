import {
  arrowHead,
  currentDotsFrom,
  dsign,
  elementLength,
  endpoints,
  interp,
  interp2,
  lead,
  polygon,
  voltageColor,
} from '../../../render/draw';
import { TRANSISTOR_FLIP } from '../flags';
import { OPEN_HS } from '../shared';
import type { CircuitElement, DrawContext, ElementDef, Point } from '../../types';

function drawTransistorBody(g: DrawContext, e: CircuitElement): void {
  const [p1, p2] = endpoints(e);
  const posts = transistorPosts(e);
  const pnp = (e.params.pnp ?? 1) === -1;
  const dn = elementLength(e);
  const baseColor = voltageColor(g, g.voltages[0]);

  // The base bar is a 3-unit-deep rectangle straddling the axis at the
  // 16-unit half width, from fraction 1-16/dn to 1-13/dn (TransistorElm.java:
  // 226-235). The base lead meets its far edge on the axis.
  const base = interp(p1, p2, backFraction(dn));
  const [backTop, backBottom] = interp2(p1, p2, backFraction(dn), OPEN_HS);
  const [frontTop, frontBottom] = interp2(p1, p2, frontFraction(dn), OPEN_HS);
  lead(g, p1, base, baseColor);

  // The collector and emitter leads leave the bar's near edge just off the
  // axis and fan out to their posts (TransistorElm.java:230).
  const [c1, e1] = transistorBarContacts(e);
  lead(g, c1, posts[1], voltageColor(g, g.voltages[1]));
  lead(g, e1, posts[2], voltageColor(g, g.voltages[2]));

  // The arrow sits on the emitter: NPN points out toward the terminal, PNP
  // points in from it (TransistorElm.java:238-243).
  if (pnp) {
    const pt = transistorArrowTip(e);
    if (pt) arrowHead(g, posts[2], pt, 8, voltageColor(g, g.voltages[2]));
  } else {
    arrowHead(g, e1, posts[2], 8, voltageColor(g, g.voltages[2]));
  }

  // One dot run per terminal, each from the body contact outward to its post,
  // each animated on its own current and phase (TransistorElm.java:179-184).
  // `postCurrents[i]` is `current_into_node(i)`, which is upstream's -ib, -ic
  // and -ie term for term, so a base carrying a fraction of the collector
  // current crawls while the collector runs.
  currentDotsFrom(g, base, posts[0], g.postCurrents[0], g.postDotPhases[0]);
  currentDotsFrom(g, c1, posts[1], g.postCurrents[1], g.postDotPhases[1]);
  currentDotsFrom(g, e1, posts[2], g.postCurrents[2], g.postDotPhases[2]);

  // The bar is filled last, on top of the leads, the arrow and the dot runs,
  // so its front face covers the inner ends of the C/E leads and the base
  // run's innermost dots, exactly as upstream fills its rectPoly last
  // (TransistorElm.java:186-188). The port once filled it first, which made
  // the junction read as two separate shapes. Options (b) and (c) from the
  // plan, attaching the leads at the bar's corners or moving the bar forward
  // toward the posts, were considered and rejected: both change upstream's
  // symbol proportions. The contacts stay at ±6 and the bar edges stay at
  // 1-16/dn and 1-13/dn.
  polygon(g, [backTop, frontTop, frontBottom, backBottom], baseColor);
}

/** Fraction along the axis of the base bar's back edge (TransistorElm.java:227). */
function backFraction(dn: number): number {
  return dn > 0 ? 1 - 16 / dn : 1;
}

/** Fraction along the axis of the base bar's front edge (TransistorElm.java:228). */
function frontFraction(dn: number): number {
  return dn > 0 ? 1 - 13 / dn : 1;
}

/** Signed side factor for the transistor's collector and emitter, combining
 *  the pnp sign, `dsign` and FLAG_FLIP exactly as the original does
 *  (TransistorElm.java:218-220, `hs2 = hs*dsign*pnp`). */
export function transistorSideFactor(e: CircuitElement): number {
  const [p1, p2] = endpoints(e);
  let d = dsign(p1, p2);
  if ((e.flags & TRANSISTOR_FLIP) !== 0) d = -d;
  const pnp = (e.params.pnp ?? 1) === -1 ? -1 : 1;
  return d * pnp;
}

/** Points on the base bar where the collector and emitter leads attach,
 *  ordered like `transistorPosts`: the near edge at `6*dsign*pnp` either side
 *  (TransistorElm.java:230). */
export function transistorBarContacts(e: CircuitElement): [Point, Point] {
  const [p1, p2] = endpoints(e);
  return interp2(p1, p2, frontFraction(elementLength(e)), 6 * transistorSideFactor(e));
}

/** Arrow tip on the emitter lead: the emitter post for NPN, the emitter bar
 *  contact for PNP. The PNP arrow is drawn from the emitter post back to this
 *  point, so it lies exactly on the lead by construction, the mirror of the
 *  NPN one. This diverges from upstream, which floats the PNP tip beside the
 *  lead at 1-11/dn (TransistorElm.java:241-242): there the arrow runs at a
 *  45-degree tilt to a lead that leaves the bar at 37.6 degrees, and its
 *  point hangs 2.5 units clear of the wire. Terminal geometry is untouched. */
export function transistorArrowTip(e: CircuitElement): Point | null {
  if ((e.params.pnp ?? 1) !== -1) return null;  // NPN arrow lands on the post
  return transistorBarContacts(e)[1];
}

function transistorPosts(e: CircuitElement): Point[] {
  const [p1, p2] = endpoints(e);
  let d = dsign(p1, p2);
  if ((e.flags & TRANSISTOR_FLIP) !== 0) d = -d;
  const pnp = (e.params.pnp ?? 1) === -1 ? -1 : 1;
  const [coll, emit] = interp2(p1, p2, 1, OPEN_HS * d * pnp);
  return [p1, coll, emit];
}

export const TRANSISTOR_DEF: ElementDef = {
  kind: 'transistor',
  label: 'Transistor (BJT)',
  category: 'Semiconductors',
  dumpCode: 't',
  postCount: 3,
  posts: transistorPosts,
  canMirror: true,
  noDiagonal: true,  // TransistorElm.java:80
  defaults: { pnp: 1, beta: 100 },
  // The file sign is the type: +1 is NPN, -1 is PNP, and the optional 5th
  // token is the unescaped model name, read into the `modelName` slot the
  // `32` model-library resolution looks up (TransistorElm.java:58-75). A
  // non-negative pnp (including the legacy 0 saved by older builds)
  // normalises to NPN.
  parse: (t, e) => {
    const raw = Number(t[0]);
    e.params.pnp = Number.isFinite(raw) ? (raw < 0 ? -1 : 1) : 1;
    // Non-finite tokens are skipped, matching readParams, so a malformed
    // line keeps its defaults instead of poisoning the engine with NaN.
    if (t[1] !== undefined && Number.isFinite(Number(t[1]))) e.params.lastVbe = Number(t[1]);
    if (t[2] !== undefined && Number.isFinite(Number(t[2]))) e.params.lastVbc = Number(t[2]);
    if (t[3] !== undefined && Number.isFinite(Number(t[3]))) e.params.beta = Number(t[3]);
    if (t[4] !== undefined) e.modelName = t[4];
  },
  // The model name is re-emitted only when it was present on load, so a line
  // that arrived with 4 tokens stays 4 tokens.
  dump: (e) => [
    (e.params.pnp ?? 1) === -1 ? -1 : 1,
    e.params.lastVbe ?? 0,
    e.params.lastVbc ?? 0,
    e.params.beta ?? 100,
    ...(e.modelName !== undefined ? [e.modelName] : []),
  ],
  fields: [
    {
      name: 'pnp',
      label: 'Type',
      type: 'choice',
      choices: [
        { value: 1, label: 'NPN' },
        { value: -1, label: 'PNP' },
      ],
    },
    { name: 'beta', label: 'Current gain (β)' },
    // The model choice is upstream's edit item 3 (TransistorElm.java:619-631).
    { name: 'modelName', label: 'Model', type: 'modelChoice', target: 'modelName', modelFamily: 'transistor' },
  ],
  draw: drawTransistorBody,
};
