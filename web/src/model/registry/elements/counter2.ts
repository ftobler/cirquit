/**
 * Counter 2 (Counter2Elm.java, dump 421): a bit-width counter with
 * parallel-load and clear pins. The count advances on a rising clock edge
 * while EnP and EnT are both high, wraps at the `modulus` token (or at 2^bits
 * when it is 0), and RCO pulses high while the count sits at modulus-1 with
 * EnT high. LOAD and CLR are active low; the Q levels are saved as state
 * tokens followed by the modulus.
 */

import {
  chipBitOrderFlags,
  chipBitOrderParam,
  chipBodyRect,
  chipCommonTokens,
  chipDumpFlags,
  chipPosts,
  chipStateNames,
  drawChip,
  normalizeChipBits,
  CHIP_BIT_ORDER_BUS,
  type ChipPinDef,
} from './dFlipFlop';
import { readParams } from '../shared';
import type { CircuitElement, DrawContext, ElementDef } from '../../types';

/** The bits field, clamped like the engine: truncated and held to the engine's
 *  2..32 range, the edit dialog's floor and the ceiling that keeps a
 *  hand-edited width from allocating unbounded Q/I pins (counter2.rs:27,
 *  Counter2Elm.java:100). */
export function normalizeCounter2Bits(value: number): number {
  return normalizeChipBits(value, 2, 32);
}

function counter2Bits(e: CircuitElement): number {
  return normalizeCounter2Bits(e.params.bits ?? 4);
}

/** Bus bit order (upstream BIT_ORDER_BUS, the XML attribute `bo="2"`): the
 *  Q pins share one east coordinate and the I pins one west coordinate, told
 *  apart by per-post tags. */
export function counter2Bus(e: CircuitElement): boolean {
  return e.params.bitOrder === 2 || (e.flags & CHIP_BIT_ORDER_BUS) !== 0;
}

function counter2SizeY(e: CircuitElement): number {
  // bitsY is 1 in bus mode and `bits` otherwise (Counter2Elm.java:72-73).
  return counter2Bus(e) ? 4 : counter2Bits(e) + 3;
}

/** The pin table, from `setupPins` (Counter2Elm.java:70-94). The Q outputs
 *  run MSB first (makeBitPins reversed), so Q_{bits-1} sits at the top. In
 *  bus mode each group collapses onto row 1 of its side with every pin
 *  carrying its logical bit as its tag (makeBitPins' useBus branch), which is
 *  what keeps the td4 family's registers wired to their bus wires. */
export function counter2Pins(e: CircuitElement): ChipPinDef[] {
  const bits = counter2Bits(e);
  const bus = counter2Bus(e);
  const sizeY = counter2SizeY(e);
  const pins: ChipPinDef[] = [];
  if (bus) {
    for (let i = 0; i < bits; i++) {
      pins.push({
        side: 'E',
        pos: 1,
        text: 'Q',
        output: true,
        state: true,
        busWidth: bits,
        busZ: bits - 1 - i,
      });
    }
    for (let i = 0; i < bits; i++) {
      pins.push({ side: 'W', pos: 1, text: 'I', busWidth: bits, busZ: bits - 1 - i });
    }
  } else {
    for (let i = 0; i < bits; i++) {
      pins.push({ side: 'E', pos: 1 + i, text: `Q${bits - 1 - i}`, output: true, state: true });
    }
    for (let i = 0; i < bits; i++) {
      pins.push({ side: 'W', pos: 1 + i, text: `I${bits - 1 - i}` });
    }
  }
  pins.push({ side: 'W', pos: 0, text: '', clock: true });
  // CLR and LOAD sit at bitsY+1 = sizeY-2, EnP and EnT at bitsY+2 = sizeY-1,
  // one row inside the body bottom edge (Counter2Elm.java:86-93).
  pins.push({ side: 'W', pos: sizeY - 2, text: 'CLR', bubble: true });
  pins.push({ side: 'W', pos: sizeY - 1, text: 'EnP' });
  pins.push({ side: 'E', pos: 0, text: 'RCO', output: true });
  pins.push({ side: 'E', pos: sizeY - 2, text: 'LOAD', bubble: true });
  pins.push({ side: 'E', pos: sizeY - 1, text: 'EnT' });
  return pins;
}

function drawCounter2(g: DrawContext, e: CircuitElement): void {
  drawChip(g, e, 2, counter2SizeY(e), counter2Pins(e));
}

export const COUNTER2_DEF: ElementDef = {
  kind: 'counter2',
  label: 'counter (parallel load)',
  category: 'Logic',
  dumpCode: '421',
  postCount: 14,  // 2*bits(4) + the six control pins at the default
  posts: (e) => chipPosts(e, 2, counter2SizeY(e), counter2Pins(e)),
  chipExtents: (e) => ({ sx: 2, sy: counter2SizeY(e) }),
  canMirror: true,  // ChipElm.flipX, CounterElm inherits it
  bodyRect: (e) => chipBodyRect(e, 2, counter2SizeY(e)),
  noDiagonal: true,  // ChipElm.java:44
  defaultLength: 3,  // the chip spans (sizeX + 1) * 32
  defaults: { bits: 4, modulus: 0, highVoltage: 5 },
  parse: (t, e, warn) => {
    // `bits` must land first: it decides how many saved Q levels follow, and
    // the modulus token comes after them (Counter2Elm.java:38-39).
    const i = chipCommonTokens(t, e, true, normalizeCounter2Bits, 'counter (parallel load)', warn);
    const names = chipStateNames(counter2Pins(e));
    readParams(t.slice(i, i + names.length), e, names);
    const mod = Number(t[i + names.length]);
    if (t[i + names.length] !== undefined && Number.isFinite(mod)) {
      e.params.modulus = mod;
    }
    chipBitOrderParam(e);
  },
  dump: (e) => {
    const names = chipStateNames(counter2Pins(e));
    const out: (string | number)[] = [e.params.bits ?? 4];
    const hv = e.params.highVoltage;
    if (hv !== undefined && hv !== 5) out.push(hv);
    for (const name of names) out.push(e.params[name] ?? 0);
    out.push(e.params.modulus ?? 0);
    return out;
  },
  dumpFlags: (e) => chipBitOrderFlags(e, chipDumpFlags(e)),
  fields: [
    { name: 'bits', label: '# of Bits', min: 2, max: 32, integer: true },
    { name: 'modulus', label: 'Modulus', min: 0, integer: true },
    { name: 'highVoltage', label: 'High logic voltage', unit: 'V' },
  ],
  draw: drawCounter2,
};
