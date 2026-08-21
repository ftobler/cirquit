/**
 * The register/latch (LatchElm.java, dump 168). A bit-width register that
 * samples its inputs on a clock edge (or transparently at any high level under
 * FLAG_NO_EDGE), with optional reset and set pins and up to two input/output
 * enable pairs whose active-low pins tri-state the outputs.
 */

import {
  chipBodyRect,
  chipCommonTokens,
  chipDump,
  chipDumpFlags,
  chipPosts,
  chipStateNames,
  drawChip,
  normalizeChipBits,
  type ChipPinDef,
} from './dFlipFlop';
import { readParams } from '../shared';
import type { CircuitElement, DrawContext, ElementDef } from '../../types';

export const LATCH_STATE = 2;
export const LATCH_NO_EDGE = 4;
export const LATCH_RESET = 8;
export const LATCH_SET = 16;
/** The enable mode lives in bits 5-6 (LatchElm.java:27-29): bit 5 = one
 *  enable pair, bit 6 = two. Both set clamps to two. */
export const LATCH_ENABLE_ONE = 32;
export const LATCH_ENABLE_TWO = 64;
export const LATCH_RESET_INVERT = 128;

/** The bits field, clamped like the engine: truncated and held to the engine's
 *  2..32 range, the edit dialog's floor and the ceiling that keeps a
 *  hand-edited width from allocating unbounded pins (latch.rs:42,
 *  LatchElm.java:258). */
export function normalizeLatchBits(value: number): number {
  return normalizeChipBits(value, 2, 32);
}

function latchBits(e: CircuitElement): number {
  return normalizeLatchBits(e.params.bits ?? 4);
}

/** The number of input (and output) enable pins, from bits 5-6. */
export function latchEnableMode(e: CircuitElement): number {
  const mode = ((e.flags & LATCH_ENABLE_ONE) ? 1 : 0) + ((e.flags & LATCH_ENABLE_TWO) ? 2 : 0);
  return Math.min(2, mode);
}

function latchSizeY(e: CircuitElement): number {
  const bits = latchBits(e);
  const enable = latchEnableMode(e);
  return (
    bits +
    1 +
    ((e.flags & LATCH_RESET) ? 1 : 0) +
    ((e.flags & LATCH_SET) ? 1 : 0) +
    enable
  );
}

/** The pin table, from `setupPins` (LatchElm.java:67-109). The bit pins run
 *  MSB first, so I0 sits at the bottom and I_{bits-1} at the top. */
export function latchPins(e: CircuitElement): ChipPinDef[] {
  const bits = latchBits(e);
  const edge = (e.flags & LATCH_NO_EDGE) === 0;
  const enable = latchEnableMode(e);
  const pins: ChipPinDef[] = [];
  for (let i = 0; i < bits; i++) {
    pins.push({ side: 'W', pos: bits - 1 - i, text: `I${i}` });
  }
  for (let i = 0; i < bits; i++) {
    pins.push({ side: 'E', pos: bits - 1 - i, text: `O${i}`, output: true, state: true });
  }
  let left = bits;
  pins.push({ side: 'W', pos: left++, text: edge ? '' : 'Ld', clock: edge });
  if ((e.flags & LATCH_RESET) !== 0) {
    pins.push({ side: 'W', pos: left++, text: 'R', lineOver: (e.flags & LATCH_RESET_INVERT) !== 0 });
  }
  if ((e.flags & LATCH_SET) !== 0) {
    pins.push({ side: 'W', pos: left++, text: 'S' });
  }
  let right = left;
  for (let i = 0; i < enable; i++) pins.push({ side: 'W', pos: left++, text: 'IE', lineOver: true });
  for (let i = 0; i < enable; i++) pins.push({ side: 'E', pos: right++, text: 'OE', lineOver: true });
  return pins;
}

function drawLatch(g: DrawContext, e: CircuitElement): void {
  drawChip(g, e, 2, latchSizeY(e), latchPins(e));
}

export const LATCH_DEF: ElementDef = {
  kind: 'latch',
  label: 'latch',
  category: 'Logic',
  dumpCode: '168',
  postCount: 9,
  posts: (e) => chipPosts(e, 2, latchSizeY(e), latchPins(e)),
  bodyRect: (e) => chipBodyRect(e, 2, latchSizeY(e)),
  noDiagonal: true,  // ChipElm.java:44
  defaultLength: 6,  // the chip spans (sizeX + 1) * 32
  defaultFlags: LATCH_STATE,  // LatchElm.java:47
  defaults: { bits: 4, highVoltage: 5 },
  parse: (t, e, warn) => {
    // `bits` must land first: the output pins (and their state tokens) sit at
    // posts `bits..2*bits`, so the state names depend on the loaded width.
    const i = chipCommonTokens(t, e, true, normalizeLatchBits, 'latch', warn);
    readParams(t.slice(i), e, chipStateNames(latchPins(e)));
    // Old latches predate FLAG_STATE; upstream adds it on load so the next
    // save carries the state tokens (LatchElm.java:54-58).
    e.flags |= LATCH_STATE;
  },
  dump: (e) => chipDump(e, latchPins(e), true),
  dumpFlags: chipDumpFlags,
  fields: [
    { name: 'bits', label: '# of Bits', min: 2, max: 32, integer: true },
    { name: 'highVoltage', label: 'High logic voltage', unit: 'V' },
    { name: 'level', label: 'Level triggered', type: 'bool', flag: LATCH_NO_EDGE },
    { name: 'reset', label: 'Reset Pin', type: 'bool', flag: LATCH_RESET },
    { name: 'set', label: 'Set Pin', type: 'bool', flag: LATCH_SET },
    { name: 'enableOne', label: 'Enable pins (1 each)', type: 'bool', flag: LATCH_ENABLE_ONE },
    { name: 'enableTwo', label: 'Enable pins (2 each)', type: 'bool', flag: LATCH_ENABLE_TWO },
    { name: 'invertReset', label: 'Invert Reset', type: 'bool', flag: LATCH_RESET_INVERT },
  ],
  draw: drawLatch,
};
