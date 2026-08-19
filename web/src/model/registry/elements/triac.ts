import {
  currentDotsFrom,
  dotPhaseAfter,
  endpoints,
  interp,
  interpPrecise,
  interp2Precise,
  lead,
  line,
  triangle,
  voltageColor,
} from '../../../render/draw';
import { elementColor, readParams, boxOfPoints } from '../shared';
import { GRID_SIZE } from '../../types';
import { TOO_FAST } from '../../../render/dots';
import type { CircuitElement, DrawContext, ElementDef, Point } from '../../types';

/** Perpendicular offset of the two end plates (TriacElm.java:126-130). */
const HS = 16;
/** Perpendicular offset of the arrow triangles' inner tips (TriacElm.java:
 *  136-139). */
const ARROW_HS = 8;

/** Negate a phase for the post-anchored runs, keeping the TOO_FAST sentinel
 *  positive so currentDotsFrom still draws the flow line. */
function negPhase(phase: number): number {
  return phase === TOO_FAST ? TOO_FAST : -phase;
}

/** Upstream's `snapGrid` (CirSim.java:536-538): round down to the grid, with
 *  the half-size-minus-one offset the original's bitmask arithmetic applies. */
function snapGrid(x: number): number {
  return Math.floor((x + GRID_SIZE / 2 - 1) / GRID_SIZE) * GRID_SIZE;
}

export interface TriacGeometry {
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
export function triacGeometry(e: CircuitElement): TriacGeometry {
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
  lead(g, p1, lead1, voltageColor(g, g.voltages[0]));
  lead(g, lead2, p2, voltageColor(g, g.voltages[1]));
  // The plates sit across the lead ends, one per main terminal
  // (TriacElm.java:126-130). Body geometry, so the plates and arrow triangles
  // are interpolated without the grid rounding `interp` applies to posts.
  const [pa1, pa2] = interp2Precise(lead1, lead2, 0, HS);
  // The plates are drawThickLine strokes upstream (TriacElm.java:164-167),
  // the 3-unit body weight.
  line(g, pa1, pa2, elementColor(g, g.voltages[0], g.power));
  const [pb1, pb2] = interp2Precise(lead1, lead2, 1, HS);
  line(g, pb1, pb2, elementColor(g, g.voltages[1], g.power));
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
  lead(g, lead2, gate0, gateColor);
  lead(g, gate0, gate1, gateColor);

  // One dot run per terminal, each anchored at its POST and integrated in the
  // flow direction (TriacElm.java:181-184), so a dot sits on the post when the
  // phase wraps to a multiple of DOT_SPACING, the same residue a connecting
  // wire's run uses, and the train is phase-continuous across the element
  // boundary. `postCurrents[i]` is the engine's `current_into_node(i)`, the
  // negation of the terminal current, so the runs pass the negated phase
  // (TOO_FAST preserved) to keep the crawl direction while the boundary
  // residue aligns: entering at the MT2 (`postCurrents[0] < 0`) crawls post to
  // body, leaving at the MT1 (`postCurrents[1] > 0`) crawls body to post, each
  // at its own speed; the gate pulse rides on post 2.
  currentDotsFrom(g, p1, lead2, g.postCurrents[0], negPhase(g.postDotPhases[0]));
  currentDotsFrom(g, p2, lead2, g.postCurrents[1], negPhase(g.postDotPhases[1]));
  // The gate is one continuous train across both segments, anchored at the
  // gate post like the others, the second run phase-offset by the first
  // segment's length so the dots keep their spacing across the corner
  // (TriacElm.java:182-184). Skipped on the degenerate case: a span too short
  // for a gate lead leaves gate0 at the (0,0) sentinel, and the run would
  // smear dots from the origin into the body.
  if (gate0.x !== 0 || gate0.y !== 0) {
    const gatePhase = negPhase(g.postDotPhases[2]);
    currentDotsFrom(g, gate1, gate0, g.postCurrents[2], gatePhase);
    currentDotsFrom(
      g,
      gate0,
      lead2,
      g.postCurrents[2],
      dotPhaseAfter(gatePhase, Math.hypot(gate1.x - gate0.x, gate1.y - gate0.y)),
    );
  }
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
  // The two plates at the lead ends span the 16-unit half-width, and the arrow
  // triangles ride inside them, so the body box covers the plate pair
  // (TriacElm.java:164-170); the gate lead is its own, reached by its post.
  bodyRect: (e) => {
    const geo = triacGeometry(e);
    const [pa1, pa2] = interp2Precise(geo.lead1, geo.lead2, 0, HS);
    const [pb1, pb2] = interp2Precise(geo.lead1, geo.lead2, 1, HS);
    return boxOfPoints([pa1, pa2, pb1, pb2]);
  },
  draw: drawTriac,
};
