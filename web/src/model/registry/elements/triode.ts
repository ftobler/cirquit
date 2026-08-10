import {
  circle,
  currentDots,
  dsign,
  elementLength,
  endpoints,
  interp,
  interp2,
  lead,
  line,
  voltageColor,
} from '../../../render/draw';
import { elementColor, readParams } from '../shared';
import { TRIODE_FLIP, TRIODE_DSIGN_FIX } from '../flags';
import type { CircuitElement, DrawContext, ElementDef, Point } from '../../types';

/** Radius of the tube envelope (TriodeElm.java:85). */
const CIRCLER = 24;
/** Half-width of the plate bar across the top (TriodeElm.java:82). */
const PLATE_W = 18;

/** Signed electrode side factor (TriodeElm.java:71-73): `dsign` while
 *  FLAG_DSIGN_FIX is set, else a fixed 1, negated by FLAG_FLIP. The corpus
 *  `173` lines carry flags 0, so their electrodes hang off the fixed side
 *  regardless of the drag direction. */
function triodeSide(e: CircuitElement): number {
  const [p1, p2] = endpoints(e);
  let s = (e.flags & TRIODE_DSIGN_FIX) !== 0 ? dsign(p1, p2) : 1;
  if ((e.flags & TRIODE_FLIP) !== 0) s = -s;
  return s;
}

interface TriodeGeometry {
  p1: Point;
  p2: Point;
  plate0: Point;
  plate1: Point;
  plate2: Point;
  plate3: Point;
  cath0: Point;
  cath1: Point;
  cath2: Point;
  cath3: Point;
  midcath: Point;
  grid: Point[];
}

/** The triode body geometry (TriodeElm.java:69-99). The grid is `point1`; the
 *  plate post hangs off `point2` at `farw = 32*s`, and the cathode post at
 *  `-farw/nearw = -4` along the `point2`-to-`plate1` segment, which puts the
 *  three posts on the grid, top and bottom of the tube as the corpus wires
 *  expect. */
function triodeGeometry(e: CircuitElement): TriodeGeometry {
  const [p1, p2] = endpoints(e);
  const s = triodeSide(e);
  const nearw = 8 * s;
  const farw = 32 * s;
  const cathw = 16 * s;
  const dn = elementLength(e);

  // The plate electrode: the lead from the post down to the tube and the bar
  // across the top (TriodeElm.java:78-83).
  const plate1 = interp(p1, p2, 1, nearw);
  const plate0 = interp(p1, p2, 1, farw);
  const [plate2, plate3] = interp2(p2, plate1, 1, PLATE_W);

  // The grid lead from `point1` to the tube edge, then the four grid wires
  // filling the circle (TriodeElm.java:77, :85-91). The pair list is
  // `(p1, grid1), (g2, g3), (g4, g5), (g6, g7)`.
  const grid = [p1];
  grid.push(interp(p1, p2, (dn - CIRCLER) / dn));
  for (let i = 0; i < 3; i++) {
    grid.push(interp(grid[1], p2, (i * 3 + 1) / 4.5));
    grid.push(interp(grid[1], p2, (i * 3 + 2) / 4.5));
  }

  // The cathode basket below the circle centre (TriodeElm.java:94-98). The
  // post hangs at `-farw/nearw = -4` along the `point2`-to-`plate1` segment,
  // which is exactly `farw` back from `point2` on the other side of the axis.
  const midcath = interp(p1, p2, 1, -nearw);
  const [cath1, cath2] = interp2(p2, plate1, -1, cathw);
  const cath3 = interp(p2, plate1, -1.2, -cathw);
  const cath0 = interp(p2, plate1, -4, cathw);

  return { p1, p2, plate0, plate1, plate2, plate3, cath0, cath1, cath2, cath3, midcath, grid };
}

/** The vacuum-tube triode symbol: the tube envelope circle, the plate bar
 *  across the top, the grid wires through the middle and the cathode basket
 *  below (TriodeElm.java:101-133). */
function drawTriode(g: DrawContext, e: CircuitElement): void {
  const geo = triodeGeometry(e);
  // The tube envelope, drawn first so the electrodes sit on top
  // (TriodeElm.java:103).
  circle(g, geo.p2, CIRCLER, g.theme.wire, false);
  // Plate: the lead to its post and the top bar (TriodeElm.java:106-110).
  const plateColor = elementColor(g, g.voltages[0], g.power);
  lead(g, geo.plate0, geo.plate1, plateColor);
  line(g, geo.plate2, geo.plate3, plateColor);
  // Grid: the four wires through the tube plus the lead from the grid post
  // (TriodeElm.java:111-116).
  const gridColor = elementColor(g, g.voltages[1], g.power);
  for (let i = 0; i < geo.grid.length; i += 2) lead(g, geo.grid[i], geo.grid[i + 1], gridColor);
  // Cathode: the three-segment basket, coloured with the cathode voltage only
  // (upstream's `setPowerColor(0)`, TriodeElm.java:117-121).
  const cathodeColor = voltageColor(g, g.voltages[2]);
  lead(g, geo.cath0, geo.cath1, cathodeColor);
  lead(g, geo.cath1, geo.cath2, cathodeColor);
  lead(g, geo.cath2, geo.cath3, cathodeColor);
  // Current dots along the plate-to-cathode conduction path (TriodeElm.java:
  // 123-131). The grid-lead dots upstream draws for `curcountg` are omitted:
  // the engine boundary carries one current per element, the cathode current.
  currentDots(g, geo.plate0, geo.p2, g.current);
  currentDots(g, geo.p2, geo.midcath, g.current);
  currentDots(g, geo.midcath, geo.cath1, g.current);
  currentDots(g, geo.cath1, geo.cath0, g.current);
}

export const TRIODE_DEF: ElementDef = {
  kind: 'triode',
  label: 'Triode',
  category: 'Semiconductors',
  dumpCode: '173',
  postCount: 3,
  posts: (e) => {
    const geo = triodeGeometry(e);
    return [geo.plate0, geo.p1, geo.cath0];
  },
  canMirror: true, // TriodeElm canFlipX (TriodeElm.java:251-268)
  noDiagonal: true, // TriodeElm.java:46
  // A fresh part sets FLAG_DSIGN_FIX so the electrode side tracks the drag
  // direction; a loaded file keeps whatever bits it carried (TriodeElm.java:35).
  defaultFlags: TRIODE_DSIGN_FIX,
  // Defaults from the plain constructor (TriodeElm.java:31-36). The token
  // constructor reads both tokens in this order.
  defaults: { mu: 93, kg1: 680 },
  parse: (t, e) => {
    readParams(t, e, ['mu', 'kg1']);
  },
  // Upstream's own class never overrides `dump()`, so its text save writes only
  // the x/y/flags fields (the same quirk as the thermistor and LDR); this port
  // writes both tokens so a save never loses the model.
  dump: (e) => [e.params.mu ?? 93, e.params.kg1 ?? 680],
  fields: [
    { name: 'mu', label: 'Amplification factor (μ)' },
    { name: 'kg1', label: 'Plate scale (kg1)' },
  ],
  draw: drawTriode,
};
