/**
 * The LED array (LEDArrayElm.java, dump 405): a chip with a row of south
 * column posts and a row of west row posts, and a dot of light where each
 * column line crosses each row line. The engine models the grid as real
 * Shockley diodes between the row posts (anodes) and the column posts
 * (cathodes), so a cell conducts when its row sits above its column; this file
 * owns the geometry and the dots, which are drawn from the terminal voltages
 * exactly the way the engine's junction model decides conduction.
 *
 * Token layout after the common fields differs from the other chips only in
 * what follows the optional high-voltage token: the ChipElm base writes that
 * token (only under CHIP_CUSTOM_VOLTAGE) before this element's own `sizeX
 * sizeY` (ChipElm.java:356-366, LEDArrayElm.java:32-35). No pin is a `state`
 * pin, so there are no saved-voltage tokens.
 */

import {
  CHIP_FLIP_XY,
  CHIP_SMALL,
  chipBodyRect,
  chipCommonTokens,
  chipDump,
  chipDumpFlags,
  chipPosts,
  drawChip,
  type ChipPinDef,
} from './dFlipFlop';
import { circle } from '../../../render/draw';
import type { CircuitElement, DrawContext, ElementDef } from '../../types';

/** The grid bounds upstream's edit dialog enforces, setChipEditValue's
 *  "must be between 2 and 16" (LEDArrayElm.java:194-216). The engine twin
 *  rejects out-of-range grids by name at build time
 *  (engine/core/src/elements/led_array.rs); this side keeps its derived
 *  geometry inside the same window so nothing unbounded is ever laid out. */
const GRID_MIN = 2;
const GRID_MAX = 16;

/** The grid sizes. Missing, zero or non-finite sizes keep the token
 *  constructor's 8x8 fallback (LEDArrayElm.java:60-64); any other size
 *  clamps into the dialog range, so a hostile stored size cannot blow up
 *  pins, posts and draw while the banner reports the engine's rejection.
 *  The raw params are never rewritten here: dump still writes the original
 *  tokens back byte-for-byte. */
function ledArraySize(e: CircuitElement): { sizeX: number; sizeY: number } {
  const size = (raw?: number) => {
    const v = Math.round(raw ?? 0);
    if (!(v > 0)) return 8;  // also catches NaN
    return Math.min(GRID_MAX, Math.max(GRID_MIN, v));
  };
  return { sizeX: size(e.params.sizeX), sizeY: size(e.params.sizeY) };
}

/** The pin table, from `setupPins` (LEDArrayElm.java:66-70): the columns on
 *  the south, then the rows on the west, all unlabelled. */
export function ledArrayPins(e: CircuitElement): ChipPinDef[] {
  const { sizeX, sizeY } = ledArraySize(e);
  const pins: ChipPinDef[] = [];
  for (let i = 0; i < sizeX; i++) {
    pins.push({ side: 'S', pos: i, text: '' });
  }
  for (let i = 0; i < sizeY; i++) {
    pins.push({ side: 'W', pos: i, text: '' });
  }
  return pins;
}

/** The chip's cell size, `cspc` in ChipElm terms, as in dFlipFlop.ts. */
function chipCspc(e: CircuitElement): number {
  return (e.flags & CHIP_SMALL) !== 0 ? 8 : 16;
}

/** One cell's lit state from its two posts' voltages, row minus column. The
 *  grid's LED conducts once its forward drop clears the knee of the 3.73
 *  emission-coefficient model (roughly 1 V), so the same threshold that the
 *  engine's junction would carry separates a lit cell from a dark one. */
function ledLit(g: DrawContext, sizeX: number, ix: number, iy: number): boolean {
  const vf = (g.voltages[sizeX + iy] ?? 0) - (g.voltages[ix] ?? 0);
  return vf > 1.0;
}

/** Lit cells are red, dark cells a dim red or light gray, the display-family
 *  palette sevenSeg's segments use. */
function ledColor(g: DrawContext, lit: boolean): string {
  if (lit) return '#ff0000';
  const bg = g.theme.background;
  return parseInt(bg.slice(1, 3), 16) > 128 ? '#f5f5f5' : '#1e0000';
}

function drawLedArray(g: DrawContext, e: CircuitElement): void {
  const { sizeX, sizeY } = ledArraySize(e);
  const pins = ledArrayPins(e);
  drawChip(g, e, sizeX, sizeY, pins);
  const posts = chipPosts(e, sizeX, sizeY, pins);
  const cspc = chipCspc(e);
  const flipXY = (e.flags & CHIP_FLIP_XY) !== 0;
  for (let ix = 0; ix < sizeX; ix++) {
    for (let iy = 0; iy < sizeY; iy++) {
      // Each LED sits at the crossing of its column's post x and its row's
      // post y, swapped when the chip is flipped XY (LEDArrayElm.java:121-125).
      const col = posts[ix];
      const row = posts[sizeX + iy];
      const centre = flipXY ? { x: row.x, y: col.y } : { x: col.x, y: row.y };
      circle(g, centre, cspc / 2, ledColor(g, ledLit(g, sizeX, ix, iy)), true);
    }
  }
}

export const LED_ARRAY_DEF: ElementDef = {
  kind: 'ledArray',
  label: 'LED array',
  category: 'Other',
  dumpCode: '405',
  postCount: 16,  // the default 8x8 grid
  posts: (e) => {
    const { sizeX, sizeY } = ledArraySize(e);
    return chipPosts(e, sizeX, sizeY, ledArrayPins(e));
  },
  chipExtents: (e) => {
    const { sizeX, sizeY } = ledArraySize(e);
    return { sx: sizeX, sy: sizeY };
  },
  canMirror: true,  // ChipElm.flipX, LedArrayElm inherits it
  bodyRect: (e) => {
    const { sizeX, sizeY } = ledArraySize(e);
    return chipBodyRect(e, sizeX, sizeY);
  },
  noDiagonal: true,  // ChipElm.java:44
  defaultLength: 18,  // the default 8x8 spans (sizeX + 1) * 32
  defaults: { sizeX: 8, sizeY: 8, highVoltage: 5 },
  parse: (t, e) => {
    // The ChipElm base writes an optional high-voltage token (only under
    // CHIP_CUSTOM_VOLTAGE) before this element's own `sizeX sizeY`
    // (ChipElm.java:356-366, LEDArrayElm.java:32-35).
    const i = chipCommonTokens(t, e, false);
    const sizeX = Math.round(Number(t[i]));
    if (t[i] !== undefined && Number.isFinite(sizeX)) e.params.sizeX = sizeX;
    const sizeY = Math.round(Number(t[i + 1]));
    if (t[i + 1] !== undefined && Number.isFinite(sizeY)) e.params.sizeY = sizeY;
  },
  dump: (e) => [
    ...chipDump(e, ledArrayPins(e), false),
    e.params.sizeX ?? 8,
    e.params.sizeY ?? 8,
  ],
  dumpFlags: chipDumpFlags,
  fields: [
    { name: 'sizeX', label: 'Grid Width', min: 2, max: 16, integer: true },
    { name: 'sizeY', label: 'Grid Height', min: 2, max: 16, integer: true },
  ],
  draw: drawLedArray,
};
