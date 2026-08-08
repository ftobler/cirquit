import { currentDots, interp, line, voltageColor } from '../../../render/draw';
import { readParams, writeParams } from '../shared';
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
  // the axis (TransLineElm.java:131-132). Upstream fills dark gray; the port's
  // theme has no dark gray, so the text colour stands in.
  g.ctx.fillStyle = g.theme.text;
  g.ctx.fillRect(
    inner[2].x,
    inner[2].y,
    inner[1].x - inner[2].x + 2,
    inner[1].y - inner[2].y + 2,
  );
  for (let i = 0; i < 4; i++) {
    line(g, posts[i], inner[i], voltageColor(g, g.voltages[i]));
  }
  // The far edge reads as the line's far conductor, drawn over the body in the
  // inner-post colour (TransLineElm.java:150-151). The animated wave segments
  // are skipped: the ring buffer never crosses the engine boundary.
  line(g, inner[0], inner[1], voltageColor(g, g.voltages[0]));
  currentDots(g, posts[0], inner[0], g.current);
  currentDots(g, inner[2], posts[2], g.current);
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
  draw: drawTransmissionLine,
};
