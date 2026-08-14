/**
 * The bus splitter (BusSplitterElm.java, dump 433): `bits` bus-side pins all
 * hang off one shared node, and each individual pin ties to bus bit `i`, so a
 * bus wire fans out into per-bit wires. The file line carries only the `bits`
 * token, the standard `needsBits` chip stream (ChipElm.java:51-55), and no
 * pin saves state.
 */

import {
  chipBodyRect,
  chipParse,
  chipDump,
  chipDumpFlags,
  chipPosts,
  drawChip,
  normalizeChipBits,
  type ChipPinDef,
} from './dFlipFlop';
import type { CircuitElement, DrawContext, ElementDef } from '../../types';

/** The bit count, floored like the engine: truncated and clamped to the 2..32
 *  the engine accepts (bus_splitter.rs:26). */
export function normalizeBusSplitterBits(value: number): number {
  return normalizeChipBits(value, 2, 32);
}

function busSplitterBits(e: CircuitElement): number {
  return normalizeBusSplitterBits(e.params.bits ?? 4);
}

function busSplitterSizeY(e: CircuitElement): number {
  return busSplitterBits(e);
}

/** The pin table, from `setupPins` (BusSplitterElm.java:33-52): the bus-side
 *  pins all sit at west position 0 with `busWidth`/`busZ` marking their bit,
 *  and the individual pins run down the east MSB first. */
export function busSplitterPins(e: CircuitElement): ChipPinDef[] {
  const bits = busSplitterBits(e);
  const pins: ChipPinDef[] = [];
  for (let i = 0; i < bits; i++) {
    pins.push({ side: 'W', pos: 0, text: 'Bus', busWidth: bits, busZ: i });
  }
  for (let i = 0; i < bits; i++) {
    pins.push({ side: 'E', pos: bits - 1 - i, text: `${i}` });
  }
  return pins;
}

function drawBusSplitter(g: DrawContext, e: CircuitElement): void {
  drawChip(g, e, 2, busSplitterSizeY(e), busSplitterPins(e));
}

export const BUS_SPLITTER_DEF: ElementDef = {
  kind: 'busSplitter',
  label: 'bus splitter',
  category: 'Logic',
  dumpCode: '433',
  postCount: 8,  // 2*bits(4) at the default
  posts: (e) => chipPosts(e, 2, busSplitterSizeY(e), busSplitterPins(e)),
  bodyRect: (e) => chipBodyRect(e, 2, busSplitterSizeY(e)),
  noDiagonal: true,  // ChipElm.java:44
  defaultLength: 3,  // the chip spans (sizeX + 1) * 32
  defaults: { bits: 4, highVoltage: 5 },
  parse: (t, e, warn) =>
    chipParse(t, e, busSplitterPins(e), true, normalizeBusSplitterBits, 'bus splitter', warn),
  dump: (e) => chipDump(e, busSplitterPins(e), true),
  dumpFlags: chipDumpFlags,
  fields: [
    { name: 'bits', label: '# of Bits', min: 2 },
    { name: 'highVoltage', label: 'High logic voltage', unit: 'V' },
  ],
  draw: drawBusSplitter,
};
