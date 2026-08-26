/**
 * The binary counter (CounterElm.java, dump 164): a bit-width up/down counter
 * with a reset pin and an optional U/D control. The reset polarity and the
 * count modulus are plain file tokens (not flags), and the clock pin carries a
 * bubble under FLAG_NEGATIVE_EDGE.
 */

import {
  chipBodyRect,
  chipCommonTokens,
  chipDumpFlags,
  chipPosts,
  chipStateNames,
  drawChip,
  normalizeChipBits,
  type ChipPinDef,
} from './dFlipFlop';
import { readParams } from '../shared';
import { boolToken } from './switch';
import type { CircuitElement, DrawContext, ElementDef } from '../../types';

export const COUNTER_UP_DOWN = 4;
export const COUNTER_NEGATIVE_EDGE = 8;

/** The bits field, clamped like the engine: truncated and held to the engine's
 *  3..62 range, the edit dialog's minimum and the ceiling that keeps the
 *  per-bit i64 shifts in execute() clear of the sign bit (counter.rs:27). */
export function normalizeCounterBits(value: number): number {
  return normalizeChipBits(value, 3, 62);
}

function counterBits(e: CircuitElement): number {
  return normalizeCounterBits(e.params.bits ?? 4);
}

/** The pin table, from `setupPins` (CounterElm.java:72-85). The output pins
 *  run MSB first (makeBitPins with reversed = true), so Q_{bits-1} sits at the
 *  top and Q0 at the bottom. */
export function counterPins(e: CircuitElement): ChipPinDef[] {
  const bits = counterBits(e);
  const upDown = (e.flags & COUNTER_UP_DOWN) !== 0;
  const negativeEdge = (e.flags & COUNTER_NEGATIVE_EDGE) !== 0;
  const invertReset = (e.params.invertreset ?? 1) !== 0;
  const pins: ChipPinDef[] = [
    { side: 'W', pos: 0, text: '', clock: true, bubble: negativeEdge },
    { side: 'W', pos: bits - 1, text: 'R', bubble: invertReset },
  ];
  for (let k = 0; k < bits; k++) {
    pins.push({ side: 'E', pos: k, text: `Q${bits - 1 - k}`, output: true, state: true });
  }
  if (upDown) {
    pins.push({ side: 'W', pos: bits - 2, text: 'U/D' });
  }
  return pins;
}

function drawCounter(g: DrawContext, e: CircuitElement): void {
  drawChip(g, e, 2, counterBits(e), counterPins(e));
}

export const COUNTER_DEF: ElementDef = {
  kind: 'counter',
  label: 'counter',
  category: 'Logic',
  dumpCode: '164',
  postCount: 6,
  posts: (e) => chipPosts(e, 2, counterBits(e), counterPins(e)),
  chipExtents: (e) => ({ sx: 2, sy: counterBits(e) }),
  canMirror: true,  // ChipElm.flipX, CounterElm inherits it
  bodyRect: (e) => chipBodyRect(e, 2, counterBits(e)),
  noDiagonal: true,  // ChipElm.java:44
  defaultLength: 6,  // the chip spans (sizeX + 1) * 32
  defaults: { bits: 4, invertreset: 1, modulus: 0, highVoltage: 5 },
  parse: (t, e, warn) => {
    const i = chipCommonTokens(t, e, true, normalizeCounterBits, 'counter', warn);
    const names = chipStateNames(counterPins(e));
    readParams(t.slice(i, i + names.length), e, names);
    // The counter's own trailing tokens: the reset polarity as a Boolean, then
    // the count modulus, both read defensively (CounterElm.java:39-46).
    const inv = t[i + names.length];
    if (inv !== undefined) e.params.invertreset = boolToken(inv);
    const mod = Number(t[i + names.length + 1]);
    if (t[i + names.length + 1] !== undefined && Number.isFinite(mod)) {
      e.params.modulus = mod;
    }
  },
  dump: (e) => {
    const names = chipStateNames(counterPins(e));
    const out: (string | number)[] = [e.params.bits ?? 4];
    const hv = e.params.highVoltage;
    if (hv !== undefined && hv !== 5) out.push(hv);
    for (const name of names) out.push(e.params[name] ?? 0);
    out.push((e.params.invertreset ?? 1) ? 'true' : 'false');
    out.push(e.params.modulus ?? 0);
    return out;
  },
  dumpFlags: chipDumpFlags,
  fields: [
    { name: 'bits', label: '# of Bits', min: 3, max: 62, integer: true },
    { name: 'modulus', label: 'Modulus', min: 0, integer: true },
    { name: 'highVoltage', label: 'High logic voltage', unit: 'V' },
    {
      name: 'invertreset',
      label: 'Reset polarity',
      type: 'choice',
      choices: [
        { value: 0, label: 'Active high' },
        { value: 1, label: 'Active low' },
      ],
    },
    { name: 'upDown', label: 'Up/Down Pin', type: 'bool', flag: COUNTER_UP_DOWN },
    { name: 'negativeEdge', label: 'Negative Edge Triggered', type: 'bool', flag: COUNTER_NEGATIVE_EDGE },
  ],
  draw: drawCounter,
};
