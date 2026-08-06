import {
  arrowHead,
  currentDots,
  dsign,
  endpoints,
  interp,
  interp2,
  line,
  voltageColor,
} from '../../../render/draw';
import { TRANSISTOR_FLIP } from '../flags';
import { OPEN_HS } from '../shared';
import type { CircuitElement, DrawContext, ElementDef, Point } from '../../types';

function drawTransistorBody(g: DrawContext, e: CircuitElement): void {
  const [p1, p2] = endpoints(e);
  const posts = transistorPosts(e);
  const pnp = (e.params.pnp ?? 1) === -1;
  const baseColor = voltageColor(g, g.voltages[0]);

  // Base lead up to the vertical bar.
  const barCentre = interp(p1, p2, 0.72);
  line(g, p1, barCentre, baseColor);
  // The bar straddles the axis; the sign only picks which endpoint is which.
  const [barTop, barBottom] = interp2(p1, p2, 0.72, OPEN_HS * 0.6);
  line(g, barTop, barBottom, baseColor, 3);

  // Collector and emitter leads leave the bar on their posts' side, so a
  // flipped or mirrored body's leads do not cross over the symbol.
  const [c1, e1] = transistorBarContacts(e);
  line(g, c1, posts[1], voltageColor(g, g.voltages[1]));
  line(g, e1, posts[2], voltageColor(g, g.voltages[2]));
  // The arrow sits on the emitter and points the way conventional current
  // flows, which is what distinguishes NPN from PNP.
  if (pnp) arrowHead(g, posts[2], e1, 8, voltageColor(g, g.voltages[2]));
  else arrowHead(g, e1, posts[2], 8, voltageColor(g, g.voltages[2]));

  currentDots(g, posts[1], c1, g.current);
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
 *  ordered like `transistorPosts`. */
export function transistorBarContacts(e: CircuitElement): [Point, Point] {
  const [p1, p2] = endpoints(e);
  return interp2(p1, p2, 0.72, OPEN_HS * 0.6 * transistorSideFactor(e));
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
