/**
 * The seven-segment display (SevenSegElm.java, dump 157): a chip with no
 * output pins that lights its segments from its input bits. The engine reads
 * the same pins through the shared chip base; this file owns the geometry and
 * the digit glyph, which thresholds the terminal voltages itself.
 *
 * The diode modes (common cathode/anode) add a common post and label it gnd
 * or Vcc, but this port does not model the LED currents, so the lit rule is
 * always the thresholded input level, as upstream's no-diode mode draws it.
 */

import {
  CHIP_FLIP_XY,
  CHIP_FLIP_Y,
  CHIP_SMALL,
  chipBodyRect,
  chipCommonTokens,
  chipDump,
  chipDumpFlags,
  chipPosts,
  drawChip,
  type ChipPinDef,
} from './dFlipFlop';
import { readParams } from '../shared';
import { dsign, elementLength, endpoints, interp2, polygon } from '../../../render/draw';
import type { CircuitElement, DrawContext, ElementDef, Point } from '../../types';

/** The segments field, the base count before the decimal point or colon. */
function sevenSegBaseSegments(e: CircuitElement): number {
  return Math.max(1, Math.round(e.params.baseSegments ?? 7));
}

/** The derived counts from `setPinCount` (SevenSegElm.java:391-405): the
 *  segment count including the extra segment, the total pin count, and the
 *  common pin index (-1 when there is no diode mode). */
function sevenSegParams(e: CircuitElement): {
  segmentCount: number;
  pinCount: number;
  commonPin: number;
} {
  const baseSegments = sevenSegBaseSegments(e);
  const extraSegment = Math.round(e.params.extraSegment ?? 0);
  const diodeDirection = Math.round(e.params.diodeDirection ?? 0);
  const segmentCount = baseSegments + (extraSegment > 0 ? 1 : 0);
  const pinCount = segmentCount + (diodeDirection === 0 ? 0 : 1);
  const commonPin = diodeDirection === 0 ? -1 : pinCount - 1;
  return { segmentCount, pinCount, commonPin };
}

/** The chip's cell size, `cspc` in ChipElm terms, as in dFlipFlop.ts. */
function chipCspc(e: CircuitElement): number {
  return (e.flags & CHIP_SMALL) !== 0 ? 8 : 16;
}

/** The chip's body size, from `setupPins` (SevenSegElm.java:100-113). The
 *  width and height grow when the common pin has to fit somewhere. */
function sevenSegSize(e: CircuitElement): { sizeX: number; sizeY: number } {
  const baseSegments = sevenSegBaseSegments(e);
  const { pinCount } = sevenSegParams(e);
  const segmentPinsOnLeftSide = Math.floor((baseSegments + 1) / 2);
  let sizeY = segmentPinsOnLeftSide;
  let sizeX: number;
  if (baseSegments === 7) {
    sizeX = 4;
    if (pinCount > 7) sizeX = 5;
  } else {
    sizeX = 5;
  }
  if (pinCount > sizeY * 2) sizeY++;
  return { sizeX, sizeY };
}

/** The pin table, from `setupPins` (SevenSegElm.java:86-135). The classic
 *  7-segment keeps e, f and g on the south side so old files keep their post
 *  positions; any other configuration spills the rest of the segments onto
 *  the east, and the common pin lands on the east (or the west when the chip
 *  is not 7 segments). */
export function sevenSegPins(e: CircuitElement): ChipPinDef[] {
  const baseSegments = sevenSegBaseSegments(e);
  const extraSegment = Math.round(e.params.extraSegment ?? 0);
  const diodeDirection = Math.round(e.params.diodeDirection ?? 0);
  const { segmentCount, commonPin } = sevenSegParams(e);
  const segmentPinsOnLeftSide = Math.floor((baseSegments + 1) / 2);
  const pins: ChipPinDef[] = [];
  let i = 0;
  for (; i < segmentPinsOnLeftSide; i++) {
    pins.push({ side: 'W', pos: i, text: String.fromCharCode(97 + i) });
  }
  const backwardCompatibility = segmentCount === 7 && diodeDirection === 0 && extraSegment === 0;
  let s = backwardCompatibility ? 1 : 0;
  for (; i < segmentCount; i++) {
    pins.push({
      side: backwardCompatibility ? 'S' : 'E',
      pos: s++,
      text: String.fromCharCode(97 + i),
    });
  }
  if (extraSegment === 1) {
    pins[segmentCount - 1].text = 'dp';
  }
  if (commonPin > 0) {
    let side: 'W' | 'E' = 'E';
    if (segmentCount !== 7) {
      side = 'W';
      s = segmentPinsOnLeftSide;
    }
    pins.push({ side, pos: s++, text: diodeDirection === 1 ? 'gnd' : 'Vcc' });
  }
  return pins;
}

/** The chip's local frame, duplicated from dFlipFlop.ts (not exported there);
 *  the glyph is drawn in the same local (along, row) space as the pins. */
