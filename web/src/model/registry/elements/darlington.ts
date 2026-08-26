/**
 * The Darlington pair (DarlingtonElm.java, dump 400): a CompositeElm of two
 * NPN (or PNP) transistors sharing one collector post, with Q1's emitter
 * feeding Q2's base at an internal node. Upstream's model string is
 * `NTransistorElm 1 2 4` and `NTransistorElm 4 2 3`, so the posts are base,
 * collector, emitter and node 4 is the internal Q1-emitter/Q2-base junction.
 */

import {
  arrowHead,
  currentDots,
  dsign,
  elementLength,
  endpoints,
  interp,
  interp2,
  lead,
  polygon,
  voltageColor,
} from '../../../render/draw';
import { elementColor, postsBox } from '../shared';
import type { CircuitElement, DrawContext, ElementDef, Point } from '../../types';

/** One internal transistor's opaque state token on a fresh part: flags, pnp,
 *  lastVbe, lastVbc, beta, the `_`-joined shape the corpus `400` lines carry.
 *  The tokens are convergence seeds for upstream's internal transistors and
 *  are never read by this engine; they exist so a load/save round-trip stays
 *  byte-for-byte. Exported because the XML converter emits it for tags whose
 *  composite state upstream never writes. */
export const DEFAULT_Q_STATE = '0_1_0_0_100';

/** Terminal posts, mirroring DarlingtonElm.setPoints (DarlingtonElm.java:
 *  128-134, :155-157): the base at `point1`, the collector and emitter at
 *  `point2` offset `+hs2` and `-hs2`, where `hs2 = 16*dsign*pnp`. There is no
 *  FLAG_FLIP term: the darlington's bit 1 is the composite's FLAG_ESCAPE, not
 *  a flip flag, and the file sign in `params.pnp` drives the hanging side. */
function darlingtonPosts(e: CircuitElement): Point[] {
  const [p1, p2] = endpoints(e);
  const pnp = (e.params.pnp ?? 1) === -1 ? -1 : 1;
  const [coll, emit] = interp2(p1, p2, 1, 16 * dsign(p1, p2) * pnp);
  return [p1, coll, emit];
}

/** Signed side factor: `dsign*pnp`, the whole `hs2` scaling upstream applies
 *  (DarlingtonElm.java:129). Distinct from the transistor's
 *  `transistorSideFactor`, which folds FLAG_FLIP in; the darlington has no
 *  such flag. */
function darlingtonSideFactor(e: CircuitElement): number {
  const [p1, p2] = endpoints(e);
  const pnp = (e.params.pnp ?? 1) === -1 ? -1 : 1;
  return dsign(p1, p2) * pnp;
}

function drawDarlington(g: DrawContext, e: CircuitElement): void {
  const [p1, p2] = endpoints(e);
  const dn = elementLength(e);
  const side = darlingtonSideFactor(e);
  const back = dn > 0 ? 1 - 16 / dn : 1; // DarlingtonElm.java:138
  const front = dn > 0 ? 1 - 13 / dn : 1; // DarlingtonElm.java:139
  const [coll0, emit0] = interp2(p1, p2, 1, 16 * side);
  const coll20 = interp(p1, p2, 1, 11 * side); // hs2 - 5*dsign*pnp, :135

  // The base bar straddling the axis from the back edge to the front edge,
  // 16 units to each side, filled with the base voltage (DarlingtonElm.java:
  // 138-139, filled at :147).
  const [backTop, backBottom] = interp2(p1, p2, back, 16);
  const [frontTop, frontBottom] = interp2(p1, p2, front, 16);
  polygon(
    g,
    [backTop, frontTop, frontBottom, backBottom],
    elementColor(g, g.voltages[0], g.power),
  );

  // The two collector leads fork off the bar's front edge, 6 and 1 units off
  // the axis, and meet at the collector post (DarlingtonElm.java:134, :141-142,
  // drawn at :68-71).
  const coll1 = interp(p1, p2, front, 6 * side);
  const coll21 = interp(p1, p2, front, side);
  const c = voltageColor(g, g.voltages[1]);
  lead(g, coll0, coll1, c);
  lead(g, coll20, coll21, c);
  lead(g, coll0, coll20, c);

  // The emitter lead to the bar's front edge at 6 units, with its junction
  // arrow: NPN points out toward the terminal, PNP points back in
  // (DarlingtonElm.java:149-154).
  const emit1 = interp(p1, p2, front, -6 * side);
  const eColor = voltageColor(g, g.voltages[2]);
  lead(g, emit0, emit1, eColor);
  if ((e.params.pnp ?? 1) === -1) {
    const pt = interp(p1, p2, dn > 0 ? 1 - 11 / dn : 1, -5 * side);
    arrowHead(g, emit0, pt, 8, eColor);
  } else {
    arrowHead(g, emit1, emit0, 8, eColor);
  }

  // The base lead meets the bar's back edge on the axis.
  const base = interp(p1, p2, back);
  lead(g, p1, base, voltageColor(g, g.voltages[0]));

  // Current dots with the sign choices of DarlingtonElm.java:84-89. Upstream
  // feeds each run the node current: `getCurrentIntoNode(0) = -ib` on the
  // base, `getCurrentIntoNode(1) = -ic` on the collector and
  // `getCurrentIntoNode(2) = -ie` on the emitter, all drawn on the
  // body-to-post segments. Reversing those segments here reproduces the same
  // dot flow for a conducting pair; only the base lead still uses the single
  // reported `ic`, since the engine boundary exposes the collector current
  // only, not the pair's base current.
  currentDots(g, p1, base, g.current);
  currentDots(g, coll0, coll1, g.current);
  currentDots(g, emit1, emit0, g.current);
}

export const DARLINGTON_DEF: ElementDef = {
  kind: 'darlington',
  label: 'Darlington Pair',
  category: 'Semiconductors',
  dumpCode: '400',
  postCount: 3,
  posts: darlingtonPosts,
  canMirror: true, // DarlingtonElm canFlipX (only flipY is forbidden, :161)
  noDiagonal: true, // DarlingtonElm.java:26
  defaults: { pnp: 1 },
  // The line is `... flags <q1 state token> <q2 state token> pnp`
  // (CompositeElm.dump + the pnp, DarlingtonElm.java:46-48): one opaque
  // `_`-joined state token per internal transistor, then the file sign. The
  // tokens are raw on both sides, like the scope's config: upstream escapes
  // them with the composite FLAG_ESCAPE bit when it saves, and the legacy
  // corpus form joins them with `_`, so running them through the netlist
  // escape scheme would corrupt either shape.
  rawTokens: true,
  parse: (t, e) => {
    // The two state tokens are carried verbatim for the round trip; only the
    // trailing pnp token is interpreted. `modelName` is a spare string slot,
    // not a device-model reference: the darlington has no named model.
    if (t[0] !== undefined) e.text = t[0];
    if (t[1] !== undefined) e.modelName = t[1];
    const pnp = Number(t[2]);
    e.params.pnp = Number.isFinite(pnp) ? (pnp < 0 ? -1 : 1) : 1;
  },
  dump: (e) => [
    e.text ?? DEFAULT_Q_STATE,
    e.modelName ?? DEFAULT_Q_STATE,
    (e.params.pnp ?? 1) === -1 ? -1 : 1,
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
  ],
  // The base bar and the collector/emitter fork span the whole axis at a
  // 16-unit half width (DarlingtonElm.java:65).
  bodyRect: (e) => postsBox(e, 16),
  draw: drawDarlington,
};
