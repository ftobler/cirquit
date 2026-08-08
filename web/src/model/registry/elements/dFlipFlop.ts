/**
 * The digital chip family's shared layout and drawing, plus the D flip-flop
 * registry entry. Every member of the family is a ChipElm upstream: the same
 * body, the same pin stubs, bubbles, clock markers and labels, and the same
 * file-format tokens (`bits`, optional `highVoltage`, then the saved output
 * levels). That shared machinery lives here and the other five definitions
 * import `chipPosts`, `chipPins`, `drawChip` and the flag bits from this file
 * rather than duplicating them.
 */

import {
  canvasFont,
  circle,
  dsign,
  elementLength,
  endpoints,
  line,
  polyline,
  voltageColor,
} from '../../../render/draw';
import { readParams } from '../shared';
import type { CircuitElement, DrawContext, ElementDef, Point } from '../../types';

/** File-format flag bits shared by every chip (ChipElm.java:30-34). */
export const CHIP_SMALL = 1;
export const CHIP_FLIP_X = 1 << 10;
export const CHIP_FLIP_Y = 1 << 11;
export const CHIP_FLIP_XY = 1 << 12;
export const CHIP_CUSTOM_VOLTAGE = 1 << 13;

/** D flip-flop flag bits (DFlipFlopElm.java:23-25). */
export const DFF_RESET = 2;
export const DFF_SET = 4;
export const DFF_INVERT_SET_RESET = 8;

/** One chip pin, the geometry the engine never sees (ChipElm.Pin). `output`
 *  marks a voltage-source pin and `state` one whose level is saved to the
 *  file; the engine's pin table carries the same roles. */
export interface ChipPinDef {
  side: 'W' | 'E' | 'N' | 'S';
  pos: number;
  text: string;
  output?: boolean;
  state?: boolean;
  clock?: boolean;
  bubble?: boolean;
  lineOver?: boolean;
}

/** Grid half-spacing, `cspc` in ChipElm terms: 16 normally, 8 under FLAG_SMALL
 *  (setSize, ChipElm.java:77-83). */
function chipCspc(e: CircuitElement): number {
  return (e.flags & CHIP_SMALL) !== 0 ? 8 : 16;
}

/** The chip's local frame: the anchor `a` (the left/top drag end in the
 *  forward direction), the unit axis along it and the perpendicular that
 *  points toward increasing row positions, which is down on screen for a
 *  rightward chip, matching upstream's layout. */
function chipFrame(e: CircuitElement): { a: Point; u: Point; r: Point } {
  const [p1, p2] = endpoints(e);
  const d = dsign(p1, p2);
  const a = d >= 0 ? p1 : p2;
  const b = d >= 0 ? p2 : p1;
  const dn = Math.max(1, elementLength(e));
  const u = { x: (b.x - a.x) / dn, y: (b.y - a.y) / dn };
  const r = { x: -u.y, y: u.x };
  return { a, u, r };
}

/** Local chip coordinates to circuit space, rounded like `interp` so posts
 *  land exactly on the grid. */
function chipPoint(
  frame: { a: Point; u: Point; r: Point },
  along: number,
  row: number,
): Point {
  const { a, u, r } = frame;
  return {
    x: Math.floor(a.x + u.x * along + r.x * row + 0.48),
    y: Math.floor(a.y + u.y * along + r.y * row + 0.48),
  };
}

/** One pin's full geometry, ported from `Pin.setPoint` (ChipElm.java:688-736):
 *  the post and the stub where it meets the body, the label anchor, and the
 *  bubble and three-point clock marker when the pin has them. */
function chipPinPoints(
  e: CircuitElement,
  frame: { a: Point; u: Point; r: Point },
  sizeX: number,
  sizeY: number,
  pin: ChipPinDef,
) {
  const cspc = chipCspc(e);
  const cspc2 = 2 * cspc;
  const flipXY = (e.flags & CHIP_FLIP_XY) !== 0;
  const fsx = flipXY ? sizeY : sizeX;
  const fsy = flipXY ? sizeX : sizeY;
  const xs = fsx * cspc2;
  const ys = fsy * cspc2;
  let side = pin.side;
  if (flipXY) side = { W: 'N', E: 'S', N: 'W', S: 'E' }[side] as ChipPinDef['side'];
  let dx = 0;
  let dy = 0;
  let dax = 0;
  let day = 0;
  let sx = 0;
  let sy = 0;
  switch (side) {
    case 'N':
      dx = 1;
      day = -1;
      break;
    case 'S':
      dx = 1;
      day = 1;
      sy = ys - cspc2;
      break;
    case 'W':
      dy = 1;
      dax = -1;
      break;
    case 'E':
      dy = 1;
      dax = 1;
      sx = xs - cspc2;
      break;
  }
  let px = cspc2;
  let py = 0;
  if ((e.flags & CHIP_FLIP_X) !== 0) {
    dx = -dx;
    dax = -dax;
    px += cspc2 * (fsx - 1);
    sx = -sx;
  }
  if ((e.flags & CHIP_FLIP_Y) !== 0) {
    dy = -dy;
    day = -day;
    py += cspc2 * (fsy - 1);
    sy = -sy;
  }
  const xa = px + cspc2 * dx * pin.pos + sx;
  const ya = py + cspc2 * dy * pin.pos + sy;
  const csize = cspc / 8;
  return {
    side,
    post: chipPoint(frame, xa + dax * cspc2, ya + day * cspc2),
    stub: chipPoint(frame, xa + dax * cspc, ya + day * cspc),
    textloc: chipPoint(frame, xa, ya),
    ...(pin.bubble ? { bubble: chipPoint(frame, xa + dax * 10 * csize, ya + day * 10 * csize) } : {}),
    ...(pin.clock
      ? {
          clockPoints: [
            chipPoint(frame, xa + dax * cspc - (dx * cspc) / 2, ya + day * cspc - (dy * cspc) / 2),
            chipPoint(frame, xa, ya),
            chipPoint(frame, xa + dax * cspc + (dx * cspc) / 2, ya + day * cspc + (dy * cspc) / 2),
          ],
        }
      : {}),
  };
}

