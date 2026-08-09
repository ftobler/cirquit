import {
  calcLeads,
  currentDotsPath,
  drawLeads,
  endpoints,
  gradientPolyline,
  interp,
} from '../../../render/draw';
import { twoPosts, readParams } from '../shared';
import type { CircuitElement, DrawContext, ElementDef, Point } from '../../types';

/** Body length upstream's `setPoints` uses for the default (non-IEC) symbol
 *  (FuseElm.java:76-80). The IEC-symbol variant isn't wired up here (see
 *  `drawFuseBody`), so this is the only length used. */
const FUSE_BODY_LENGTH = 16;

/**
 * A wavy "melting wire" while intact, matching upstream's un-blown,
 * non-IEC-symbol draw path: 16 segments of a sine wave across the body
 * (FuseElm.java:107-140). Upstream also tints the body by accumulated heat
 * (`getTempColor`); that needs the engine to report heat back per frame,
 * which nothing else here does yet (only voltages and currents round-trip),
 * so this uses the same voltage colouring every other two-terminal body
 * does instead. A blown fuse draws no body at all, just the leads — the open
 * gap upstream leaves behind.
 */
function drawFuseBody(g: DrawContext, e: CircuitElement): void {
  const [lead1, lead2] = calcLeads(e, FUSE_BODY_LENGTH);
  drawLeads(g, e, lead1, lead2);
  if ((e.params.blown ?? 0) === 0) {
    const segments = 16;
    const pts: Point[] = [];
    for (let i = 0; i <= segments; i++) {
      pts.push(interp(lead1, lead2, i / segments, 6 * Math.sin((i * Math.PI * 2) / segments)));
    }
    // The melting wire is the current path, so it shades along the voltage
    // drop like the resistor body (the sweep's rule: a gradient belongs where
    // current flows through continuous material).
    gradientPolyline(g, pts);
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
  // switch's momentary flag, not a number.
  parse: (t, e) => {
    readParams(t, e, ['resistance', 'i2t', 'heat']);
    e.params.blown = t[3] === 'true' ? 1 : 0;
  },
  dump: (e) => [
    e.params.resistance ?? 0.0613,
    e.params.i2t ?? 6.73,
    e.params.heat ?? 0,
    (e.params.blown ?? 0) !== 0 ? 'true' : 'false',
  ],
  fields: [
    { name: 'resistance', label: 'Resistance', unit: 'Ω' },
    { name: 'i2t', label: 'I²t rating', unit: 'A²s' },
  ],
  draw: drawFuseBody,
};
