/**
 * Second-generation current conveyor CCII+/CCII- (CC2Elm, dump 179): a 2x3
 * chip with X (output, west row 0), Y (west row 2) and Z (east row 1). The
 * X terminal is driven to the Y voltage and the Z current is `gain` times the
 * X current, so +1 is a CCII+ and -1 a CCII- (CC2Elm.java:61-67).
 *
 * Token layout after the common fields is the single gain value, the last of
 * the conveyor's own parameters (CC2Elm.java:29-33); the outputs carry no
 * saved state, so nothing follows it.
 */

import {
  chipDumpFlags,
  chipPosts,
  drawChip,
  type ChipPinDef,
} from './dFlipFlop';
import { readParams, writeParams } from '../shared';
import type { CircuitElement, DrawContext, ElementDef } from '../../types';

/** The pin table, from `setupPins` (CC2Elm.java:43-51): the X output source
 *  on the west, the Y input two rows down, and the Z output on the east. */
export function cc2Pins(): ChipPinDef[] {
  return [
    { side: 'W', pos: 0, text: 'X', output: true },
    { side: 'W', pos: 2, text: 'Y' },
    { side: 'E', pos: 1, text: 'Z' },
  ];
}

function drawCc2(g: DrawContext, e: CircuitElement): void {
  drawChip(g, e, 2, 3, cc2Pins());
}

export const CC2_DEF: ElementDef = {
  kind: 'cc2',
  label: 'Current Conveyor',
  category: 'Active',
  dumpCode: '179',
  postCount: 3,
  posts: (e) => chipPosts(e, 2, 3, cc2Pins()),
  noDiagonal: true, // ChipElm.java:44
  defaultLength: 6, // the chip spans (sizeX + 1) * 32
  defaults: { gain: 1 },
  parse: (t, e) => {
    readParams(t, e, ['gain']);
  },
  dump: writeParams(['gain']),
  dumpFlags: chipDumpFlags,
  fields: [{ name: 'gain', label: 'Gain' }],
  draw: drawCc2,
};
