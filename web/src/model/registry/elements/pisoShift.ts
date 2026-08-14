/**
 * The PISO shift register (PisoShiftElm.java, dump 186): a parallel-in,
 * serial-out register. A rising LD edge latches the D inputs; each rising
 * clock edge shifts the register toward the Q output, feeding the SER pin in
 * under FLAG_NEW_BEHAVIOR (the default) or a hard low without it. The data
 * words are packed integers, one per 32 bits, exactly the tokens
 * `readBits`/`writeBits` use (ChipElm.java:530-566).
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

export const PISO_NEW_BEHAVIOR = 2;

/** The bits field, clamped like the engine: truncated and held to the engine's
 *  1..32 range, the edit dialog's floor and the ceiling that keeps a
 *  hand-edited width from allocating unbounded D pins and register storage
 *  (piso_shift.rs:32, PisoShiftElm.java:144). */
export function normalizePisoBits(value: number): number {
  return normalizeChipBits(value, 1, 32);
}

function pisoBits(e: CircuitElement): number {
  return normalizePisoBits(e.params.bits ?? 8);
}

function pisoHasNewBehavior(e: CircuitElement): boolean {
  return (e.flags & PISO_NEW_BEHAVIOR) !== 0;
}

function pisoSizeX(e: CircuitElement): number {
  return pisoBits(e) + 2;
}

/** The data-word param names, one per 32 bits of the register. */
function pisoDataNames(bits: number): string[] {
  const words = Math.max(1, Math.ceil(bits / 32));
  return Array.from({ length: words }, (_, i) => `data${i}`);
}

/** The pin table, from `setupPins` (PisoShiftElm.java:80-104). */
export function pisoPins(e: CircuitElement): ChipPinDef[] {
  const bits = pisoBits(e);
  const newBhvr = pisoHasNewBehavior(e);
  const pins: ChipPinDef[] = [
    { side: 'W', pos: 1, text: 'LD' },
    { side: 'W', pos: 2, text: '', clock: true },
    { side: 'E', pos: 1, text: `Q${newBhvr ? bits - 1 : bits}`, output: true },
  ];
  if (newBhvr) {
    pins.push({ side: 'W', pos: 0, text: 'SER' });
  }
  for (let i = 0; i < bits; i++) {
    pins.push({ side: 'N', pos: bits - i, text: `D${bits - i - 1}` });
  }
  return pins;
}

function drawPiso(g: DrawContext, e: CircuitElement): void {
  drawChip(g, e, pisoSizeX(e), 3, pisoPins(e));
}

export const PISO_SHIFT_DEF: ElementDef = {
  kind: 'pisoShift',
  label: 'PISO shift register',
  category: 'Logic',
  dumpCode: '186',
  postCount: 12,  // bits(8) + LD + clock + Q + SER at the default
  posts: (e) => chipPosts(e, pisoSizeX(e), 3, pisoPins(e)),
  bodyRect: (e) => chipBodyRect(e, pisoSizeX(e), 3),
  noDiagonal: true,  // ChipElm.java:44
  defaultLength: 11,  // the chip spans (sizeX + 1) * 32
  defaultFlags: PISO_NEW_BEHAVIOR,  // PisoShiftElm.java:39
  defaults: { bits: 8, highVoltage: 5 },
  parse: (t, e) => {
    // `bits` must land first: it decides how many data words follow.
    const i = chipCommonTokens(t, e, true, normalizePisoBits);
    readParams(t.slice(i), e, pisoDataNames(pisoBits(e)));
  },
  dump: (e) => {
    // The data words are written even though upstream's own `dump()` drops
    // them: a save must not lose the register contents (the same quirk fix as
    // the thermistor's position token).
    const out: (string | number)[] = [e.params.bits ?? 8];
    const hv = e.params.highVoltage;
    if (hv !== undefined && hv !== 5) out.push(hv);
    for (const name of pisoDataNames(pisoBits(e))) out.push(e.params[name] ?? 0);
    return out;
  },
  dumpFlags: chipDumpFlags,
  fields: [
    { name: 'bits', label: '# of Bits', min: 1, max: 32 },
    { name: 'highVoltage', label: 'High logic voltage', unit: 'V' },
    { name: 'newBehavior', label: 'New behavior', type: 'bool', flag: PISO_NEW_BEHAVIOR },
  ],
  draw: drawPiso,
};
