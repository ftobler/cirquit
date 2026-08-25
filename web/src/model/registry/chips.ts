/**
 * The chip family's pin tables, keyed by kind: every port kind whose upstream
 * class extends ChipElm, directly or through SRAMElm (ROM), which is exactly
 * the set the Create Test harness targets (TestCreator.java:
 * `instanceof ChipElm`). The pins carry the side, output and bus metadata the
 * harness needs to place its logic inputs and outputs.
 *
 * Two deliberate absences despite chip-looking bodies. The four controlled
 * sources are ChipElm subclasses upstream too (VCVS, CCCS and CCVS extend
 * VCCSElm), but their pins are analog, so they stay out: a selected VCVS must
 * never become a harness target. And DelayBufferElm extends CircuitElm
 * directly, not ChipElm, so the delay buffer is not one either. Upstream's
 * CustomCompositeChip has no port kind yet, so it has nothing to register.
 */

import type { CircuitElement } from '../types';
import type { ChipPinDef } from './elements/dFlipFlop';
import { adcPins } from './elements/adc';
import { analogMuxPins } from './elements/analogMux';
import { busSplitterPins } from './elements/busSplitter';
import { busTransceiverPins } from './elements/busTransceiver';
import { cc2Pins } from './elements/cc2';
import { counterPins } from './elements/counter';
import { counter2Pins } from './elements/counter2';
import { customLogicPins } from './elements/customLogic';
import { dacPins } from './elements/dac';
import { dffPins } from './elements/dFlipFlop';
import { decimalPins } from './elements/decimalDisplay';
import { demuxPins } from './elements/deMultiplexer';
import { fullAdderPins } from './elements/fullAdder';
import { halfAdderPins } from './elements/halfAdder';
import { jkPins } from './elements/jkFlipFlop';
import { latchPins } from './elements/latch';
import { ledArrayPins } from './elements/ledArray';
import { monostablePins } from './elements/monostable';
import { muxPins } from './elements/multiplexer';
import { phaseCompPins } from './elements/phaseComp';
import { pisoPins } from './elements/pisoShift';
import { ringPins } from './elements/ringCounter';
import { seqGenPins } from './elements/seqGen';
import { sevenSegPins } from './elements/sevenSeg';
import { sevenSegDecoderPins } from './elements/sevenSegDecoder';
import { sipoPins } from './elements/sipoShift';
import { memoryPins } from './elements/sram';
import { tffPins } from './elements/tFlipFlop';
import { timeDelayRelayPins } from './elements/timeDelayRelay';
import { timerPins } from './elements/timer';
import { vcoPins } from './elements/vco';

/** Kind to pin-table builder. The pins line up with the posts `postsOf` hands
 *  back: `chipPosts` maps the same table to coordinates, so pin i is the post
 *  at index i. */
export const CHIP_PINS: ReadonlyMap<string, (e: CircuitElement) => ChipPinDef[]> = new Map([
  ['adc', adcPins],
  ['analogMux', analogMuxPins],
  ['busSplitter', busSplitterPins],
  ['busTransceiver', busTransceiverPins],
  ['cc2', cc2Pins],
  ['counter', counterPins],
  ['counter2', counter2Pins],
  ['customLogic', customLogicPins],
  ['dac', dacPins],
  ['dFlipFlop', dffPins],
  ['decimalDisplay', decimalPins],
  ['deMultiplexer', demuxPins],
  ['fullAdder', fullAdderPins],
  ['halfAdder', halfAdderPins],
  ['jkFlipFlop', jkPins],
  ['latch', latchPins],
  ['ledArray', ledArrayPins],
  ['monostable', monostablePins],
  ['multiplexer', muxPins],
  ['phaseComp', () => phaseCompPins],
  ['pisoShift', pisoPins],
  ['ringCounter', ringPins],
  ['seqGen', seqGenPins],
  ['sevenSeg', sevenSegPins],
  ['sevenSegDecoder', sevenSegDecoderPins],
  ['sipoShift', sipoPins],
  ['sram', (e) => memoryPins(e, true)],
  ['rom', (e) => memoryPins(e, false)],
  ['tFlipFlop', tffPins],
  ['timeDelayRelay', timeDelayRelayPins],
  ['timer', timerPins],
  ['vco', vcoPins],
]);

/** The pin table of a chip element, or undefined when the kind is not a chip. */
export function chipPinsOf(e: CircuitElement): ChipPinDef[] | undefined {
  return CHIP_PINS.get(e.kind)?.(e);
}
