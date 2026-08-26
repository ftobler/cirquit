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
  closedPolyline,
  dsign,
  elementLength,
  endpoints,
  line,
  polyline,
  voltageColor,
} from '../../../render/draw';
import { readParams, warnOnClamp } from '../shared';
import type { Box, CircuitElement, DrawContext, ElementDef, Point } from '../../types';

/** File-format flag bits shared by every chip (ChipElm.java:30-34). */
export const CHIP_SMALL = 1;
export const CHIP_FLIP_X = 1 << 10;
export const CHIP_FLIP_Y = 1 << 11;
export const CHIP_FLIP_XY = 1 << 12;
export const CHIP_CUSTOM_VOLTAGE = 1 << 13;
/**
 * Port extension: the chip's bit order is upstream's BIT_ORDER_BUS
 * (ChipElm.java:37, the XML attribute `bo="2"`), under which every bit-pin
 * group collapses onto one coordinate told apart by per-post tags. Upstream's
 * text format has no home for the state, so the port parks it in this free
 * chip flag bit, which round-trips verbatim like the rest of the word.
 */
export const CHIP_BIT_ORDER_BUS = 1 << 14;

/** Reads the port bit-order flag into `params.bitOrder`, the shape the
 *  geometry and the engine-facing param both consume. */
export function chipBitOrderParam(e: CircuitElement): void {
  if ((e.flags & CHIP_BIT_ORDER_BUS) !== 0) e.params.bitOrder = 2;
}

/** Keeps the port bit-order flag in step with `params.bitOrder`, layered on
 *  the shared chip flags. */
export function chipBitOrderFlags(e: CircuitElement, base: number): number {
  return e.params.bitOrder === 2 ? base | CHIP_BIT_ORDER_BUS : base & ~CHIP_BIT_ORDER_BUS;
}

/** D flip-flop flag bits (DFlipFlopElm.java:23-25). */
export const DFF_RESET = 2;
export const DFF_SET = 4;
export const DFF_INVERT_SET_RESET = 8;

/** One chip pin, the geometry the engine never sees (ChipElm.Pin). `output`
 *  marks a voltage-source pin and `state` one whose level is saved to the
 *  file; the engine's pin table carries the same roles. `busWidth`/`busZ`
 *  describe a multi-bit pin (ChipElm.Pin defaults of 1 and 0); bus-mode chips
 *  like the wide adder or the counter2 collapse each bank onto one row and
 *  tag every bit with them, and the Create Test harness reads them to skip
 *  the duplicate entries of a bus. */
