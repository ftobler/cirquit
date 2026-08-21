/**
 * The analog multiplexer (AnalogMuxElm.java, dump 432): a chip whose output Z
 * connects to one of `2^selectBitCount` analog inputs through `r_on`, the
 * others through `r_off` or, under FLAG_PULLDOWN, to ground so unselected
 * inputs never float. The select pins read against the `threshold` token. The
 * file line carries `selectBitCount r_on r_off threshold` after the optional
 * high voltage, always written like upstream's own `dump()` (AnalogMuxElm.java:
 * 63-65).
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

/** Pull the unselected inputs to ground through `r_off` instead of coupling
 *  them to the output (AnalogMuxElm.java:26). */
export const ANALOG_MUX_PULLDOWN = 2;

/** The select-bit count, floored like the engine: truncated and clamped to
 *  the 1..6 the edit dialog allows (AnalogMuxElm.java:202, analog_mux.rs:38). */
export function normalizeAnalogMuxSelects(value: number): number {
  return normalizeChipBits(value, 1, 6);
}

function analogMuxSelectBits(e: CircuitElement): number {
  return normalizeAnalogMuxSelects(e.params.selectBitCount ?? 2);
}

function analogMuxInputCount(e: CircuitElement): number {
  return 1 << analogMuxSelectBits(e);
}

function analogMuxSizeX(e: CircuitElement): number {
  return analogMuxSelectBits(e) + 1;
}

function analogMuxSizeY(e: CircuitElement): number {
  return analogMuxInputCount(e) + 1;
}

/** The pin table, from `setupPins` (AnalogMuxElm.java:84-98): the inputs run
 *  down the west, the select pins across the south one row in from the edge,
 *  and the Z output at the east top. */
export function analogMuxPins(e: CircuitElement): ChipPinDef[] {
  const inputs = analogMuxInputCount(e);
  const selects = analogMuxSelectBits(e);
  const pins: ChipPinDef[] = [];
  for (let i = 0; i < inputs; i++) {
    pins.push({ side: 'W', pos: i, text: `I${i}` });
  }
  for (let i = 0; i < selects; i++) {
    pins.push({ side: 'S', pos: i + 1, text: `S${i}` });
  }
  pins.push({ side: 'E', pos: 0, text: 'Z' });
  return pins;
}

function drawAnalogMux(g: DrawContext, e: CircuitElement): void {
  drawChip(g, e, analogMuxSizeX(e), analogMuxSizeY(e), analogMuxPins(e));
}

export const ANALOG_MUX_DEF: ElementDef = {
  kind: 'analogMux',
  label: 'Analog mux',
  category: 'Active',
  dumpCode: '432',
  postCount: 7,  // 4 inputs + 2 selects + Z at the default
  posts: (e) => chipPosts(e, analogMuxSizeX(e), analogMuxSizeY(e), analogMuxPins(e)),
  bodyRect: (e) => chipBodyRect(e, analogMuxSizeX(e), analogMuxSizeY(e)),
  noDiagonal: true,  // ChipElm.java:44
  defaultLength: 4,  // the chip spans (sizeX + 1) * 32 with sizeX 3
  defaultFlags: ANALOG_MUX_PULLDOWN,  // the fresh constructor sets it (AnalogMuxElm.java:39)
  defaults: { selectBitCount: 2, r_on: 20, r_off: 1e10, threshold: 2.5, highVoltage: 5 },
  parse: (t, e) => {
    // The four own tokens follow the optional high voltage (ChipElm.java:
    // 51-56, AnalogMuxElm.java:49-53).
    const i = chipCommonTokens(t, e, false);
    const sb = Number(t[i]);
    if (t[i] !== undefined && Number.isFinite(sb)) e.params.selectBitCount = normalizeAnalogMuxSelects(sb);
    readParams(t.slice(i + 1), e, ['r_on', 'r_off', 'threshold']);
  },
  dump: (e) => {
    const out: (string | number)[] = [];
    const hv = e.params.highVoltage;
    if (hv !== undefined && hv !== 5) out.push(hv);
    out.push(e.params.selectBitCount ?? 2);
    out.push(e.params.r_on ?? 20);
    out.push(e.params.r_off ?? 1e10);
    out.push(e.params.threshold ?? 2.5);
    return out;
  },
  dumpFlags: chipDumpFlags,
  fields: [
    { name: 'selectBitCount', label: '# of Select Bits', min: 1, max: 6, integer: true },
    { name: 'r_on', label: 'On resistance', unit: 'Ω' },
    { name: 'r_off', label: 'Off resistance', unit: 'Ω' },
    { name: 'threshold', label: 'Threshold', unit: 'V' },
    { name: 'pulldown', label: 'Pulldown resistor', type: 'bool', flag: ANALOG_MUX_PULLDOWN },
    { name: 'highVoltage', label: 'High logic voltage', unit: 'V' },
  ],
  draw: drawAnalogMux,
};
