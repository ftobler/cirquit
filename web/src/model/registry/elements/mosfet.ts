import {
  arrowHead,
  currentDots,
  dsign,
  elementLength,
  endpoints,
  interp,
  interp2,
  lead,
  line,
  voltageColor,
} from '../../../render/draw';
import { MOSFET_FLIP, MOSFET_PNP } from '../flags';
import { postsBox } from '../shared';
import type { CircuitElement, DrawContext, ElementDef, Point } from '../../types';

/** Terminal posts, mirroring MosfetElm.setPoints (MosfetElm.java:391-402):
 *  the gate at `point1`, the source and drain at `point2` offset `-hs2` and
 *  `+hs2` respectively, where `hs2 = 16*dsign` flipped by FLAG_FLIP (bit 8).
 *  The source/drain labels swap with the channel type but the coordinates do
 *  not, exactly as upstream's `src`/`drn` arrays stay put while only the
 *  arrow and labels change. */
function mosfetPosts(e: CircuitElement): Point[] {
  const [p1, p2] = endpoints(e);
  let hs2 = 16 * dsign(p1, p2);
  if ((e.flags & MOSFET_FLIP) !== 0) hs2 = -hs2;
  const [src, drn] = interp2(p1, p2, 1, -hs2);
  return [p1, src, drn];
}

/**
 * Port of MosfetElm.draw (MosfetElm.java:222-359), milestone-1 style: the
 * gate lead, the source and drain rails, the six-segment channel with the
 * enhancement gap, the bulk line and the channel arrow. The body-diode symbol
 * is deliberately absent until a later milestone.
 */
function drawMosfet(g: DrawContext, e: CircuitElement): void {
  const [p1, p2] = endpoints(e);
  const posts = mosfetPosts(e);
  const pnp = (e.params.pnp ?? 1) === -1;
  const dn = elementLength(e);
  let hs2 = 16 * dsign(p1, p2);
  if ((e.flags & MOSFET_FLIP) !== 0) hs2 = -hs2;

  // Source and drain rails, each ending just short of the channel so the
  // six segments below read as one body (MosfetElm.java:402-403).
  const src1 = interp(p1, p2, 1 - 22 / dn, -hs2);
  const drn1 = interp(p1, p2, 1 - 22 / dn, hs2);
  lead(g, posts[1], src1, voltageColor(g, g.voltages[1]));
  lead(g, posts[2], drn1, voltageColor(g, g.voltages[2]));

  // The channel, split into six segments with the two middle ones left out:
  // the enhancement-gap gap. Each segment is coloured by the voltage at its
  // start, like upstream's per-segment `setVoltageColor`.
  const segments = 6;
  for (let i = 0; i < segments; i++) {
    if (i === 1 || i === 4) continue;  // enhancement gap
    const a = interp(src1, drn1, i / segments);
    const b = interp(src1, drn1, (i + 1) / segments);
    const v = g.voltages[1] + ((g.voltages[2] - g.voltages[1]) * i) / segments;
    line(g, a, b, voltageColor(g, v));
  }

  // Little perpendicular stubs at the channel ends (MosfetElm.java:403-404).
  const src2 = interp(p1, p2, 1 - 22 / dn, -hs2 * (4 / 3));
  const drn2 = interp(p1, p2, 1 - 22 / dn, hs2 * (4 / 3));
  line(g, src1, src2, voltageColor(g, g.voltages[1]));
  line(g, drn1, drn2, voltageColor(g, g.voltages[2]));

  // The bulk connection: the body ties to the source for an N-channel and the
  // drain for a P-channel, then the body line runs back toward the gate
  // (MosfetElm.java:409-413, :257-262).
  const body0 = interp(posts[1], posts[2], 0.5);
  const body1 = interp(src1, drn1, 0.5);
  const bodyColor = voltageColor(g, g.voltages[pnp ? 2 : 1]);
  line(g, pnp ? posts[2] : posts[1], body0, bodyColor);
  line(g, body0, body1, bodyColor);

  // The arrow on the body distinguishes the channel type: N points from the
  // source side toward the drain side, P the reverse (MosfetElm.java:416-426).
  arrowHead(g, pnp ? body1 : body0, pnp ? body0 : body1, 12, bodyColor);

  // Gate lead and bar (MosfetElm.java:406-408).
  const gate0 = interp(p1, p2, 1 - 28 / dn, hs2 / 2);
  const gate2 = interp(p1, p2, 1 - 28 / dn, -hs2 / 2);
  const gate1 = interp(gate0, gate2, 0.5);
  const gateColor = voltageColor(g, g.voltages[0]);
  lead(g, p1, gate1, gateColor);
  line(g, gate0, gate2, gateColor);

  // Current dots along the source rail, the channel and the drain rail. The
  // channel current is reported drain-to-source for an N-channel, so the dots
  // flow the opposite way along each drawn segment; upstream expresses the
  // same reversal as negated dot counts `-(ids + capCurGS)` on the same
  // segments (MosfetElm.java:315-319). The port's reversal is the reversed
  // segment, because the frame phase already encodes the reported current's
  // sign.
  currentDots(g, src1, posts[1], g.current);
  currentDots(g, drn1, src1, g.current);
  currentDots(g, posts[2], drn1, g.current);
}

export const MOSFET_DEF: ElementDef = {
  kind: 'mosfet',
  label: 'MOSFET',
  category: 'Semiconductors',
  dumpCode: 'f',
  postCount: 3,
  posts: mosfetPosts,
  canMirror: true,
  noDiagonal: true,  // MosfetElm.java:92
  // The channel type is FLAG_PNP (bit 1), not a token; the two legacy tokens
  // are `vt beta`, read defensively and never written upstream (MosfetElm.java:
  // 96-99). This port writes them anyway so a save never loses the model.
  defaults: { pnp: 1, beta: 0.02, threshold: 1.5 },
  parse: (t, e) => {
    e.params.pnp = (e.flags & MOSFET_PNP) !== 0 ? -1 : 1;
    if (t[0] !== undefined && Number.isFinite(Number(t[0]))) e.params.threshold = Number(t[0]);
    if (t[1] !== undefined && Number.isFinite(Number(t[1]))) e.params.beta = Number(t[1]);
  },
  dump: (e) => [e.params.threshold ?? 1.5, e.params.beta ?? 0.02],
  dumpFlags: (e) =>
    (e.params.pnp ?? 1) === -1 ? e.flags | MOSFET_PNP : e.flags & ~MOSFET_PNP,
  fields: [
    // The model choice is upstream's edit item 0 (MosfetElm.java:724-736).
    { name: 'modelName', label: 'Model', type: 'modelChoice', target: 'modelName', modelFamily: 'mosfet' },
    {
      name: 'pnp',
      label: 'Type',
      type: 'choice',
      choices: [
        { value: 1, label: 'N-Channel' },
        { value: -1, label: 'P-Channel' },
      ],
    },
    { name: 'threshold', label: 'Threshold voltage (Vt)' },
    { name: 'beta', label: 'Transconductance (β)' },
  ],
  // The channel, the bulk line and the gate bar span the whole axis at a
  // 16-unit half width (MosfetElm.java:25, 391-402).
  bodyRect: (e) => postsBox(e, 16),
  draw: drawMosfet,
};
