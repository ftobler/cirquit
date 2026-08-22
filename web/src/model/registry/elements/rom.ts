/**
 * The ROM (ROMElm.java, dump 436): the SRAM's read-only twin. Same token
 * stream (`addressBits dataBits` plus the contents runs), same address and
 * data pins, but no WE pin and no write path: the OE pin sits alone at the
 * top-left (ROMElm.java:47-49). The shared helpers live in `sram.ts`.
 */

import {
  chipBitOrderFlags,
  chipBodyRect,
  chipDumpFlags,
  chipPosts,
  drawChip,
} from './dFlipFlop';
import { memoryDump, memoryParse, memoryPins, memorySizeY, SRAM_RELOAD_ON_RESET, SRAM_HEX_DISPLAY } from './sram';
import type { CircuitElement, DrawContext, ElementDef } from '../../types';

function drawRom(g: DrawContext, e: CircuitElement): void {
  drawChip(g, e, 2, memorySizeY(e), memoryPins(e, false));
}

export const ROM_DEF: ElementDef = {
  kind: 'rom',
  label: 'ROM',
  category: 'Logic',
  dumpCode: '436',
  postCount: 9,  // OE + 2*4 bits at the default
  posts: (e) => chipPosts(e, 2, memorySizeY(e), memoryPins(e, false)),
  bodyRect: (e) => chipBodyRect(e, 2, memorySizeY(e)),
  noDiagonal: true,  // ChipElm.java:44
  defaultLength: 3,  // the chip spans (sizeX + 1) * 32
  defaults: { addressBits: 4, dataBits: 4, highVoltage: 5 },
  parse: (t, e) => memoryParse(t, e),
  dump: memoryDump,
  dumpFlags: (e) => chipBitOrderFlags(e, chipDumpFlags(e)),
  fields: [
    { name: 'addressBits', label: '# of Address Bits', min: 2, max: 16, integer: true },
    { name: 'dataBits', label: '# of Data Bits', min: 2, max: 16, integer: true },
    { name: 'highVoltage', label: 'High logic voltage', unit: 'V' },
    { name: 'hexDisplay', label: 'Hex Display', type: 'bool', flag: SRAM_HEX_DISPLAY },
    {
      name: 'reloadOnReset',
      label: 'Restore Contents on Reset',
      type: 'bool',
      flag: SRAM_RELOAD_ON_RESET,
    },
  ],
  draw: drawRom,
};
