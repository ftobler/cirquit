/**
 * Three-phase induction motor (ThreePhaseMotorElm.java, dump 427). Six posts
 * in three phase pairs: posts 0, 2, 4 are the phase-1 leads, posts 1, 3, 5 the
 * phase-2 leads. The body is a circle around the axis midpoint with three
 * rotor spoke lines across it, and each phase pair hangs off the axis at a
 * 32-unit perpendicular offset (ThreePhaseMotorElm.java:86-95).
 */

import {
  canvasFont,
  circle,
  currentDots,
  endpoints,
  interp,
  isHighlighted,
  lead,
  line,
  voltageColor,
} from '../../../render/draw';
import { elementColor, readParams, boxOfPoints } from '../shared';
import type { CircuitElement, DrawContext, ElementDef, Point } from '../../types';

/** Motor body radius (ThreePhaseMotorElm.java:272). */
const CR = 37;
/** Perpendicular lead spacing between the phase pairs (ThreePhaseMotorElm.java:88-91). */
const PHASE_SPACING = 32;
const PHASE_LABELS = ['U', 'V', 'W'];

/** The axis direction sign upstream's setPoints derives from which axis the
 *  drag dominates (`q = (|dy| > |dx|) ? -1 : 1`, ThreePhaseMotorElm.java:86).
 *  Unlike `dsign` it is not the drag's sign, so a right-to-left motor still
 *  stacks U above V above W. */
function motorAxis(e: CircuitElement): { p1: Point; p2: Point; q: number } {
  const [p1, p2] = endpoints(e);
  const q = Math.abs(p2.y - p1.y) > Math.abs(p2.x - p1.x) ? -1 : 1;
  return { p1, p2, q };
}

/** The six posts, in upstream's order: phase i's first lead at `f = 0` and its
 *  second at `f = 1`, offset `∓q·32·(i-1)` (ThreePhaseMotorElm.java:88-91). */
function motorPosts(e: CircuitElement): Point[] {
  const { p1, p2, q } = motorAxis(e);
  const posts: Point[] = [];
  for (let i = 0; i < 3; i++) {
    posts[2 * i] = interp(p1, p2, 0, -q * PHASE_SPACING * (i - 1));
    posts[2 * i + 1] = interp(p1, p2, 1, q * PHASE_SPACING * (i - 1));
  }
  return posts;
}

/** The lead-in points, the same offsets at `f = 0.45` / `0.55`
 *  (ThreePhaseMotorElm.java:89-91). */
function motorLeads(e: CircuitElement): Point[] {
  const { p1, p2, q } = motorAxis(e);
  const leads: Point[] = [];
  for (let i = 0; i < 3; i++) {
    leads[2 * i] = interp(p1, p2, 0.45, -q * PHASE_SPACING * (i - 1));
    leads[2 * i + 1] = interp(p1, p2, 0.55, q * PHASE_SPACING * (i - 1));
  }
  return leads;
}

/** Upstream's `interpPointFix` (ThreePhaseMotorElm.java:348-353): like `interp`
 *  but the perpendicular displacement scales with the raw axis delta rather
 *  than the unit normal, and the result rounds with Math.round. Only the
 *  cosmetic rotor spokes use it, so the rounding difference never touches a
 *  terminal position. */
function interpFix(a: Point, b: Point, f: number, g: number): Point {
  const gx = b.y - a.y;
  const gy = a.x - b.x;
  return {
    x: Math.round(a.x * (1 - f) + b.x * f + g * gx),
    y: Math.round(a.y * (1 - f) + b.y * f + g * gy),
  };
}

