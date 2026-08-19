import {
  bodyRect,
  currentDotsPath,
  endpoints,
  formatValueShort,
  interp,
  interpPrecise,
  interp2Precise,
  label,
  lead,
  line,
  polyline,
  triangle,
  voltageColor,
  ZIGZAG_HS,
  zigzagPoints,
} from '../../../render/draw';
import { POT_FLIP, POT_FLIP_OFFSET, POT_SHOW_VALUES } from '../flags';
import { elementColor, readParams, bodyBox } from '../shared';
import { GRID_SIZE } from '../../types';
import type { CircuitElement, DrawContext, ElementDef, Point } from '../../types';

function drawPotBody(g: DrawContext, e: CircuitElement): void {
  const [p1] = endpoints(e);
  const { end } = potEndpoint(e);
  const dn = Math.hypot(end.x - p1.x, end.y - p1.y);
  const color = elementColor(g, (g.voltages[0] + g.voltages[1]) / 2, g.power);
  // The body spans the normalized span (the snapped end, not the dragged one),
  // as upstream's setPoints snaps point2 before calcLeads (PotElm.java:184-205).
  const f = dn >= 32 ? (dn - 32) / (2 * dn) : 0;
  const lead1 = interp(p1, end, f);
  const lead2 = interp(p1, end, 1 - f);
  lead(g, p1, lead1, voltageColor(g, g.voltages[0]));
  lead(g, lead2, end, voltageColor(g, g.voltages[1]));
  if (g.euroResistors) {
    bodyRect(g, lead1, lead2, 6, color);  // IEC rectangle, hs 6 (PotElm.java:226)
  } else {
    polyline(g, zigzagPoints(lead1, lead2, ZIGZAG_HS), color);
  }

  const wiper = potPosts(e)[2];
  const { corner, arrowPoint, arrowBase } = potWiperGeometry(e);
  const wiperColor = voltageColor(g, g.voltages[2]);
  lead(g, wiper, corner, wiperColor);
  line(g, corner, arrowPoint, wiperColor);
  // The arrowhead is a squat triangle: base half-width 8 a full `clen` back
  // (PotElm.java:213-216).
  triangle(g, arrowPoint, arrowBase[0], arrowBase[1], wiperColor);
  currentDotsPath(g, [p1, lead1, lead2, end], g.current);
  label(g, e, formatValueShort(e.params.maxResistance ?? 0, 'Ω', g.valueDigits), 20);
}

/**
 * The pot's snapped far post and its perpendicular wiper offset, replicating
 * `PotElm.setPoints` (PotElm.java:184-202): the far post snaps to the
 * dominant axis and, on a drag, the wiper offset comes from the perpendicular
 * drag delta instead of a fixed side. The file stores the dragged x2,y2 while
 * the posts use the normalized endpoint, exactly like upstream.
 */
export function potEndpoint(e: CircuitElement): { end: Point; offset: number } {
  const [p1, p2] = endpoints(e);
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  let end = p2;
  let offset = 0;
  if (Math.abs(dx) > Math.abs(dy) !== ((e.flags & POT_FLIP) !== 0)) {
    const myLen = 2 * GRID_SIZE * Math.sign(dx) * Math.ceil(Math.abs(dx) / (2 * GRID_SIZE));
    end = { x: p1.x + myLen, y: p1.y };  // PotElm.java:190-192
    offset = dx < 0 ? dy : -dy;          // PotElm.java:191
  } else {
    const myLen = 2 * GRID_SIZE * Math.sign(dy) * Math.ceil(Math.abs(dy) / (2 * GRID_SIZE));
    if (dy !== 0) {
      end = { x: p1.x, y: p1.y + myLen };  // PotElm.java:196-197
      offset = dy > 0 ? dx : -dx;          // PotElm.java:197
    }
  }
  if (offset === 0)
    offset = (e.flags & POT_FLIP_OFFSET) !== 0 ? -GRID_SIZE : GRID_SIZE;  // PotElm.java:201-202
  return { end, offset };
}

function potPosts(e: CircuitElement): Point[] {
  const [p1] = endpoints(e);
  const { end, offset } = potEndpoint(e);
  return [p1, end, interp(p1, end, 0.5, offset)];  // post3, PotElm.java:209
}

/**
 * The wiper's drawn geometry (PotElm.java:207-216): a corner on the body at
 * the wiper position and its perpendicular offset, an arrow tip between it and
 * the axis, and the squat arrowhead base at the far end of the corner-to-tip
 * segment.
 */
export function potWiperGeometry(e: CircuitElement): {
  corner: Point;
  arrowPoint: Point;
  arrowBase: [Point, Point];
} {
  const [p1] = endpoints(e);
  const { end, offset } = potEndpoint(e);
  const dn = Math.max(1, Math.hypot(end.x - p1.x, end.y - p1.y));
  const soff = Math.trunc(((e.params.position ?? 0.5) - 0.5) * 32);  // PotElm.java:207
  const f = 0.5 + soff / dn;
  const dir = Math.sign(offset) || 1;
  // The wiper corner and arrowhead are body geometry, so they are interpolated
  // without the grid rounding `interp` applies to posts.
  const corner = interpPrecise(p1, end, f, offset);
  const arrowPoint = interpPrecise(p1, end, f, 8 * dir);
  const clen = Math.abs(offset) - 8;
  const frac = clen !== 0 ? (clen - 8) / clen : 0;
  return { corner, arrowPoint, arrowBase: interp2Precise(corner, arrowPoint, frac, 8) };
}

export const POTENTIOMETER_DEF: ElementDef = {
  kind: 'potentiometer',
  label: 'Potentiometer',
  category: 'Basics',
  dumpCode: '174',
  postCount: 3,
  posts: potPosts,
  canMirror: true,
  defaultFlags: POT_SHOW_VALUES,  // PotElm.java:51
  defaults: { maxResistance: 1000, position: 0.5 },
  // Upstream joins every remaining token into the slider caption with single
  // spaces and never escapes it (PotElm.java:58-62), so the tokens stay raw
  // in both directions. Its own writer dropped these three tokens when the
  // save path moved to XML; its reader still requires them.
  rawTokens: true,
  parse: (t, e) => {
    readParams(t, e, ['maxResistance', 'position']);
    if (t.length > 2) e.text = t.slice(2).join(' ');
  },
  dump: (e) => {
    // An empty caption would write a trailing empty token and shift nothing
    // into `sliderText`, so fall back to the constructor's default.
    const text = e.text?.trim() ? e.text.trim() : 'Resistance';  // PotElm.java:50
    return [e.params.maxResistance ?? 1000, e.params.position ?? 0.5, ...text.split(/\s+/)];
  },
  fields: [
    { name: 'maxResistance', label: 'Max resistance', unit: 'Ω' },
    { name: 'position', label: 'Wiper position', min: 0, max: 1 },
  ],
  // The resistor body (the 32-long zigzag or the IEC box), a solid pick zone;
  // the wiper lead and arrow reach their own post, so they stay out of the box
  // (PotElm.java:226-230's hs 6/8).
  bodyRect: (e) => bodyBox(e, 32, 8),
  draw: drawPotBody,
};
