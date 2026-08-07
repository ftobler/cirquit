import {
  arrowHead,
  currentDots,
  dsign,
  elementLength,
  endpoints,
  interp,
  interp2,
  line,
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
  polygon(g, [backTop, frontTop, frontBottom, backBottom], baseColor);
  line(g, p1, base, baseColor);

  // The collector and emitter leads leave the bar's near edge just off the
  // axis and fan out to their posts (TransistorElm.java:230).
  const [c1, e1] = transistorBarContacts(e);
  line(g, c1, posts[1], voltageColor(g, g.voltages[1]));
  line(g, e1, posts[2], voltageColor(g, g.voltages[2]));

  // The arrow sits on the emitter: NPN points out toward the terminal, PNP
  // points in from it (TransistorElm.java:238-243).
  if (pnp) {
    const pt = transistorArrowTip(e);
    if (pt) arrowHead(g, posts[2], pt, 8, voltageColor(g, g.voltages[2]));
  } else {
    arrowHead(g, e1, posts[2], 8, voltageColor(g, g.voltages[2]));
  }

  currentDots(g, posts[1], c1, g.current);
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

/** Arrow tip on the emitter lead: the emitter post for NPN, a point a third
 *  of the bar back for PNP (TransistorElm.java:241-242). */
export function transistorArrowTip(e: CircuitElement): Point | null {
  const [p1, p2] = endpoints(e);
  if ((e.params.pnp ?? 1) !== -1) return null;  // NPN arrow lands on the post
  const dn = elementLength(e);
  return interp(p1, p2, dn > 0 ? 1 - 11 / dn : 1, -5 * transistorSideFactor(e));
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
  // token is the model name. A non-negative pnp (including the legacy 0
  // saved by older builds) normalises to NPN.
  parse: (t, e) => {
    const raw = Number(t[0]);
    e.params.pnp = Number.isFinite(raw) ? (raw < 0 ? -1 : 1) : 1;
    // Non-finite tokens are skipped, matching readParams, so a malformed
    // line keeps its defaults instead of poisoning the engine with NaN.
    if (t[1] !== undefined && Number.isFinite(Number(t[1]))) e.params.lastVbe = Number(t[1]);
    if (t[2] !== undefined && Number.isFinite(Number(t[2]))) e.params.lastVbc = Number(t[2]);
    if (t[3] !== undefined && Number.isFinite(Number(t[3]))) e.params.beta = Number(t[3]);
    if (t[4] !== undefined) e.text = t[4];
  },
  // The model name is re-emitted only when it was present on load, so a line
  // that arrived with 4 tokens stays 4 tokens.
  dump: (e) => [
    (e.params.pnp ?? 1) === -1 ? -1 : 1,
    e.params.lastVbe ?? 0,
    e.params.lastVbc ?? 0,
    e.params.beta ?? 100,
    ...(e.text !== undefined ? [e.text] : []),
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
  ],
  draw: drawTransistorBody,
};