/** Terminal coordinates in post order, exactly where upstream's `getPost`
 *  puts them (ChipElm.java:196-207), so wires drawn against a loaded file
 *  connect. */
export function chipPosts(
  e: CircuitElement,
  sizeX: number,
  sizeY: number,
  pins: ChipPinDef[],
): Point[] {
  const frame = chipFrame(e);
  return pins.map((p) => chipPinPoints(e, frame, sizeX, sizeY, p).post);
}

/** The body rectangle corners, `rectPoints` (ChipElm.java:208-209). */
function chipBody(
  e: CircuitElement,
  frame: { a: Point; u: Point; r: Point },
  sizeX: number,
  sizeY: number,
): Point[] {
  const cspc = chipCspc(e);
  const cspc2 = 2 * cspc;
  const flipXY = (e.flags & CHIP_FLIP_XY) !== 0;
  const fsx = flipXY ? sizeY : sizeX;
  const fsy = flipXY ? sizeX : sizeY;
  const xs = fsx * cspc2;
  const ys = fsy * cspc2;
  return [
    chipPoint(frame, cspc, -cspc),
    chipPoint(frame, cspc + xs, -cspc),
    chipPoint(frame, cspc + xs, -cspc + ys),
    chipPoint(frame, cspc, -cspc + ys),
  ];
}

/** The chip body, pin stubs, bubbles, clock markers and pin labels, ported
 *  from `ChipElm.drawChip` (ChipElm.java:88-162). */
export function drawChip(
  g: DrawContext,
  e: CircuitElement,
  sizeX: number,
  sizeY: number,
  pins: ChipPinDef[],
): void {
  const frame = chipFrame(e);
  const body = chipBody(e, frame, sizeX, sizeY);
  polyline(g, [body[0], body[1], body[2], body[3], body[0]], g.theme.wire, 2);
  pins.forEach((pin, i) => {
    const pt = chipPinPoints(e, frame, sizeX, sizeY, pin);
    line(g, pt.post, pt.stub, voltageColor(g, g.voltages[i]), 3);
    if (pin.bubble && pt.bubble) {
      // A bubble is a stroked ring over the stub, the port's usual bubble.
      circle(g, pt.bubble, 3, g.theme.wire, false, 3);
    }
    if (pt.clockPoints) {
      polyline(g, pt.clockPoints, g.theme.wire, 1);
    }
  });
  pins.forEach((pin) => {
    if (!pin.text) return;
    const pt = chipPinPoints(e, frame, sizeX, sizeY, pin);
    g.ctx.fillStyle = g.theme.text;
    g.ctx.font = canvasFont(10);
    g.ctx.textBaseline = 'middle';
    const cspc = chipCspc(e);
    if (pt.side === 'W' || pt.side === 'E') {
      // W labels right-align just inside the body edge, E labels left-align,
      // so neither crosses the body (ChipElm.java:142-147).
      g.ctx.textAlign = pt.side === 'W' ? 'right' : 'left';
      const x = pt.textloc.x + (pt.side === 'W' ? -(cspc - 5) : cspc - 5);
      g.ctx.fillText(pin.text, x, pt.textloc.y);
      if (pin.lineOver) {
        const w = g.ctx.measureText(pin.text).width;
        line(g, { x, y: pt.textloc.y - 5 }, { x: x + w, y: pt.textloc.y - 5 }, g.theme.text, 1);
      }
    } else {
      g.ctx.textAlign = 'center';
      g.ctx.fillText(pin.text, pt.textloc.x, pt.textloc.y);
      if (pin.lineOver) {
        const w = g.ctx.measureText(pin.text).width;
        line(
          g,
          { x: pt.textloc.x - w / 2, y: pt.textloc.y - 5 },
          { x: pt.textloc.x + w / 2, y: pt.textloc.y - 5 },
          g.theme.text,
          1,
        );
      }
    }
  });
}

