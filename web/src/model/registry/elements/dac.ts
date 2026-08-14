/**
 * The digital-to-analog converter (DACElm.java, dump 166): a bit-width chip
 * whose analog output scales its thresholded bit inputs against the V+ pin
 * voltage, so all bits high drives the output to exactly V+ and the pattern
 * in between scales linearly. The engine holds the output source and the
 * scaling law; this file owns the geometry and the file-format mapping.
 *
 * It is a ChipElm upstream, so the body, pin stubs and labels come from the
 * shared chip machinery. Token layout after the common fields is just the bit
 * count and the optional high-voltage token (ChipElm.java:356-366); no pin
 * saves its level to the file, because the O pin's level is derived, not
 * stored.
 */

import {
  chipBodyRect,
  chipDump,
  chipDumpFlags,
  chipParse,
  chipPosts,
  drawChip,
  normalizeChipBits,
  type ChipPinDef,
} from './dFlipFlop';
import type { CircuitElement, DrawContext, ElementDef } from '../../types';

/** The bits field, clamped like the engine: truncated, held to the engine's
 *  floor of 1 so a degenerate file cannot draw a zero-size chip, and capped at
 *  30 so `1usize << bits` cannot reach the width of usize on the wasm32
 *  target this ships to (dac.rs:36). The edit dialog rejects below 2, but the
 *  engine floor is 1. */
export function normalizeDacBits(value: number): number {
  return normalizeChipBits(value, 1, 30);
}

function dacBits(e: CircuitElement): number {
  return normalizeDacBits(e.params.bits ?? 4);
}

/** The pin table, from `setupPins` (DACElm.java:31-41): the bit inputs run
 *  MSB first on the west (D0 at the bottom), the O output source at the top of
 *  the east and the V+ full-scale reference at the bottom. */
export function dacPins(e: CircuitElement): ChipPinDef[] {
  const bits = dacBits(e);
  const sizeY = Math.max(bits, 2);
  const pins: ChipPinDef[] = [];
  for (let i = 0; i < bits; i++) {
    pins.push({ side: 'W', pos: bits - 1 - i, text: `D${i}` });
  }
  pins.push({ side: 'E', pos: 0, text: 'O', output: true });
  pins.push({ side: 'E', pos: sizeY - 1, text: 'V+' });
  return pins;
}

function drawDac(g: DrawContext, e: CircuitElement): void {
  drawChip(g, e, 2, Math.max(dacBits(e), 2), dacPins(e));
}

export const DAC_DEF: ElementDef = {
  kind: 'dac',
  label: 'DAC',
  category: 'Active',
  dumpCode: '166',
  postCount: 6,
  posts: (e) => chipPosts(e, 2, Math.max(dacBits(e), 2), dacPins(e)),
  bodyRect: (e) => chipBodyRect(e, 2, Math.max(dacBits(e), 2)),
  noDiagonal: true, // ChipElm.java:44
  defaultLength: 6, // the chip spans (sizeX + 1) * 32
  defaults: { bits: 4, highVoltage: 5 },
  parse: (t, e) => chipParse(t, e, dacPins(e), true, normalizeDacBits),
  dump: (e) => chipDump(e, dacPins(e), true),
  dumpFlags: chipDumpFlags,
  fields: [
    { name: 'bits', label: '# of Bits', min: 2, max: 30 },
    // Upstream's DAC dialog skips the high logic voltage (isDigitalChip is
    // false), but the threshold it sets lives in the file format under
    // FLAG_CUSTOM_VOLTAGE, so it is exposed here like every other chip.
    { name: 'highVoltage', label: 'High logic voltage', unit: 'V' },
  ],
  draw: drawDac,
};
