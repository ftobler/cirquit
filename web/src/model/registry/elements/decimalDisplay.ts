/**
 * The decimal/hex/octal display (DecimalDisplayElm.java, dump 419): a
 * bit-width chip with no output pins. It shows the binary value of its west
 * input pins as a digit glyph inside the body. The engine reads the same pins
 * through the shared chip base; this file owns the geometry and the glyph.
 *
 * Token layout after the common fields differs from the other chips: the
 * ChipElm base writes an optional high-voltage token (only under
 * FLAG_CUSTOM_VOLTAGE) before this element's own `bitCount displayMode`
 * (ChipElm.java:356-366, DecimalDisplayElm.java:78). The display-mode token is
 * absent from older files, so it is read defensively.
 */

import {
  canvasFont,
  dsign,
  elementLength,
  endpoints,
} from '../../../render/draw';
import {
  CHIP_CUSTOM_VOLTAGE,
  CHIP_FLIP_XY,
  CHIP_FLIP_Y,
  CHIP_SMALL,
  chipDumpFlags,
  chipPosts,
  drawChip,
  type ChipPinDef,
} from './dFlipFlop';
import type { CircuitElement, DrawContext, ElementDef, Point } from '../../types';

/** The bits field, clamped like the engine and the edit dialog. */
function decimalBits(e: CircuitElement): number {
  return Math.max(1, Math.min(8, Math.round(e.params.bits ?? 4)));
}

/** The pin table, from `setupPins` (DecimalDisplayElm.java:96-102): one west
 *  input per bit, MSB first, so I0 sits at the bottom, exactly like the latch's
 *  bit inputs. */
function decimalPins(e: CircuitElement): ChipPinDef[] {
  const bits = decimalBits(e);
  const pins: ChipPinDef[] = [];
  for (let i = 0; i < bits; i++) {
    pins.push({ side: 'W', pos: bits - 1 - i, text: `I${i}` });
  }
  return pins;
}

/** Grid half-spacing, `cspc` in ChipElm terms, matching dFlipFlop.ts. */
function chipCspc(e: CircuitElement): number {
  return (e.flags & CHIP_SMALL) !== 0 ? 8 : 16;
}

/** The chip's local frame, duplicated from dFlipFlop.ts (not exported there). */
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

/** The digit's anchor: the body centre, plus the FLIP_XY nudge upstream applies
 *  to the screen-y coordinate (DecimalDisplayElm.java:54-57). */
function digitAnchor(e: CircuitElement, sizeX: number, sizeY: number): Point {
  const frame = chipFrame(e);
  const cspc = chipCspc(e);
  const flipXY = (e.flags & CHIP_FLIP_XY) !== 0;
  const fsx = flipXY ? sizeY : sizeX;
  const fsy = flipXY ? sizeX : sizeY;
  const p = chipPoint(frame, cspc + fsx * cspc, -cspc + fsy * cspc);
  if (flipXY) p.y += ((e.flags & CHIP_FLIP_Y) !== 0 ? -cspc : cspc) / 2;
  return p;
}

/** The digit glyph, from the thresholded input levels and the display mode
 *  (DecimalDisplayElm.java:63-72). The mode only shapes the string, never the
 *  value, which is always the plain binary number. */
function digitString(e: CircuitElement, g: DrawContext): string {
  const bits = decimalBits(e);
  const threshold = (e.params.highVoltage ?? 5) / 2;
  let value = 0;
  for (let i = 0; i < bits; i++) {
    if ((g.voltages[i] ?? 0) > threshold) value |= 1 << i;
  }
  switch (Math.round(e.params.displayMode ?? 0)) {
    case 1:
      return value.toString(16).toUpperCase();
    case 2:
      return value.toString(8);
    default:
      return String(value);
  }
}

function drawDecimalDisplay(g: DrawContext, e: CircuitElement): void {
  const bits = decimalBits(e);
  drawChip(g, e, 3, bits, decimalPins(e));
  const anchor = digitAnchor(e, 3, bits);
  // Upstream draws the glyph with the text centred on the body centre plus
  // `5*csize`, right of dead centre (DecimalDisplayElm.java:74).
  const csize = chipCspc(e) / 8;
  g.ctx.fillStyle = g.theme.text;
  g.ctx.font = canvasFont(15 * csize);
  g.ctx.textAlign = 'center';
  g.ctx.textBaseline = 'middle';
  g.ctx.fillText(digitString(e, g), anchor.x + 5 * csize, anchor.y);
}

export const DECIMAL_DISPLAY_DEF: ElementDef = {
  kind: 'decimalDisplay',
  label: 'Decimal display',
  category: 'Other',
  dumpCode: '419',
  postCount: 4,
  posts: (e) => chipPosts(e, 3, decimalBits(e), decimalPins(e)),
  noDiagonal: true,  // ChipElm.java:44
  defaultLength: 8,  // the chip spans (sizeX + 1) * 32
  defaults: { bits: 4, displayMode: 0, highVoltage: 5 },
  parse: (t, e) => {
    let i = 0;
    if ((e.flags & CHIP_CUSTOM_VOLTAGE) !== 0) {
      const hv = Number(t[i]);
      if (t[i] !== undefined && Number.isFinite(hv)) e.params.highVoltage = hv;
      i++;
    }
    const bits = Math.round(Number(t[i]));
    if (t[i] !== undefined && Number.isFinite(bits)) e.params.bits = bits;
    i++;
    const dm = Math.round(Number(t[i]));
    if (t[i] !== undefined && Number.isFinite(dm)) e.params.displayMode = dm;
  },
  dump: (e) => {
    const out: (string | number)[] = [];
    const hv = e.params.highVoltage;
    if (hv !== undefined && hv !== 5) out.push(hv);
    out.push(e.params.bits ?? 4);
    out.push(e.params.displayMode ?? 0);
    return out;
  },
  dumpFlags: chipDumpFlags,
  fields: [
    { name: 'bits', label: '# of Bits', min: 1, max: 8 },
    {
      name: 'displayMode',
      label: 'Display Mode',
      type: 'choice',
      choices: [
        { value: 0, label: 'Decimal' },
        { value: 1, label: 'Hexadecimal' },
        { value: 2, label: 'Octal' },
      ],
    },
    { name: 'highVoltage', label: 'High logic voltage', unit: 'V' },
  ],
  draw: drawDecimalDisplay,
};
