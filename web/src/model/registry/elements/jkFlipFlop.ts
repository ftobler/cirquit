/**
 * The JK flip-flop (JKFlipFlopElm.java, dump 156). The clock pin carries a
 * bubble unless FLAG_POSITIVE_EDGE is set, so the default is negative-edge
 * triggered, and an optional reset pin appears on the east under FLAG_RESET.
 */

import {
  chipBodyRect,
  chipDump,
  chipDumpFlags,
  chipParse,
  chipPosts,
  drawChip,
  type ChipPinDef,
} from './dFlipFlop';
import type { CircuitElement, DrawContext, ElementDef } from '../../types';

export const JK_RESET = 2;
export const JK_POSITIVE_EDGE = 4;
export const JK_INVERT_RESET = 8;

/** The pin table, from `setupPins` (JKFlipFlopElm.java:37-56). */
export function jkPins(e: CircuitElement): ChipPinDef[] {
  const reset = (e.flags & JK_RESET) !== 0;
  const invert = (e.flags & JK_INVERT_RESET) !== 0;
  const pins: ChipPinDef[] = [
    { side: 'W', pos: 0, text: 'J' },
    { side: 'W', pos: 1, text: '', clock: true, bubble: (e.flags & JK_POSITIVE_EDGE) === 0 },
    { side: 'W', pos: 2, text: 'K' },
    { side: 'E', pos: 0, text: 'Q', output: true, state: true },
    { side: 'E', pos: 2, text: 'Q', output: true, lineOver: true },
  ];
  if (reset) {
    pins.push({ side: 'E', pos: 1, text: 'R', bubble: invert });
  }
  return pins;
}

function drawJk(g: DrawContext, e: CircuitElement): void {
  drawChip(g, e, 2, 3, jkPins(e));
}

export const JKFLIPFLOP_DEF: ElementDef = {
  kind: 'jkFlipFlop',
  label: 'JK flip-flop',
  category: 'Logic',
  dumpCode: '156',
  postCount: 5,
  posts: (e) => chipPosts(e, 2, 3, jkPins(e)),
  bodyRect: (e) => chipBodyRect(e, 2, 3),
  noDiagonal: true,  // ChipElm.java:44
  defaultLength: 6,  // the chip spans (sizeX + 1) * 32
  defaults: { highVoltage: 5 },
  parse: (t, e) => chipParse(t, e, jkPins(e), false),
  dump: (e) => chipDump(e, jkPins(e), false),
  dumpFlags: chipDumpFlags,
  fields: [
    { name: 'highVoltage', label: 'High logic voltage', unit: 'V' },
    { name: 'reset', label: 'Reset Pin', type: 'bool', flag: JK_RESET },
    { name: 'positiveEdge', label: 'Positive Edge Triggered', type: 'bool', flag: JK_POSITIVE_EDGE },
    { name: 'invertReset', label: 'Invert Reset', type: 'bool', flag: JK_INVERT_RESET },
  ],
  draw: drawJk,
};
