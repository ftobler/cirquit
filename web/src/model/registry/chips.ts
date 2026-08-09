/**
 * The chip family's pin tables, keyed by kind. Every entry is a ChipElm
 * subclass upstream, the exact set the Create Test harness targets
 * (TestCreator.java: `instanceof ChipElm`): the pins carry the side, output
 * and bus metadata the harness needs to place its logic inputs and outputs.
 *
 * The controlled sources (VCVS, VCCS) draw a chip body here but extend
 * VoltageSourceElm upstream, not ChipElm, so they are deliberately absent: a
 * selected VCVS must not become a harness target.
 */

import type { CircuitElement } from '../types';
import type { ChipPinDef } from './elements/dFlipFlop';
import { adcPins } from './elements/adc';
import { cc2Pins } from './elements/cc2';
import { counterPins } from './elements/counter';
import { customLogicPins } from './elements/customLogic';
import { dacPins } from './elements/dac';
import { dffPins } from './elements/dFlipFlop';
import { decimalPins } from './elements/decimalDisplay';
import { demuxPins } from './elements/deMultiplexer';
import { jkPins } from './elements/jkFlipFlop';
import { latchPins } from './elements/latch';
import { ledArrayPins } from './elements/ledArray';
import { muxPins } from './elements/multiplexer';
import { phaseCompPins } from './elements/phaseComp';
import { ringPins } from './elements/ringCounter';
import { sevenSegPins } from './elements/sevenSeg';
import { tffPins } from './elements/tFlipFlop';
import { timerPins } from './elements/timer';
import { vcoPins } from './elements/vco';

/** Kind to pin-table builder. The pins line up with the posts `postsOf` hands
 *  back: `chipPosts` maps the same table to coordinates, so pin i is the post
 *  at index i. */
export const CHIP_PINS: ReadonlyMap<string, (e: CircuitElement) => ChipPinDef[]> = new Map([
  ['adc', adcPins],
  ['cc2', cc2Pins],
  ['counter', counterPins],
  ['customLogic', customLogicPins],
  ['dac', dacPins],
  ['dFlipFlop', dffPins],
  ['decimalDisplay', decimalPins],
  ['deMultiplexer', demuxPins],
  ['jkFlipFlop', jkPins],
  ['latch', latchPins],
  ['ledArray', ledArrayPins],
  ['multiplexer', muxPins],
  ['phaseComp', () => phaseCompPins],
  ['ringCounter', ringPins],
  ['sevenSeg', sevenSegPins],
  ['tFlipFlop', tffPins],
  ['timer', timerPins],
  ['vco', vcoPins],
]);

/** The pin table of a chip element, or undefined when the kind is not a chip. */
export function chipPinsOf(e: CircuitElement): ChipPinDef[] | undefined {
  return CHIP_PINS.get(e.kind)?.(e);
}
