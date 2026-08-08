/**
 * The voltage-controlled oscillator (VCOElm.java, dump 158): a fixed six-post
 * chip whose output square-wave frequency follows the Vi input. The engine
 * mirrors the currents through the external R1 and R2 resistors (the R1 pin is
 * clamped to Vi, the R2 pin held at 5 V) into the external capacitor across
 * the C pins, so with R1 and R2 to ground the frequency is
 * `(Vi/R1 + 5/R2) / (8C)`.
 *
 * It is a ChipElm upstream, so the body, pin stubs and labels come from the
 * shared chip machinery, but it has no editable fields and no pin saves its
 * level to the file, so the token stream after the common fields is empty.
 */

import { chipDump, chipDumpFlags, chipParse, chipPosts, drawChip, type ChipPinDef } from './dFlipFlop';
import type { CircuitElement, DrawContext, ElementDef } from '../../types';

/** The pin table, from `setupPins` (VCOElm.java:29-42): Vi and the Vo output
 *  on the west, the two C pins, R1 and R2 on the east. No pin is a state pin,
 *  so none of their levels is saved. */
function vcoPins(): ChipPinDef[] {
  return [
    { side: 'W', pos: 0, text: 'Vi' },
    { side: 'W', pos: 3, text: 'Vo', output: true },
    { side: 'E', pos: 0, text: 'C' },
    { side: 'E', pos: 1, text: 'C' },
    { side: 'E', pos: 2, text: 'R1', output: true },
    { side: 'E', pos: 3, text: 'R2', output: true },
  ];
}

function drawVco(g: DrawContext, e: CircuitElement): void {
  drawChip(g, e, 2, 4, vcoPins());
}

export const VCO_DEF: ElementDef = {
  kind: 'vco',
  label: 'VCO',
  category: 'Active',
  dumpCode: '158',
  postCount: 6,
  posts: (e) => chipPosts(e, 2, 4, vcoPins()),
  noDiagonal: true,  // ChipElm.java:44
  defaultLength: 6,  // the chip spans (sizeX + 1) * 32
  defaults: {},
  parse: (t, e) => chipParse(t, e, vcoPins(), false),
  dump: (e) => chipDump(e, vcoPins(), false),
  dumpFlags: chipDumpFlags,
  fields: [],
  draw: drawVco,
};
