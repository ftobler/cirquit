/**
 * The SIPO shift register (SipoShiftElm.java, dump 189): a serial-in,
 * parallel-out register. A rising clock edge shifts the register one position
 * toward Q_{bits-1} and loads the D pin into Q0. The Q levels are saved as
 * packed integer data words, one per 32 bits (ChipElm.java:530-566).
 */

import {
  chipBodyRect,
  chipCommonTokens,
  chipDumpFlags,
  chipPosts,
  drawChip,
  normalizeChipBits,
  type ChipPinDef,
} from './dFlipFlop';
import { readParams } from '../shared';
import type { CircuitElement, DrawContext, ElementDef } from '../../types';

/** The bits field, clamped like the engine: truncated and held to the engine's
 *  1..32 range, the edit dialog's floor and the ceiling that keeps a
 *  hand-edited width from allocating unbounded Q pins (sipo_shift.rs:20,
 *  SipoShiftElm.java:105). */
export function normalizeSipoBits(value: number): number {
  return normalizeChipBits(value, 1, 32);
}

function sipoBits(e: CircuitElement): number {
  return normalizeSipoBits(e.params.bits ?? 8);
}

function sipoSizeX(e: CircuitElement): number {
  return sipoBits(e) + 1;
}

function sipoDataNames(bits: number): string[] {
  const words = Math.max(1, Math.ceil(bits / 32));
  return Array.from({ length: words }, (_, i) => `data${i}`);
}

/** The pin table, from `setupPins` (SipoShiftElm.java:71-87). */
export function sipoPins(e: CircuitElement): ChipPinDef[] {
  const bits = sipoBits(e);
  const pins: ChipPinDef[] = [
    { side: 'W', pos: 1, text: 'D' },
    { side: 'W', pos: 2, text: '', clock: true },
  ];
  for (let i = 0; i < bits; i++) {
    pins.push({ side: 'N', pos: i + 1, text: `Q${i}`, output: true });
  }
  return pins;
}

function drawSipo(g: DrawContext, e: CircuitElement): void {
  drawChip(g, e, sipoSizeX(e), 3, sipoPins(e));
}

export const SIPO_SHIFT_DEF: ElementDef = {
  kind: 'sipoShift',
  label: 'SIPO shift register',
  category: 'Logic',
  dumpCode: '189',
  postCount: 10,  // bits(8) + D + clock at the default
  posts: (e) => chipPosts(e, sipoSizeX(e), 3, sipoPins(e)),
  bodyRect: (e) => chipBodyRect(e, sipoSizeX(e), 3),
  noDiagonal: true,  // ChipElm.java:44
  defaultLength: 10,  // the chip spans (sizeX + 1) * 32
  defaults: { bits: 8, highVoltage: 5 },
  parse: (t, e) => {
    // `bits` must land first: it decides how many data words follow.
    const i = chipCommonTokens(t, e, true, normalizeSipoBits);
    readParams(t.slice(i), e, sipoDataNames(sipoBits(e)));
  },
  dump: (e) => {
    // The data words are written even though upstream's own `dump()` drops
    // them: a save must not lose the register contents.
    const out: (string | number)[] = [e.params.bits ?? 8];
    const hv = e.params.highVoltage;
    if (hv !== undefined && hv !== 5) out.push(hv);
    for (const name of sipoDataNames(sipoBits(e))) out.push(e.params[name] ?? 0);
    return out;
  },
  dumpFlags: chipDumpFlags,
  fields: [
    { name: 'bits', label: '# of Bits', min: 1, max: 32 },
    { name: 'highVoltage', label: 'High logic voltage', unit: 'V' },
  ],
  draw: drawSipo,
};