/** Parameter names of the pins whose levels the file saves, in post order. */
export function chipStateNames(pins: ChipPinDef[]): string[] {
  return pins.flatMap((p, i) => (p.state ? [`voltage${i}`] : []));
}

/** Reads the common chip tokens that precede the state-pin voltages: the bit
 *  count for the variable-width chips and the high voltage when
 *  FLAG_CUSTOM_VOLTAGE says a token follows (ChipElm.java:51-56). Returns the
 *  index of the first state-voltage token. */
export function chipCommonTokens(t: string[], e: CircuitElement, hasBits: boolean): number {
  let i = 0;
  if (hasBits) {
    const bits = Math.round(Number(t[i]));
    if (t[i] !== undefined && Number.isFinite(bits)) e.params.bits = bits;
    i++;
  }
  if ((e.flags & CHIP_CUSTOM_VOLTAGE) !== 0) {
    const hv = Number(t[i]);
    if (t[i] !== undefined && Number.isFinite(hv)) e.params.highVoltage = hv;
    i++;
  }
  return i;
}

/** Reads the common chip tokens and then the saved output levels. */
export function chipParse(
  t: string[],
  e: CircuitElement,
  pins: ChipPinDef[],
  hasBits: boolean,
): void {
  const i = chipCommonTokens(t, e, hasBits);
  readParams(t.slice(i), e, chipStateNames(pins));
}

/** Writes the common chip tokens and the saved output levels. The running
 *  output state never crosses back out of the engine, so the levels written
 *  are the ones the file was loaded with, like the capacitor's `voltDiff`. */
export function chipDump(
  e: CircuitElement,
  pins: ChipPinDef[],
  hasBits: boolean,
  bitsDefault = 4,
): (string | number)[] {
  const out: (string | number)[] = [];
  if (hasBits) out.push(e.params.bits ?? bitsDefault);
  const hv = e.params.highVoltage;
  if (hv !== undefined && hv !== 5) out.push(hv);
  for (const name of chipStateNames(pins)) out.push(e.params[name] ?? 0);
  return out;
}

/** Keeps FLAG_CUSTOM_VOLTAGE in step with the high voltage, the bit upstream
 *  computes in `dump` (ChipElm.java:357-360). */
export function chipDumpFlags(e: CircuitElement): number {
  const hv = e.params.highVoltage;
  const custom = hv !== undefined && hv !== 5;
  return (e.flags & ~CHIP_CUSTOM_VOLTAGE) | (custom ? CHIP_CUSTOM_VOLTAGE : 0);
}

/** The pin table, from `setupPins` (DFlipFlopElm.java:43-65). */
function dffPins(e: CircuitElement): ChipPinDef[] {
  const set = (e.flags & DFF_SET) !== 0;
  const reset = (e.flags & DFF_RESET) !== 0 || set;
  const invert = (e.flags & DFF_INVERT_SET_RESET) !== 0;
  const pins: ChipPinDef[] = [
    { side: 'W', pos: 0, text: 'D' },
    { side: 'E', pos: 0, text: 'Q', output: true, state: true },
    { side: 'E', pos: set ? 1 : 2, text: 'Q', output: true, lineOver: true },
    { side: 'W', pos: 1, text: '', clock: true },
  ];
  if (set) {
    // Post order must match the engine: 4 is R on the east, 5 is S on the
    // west (DFlipFlopElm.java:60-64), so the S wire actually reaches the set
    // input.
    pins.push({ side: 'E', pos: 2, text: 'R', bubble: invert });
    pins.push({ side: 'W', pos: 2, text: 'S', bubble: invert });
  } else if (reset) {
    pins.push({ side: 'W', pos: 2, text: 'R', bubble: invert });
  }
  return pins;
}

function drawDff(g: DrawContext, e: CircuitElement): void {
  drawChip(g, e, 2, 3, dffPins(e));
}

export const DFLIPFLOP_DEF: ElementDef = {
  kind: 'dFlipFlop',
  label: 'D flip-flop',
  category: 'Logic',
  dumpCode: '155',
  postCount: 4,
  posts: (e) => chipPosts(e, 2, 3, dffPins(e)),
  noDiagonal: true,  // ChipElm.java:44
  defaultLength: 6,  // the chip spans (sizeX + 1) * 32
  defaults: { highVoltage: 5 },
  parse: (t, e) => chipParse(t, e, dffPins(e), false),
  dump: (e) => chipDump(e, dffPins(e), false),
  dumpFlags: chipDumpFlags,
  fields: [
    { name: 'highVoltage', label: 'High logic voltage', unit: 'V' },
    { name: 'reset', label: 'Reset Pin', type: 'bool', flag: DFF_RESET },
    { name: 'set', label: 'Set Pin', type: 'bool', flag: DFF_SET },
    { name: 'invertSetReset', label: 'Invert Set/Reset', type: 'bool', flag: DFF_INVERT_SET_RESET },
  ],
  draw: drawDff,
};