function drawMotor(g: DrawContext, e: CircuitElement): void {
  const { p1, p2 } = motorAxis(e);
  const posts = motorPosts(e);
  const leads = motorLeads(e);
  for (let i = 0; i < 6; i++) {
    lead(g, posts[i], leads[i], voltageColor(g, g.voltages[i]));
  }

  const center = interp(p1, p2, 0.5);
  const bodyColor = elementColor(g, (g.voltages[0] + g.voltages[2] + g.voltages[4]) / 3, g.power);
  // The body and hub are filled discs; on hover or selection the fill drops
  // out so the two circles read as outlines instead of a solid block.
  const filled = !isHighlighted(g);
  circle(g, center, CR, bodyColor, filled);
  circle(g, center, Math.trunc(CR / 2.2), g.theme.text, filled);

  // The three rotor spoke lines, rotated by the live rotor angle the engine
  // ships in `g.state` (the same channel the DC motor uses). The angle is
  // rounded to 1/300 rad like upstream's `angleAux`
  // (ThreePhaseMotorElm.java:299) so a slow frame cannot make the spokes
  // jitter.
  const dn = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  if (dn > 0) {
    const qs = 0.28 * 1.7 * (36 / dn) * (CR / 27);  // ThreePhaseMotorElm.java:303
    const angle = Math.round((g.state ?? 0) * 300) / 300;
    for (let k = 0; k < 3; k++) {
      const a = angle + (k * Math.PI) / 3;
      const s1 = interpFix(p1, p2, 0.5 + qs * Math.cos(a), qs * Math.sin(a));
      const s2 = interpFix(p1, p2, 0.5 - qs * Math.cos(a), -qs * Math.sin(a));
      line(g, s1, s2, g.theme.text, 6);
    }
  }

  // Phase labels, ported from upstream's "UVW" strings: centred over a
  // horizontal body, left-anchored beside a vertical one
  // (ThreePhaseMotorElm.java:323-337).
  const horizontal = Math.abs(p2.y - p1.y) <= Math.abs(p2.x - p1.x);
  g.ctx.fillStyle = g.theme.text;
  g.ctx.font = canvasFont(g.valueFontSize);
  g.ctx.textBaseline = 'middle';
  if (horizontal) {
    g.ctx.textAlign = 'center';
    for (let i = 0; i < 3; i++) {
      g.ctx.fillText(`${PHASE_LABELS[i]}1`, posts[2 * i].x + 11, posts[2 * i].y - 7);
      g.ctx.fillText(`${PHASE_LABELS[i]}2`, posts[2 * i + 1].x - 11, posts[2 * i + 1].y - 7);
    }
  } else {
    g.ctx.textAlign = 'left';
    for (let i = 0; i < 3; i++) {
      g.ctx.fillText(`${PHASE_LABELS[i]}1`, posts[2 * i].x + 5, posts[2 * i].y + 8);
      g.ctx.fillText(`${PHASE_LABELS[i]}2`, posts[2 * i + 1].x + 5, posts[2 * i + 1].y - 2);
    }
  }

  // Current dots on the phase leads (ThreePhaseMotorElm.java:285-289). Only
  // one current value crosses the engine boundary, so all three phases share
  // the U-phase current.
  for (let i = 0; i < 3; i++) {
    currentDots(g, posts[2 * i], leads[2 * i], g.current);
    currentDots(g, leads[2 * i + 1], posts[2 * i + 1], g.current);
  }
}

export const THREE_PHASE_MOTOR_DEF: ElementDef = {
  kind: 'threePhaseMotor',
  label: '3-Phase Motor',
  category: 'Basics',
  dumpCode: '427',
  postCount: 6,
  posts: motorPosts,
  defaultLength: 9,  // 144 px, the bundled 3motor.txt span
  defaults: {
    Rs: 0.435,
    Rr: 0.816,
    Ls: 0.0294,
    Lr: 0.0297,
    lm: 0.0287,
    b: 0.05,
    J: 1,
  },
  // The token order is `Rs Rr Ls Lr Lm b J` (ThreePhaseMotorElm.java:43-51);
  // the trailing `J` is optional upstream and defaults to 1. Upstream's class
  // never overrides dump(), so its own text save would write only the common
  // fields; this port writes all seven, the thermistor/LDR fix, so a save
  // never loses the model.
  parse: (t, e) => readParams(t, e, ['Rs', 'Rr', 'Ls', 'Lr', 'lm', 'b', 'J']),
  dump: (e) => [
    e.params.Rs ?? 0.435,
    e.params.Rr ?? 0.816,
    e.params.Ls ?? 0.0294,
    e.params.Lr ?? 0.0297,
    e.params.lm ?? 0.0287,
    e.params.b ?? 0.05,
    e.params.J ?? 1,
  ],
  fields: [
    { name: 'Ls', label: 'Stator inductance', unit: 'H' },
    { name: 'Lr', label: 'Rotor inductance', unit: 'H' },
    { name: 'lm', label: 'Mutual inductance', unit: 'H' },
    { name: 'Rs', label: 'Stator resistance', unit: 'Ω' },
    { name: 'Rr', label: 'Rotor resistance', unit: 'Ω' },
    { name: 'b', label: 'Friction coefficient', unit: 'Nms/rad' },
    { name: 'J', label: 'Moment of inertia', unit: 'kg·m²' },
  ],
  // The 37-radius rotor disc is a solid pick zone (ThreePhaseMotorElm.java:278).
  bodyRect: (e) => {
    const [p1, p2] = endpoints(e);
    const center = interp(p1, p2, 0.5);
    return boxOfPoints([
      { x: center.x - CR, y: center.y - CR },
      { x: center.x + CR, y: center.y + CR },
    ]);
  },
  draw: drawMotor,
};