function sevenSegFrame(e: CircuitElement): { a: Point; u: Point; r: Point } {
  const [p1, p2] = endpoints(e);
  const d = dsign(p1, p2);
  const a = d >= 0 ? p1 : p2;
  const b = d >= 0 ? p2 : p1;
  const dn = Math.max(1, elementLength(e));
  const u = { x: (b.x - a.x) / dn, y: (b.y - a.y) / dn };
  const r = { x: -u.y, y: u.x };
  return { a, u, r };
}

/** Local chip coordinates to circuit space, the same half-point floor as
 *  `chipPoint`, so the glyph corners land on the grid like the posts. */
function sevenSegPoint(frame: { a: Point; u: Point; r: Point }, along: number, row: number): Point {
  const { a, u, r } = frame;
  return {
    x: Math.floor(a.x + u.x * along + r.x * row + 0.48),
    y: Math.floor(a.y + u.y * along + r.y * row + 0.48),
  };
}

/** Segment endpoints in unit grid, x1, y1, x2, y2 (SevenSegElm.java:168-211). */
const DISPLAY7 = [
  0, 0, 2, 0, 2, 0, 2, 1, 2, 1, 2, 2, 0, 2, 2, 2, 0, 1, 0, 2, 0, 0, 0, 1, 0, 1, 2, 1,
];
const DISPLAY16 = [
  0, 0, 1, 0, 1, 0, 2, 0, 2, 0, 2, 1, 2, 1, 2, 2, 2, 2, 1, 2, 1, 2, 0, 2, 0, 2, 0, 1, 0, 1, 0, 0, 0,
  0, 1, 1, 1, 0, 1, 1, 2, 0, 1, 1, 1, 1, 2, 1, 1, 1, 2, 2, 1, 1, 1, 2, 1, 1, 0, 2, 0, 1, 1, 1,
];
const DISPLAY14 = [
  0, 0, 2, 0, 2, 0, 2, 1, 2, 1, 2, 2, 2, 2, 0, 2, 0, 2, 0, 1, 0, 1, 0, 0, 0, 0, 1, 1, 1, 0, 1, 1, 2,
  0, 1, 1, 1, 1, 2, 1, 1, 1, 2, 2, 1, 1, 1, 2, 1, 1, 0, 2, 0, 1, 1, 1,
];

/** A filled bar segment, `drawSegment` (SevenSegElm.java:137-158): the
 *  hexagon one bar-thickness wide along the segment's whole length. */
function drawSegment(
  g: DrawContext,
  frame: { a: Point; u: Point; r: Point },
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  thick: number,
  color: string,
): void {
  const p1 = sevenSegPoint(frame, x1, y1);
  const p2 = sevenSegPoint(frame, x2, y2);
  const dn = Math.hypot(p1.x - p2.x, p1.y - p2.y);
  if (dn === 0) return;
  const [p3, p4] = interp2(p1, p2, thick / dn, thick);
  const [p5, p6] = interp2(p1, p2, 1 - thick / dn, thick);
  polygon(g, [p1, p3, p5, p2, p6, p4], color);
}

/** A filled diamond, `drawDecimal` (SevenSegElm.java:159-167). */
function drawDecimal(
  g: DrawContext,
  frame: { a: Point; u: Point; r: Point },
  x: number,
  y: number,
  sp: number,
  color: string,
): void {
  const c = sevenSegPoint(frame, x, y);
  polygon(
    g,
    [
      { x: c.x, y: c.y - sp },
      { x: c.x - sp, y: c.y },
      { x: c.x, y: c.y + sp },
      { x: c.x + sp, y: c.y },
    ],
    color,
  );
}

/** Lit segments are red, off segments a dim red or light gray, the no-diode
 *  branch of `setColor` (SevenSegElm.java:314-319): lightgray on the printable
 *  white theme, darkred on the dark one. */
function segmentColor(g: DrawContext, lit: boolean): string {
  if (lit) return '#ff0000';
  const bg = g.theme.background;
  return parseInt(bg.slice(1, 3), 16) > 128 ? '#f5f5f5' : '#1e0000';
}

