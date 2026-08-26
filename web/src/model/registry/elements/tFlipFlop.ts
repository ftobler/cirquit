/**
 * The T flip-flop (TFlipFlopElm.java, dump 193). A rising clock edge toggles
 * Q when T is high; an optional reset pin on the west (and set pin with its
 * matching east reset post) appear under the flag bits.
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

export const TFF_RESET = 2;
export const TFF_SET = 4;

/** The pin table, from `setupPins` (TFlipFlopElm.java:34-53). */
export function tffPins(e: CircuitElement): ChipPinDef[] {
  const set = (e.flags & TFF_SET) !== 0;
  const reset = (e.flags & TFF_RESET) !== 0 || set;
  const pins: ChipPinDef[] = [
    { side: 'W', pos: 0, text: 'T' },
    { side: 'E', pos: 0, text: 'Q', output: true, state: true },
    { side: 'E', pos: set ? 1 : 2, text: 'Q', output: true, lineOver: true },
    { side: 'W', pos: 1, text: '', clock: true },
  ];
  if (set) {
    // Post order must match the engine: 4 is R on the east, 5 is S on the
    // west (TFlipFlopElm.java:49-52), so the S wire actually reaches the set
    // input.
    pins.push({ side: 'E', pos: 2, text: 'R' });
    pins.push({ side: 'W', pos: 2, text: 'S' });
  } else if (reset) {
    pins.push({ side: 'W', pos: 2, text: 'R' });
  }
  return pins;
}

function drawTff(g: DrawContext, e: CircuitElement): void {
  drawChip(g, e, 2, 3, tffPins(e));
}

export const TFLIPFLOP_DEF: ElementDef = {
  kind: 'tFlipFlop',
  label: 'T flip-flop',
  category: 'Logic',
  dumpCode: '193',
  postCount: 4,
  posts: (e) => chipPosts(e, 2, 3, tffPins(e)),
  chipExtents: () => ({ sx: 2, sy: 3 }),
  canMirror: true,  // ChipElm.flipX, TFlipFlopElm inherits it
  bodyRect: (e) => chipBodyRect(e, 2, 3),
  noDiagonal: true,  // ChipElm.java:44
  defaultLength: 6,  // the chip spans (sizeX + 1) * 32
  defaults: { highVoltage: 5 },
  parse: (t, e) => chipParse(t, e, tffPins(e), false),
  dump: (e) => chipDump(e, tffPins(e), false),
  dumpFlags: chipDumpFlags,
  fields: [
    { name: 'highVoltage', label: 'High logic voltage', unit: 'V' },
    { name: 'reset', label: 'Reset Pin', type: 'bool', flag: TFF_RESET },
    { name: 'set', label: 'Set Pin', type: 'bool', flag: TFF_SET },
  ],
  draw: drawTff,
};
