import { currentDotsFrom, interp, interpPrecise, lead, line, voltageColor } from '../../../render/draw';
import { readParams, writeParams, boxOfPoints } from '../shared';
import type { CircuitElement, DrawContext, ElementDef, Point } from '../../types';

/** Half the grid, the gap between the body rectangle's near and far edges
 *  (TransLineElm.java:111). */
const SEP = 8;

interface LineGeometry {
  posts: Point[];
  inner: Point[];
}

/** Port of TransLineElm.setPoints (:106-123). Posts 0 and 1, the two inner
 *  signal posts, sit `width` units off the axis at each end; posts 2 and 3 are
 *  the dragged endpoints themselves. `width` is a file token (default 32), so
 *  a freshly placed line keeps the constructor default and a loaded one its
 *  own value. The `ds` sign flips the offset side like upstream's. */
function lineGeometry(e: CircuitElement): LineGeometry {
  const p1 = { x: e.x1, y: e.y1 };
  const p2 = { x: e.x2, y: e.y2 };
  const width = e.params.width ?? 32;
  const ds = p1.y === p2.y ? Math.sign(p2.x - p1.x) : -Math.sign(p2.y - p1.y);
  const off = -width * ds;
  const p3 = interp(p1, p2, 0, off);
  const p4 = interp(p1, p2, 1, off);
  // The leads land on the near and far edges of the body rectangle, `width/2`
  // plus and minus half a grid square (TransLineElm.java:112-115).
  const near = -(width / 2 - SEP) * ds;
  const far = -(width / 2 + SEP) * ds;
  return {
    posts: [p3, p4, p1, p2],
    inner: [
      interp(p1, p2, 0, far),
      interp(p1, p2, 1, far),
      interp(p1, p2, 0, near),
      interp(p1, p2, 1, near),
    ],
  };
}

function drawTransmissionLine(g: DrawContext, e: CircuitElement): void {
  const { posts, inner } = lineGeometry(e);
  // The body is a filled rectangle between the near and far edges, diagonal to
  // the axis (TransLineElm.java:131-132). Upstream fills dark gray, so the
  // theme carries a dark-grey entry rather than borrowing the text colour.
  g.ctx.fillStyle = g.theme.darkGray;
  g.ctx.fillRect(
    inner[2].x,
    inner[2].y,
    inner[1].x - inner[2].x + 2,
    inner[1].y - inner[2].y + 2,
  );
  for (let i = 0; i < 4; i++) {
    lead(g, posts[i], inner[i], voltageColor(g, g.voltages[i]));
  }
  // The travelling wave: one strip per drawn segment, each coloured by the
  // delay-line voltage at that position, already averaged and resampled to the
  // drawn length by the engine (TransLineElm.java:126-149). Each strip draws
  // the thin boundary line at its near fraction, then the thick band along the
  // near edge; an empty array (no engine, or before the first stamp) falls
  // back to the flat body. `interpPrecise` keeps the band seamless: rounded
  // neighbours would leave a pixel gap between strips.
  if (g.wave.length > 0) {
    const segf = 1 / g.wave.length;
    for (let i = 0; i < g.wave.length; i++) {
      const color = voltageColor(g, g.wave[i]);
      const far = interpPrecise(inner[0], inner[1], i * segf);
      const near = interpPrecise(inner[2], inner[3], i * segf);
      line(g, far, near, color, 1);
      line(g, interpPrecise(inner[2], inner[3], (i + 1) * segf), near, color);
    }
  }
  // The far edge reads as the line's far conductor, drawn over the body in the
  // inner-post colour (TransLineElm.java:150-151).
  line(g, inner[0], inner[1], voltageColor(g, g.voltages[0]));
  // The four dot runs mirror upstream's `-curCount1`/`-curCount2` pairs
  // (TransLineElm.java:154-160): the two runs of each port carry that port's
  // source current, with the inner-post run reversed by swapping its
  // endpoints. Each run steps on its own post phase, so the two ports can
  // carry different currents without dragging each other's speed.
  currentDotsFrom(g, inner[0], posts[0], g.postCurrents[0], g.postDotPhases[0]);
  currentDotsFrom(g, posts[2], inner[2], g.postCurrents[0], g.postDotPhases[0]);
  currentDotsFrom(g, inner[1], posts[1], g.postCurrents[1], g.postDotPhases[1]);
  currentDotsFrom(g, posts[3], inner[3], g.postCurrents[1], g.postDotPhases[1]);
}

export const TRANSMISSION_LINE_DEF: ElementDef = {
  kind: 'transmissionLine',
  label: 'Transmission line',
  category: 'Basics',
  dumpCode: '171',
  postCount: 4,
  posts: (e) => lineGeometry(e).posts,
  noDiagonal: true,  // TransLineElm.java:36
  // Upstream's fresh constructor sets delay = 1000*sim.maxTimeStep = 0.005
  // (TransLineElm.java:42-44), the same value the engine falls back to.
  defaults: { delay: 0.005, imped: 75, width: 32 },
  // The fourth token is the unimplemented series resistance, always 0
  // (TransLineElm.java:45-47); it is consumed here so the line round-trips,
  // but never stored as a parameter.
  parse: (t, e) => readParams(t, e, ['delay', 'imped', 'width']),
  dump: (e) => [...writeParams(['delay', 'imped', 'width'])(e), 0],
  fields: [
    { name: 'delay', label: 'Delay (s)', unit: 's' },
    { name: 'imped', label: 'Impedance', unit: 'Ω' },
  ],
  // The body is the offset rectangle between the near and far conductor edges
  // (TransLineElm.java:131-132), a solid pick zone; the bare leads to the four
  // posts stay out of it, reached by their own posts and the axis.
  bodyRect: (e) => boxOfPoints(lineGeometry(e).inner),
  draw: drawTransmissionLine,
};
