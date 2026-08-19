/**
 * DC motor (DCMotorElm.java, dump 415): a two-terminal part whose armature
 * current drives an inertia loop through a torque constant, with the back-EMF
 * opposing the armature drive. The engine exposes the rotor angle as the live
 * `state`, which the draw rotates the three spokes by, times the gear ratio.
 * The body is a grey circle with a dark hub and three spoke lines, the same
 * rotor geometry as the three-phase motor but at the DC motor's smaller 18 px
 * radius (DCMotorElm.java:172-218).
 */

import {
  calcLeads,
  circle,
  currentDots,
  drawLeads,
  endpoints,
  interp,
  isHighlighted,
  line,
} from '../../../render/draw';
import { readParams, twoPosts, bodyBox } from '../shared';
import type { CircuitElement, DrawContext, ElementDef, Point } from '../../types';

/** Motor body radius (DCMotorElm.java:174). */
const CR = 18;
/** The body and hub fills upstream paints with fixed greys (DCMotorElm.java:181-184). */
const BODY_GREY = '#a5a5a5';
const HUB_DARK = '#0a0a0a';

/** Upstream's `interpPointFix` (DCMotorElm.java:213-218): like `interp` but the
 *  perpendicular displacement scales with the raw axis delta rather than the
 *  unit normal, and the result rounds with Math.round. Only the cosmetic
 *  rotor spokes use it, so the rounding difference never touches a terminal. */
function interpFix(a: Point, b: Point, f: number, g: number): Point {
  const gx = b.y - a.y;
  const gy = a.x - b.x;
  return {
    x: Math.round(a.x * (1 - f) + b.x * f + g * gx),
    y: Math.round(a.y * (1 - f) + b.y * f + g * gy),
  };
}

function drawDcMotor(g: DrawContext, e: CircuitElement): void {
  const [p1, p2] = endpoints(e);
  const [lead1, lead2] = calcLeads(e, 36);
  drawLeads(g, e, lead1, lead2);
  currentDots(g, p1, lead1, g.current);
  currentDots(g, lead2, p2, g.current);

  const center = interp(p1, p2, 0.5);
  // On hover or selection the fills drop out so the two circles read as
  // outlines, the three-phase motor's highlight behaviour.
  const filled = !isHighlighted(g);
  circle(g, center, CR, BODY_GREY, filled);
  circle(g, center, Math.trunc(CR / 2.2), HUB_DARK, filled);

  // The three rotor spoke lines, rotated by the live angle times the gear
  // ratio. The angle is rounded to 1/300 rad like upstream's `angleAux`
  // (DCMotorElm.java:187) so a slow frame cannot make the spokes jitter.
  const dn = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  if (dn > 0) {
    const gear = e.params.gearRatio ?? 1;
    const angle = Math.round((g.state ?? 0) * 300) / 300;
    for (let k = 0; k < 3; k++) {
      const a = angle * gear + (k * Math.PI) / 3;
      const s1 = interpFix(lead1, lead2, 0.5 + 0.28 * Math.cos(a), 0.28 * Math.sin(a));
      const s2 = interpFix(lead1, lead2, 0.5 - 0.28 * Math.cos(a), -0.28 * Math.sin(a));
      line(g, s1, s2, HUB_DARK, 6);
    }
  }
}

export const DC_MOTOR_DEF: ElementDef = {
  kind: 'dcMotor',
  label: 'DC Motor',
  category: 'Basics',
  dumpCode: '415',
  postCount: 2,
  posts: twoPosts,
  defaultLength: 6, // 96 px, the base getDragLength
  // Token order `inductance resistance K Kb J b gearRatio tau`
  // (DCMotorElm.java:40-47). Upstream's class never overrides dump(), so its
  // own text save would write only the common fields; this port writes all
  // eight, the thermistor/LDR fix, so a save never loses the model.
  defaults: {
    inductance: 0.5,
    resistance: 1,
    K: 0.15,
    Kb: 0.15,
    J: 0.02,
    b: 0.05,
    gearRatio: 1,
    tau: 0,
  },
  parse: (t, e) =>
    readParams(t, e, ['inductance', 'resistance', 'K', 'Kb', 'J', 'b', 'gearRatio', 'tau']),
  dump: (e) => [
    e.params.inductance ?? 0.5,
    e.params.resistance ?? 1,
    e.params.K ?? 0.15,
    // Kb is the same physical quantity as K (the torque edit moves both), so
    // a save writes the stored Kb and falls back to K when a file left it
    // out.
    e.params.Kb ?? e.params.K ?? 0.15,
    e.params.J ?? 0.02,
    e.params.b ?? 0.05,
    e.params.gearRatio ?? 1,
    e.params.tau ?? 0,
  ],
  fields: [
    { name: 'inductance', label: 'Armature inductance', unit: 'H' },
    { name: 'resistance', label: 'Armature Resistance', unit: 'Ω' },
    { name: 'K', label: 'Torque constant', unit: 'Nm/A' },
    { name: 'J', label: 'Moment of inertia', unit: 'kg·m²' },
    { name: 'b', label: 'Friction coefficient', unit: 'Nms/rad' },
    { name: 'gearRatio', label: 'Gear Ratio' },
  ],
  // The 18-radius rotor disc is a solid pick zone (DCMotorElm.java:176).
  bodyRect: (e) => bodyBox(e, 36, CR),
  draw: drawDcMotor,
};
