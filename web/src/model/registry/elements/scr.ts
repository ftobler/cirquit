import {
  currentDots,
  endpoints,
  interp,
  interp2Precise,
  lead,
  line,
  triangle,
  voltageColor,
} from '../../../render/draw';
import { elementColor, readParams } from '../shared';
import { GRID_SIZE } from '../../types';
import type { CircuitElement, DrawContext, ElementDef, Point } from '../../types';

const SCR_GATE_FIX = 1; // SCRElm.java:37
const HS = 8; // SCRElm.java:101

/** Upstream's `snapGrid` (CirSim.java:536-538): round down to the grid, with
 *  the half-size-minus-one offset the original's bitmask arithmetic applies. */
function snapGrid(x: number): number {
  return Math.floor((x + GRID_SIZE / 2 - 1) / GRID_SIZE) * GRID_SIZE;
}

interface ScrGeometry {
  p1: Point;
  p2: Point;
  lead1: Point;
  lead2: Point;
  gate0: Point;
  gate1: Point;
}

/** The SCR body geometry (SCRElm.java:107-145). The element clamps its free
 *  end onto the dominant axis, branches the gate off the cathode-side lead
 *  end at `dir` times the grid step, and snaps the gate post onto the grid,
 *  so the gate lead is always grid-aligned and a wire dropped on it meets
 *  the post the file format promises. */
function scrGeometry(e: CircuitElement): ScrGeometry {
  const [p1, p2raw] = endpoints(e);
  const dx = p2raw.x - p1.x;
  const dy = p2raw.y - p1.y;
  const vertical = Math.abs(dy) >= Math.abs(dx);
  const gateFix = (e.flags & SCR_GATE_FIX) !== 0;
  // point2 gets clamped onto the dominant axis (SCRElm.java:117, :122), so
  // the perpendicular offsets below stay perpendicular.
  const p2 = vertical ? { x: p1.x, y: p2raw.y } : { x: p2raw.x, y: p1.y };
  // The gate-fix flag replaces the diagonal length with the axis length so
  // the lead length, and with it the gate geometry, stays sane on a
  // near-diagonal drag (SCRElm.java:115-122).
  const dn = gateFix ? Math.abs(vertical ? dy : dx) : Math.hypot(dx, dy);
  const dir = (vertical ? Math.sign(dy) * Math.sign(dx) : -Math.sign(dx) * Math.sign(dy)) || 1;
  const lead1 = dn < 16 ? p1 : interp(p1, p2, (dn - 16) / (2 * dn));
  const lead2 = dn < 16 ? p2 : interp(p1, p2, (dn + 16) / (2 * dn));
  const leadlen = (dn - 16) / 2;
  const gatelen = GRID_SIZE + (leadlen % GRID_SIZE);
  if (leadlen < gatelen) {
    // Too short for a gate lead: upstream resets the span and leaves the
    // gate post a fresh (0, 0) point (SCRElm.java:137-140).
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

/** The SCR symbol: an anode triangle pointing at the cathode, a bar across
 *  the cathode-side lead end, and the gate branching off that same point
 *  (SCRElm.java:147-178). */
function drawScr(g: DrawContext, e: CircuitElement): void {
  const { p1, p2, lead1, lead2, gate0, gate1 } = scrGeometry(e);
  lead(g, p1, lead1, voltageColor(g, g.voltages[0]));
  lead(g, lead2, p2, voltageColor(g, g.voltages[1]));
  // Triangle base at the anode-side lead end, apex at the cathode-side end
  // (SCRElm.java:128-131). Body geometry, so the base and bar stay square to
  // the body without the grid rounding `interp` applies to posts.
  const [t1, t2] = interp2Precise(lead1, lead2, 0, HS);
  triangle(g, t1, t2, lead2, elementColor(g, g.voltages[0], g.power));
  // The cathode bar across the lead end, then the gate lead out to its post.
  // The bar is a drawThickLine stroke upstream (SCRElm.java:168), the 3-unit
  // body weight.
  const [c1, c2] = interp2Precise(lead1, lead2, 1, HS);
  line(g, c1, c2, elementColor(g, g.voltages[1], g.power));
  const gateColor = voltageColor(g, g.voltages[2]);
  lead(g, lead2, gate0, gateColor);
  lead(g, gate0, gate1, gateColor);
  currentDots(g, p1, lead2, g.current);
  currentDots(g, p2, lead2, g.current);
}

export const SCR_DEF: ElementDef = {
  kind: 'scr',
  label: 'SCR',
  category: 'Semiconductors',
  dumpCode: '177',
  postCount: 3,
  posts: (e) => {
    const geo = scrGeometry(e);
    return [geo.p1, geo.p2, geo.gate1];
  },
  // The gate-fix bit is set on a fresh part and left to the file by the
  // token constructor, exactly like upstream's two constructors (SCRElm.java:
  // 44, :47-49).
  defaultFlags: SCR_GATE_FIX,
  // Defaults from `setDefaults` (SCRElm.java:64-68). The operating-point
  // tokens are 0 on a fresh part and are read from the file otherwise.
  defaults: { triggerI: 0.01, holdingI: 0.0082, gResistance: 50 },
  // Token order from the token constructor (SCRElm.java:51-59): the two
  // operating-point voltages, then the three model parameters. The last three
  // are optional in the wild, where the corpus files carry only lastvac and
  // lastvag; this port writes all five so a save never loses the parameters.
  parse: (t, e) => {
    readParams(t, e, ['lastvac', 'lastvag', 'triggerI', 'holdingI', 'gResistance']);
  },
  dump: (e) => [
    e.params.lastvac ?? 0,
    e.params.lastvag ?? 0,
    e.params.triggerI ?? 0.01,
    e.params.holdingI ?? 0.0082,
    e.params.gResistance ?? 50,
  ],
  fields: [
    { name: 'triggerI', label: 'Trigger current', unit: 'A' },
    { name: 'holdingI', label: 'Holding current', unit: 'A' },
    { name: 'gResistance', label: 'Gate resistance', unit: 'Ω' },
  ],
  draw: drawScr,
};