export interface ChipPinDef {
  side: 'W' | 'E' | 'N' | 'S';
  pos: number;
  text: string;
  output?: boolean;
  state?: boolean;
  clock?: boolean;
  bubble?: boolean;
  lineOver?: boolean;
  busWidth?: number;
  busZ?: number;
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
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  // A collapsed segment (both endpoints equal, exactly what upstream writes
  // for a group-mirrored chip, ChipElm.java:623-626) carries no direction.
  // Upstream's setPoints reads only the anchor and lays the pins out along
  // absolute +x, so the frame falls back to that rightward axis instead of
  // collapsing every post onto the anchor.
  const u = dx === 0 && dy === 0 ? { x: 1, y: 0 } : { x: dx / dn, y: dy / dn };
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

/** The body rectangle as a hit-test box, `chipBody` collapsed to its bounds.
 *  Chips are never diagonal, so the four corners span an exact axis-aligned
 *  rect; every `drawChip` def hands this to `bodyRect`, the port of upstream's
 *  `boundingBox.contains` gate, so the whole housing is grabbable rather than
 *  just the central axis and the pins. */
export function chipBodyRect(e: CircuitElement, sizeX: number, sizeY: number): Box {
  const body = chipBody(e, chipFrame(e), sizeX, sizeY);
  const xs = body.map((p) => p.x);
  const ys = body.map((p) => p.y);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
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
  // Whether any N/S pin exists. A W/E label may only be given extra room when
  // no vertical pin can collide with it, the hasVertical scan upstream runs
  // before the per-pin loop (ChipElm.java:93-99, 124-128).
  let hasVertical = false;
  pins.forEach((pin, i) => {
    const pt = chipPinPoints(e, frame, sizeX, sizeY, pin);
    if (pt.side === 'N' || pt.side === 'S') hasVertical = true;
    // A bus pin draws once per shared coordinate: the z-tagged duplicates are
    // skipped and the one drawn lead is thicker (ChipElm.java:103-108).
    if ((pin.busZ ?? 0) > 0) return;
    const wide = (pin.busWidth ?? 1) > 1;
    line(g, pt.post, pt.stub, voltageColor(g, g.voltages[i]), wide ? 5 : 3, 'round');
    if (pin.bubble && pt.bubble) {
      // A bubble is a stroked ring over the stub, the port's usual bubble
      // (ChipElm.java:131-133, drawThickCircle at width 3).
      circle(g, pt.bubble, 3, g.theme.wire, false);
    }
    if (pt.clockPoints) {
      // The three-point clock marker is a plain drawPolyline upstream
      // (ChipElm.java:117-120), so it stays at fine width 1.
      polyline(g, pt.clockPoints, g.theme.wire, 1);
    }
  });
  pins.forEach((pin) => {
    if (!pin.text || (pin.busZ ?? 0) > 0) return;
    // A wide pin labels as name/width (ChipElm.java:129).
    const text = (pin.busWidth ?? 1) > 1 ? `${pin.text}/${pin.busWidth}` : pin.text;
    const pt = chipPinPoints(e, frame, sizeX, sizeY, pin);
    const cspc = chipCspc(e);
    const csize = cspc / 8;
    g.ctx.fillStyle = g.theme.text;
    // Measure each label and shrink the font until it fits the space between
    // the body edge and the pin's label anchor, the loop upstream runs per
    // pin (ChipElm.java:122-138). The floor at 4 px stops a label that can
    // never fit from hanging the frame loop: upstream has no floor and would
    // spin, the port draws at 4 and lets it clip.
    let fsz = 10 * csize;
    let availSpace = cspc * 2 - 8;
    if (!hasVertical && sizeX > 2) {
      // No N/S pin can collide with the W/E labels, so a wide chip may widen
      // the budget with its extra cells instead of keeping one pin cell
      // (ChipElm.java:124-128).
      availSpace = cspc * 2.5 + cspc * (sizeX - 3);
    }
    let sw = 0;
    while (true) {
      g.ctx.font = canvasFont(fsz);
      sw = g.ctx.measureText(text).width;
      if (sw <= availSpace || fsz <= 4) break;
      fsz -= 1;
    }
    const asc = fsz;
    // chipPinPoints has already remapped the side for FLAG_FLIP_XY; a flipped
    // X then swaps W and E again (flippedXSide, ChipElm.java:610-618), so the
    // label hugs whichever body edge the pin's label anchor actually sits by.
    let align = pt.side;
    if ((e.flags & CHIP_FLIP_X) !== 0) {
      if (align === 'W') align = 'E';
      else if (align === 'E') align = 'W';
    }
    // W labels left-align just inside the body edge and read inward, E labels
    // right-align at the mirror offset, N/S labels stay centred (ChipElm.java:
    // 140-147). The baseline follows upstream's drawString, textloc.y + asc/3,
    // so a shrunk font keeps the label anchored like the original.
    g.ctx.textBaseline = 'alphabetic';
    if (align === 'W') {
      g.ctx.textAlign = 'left';
      const x = pt.textloc.x - (cspc - 5);
      g.ctx.fillText(text, x, pt.textloc.y + asc / 3);
      if (pin.lineOver) {
        const y = pt.textloc.y - asc + asc / 3;
        line(g, { x, y }, { x: x + sw, y }, g.theme.text, 1);
      }
    } else if (align === 'E') {
      g.ctx.textAlign = 'right';
      const x = pt.textloc.x + (cspc - 5);
      g.ctx.fillText(text, x, pt.textloc.y + asc / 3);
      if (pin.lineOver) {
        const y = pt.textloc.y - asc + asc / 3;
        line(g, { x: x - sw, y }, { x, y }, g.theme.text, 1);
      }
    } else {
      g.ctx.textAlign = 'center';
      g.ctx.fillText(text, pt.textloc.x, pt.textloc.y + asc / 3);
      if (pin.lineOver) {
        const y = pt.textloc.y - asc + asc / 3;
        line(g, { x: pt.textloc.x - sw / 2, y }, { x: pt.textloc.x + sw / 2, y }, g.theme.text, 1);
      }
    }
  });
  // The housing is stroked last so its outline survives on top of any pin or
  // label overlap, the draw order upstream uses (drawThickPolygon comes after
  // the pin loop, ChipElm.java:155-159). It is a drawThickPolygon at the 3-unit
  // body weight; the corner list repeats body[0] to keep the four corners
  // explicit, and closePath is what actually closes the loop, so the start
  // corner gets a real join instead of two butt-capped stroke ends.
  closedPolyline(g, [body[0], body[1], body[2], body[3], body[0]], g.theme.wire);
}

/** Parameter names of the pins whose levels the file saves, in post order. */
export function chipStateNames(pins: ChipPinDef[]): string[] {
  return pins.flatMap((p, i) => (p.state ? [`voltage${i}`] : []));
}

/**
 * The integer bit count the engine's `(x as usize)` cast derives from a value:
 * non-finite values and negatives saturate to 0 (NaN and -1 cast to 0), a
 * fraction truncates toward zero, and the result clamps to the engine's
 * `floor..=ceiling` range. Every chip family this backs carries a ceiling now.
 * Four pack the bit count into a shifted integer (`1 << bits` or a per-bit
 * `1 << i` loop) and need the ceiling to keep that shift in range: adc.rs:28,
 * dac.rs:36, counter.rs:27, decimal_display.rs:24. The other five index pins
 * and allocate from `bits` (`Base::with_posts`, `vec![false; bits]` in
 * latch.rs), so a huge hand-edited width would panic on the allocation without
 * the same clamp: latch.rs:42, ring_counter.rs:28, counter2.rs:27,
 * sipo_shift.rs:20, piso_shift.rs:32. The store's `setParam`, the parsers and
 * the geometry all normalise to this, so a fractional edit never draws a post
 * list the engine's build rejects (circuit.rs:261-269). The clamp-on-load
 * policy (oversized-gates-load-policy, option 2): keep the clamp, but the
 * token walk reports an out-of-range width through `warnOnClamp`, so the loss
 * is surfaced instead of silently rewritten by the next save.
 */
export function normalizeChipBits(value: number, floor: number, ceiling?: number): number {
  if (!Number.isFinite(value)) return floor;
  const n = Math.trunc(value);
  if (n < floor) return floor;
  if (ceiling !== undefined && n > ceiling) return ceiling;
  return n;
}

/** Reads the common chip tokens that precede the state-pin voltages: the bit
 *  count for the variable-width chips and the high voltage when
 *  CHIP_CUSTOM_VOLTAGE says a token follows (ChipElm.java:51-56). Returns the
 *  index of the first state-voltage token. `normalizeBits` mirrors the owning
 *  element's engine cast on the bits token; the round fallback keeps any
 *  future caller that skips it on the old behaviour. `label` names the chip in
 *  the clamp-on-load warning and `warn` collects it: a hand-edited width over
 *  the engine's ceiling clamps as before but is surfaced instead of silently
 *  rewritten by the next save (oversized-gates-load-policy, option 2). */
export function chipCommonTokens(
  t: string[],
  e: CircuitElement,
  hasBits: boolean,
  normalizeBits?: (value: number) => number,
  label?: string,
  warn?: (message: string) => void,
): number {
  let i = 0;
  if (hasBits) {
    const bits = Number(t[i]);
    if (t[i] !== undefined && Number.isFinite(bits)) {
      const clamped = normalizeBits === undefined ? Math.round(bits) : normalizeBits(bits);
      if (normalizeBits !== undefined) warnOnClamp(warn, label ?? 'Chip', 'bits', bits, clamped);
      e.params.bits = clamped;
    }
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
  normalizeBits?: (value: number) => number,
  label?: string,
  warn?: (message: string) => void,
): void {
  const i = chipCommonTokens(t, e, hasBits, normalizeBits, label, warn);
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

/** Keeps CHIP_CUSTOM_VOLTAGE in step with the high voltage, the bit upstream
 *  computes in `dump` (ChipElm.java:357-360). */
export function chipDumpFlags(e: CircuitElement): number {
  const hv = e.params.highVoltage;
  const custom = hv !== undefined && hv !== 5;
  return (e.flags & ~CHIP_CUSTOM_VOLTAGE) | (custom ? CHIP_CUSTOM_VOLTAGE : 0);
}

/** The pin table, from `setupPins` (DFlipFlopElm.java:43-65). Exported so the
 *  chip registry can hand the harness the pin metadata. */
export function dffPins(e: CircuitElement): ChipPinDef[] {
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
  chipExtents: () => ({ sx: 2, sy: 3 }),  // ChipElm.flipX's span, same args
  canMirror: true,  // ChipElm.java:620-628
  bodyRect: (e) => chipBodyRect(e, 2, 3),
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
