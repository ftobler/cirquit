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
import { MOSFET_PNP } from '../flags';
import { elementColor, postsBox } from '../shared';
import type { CircuitElement, DrawContext, ElementDef, Point } from '../../types';

/** Terminal posts, mirroring JfetElm.setPoints (JfetElm.java:86-98): the gate
 *  at `point1`, the source and drain at `point2` offset `-hs2` and `+hs2`
 *  respectively, where `hs2 = 16*dsign`. Unlike the mosfet there is no
 *  FLAG_FLIP term: a JFET's `hasSwapDS()` is false, so its `setPoints`
 *  recomputes `hs2 = hs*dsign` and ignores the bit (MosfetElm.java:722). */
function jfetPosts(e: CircuitElement): Point[] {
  const [p1, p2] = endpoints(e);
  const hs2 = 16 * dsign(p1, p2);
  const [src, drn] = interp2(p1, p2, 1, -hs2);
  return [p1, src, drn];
}

/**
 * Port of JfetElm.draw (JfetElm.java:52-76): the source and drain rails down
 * to the channel, the gate lead with its junction arrow, and the filled gate
 * bar. The channel itself is implicit: the two stubs end at the bar.
 */
function drawJfet(g: DrawContext, e: CircuitElement): void {
  const [p1, p2] = endpoints(e);
  const posts = jfetPosts(e);
  const pnp = (e.params.pnp ?? 1) === -1;
  const dn = elementLength(e);
  const hs2 = 16 * dsign(p1, p2);

  // Source and drain rails, each two segments from the post to the channel
  // stub beside the gate bar (JfetElm.java:94-96, drawn at :55-59).
  const src1 = interp(p1, p2, 1, -hs2 / 2);
  const drn1 = interp(p1, p2, 1, hs2 / 2);
  const src2 = interp(p1, p2, 1 - 10 / dn, -hs2 / 2);
  const drn2 = interp(p1, p2, 1 - 10 / dn, hs2 / 2);
  lead(g, posts[1], src1, voltageColor(g, g.voltages[1]));
  lead(g, src1, src2, voltageColor(g, g.voltages[1]));
  lead(g, posts[2], drn1, voltageColor(g, g.voltages[2]));
  lead(g, drn1, drn2, voltageColor(g, g.voltages[2]));

  // Gate lead to the gate point, then the junction arrow on the axis: N
  // points from the gate toward the channel, P points back from the channel
  // toward the gate (JfetElm.java:60-62, setPoints at :104-108).
  const gatePt = interp(p1, p2, 1 - 14 / dn);
  const gateColor = voltageColor(g, g.voltages[0]);
  lead(g, p1, gatePt, gateColor);
  if (pnp) {
    const x = interp(gatePt, p1, 18 / dn);
    arrowHead(g, gatePt, x, 8, gateColor);
  } else {
    arrowHead(g, p1, gatePt, 8, gateColor);
  }

  // The filled gate bar straddling the channel, from 1-13/dn to 1-10/dn at
  // ±hs (JfetElm.java:100-103, filled at :64). Upstream colors it volts[0]
  // then calls setPowerColor, which only overrides when power mode is on.
  const [bar0, bar1] = interp2(p1, p2, 1 - 13 / dn, 16);
  const [bar2, bar3] = interp2(p1, p2, 1 - 10 / dn, 16);
  polygon(g, [bar0, bar1, bar3, bar2], elementColor(g, g.voltages[0], g.power));

  // Current dots along each rail, with the sign choices of JfetElm.java:65-74:
  // the source dots run against the reported channel current, the drain dots
  // with it. Upstream draws those as `-ids` on the source runs and `-curcountd`
  // (i.e. `+ids`) on the drain runs; the port's reversal is the reversed
  // segment on the source runs, since the frame phase already carries the
  // reported current's sign. The gate-lead dots upstream draws for
  // `gateCurrent` are omitted because the engine boundary carries one current
  // per element, which for the JFET is the channel current only.
  currentDots(g, src1, posts[1], g.current);
  currentDots(g, src2, src1, g.current);
  currentDots(g, posts[2], drn1, g.current);
  currentDots(g, drn1, drn2, g.current);
}

export const JFET_DEF: ElementDef = {
  kind: 'jfet',
  label: 'JFET',
  category: 'Semiconductors',
  dumpCode: 'j',
  postCount: 3,
  posts: jfetPosts,
  canMirror: true,
  noDiagonal: true,  // JfetElm.java:30
  // Depletion-mode defaults, from Hayes+Horowitz p155 (JfetElm.java:137-139):
  // a negative threshold, so an N-channel with its gate at source voltage
  // already conducts its full saturation current.
  defaults: { pnp: 1, beta: 0.00125, threshold: -4 },
  // The channel type is FLAG_PNP (bit 1), inherited from the mosfet; the two
  // trailing tokens are the legacy `vt beta` pair, read defensively and never
  // written upstream (MosfetElm.java:96-99). This port writes them anyway so
  // a save never loses the model.
  parse: (t, e) => {
    e.params.pnp = (e.flags & MOSFET_PNP) !== 0 ? -1 : 1;
    if (t[0] !== undefined && Number.isFinite(Number(t[0]))) e.params.threshold = Number(t[0]);
    if (t[1] !== undefined && Number.isFinite(Number(t[1]))) e.params.beta = Number(t[1]);
  },
  dump: (e) => [e.params.threshold ?? -4, e.params.beta ?? 0.00125],
  dumpFlags: (e) =>
    (e.params.pnp ?? 1) === -1 ? e.flags | MOSFET_PNP : e.flags & ~MOSFET_PNP,
  fields: [
    // The model choice is upstream's edit item 0 (MosfetElm.java:724-736).
    { name: 'modelName', label: 'Model', type: 'modelChoice', target: 'modelName', modelFamily: 'jfet' },
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
  // The gate bar and the source/drain rails span the whole axis at a 16-unit
  // half width (JfetElm.java:53).
  bodyRect: (e) => postsBox(e, 16),
  draw: drawJfet,
};
