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
  CHIP_BIT_ORDER_BUS,
  chipBitOrderFlags,
  chipBitOrderParam,
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

/** Bus bit order (upstream BIT_ORDER_BUS, XML attribute `bo="2"`): the A, B
 *  and S groups each collapse onto one row of their side. Upstream only
 *  allows it under FLAG_BITS (allowBus = needsBits). */
export function fullAdderBus(e: CircuitElement): boolean {
  return (
    e.params.bitOrder === 2 ||
    ((e.flags & (CHIP_BIT_ORDER_BUS | FULL_ADDER_BITS)) === (CHIP_BIT_ORDER_BUS | FULL_ADDER_BITS))
  );
}

function fullAdderSizeY(e: CircuitElement): number {
  // bitsY is 1 in bus mode and `bits` otherwise (FullAdderElm.java:42-43).
  return fullAdderBus(e) ? 3 : 2 * fullAdderBits(e) + 1;
}

/** The pin table, from `setupPins` (FullAdderElm.java:41-56). Non-bus, the
 *  MSB-first default lays each group out high row first (makeBitPins places
 *  name_i at row pos+count-1-i), so A3..A0 descend the west and the S outputs
 *  start two rows inside the east edge. In bus mode each group collapses onto
 *  its anchor row carrying per-bit tags (the useBus branch), which is what
 *  keeps td4's adder wired to its bus wires. */
export function fullAdderPins(e: CircuitElement): ChipPinDef[] {
  const bits = fullAdderBits(e);
  const bus = fullAdderBus(e);
  const pins: ChipPinDef[] = [];
  const bank = (side: 'W' | 'E', pos: number, name: string, output: boolean): void => {
    for (let i = 0; i < bits; i++) {
      pins.push(
        bus
          ? { side, pos, text: name, output, busWidth: bits, busZ: i }
          : { side, pos: pos + (bits - 1 - i), text: `${name}${i}`, output },
      );
    }
  };
  bank('W', 0, 'A', false);
  // The B group's anchor row is bitsY, `bits` outside bus mode.
  bank('W', bus ? 1 : bits, 'B', false);
  bank('E', 2, 'S', true);
  // The carry-in sits at bitsY*2 (FullAdderElm.java:54).
  pins.push({ side: 'W', pos: bus ? 2 : 2 * bits, text: 'Cin' });
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
    chipBitOrderParam(e);
  },
  dump: (e) => {
    const out: (string | number)[] = [];
    if ((e.flags & FULL_ADDER_BITS) !== 0) out.push(e.params.bits ?? 4);
    const hv = e.params.highVoltage;
    if (hv !== undefined && hv !== 5) out.push(hv);
    return out;
  },
  dumpFlags: (e) => chipBitOrderFlags(e, chipDumpFlags(e)),
  fields: [
    { name: 'bits', label: '# of Bits', min: 1, max: 16, integer: true },
    { name: 'highVoltage', label: 'High logic voltage', unit: 'V' },
  ],
  draw: drawFullAdder,
};