function drawSevenSeg(g: DrawContext, e: CircuitElement): void {
  const { sizeX, sizeY } = sevenSegSize(e);
  drawChip(g, e, sizeX, sizeY, sevenSegPins(e));
  const baseSegments = sevenSegBaseSegments(e);
  const extraSegment = Math.round(e.params.extraSegment ?? 0);
  const { segmentCount } = sevenSegParams(e);
  const cspc = chipCspc(e);
  // The digit box is one cell per grid unit, shrunk for the dp/colon and
  // halved on the small body or a flipped-xy chip (SevenSegElm.java:245-252).
  let spx = cspc * 2;
  if (extraSegment !== 0) spx = Math.floor(spx * 0.9);
  if (sizeY <= 4 || (e.flags & CHIP_FLIP_XY) !== 0) spx = Math.floor(spx / 2);
  const spy = spx * 2;
  const frame = sevenSegFrame(e);
  const flipXY = (e.flags & CHIP_FLIP_XY) !== 0;
  const fsx = flipXY ? sizeY : sizeX;
  const fsy = flipXY ? sizeX : sizeY;
  const along = cspc + fsx * cspc - spx;
  let row = -cspc + fsy * cspc - spy;
  // The small body keeps its digits clear of the south pins when flipped
  // (SevenSegElm.java:256-257).
  if (sizeY <= 4 && (e.flags & (CHIP_FLIP_Y | CHIP_FLIP_XY)) !== 0) row += 10;
  const disp = baseSegments === 7 ? DISPLAY7 : baseSegments === 14 ? DISPLAY14 : DISPLAY16;
  const thick = sizeY <= 4 ? 5 : Math.max(1, Math.floor(spx / 6));
  const dpsize = sizeY <= 4 ? 7 : flipXY ? 3 : 7;
  const high = e.params.highVoltage ?? 5;
  const lit = (pin: number) => (g.voltages[pin] ?? 0) > high / 2;
  // The decimal point and colon are drawn separately below, so the bar loop
  // stops at the table's own segment count. Upstream iterates the extra
  // segment too and reads past the table, which is a no-op in GWT's compiled
  // JS but a crash in the JVM; clamping is the safe reading of the intent.
  const barSegments = Math.min(segmentCount, disp.length / 4);
  // Diagonal segments paint first so the straight ones overlap them
  // (SevenSegElm.java:263-269).
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < barSegments; i++) {
      const i4 = i * 4;
      const diag = disp[i4] !== disp[i4 + 2] && disp[i4 + 1] !== disp[i4 + 3];
      if (diag !== (pass === 0)) continue;
      drawSegment(
        g,
        frame,
        along + disp[i4] * spx,
        row + disp[i4 + 1] * spy,
        along + disp[i4 + 2] * spx,
        row + disp[i4 + 3] * spy,
        thick,
        segmentColor(g, lit(i)),
      );
    }
  }
  if (extraSegment === 1) {
    const dist = Math.max(spx * 1.5, spx + 12);
    drawDecimal(
      g,
      frame,
      along + spx + dist,
      row + spy * 2,
      dpsize,
      segmentColor(g, lit(baseSegments)),
    );
  }
  if (extraSegment === 2) {
    const dist = Math.max(spx * 1.5, spx + 14);
    drawDecimal(
      g,
      frame,
      along + spx + dist,
      row + spy * 0.5,
      dpsize,
      segmentColor(g, lit(baseSegments)),
    );
    drawDecimal(
      g,
      frame,
      along + spx + dist,
      row + spy * 1.5,
      dpsize,
      segmentColor(g, lit(baseSegments)),
    );
  }
}

export const SEVEN_SEG_DEF: ElementDef = {
  kind: 'sevenSeg',
  label: '7-segment display',
  category: 'Other',
  dumpCode: '157',
  postCount: 7,
  posts: (e) => {
    const { sizeX, sizeY } = sevenSegSize(e);
    return chipPosts(e, sizeX, sizeY, sevenSegPins(e));
  },
  chipExtents: (e) => {
    const { sizeX, sizeY } = sevenSegSize(e);
    return { sx: sizeX, sy: sizeY };
  },
  canMirror: true,  // ChipElm.flipX, SevenSegElm inherits it
  bodyRect: (e) => {
    const { sizeX, sizeY } = sevenSegSize(e);
    return chipBodyRect(e, sizeX, sizeY);
  },
  noDiagonal: true,  // ChipElm.java:44
  defaultLength: 10,  // the default 7-segment spans (sizeX + 1) * 32 with sizeX 4
  defaults: { baseSegments: 7, extraSegment: 0, diodeDirection: 0, highVoltage: 5 },
  parse: (t, e) => {
    // The ChipElm base writes an optional high-voltage token (only under
    // CHIP_CUSTOM_VOLTAGE) before this element's own three tokens
    // (ChipElm.java:356-366, SevenSegElm.java:65).
    const i = chipCommonTokens(t, e, false);
    readParams(t.slice(i), e, ['baseSegments', 'extraSegment', 'diodeDirection']);
  },
  dump: (e) => [
    ...chipDump(e, sevenSegPins(e), false),
    e.params.baseSegments ?? 7,
    e.params.extraSegment ?? 0,
    e.params.diodeDirection ?? 0,
  ],
  dumpFlags: chipDumpFlags,
  fields: [
    {
      name: 'baseSegments',
      label: 'Segments',
      type: 'choice',
      choices: [
        { value: 7, label: '7 Segment' },
        { value: 14, label: '14 Segment' },
        { value: 16, label: '16 Segment' },
      ],
    },
    {
      name: 'extraSegment',
      label: 'Extra Segment',
      type: 'choice',
      choices: [
        { value: 0, label: 'None' },
        { value: 1, label: 'Decimal Point' },
        { value: 2, label: 'Colon' },
      ],
    },
    {
      name: 'diodeDirection',
      label: 'Diodes',
      type: 'choice',
      choices: [
        { value: 1, label: 'Common Cathode' },
        { value: -1, label: 'Common Anode' },
        { value: 0, label: 'None (logic inputs)' },
      ],
    },
    { name: 'highVoltage', label: 'High logic voltage', unit: 'V' },
  ],
  draw: drawSevenSeg,
};
