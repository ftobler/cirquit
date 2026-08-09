import {
  currentDots,
  endpoints,
  interp,
  interpPrecise,
  interp2Precise,
  line,
  triangle,
  voltageColor,
} from '../../../render/draw';
import { elementColor, readParams } from '../shared';
import { GRID_SIZE } from '../../types';
import type { CircuitElement, DrawContext, ElementDef, Point } from '../../types';

/** Perpendicular offset of the two end plates (TriacElm.java:126-130). */
const HS = 16;
/** Perpendicular offset of the arrow triangles' inner tips (TriacElm.java:
 *  136-139). */
const ARROW_HS = 8;

/** Upstream's `snapGrid` (CirSim.java:536-538): round down to the grid, with
 *  the half-size-minus-one offset the original's bitmask arithmetic applies. */
function snapGrid(x: number): number {
  return Math.floor((x + GRID_SIZE / 2 - 1) / GRID_SIZE) * GRID_SIZE;
}

interface TriacGeometry {
  p1: Point;
  p2: Point;
  lead1: Point;
  lead2: Point;
  gate0: Point;
  gate1: Point;
}

/** The triac body geometry (TriacElm.java:107-153). The element clamps its
 *  free end onto the dominant axis and always measures that axis length for
 *  the leads (unlike the SCR, which only does so under its gate-fix flag), and
 *  branches the gate off the MT1-side lead end at `dir` times the grid step.
 *  The gate post snaps onto the grid, matching upstream's `interpPoint`, so a
 *  wire dropped on it meets the post the file format promises. */
function triacGeometry(e: CircuitElement): TriacGeometry {
  const [p1, p2raw] = endpoints(e);
  const dx = p2raw.x - p1.x;
  const dy = p2raw.y - p1.y;
  const vertical = Math.abs(dy) >= Math.abs(dx);
  // point2 gets clamped onto the dominant axis (TriacElm.java:113-123), so
  // the perpendicular offsets below stay perpendicular.
  const p2 = vertical ? { x: p1.x, y: p2raw.y } : { x: p2raw.x, y: p1.y };
  const dn = Math.abs(vertical ? dy : dx);
  const dir = (vertical ? Math.sign(dy) * Math.sign(dx) : -Math.sign(dx) * Math.sign(dy)) || 1;
  const lead1 = dn < 16 ? p1 : interp(p1, p2, (dn - 16) / (2 * dn));
  const lead2 = dn < 16 ? p2 : interp(p1, p2, (dn + 16) / (2 * dn));
  const leadlen = (dn - 16) / 2;
  const gatelen = GRID_SIZE + (leadlen % GRID_SIZE);
  if (leadlen < gatelen) {
    // Too short for a gate lead: upstream resets the span and leaves the
    // gate post a fresh (0, 0) point (TriacElm.java:146-149).
    return { p1, p2, lead1, lead2, gate0: { x: 0, y: 0 }, gate1: { x: 0, y: 0 } };
  }
  const gate0 = interp(lead2, p2, gatelen / leadlen, gatelen * dir);
  const gate1 = interp(lead2, p2, gatelen / leadlen, GRID_SIZE * 2 * dir);
  return {
    p1,
    p2,
    lead1,
    lead2,
    gate0,
    gate1: { x: snapGrid(gate1.x), y: snapGrid(gate1.y) },
  };
}

/** The triac symbol: two plates across the lead ends and two arrow triangles
 *  pointing into the body at each end, the bidirectional thyristor shape, with
 *  the gate branching off the MT1-side lead end (TriacElm.java:155-196). */
function drawTriac(g: DrawContext, e: CircuitElement): void {
  const { p1, p2, lead1, lead2, gate0, gate1 } = triacGeometry(e);
  line(g, p1, lead1, voltageColor(g, g.voltages[0]));
  line(g, lead2, p2, voltageColor(g, g.voltages[1]));
  // The plates sit across the lead ends, one per main terminal
  // (TriacElm.java:126-130). Body geometry, so the plates and arrow triangles
  // are interpolated without the grid rounding `interp` applies to posts.
  const [pa1, pa2] = interp2Precise(lead1, lead2, 0, HS);
  line(g, pa1, pa2, elementColor(g, g.voltages[0], g.power), 2.5);
  const [pb1, pb2] = interp2Precise(lead1, lead2, 1, HS);
  line(g, pb1, pb2, elementColor(g, g.voltages[1], g.power), 2.5);
  // The arrow triangles, each filled with the voltage of the end its apex
  // faces (TriacElm.java:132-141, :161-170).
  triangle(
    g,
    interpPrecise(lead1, lead2, 0, -ARROW_HS),
    interpPrecise(lead1, lead2, 1, -HS),
    interpPrecise(lead1, lead2, 1, 0),
    elementColor(g, g.voltages[1], g.power),
  );
  triangle(
    g,
    interpPrecise(lead1, lead2, 1, ARROW_HS),
    interpPrecise(lead1, lead2, 0, HS),
    interpPrecise(lead1, lead2, 0, 0),
    elementColor(g, g.voltages[0], g.power),
  );
  const gateColor = voltageColor(g, g.voltages[2]);
  line(g, lead2, gate0, gateColor);
  line(g, gate0, gate1, gateColor);
  currentDots(g, p1, lead2, g.current);
  currentDots(g, p2, lead2, g.current);
}

export const TRIAC_DEF: ElementDef = {
  kind: 'triac',
  label: 'Triac',
  category: 'Semiconductors',
  dumpCode: '206',
  postCount: 3,
  posts: (e) => {
    const geo = triacGeometry(e);
    return [geo.p1, geo.p2, geo.gate1];
  },
  // Defaults from `setDefaults` (TriacElm.java:59-63). The latch state is 0
  // (off) on a fresh part; the file carries it as a "true"/"false" token.
  defaults: { triggerI: 0.01, holdingI: 0.0082, cresistance: 100 },
  // Token order from the token constructor (TriacElm.java:52-55): the three
  // model parameters then the latch state. Upstream's own class never
  // overrides `dump()`, so its text save writes only the x/y/flags fields
  // (the same quirk as the thermistor and LDR); this port writes all four
  // tokens so a save never loses the model.
  parse: (t, e) => {
    readParams(t, e, ['triggerI', 'holdingI', 'cresistance']);
    // The state token is a Java-style boolean string, not a number.
    if (t[3] !== undefined) e.params.state = t[3] === 'true' ? 1 : 0;
  },
  dump: (e) => [
    e.params.triggerI ?? 0.01,
    e.params.holdingI ?? 0.0082,
    e.params.cresistance ?? 100,
    e.params.state ? 'true' : 'false',
  ],
  fields: [
    { name: 'triggerI', label: 'Trigger current', unit: 'A' },
    { name: 'holdingI', label: 'Holding current', unit: 'A' },
    { name: 'cresistance', label: 'Gate-MT1 resistance', unit: 'Ω' },
  ],
  draw: drawTriac,
};
