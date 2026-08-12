/**
 * The half adder (HalfAdderElm.java, dump 195): a four-pin combinational chip
 * whose outputs are S = A XOR B and C = A AND B. The two outputs sit on the
 * east, the two inputs on the west. No pin carries saved state, so the file
 * line carries no tokens beyond the optional high voltage.
 */

import {
  chipBodyRect,
  chipParse,
  chipDump,
  chipDumpFlags,
  chipPosts,
  drawChip,
  type ChipPinDef,
} from './dFlipFlop';
import type { CircuitElement, DrawContext, ElementDef } from '../../types';

/** The pin table, from `setupPins` (HalfAdderElm.java:31-43). */
export function halfAdderPins(): ChipPinDef[] {
  return [
    { side: 'E', pos: 0, text: 'S', output: true },
    { side: 'E', pos: 1, text: 'C', output: true },
    { side: 'W', pos: 0, text: 'A' },
    { side: 'W', pos: 1, text: 'B' },
  ];
}

function drawHalfAdder(g: DrawContext, e: CircuitElement): void {
  drawChip(g, e, 2, 2, halfAdderPins());
}

export const HALF_ADDER_DEF: ElementDef = {
  kind: 'halfAdder',
  label: 'half adder',
  category: 'Logic',
  dumpCode: '195',
  postCount: 4,
  posts: (e) => chipPosts(e, 2, 2, halfAdderPins()),
  bodyRect: (e) => chipBodyRect(e, 2, 2),
  noDiagonal: true,  // ChipElm.java:44
  defaultLength: 3,  // the chip spans (sizeX + 1) * 32
  defaults: { highVoltage: 5 },
  parse: (t, e) => chipParse(t, e, halfAdderPins(), false),
  dump: (e) => chipDump(e, halfAdderPins(), false),
  dumpFlags: chipDumpFlags,
  fields: [{ name: 'highVoltage', label: 'High logic voltage', unit: 'V' }],
  draw: drawHalfAdder,
};
