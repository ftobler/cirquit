import {
  calcLeads,
  currentDotsPath,
  drawLeads,
  endpoints,
  fuseColor,
  interp,
  polyline,
  voltageColor,
} from '../../../render/draw';
import { bodyBox, twoPosts, readParams } from '../shared';
import type { CircuitElement, DrawContext, ElementDef, Point } from '../../types';

/** Body length upstream's `setPoints` uses for the default (non-IEC) symbol
 *  (FuseElm.java:76-80). The IEC-symbol variant isn't wired up here (see
 *  `drawFuseBody`), so this is the only length used. */
const FUSE_BODY_LENGTH = 16;

/**
 * A wavy "melting wire" while intact, matching upstream's un-blown,
 * non-IEC-symbol draw path: 16 segments of a sine wave across the body
 * (FuseElm.java:107-140). The melt fraction in `g.state` (the engine's
 * `heat / i2t`) tints the wire through `fuseColor` and, at or above 1, drops
 * the body entirely: the leads alone are the open gap upstream leaves when a
 * fuse pops (FuseElm.java:121-127).
 */
function drawFuseBody(g: DrawContext, e: CircuitElement): void {
  const [lead1, lead2] = calcLeads(e, FUSE_BODY_LENGTH);
  drawLeads(g, e, lead1, lead2);
  if (g.state < 1) {
    const segments = 16;
    const pts: Point[] = [];
    for (let i = 0; i <= segments; i++) {
      pts.push(interp(lead1, lead2, i / segments, 6 * Math.sin((i * Math.PI * 2) / segments)));
    }
    // Upstream strokes the whole melting wire with one getTempColor
    // (FuseElm.java:119), so the body is a flat heat-tinted colour, not the
    // voltage gradient a resistor body gets: a fuse near its rating warms
    // visibly before it goes.
    polyline(g, pts, fuseColor(voltageColor(g, g.voltages[0]), g.state));
  }
  const [p1, p2] = endpoints(e);
  currentDotsPath(g, [p1, lead1, lead2, p2], g.current);
}

export const FUSE_DEF: ElementDef = {
  kind: 'fuse',
  label: 'Fuse',
  category: 'Basics',
  // getDumpType() returns the int 404, not a char (FuseElm.java:67).
  dumpCode: '404',
  postCount: 2,
  posts: twoPosts,
  // FuseElm.java's no-args constructor: a Littelfuse 218-series rating
  // (FuseElm.java:34-39).
  defaults: { resistance: 0.0613, i2t: 6.73 },
  // dump()/the token constructor both go resistance, i2t, heat, blown
  // (FuseElm.java:43-49); blown is a literal `true`/`false` token like a
  // switch's momentary flag, not a number. `e.state` carries the live blown
  // the engine reports (switch-style), so a fuse that pops in-session saves
  // as blown and reloads blown.
  parse: (t, e) => {
    readParams(t, e, ['resistance', 'i2t', 'heat']);
    e.params.blown = t[3] === 'true' ? 1 : 0;
    e.state = e.params.blown;
  },
  dump: (e) => [
    e.params.resistance ?? 0.0613,
    e.params.i2t ?? 6.73,
    e.params.heat ?? 0,
    (e.state ?? e.params.blown ?? 0) !== 0 ? 'true' : 'false',
  ],
  fields: [
    { name: 'resistance', label: 'Resistance', unit: 'Ω' },
    { name: 'i2t', label: 'I²t rating', unit: 'A²s' },
  ],
  // The melting-wire body spans the 16-long span at a 6-unit half-amplitude
  // (FuseElm.java:76-80, 107-140), a solid pick zone while intact.
  bodyRect: (e) => bodyBox(e, FUSE_BODY_LENGTH, 6),
  draw: drawFuseBody,
};
