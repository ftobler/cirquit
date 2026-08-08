/**
 * The ring counter (RingCounterElm.java, dump 163): one output high, advanced
 * one position per clock edge. The clock and reset pins sit on the west and
 * south, the outputs along the top, and an optional active-low CE pin appears
 * on the south when FLAG_CLOCK_INHIBIT is set and the width is at least three.
 */

import {
  chipCommonTokens,
  chipDump,
  chipDumpFlags,
  chipPosts,
  chipStateNames,
  drawChip,
  type ChipPinDef,
} from './dFlipFlop';
import { readParams } from '../shared';
import type { CircuitElement, DrawContext, ElementDef } from '../../types';

export const RING_CLOCK_INHIBIT = 2;
export const RING_RESET_HIGH = 4;

function ringBits(e: CircuitElement): number {
  return Math.max(2, Math.round(e.params.bits ?? 10));
}

function ringSizeX(e: CircuitElement): number {
  const bits = ringBits(e);
  return bits > 2 ? bits : 2;
}

function hasClockInhibit(e: CircuitElement): boolean {
  return (e.flags & RING_CLOCK_INHIBIT) !== 0 && ringBits(e) >= 3;
}

/** The pin table, from `setupPins` (RingCounterElm.java:45-66). */
function ringPins(e: CircuitElement): ChipPinDef[] {
  const bits = ringBits(e);
  const sizeX = ringSizeX(e);
  // The reset pin carries an overline when the reset is active low, i.e. when
  // FLAG_RESET_HIGH is clear (hasInvertReset, RingCounterElm.java:41).
  const invertReset = (e.flags & RING_RESET_HIGH) === 0;
  const pins: ChipPinDef[] = [
    { side: 'W', pos: 1, text: '', clock: true },
    { side: 'S', pos: sizeX - 1, text: 'R', lineOver: invertReset },
  ];
  for (let i = 0; i < bits; i++) {
    pins.push({ side: 'N', pos: i, text: `Q${i}`, output: true, state: true });
  }
  if (hasClockInhibit(e)) {
    pins.push({ side: 'S', pos: 1, text: 'CE', lineOver: true });
  }
  return pins;
}

function drawRing(g: DrawContext, e: CircuitElement): void {
  drawChip(g, e, ringSizeX(e), 2, ringPins(e));
}

export const RING_COUNTER_DEF: ElementDef = {
  kind: 'ringCounter',
  label: 'ring counter',
  category: 'Logic',
  dumpCode: '163',
  postCount: 13,  // bits(10) + clock + reset + clock-inhibit at the default
  posts: (e) => chipPosts(e, ringSizeX(e), 2, ringPins(e)),
  noDiagonal: true,  // ChipElm.java:44
  defaultLength: 6,  // the chip spans (sizeX + 1) * 32
  defaultFlags: RING_CLOCK_INHIBIT,  // RingCounterElm.java:29
  defaults: { bits: 10, highVoltage: 5 },
  parse: (t, e) => {
    // `bits` must land first: it decides how many state tokens follow.
    const i = chipCommonTokens(t, e, true);
    readParams(t.slice(i), e, chipStateNames(ringPins(e)));
  },
  dump: (e) => chipDump(e, ringPins(e), true, 10),
  dumpFlags: chipDumpFlags,
  fields: [
    { name: 'bits', label: '# of Bits', min: 2 },
    { name: 'highVoltage', label: 'High logic voltage', unit: 'V' },
    { name: 'resetHigh', label: 'Reset active high', type: 'bool', flag: RING_RESET_HIGH },
  ],
  draw: drawRing,
};
