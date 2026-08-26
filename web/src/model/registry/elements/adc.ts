/**
 * The analog-to-digital converter (ADCElm.java, dump 167): a bit-width chip
 * that converts the analog In pin into digital output bits against the V+
 * reference. The engine computes `trunc((2^bits - 1) * V(in) / V(+))` every
 * step and drives the D0..D(bits-1) outputs; this file owns the geometry.
 *
 * Token layout after the common fields is the standard chip stream: `bits`
 * then the optional `highVoltage` under CHIP_CUSTOM_VOLTAGE (ChipElm.java:
 * 51-56). The output bits are never saved, so no state tokens follow.
 */

import {
  chipBodyRect,
  chipCommonTokens,
  chipDump,
  chipDumpFlags,
  chipPosts,
  drawChip,
  normalizeChipBits,
  type ChipPinDef,
} from './dFlipFlop';
import type { CircuitElement, DrawContext, ElementDef } from '../../types';

/** The bits field, clamped like the engine: truncated and capped to the 2..30
 *  the edit dialog allows, matching the engine's `(x as usize)` cast and clamp
 *  (ADCElm.java:64-69, adc.rs:28). */
export function normalizeAdcBits(value: number): number {
  return normalizeChipBits(value, 2, 30);
}

function adcBits(e: CircuitElement): number {
  return normalizeAdcBits(e.params.bits ?? 4);
}

/** The chip's cell height, `sizeY` from setupPins (ADCElm.java:33-34): the
 *  bit count, but never fewer than 2 rows. */
function adcSizeY(e: CircuitElement): number {
  return Math.max(2, adcBits(e));
}

/** The pin table, from `setupPins` (ADCElm.java:31-40): the bit outputs on
 *  the east, MSB first so D0 sits at the bottom, then the In and V+ inputs on
 *  the west. */
export function adcPins(e: CircuitElement): ChipPinDef[] {
  const bits = adcBits(e);
  const sizeY = adcSizeY(e);
  const pins: ChipPinDef[] = [];
  for (let i = 0; i < bits; i++) {
    pins.push({ side: 'E', pos: bits - 1 - i, text: `D${i}`, output: true });
  }
  pins.push({ side: 'W', pos: 0, text: 'In' });
  pins.push({ side: 'W', pos: sizeY - 1, text: 'V+' });
  return pins;
}

function drawAdc(g: DrawContext, e: CircuitElement): void {
  drawChip(g, e, 2, adcSizeY(e), adcPins(e));
}

export const ADC_DEF: ElementDef = {
  kind: 'adc',
  label: 'A/D converter',
  category: 'Active',
  dumpCode: '167',
  postCount: 6, // 4 bits + In + V+ at the default width
  posts: (e) => chipPosts(e, 2, adcSizeY(e), adcPins(e)),
  chipExtents: (e) => ({ sx: 2, sy: adcSizeY(e) }),
  canMirror: true,  // ChipElm.flipX, ADCElm inherits it
  bodyRect: (e) => chipBodyRect(e, 2, adcSizeY(e)),
  noDiagonal: true, // ChipElm.java:44
  defaultLength: 6, // the chip spans (sizeX + 1) * 32
  defaults: { bits: 4, highVoltage: 5 },
  parse: (t, e, warn) => {
    // `bits` must land first; nothing follows it but the optional high voltage
    // because the outputs carry no saved state (ADCElm.java:36).
    chipCommonTokens(t, e, true, normalizeAdcBits, 'A/D converter', warn);
  },
  dump: (e) => chipDump(e, adcPins(e), true, 4),
  dumpFlags: chipDumpFlags,
  fields: [
    { name: 'bits', label: '# of Bits', min: 2, max: 30, integer: true },
    { name: 'highVoltage', label: 'High logic voltage', unit: 'V' },
  ],
  draw: drawAdc,
};
