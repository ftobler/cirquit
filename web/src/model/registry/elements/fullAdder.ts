/**
 * The ripple-carry full adder (FullAdderElm.java, dump 196): `bits` A inputs
 * and `bits` B inputs summed with a carry-in into `bits` S outputs and a
 * carry-out. The width is the `bits` file token under FLAG_BITS, or 1 for a
 * flagless line, exactly the file constructor's default (FullAdderElm.java:
 * 30-35). A fresh part carries the flag like upstream's interactive
 * constructor; a flagless file line keeps its byte-exact form on save and an
 * edit to its width sets the flag, so the next save writes the `bits` token.
 */

import {
  chipBodyRect,
  chipCommonTokens,
  chipDumpFlags,
  chipPosts,
  drawChip,
  normalizeChipBits,
  type ChipPinDef,
} from './dFlipFlop';
import type { CircuitElement, DrawContext, ElementDef } from '../../types';

/** File flag saying a `bits` token follows the common chip fields
 *  (FullAdderElm.java:36). */
export const FULL_ADDER_BITS = 2;

/** The bit width, truncated and clamped to the 1..16 the engine accepts
 *  (full_adder.rs:38). */
export function normalizeFullAdderBits(value: number): number {
  return normalizeChipBits(value, 1, 16);
}

function fullAdderBits(e: CircuitElement): number {
  if ((e.flags & FULL_ADDER_BITS) !== 0) return normalizeFullAdderBits(e.params.bits ?? 4);
  return 1;
}

function fullAdderSizeY(e: CircuitElement): number {
  return 2 * fullAdderBits(e) + 1;
}

/** The pin table, from `setupPins` (FullAdderElm.java:41-56). The A and B
 *  inputs run MSB first down the west (makeBitPins), so A0 sits at the bottom
 *  of its group and the S outputs start two rows inside the east edge. */
export function fullAdderPins(e: CircuitElement): ChipPinDef[] {
  const bits = fullAdderBits(e);
  const pins: ChipPinDef[] = [];
  for (let i = 0; i < bits; i++) {
    pins.push({ side: 'W', pos: bits - 1 - i, text: `A${i}` });
  }
  for (let i = 0; i < bits; i++) {
    pins.push({ side: 'W', pos: 2 * bits - 1 - i, text: `B${i}` });
  }
  for (let i = 0; i < bits; i++) {
    pins.push({ side: 'E', pos: bits + 1 - i, text: `S${i}`, output: true });
  }
  pins.push({ side: 'W', pos: 2 * bits, text: 'Cin' });
  pins.push({ side: 'E', pos: 0, text: 'C', output: true });
  return pins;
}

function drawFullAdder(g: DrawContext, e: CircuitElement): void {
  drawChip(g, e, 2, fullAdderSizeY(e), fullAdderPins(e));
}

export const FULL_ADDER_DEF: ElementDef = {
  kind: 'fullAdder',
  label: 'adder',
  category: 'Logic',
  dumpCode: '196',
  postCount: 14,  // the default 4-bit layout: 3*4 + the carry pair
  posts: (e) => chipPosts(e, 2, fullAdderSizeY(e), fullAdderPins(e)),
  bodyRect: (e) => chipBodyRect(e, 2, fullAdderSizeY(e)),
  noDiagonal: true,  // ChipElm.java:44
  defaultLength: 3,  // the chip spans (sizeX + 1) * 32
  defaultFlags: FULL_ADDER_BITS,  // the interactive constructor sets it (FullAdderElm.java:25)
  defaults: { bits: 4, highVoltage: 5 },
  parse: (t, e, warn) => {
    // The bits token exists only under FLAG_BITS; a flagless line is the
    // 1-bit adder the file constructor defaults to, kept byte-exact on save.
    // The high-voltage token, when FLAG_CUSTOM_VOLTAGE says one follows, comes
    // after it (ChipElm.java:51-56).
    const flagged = (e.flags & FULL_ADDER_BITS) !== 0;
    chipCommonTokens(t, e, flagged, normalizeFullAdderBits, 'adder', warn);
    if (!flagged) e.params.bits = 1;
  },
  dump: (e) => {
    const out: (string | number)[] = [];
    if ((e.flags & FULL_ADDER_BITS) !== 0) out.push(e.params.bits ?? 4);
    const hv = e.params.highVoltage;
    if (hv !== undefined && hv !== 5) out.push(hv);
    return out;
  },
  dumpFlags: chipDumpFlags,
  fields: [
    { name: 'bits', label: '# of Bits', min: 1, max: 16, integer: true },
    { name: 'highVoltage', label: 'High logic voltage', unit: 'V' },
  ],
  draw: drawFullAdder,
};
