/**
 * The bus transceiver (BusTransceiverElm.java, XML type "bt"): an N-bit
 * tri-state transceiver chip. An active-low OE and a DIR pin decide, per bit,
 * whether the A pin drives the B pin or the reverse; a disabled direction
 * goes high-impedance. The A/B pins are one post per bit (upstream's
 * `useBus()` off, the default), MSB first down each side like the other
 * makeBitPins chips.
 *
 * Upstream saves this class only in the XML format, so the port assigns dump
 * code 437 beside the other port-assigned XML-era codes.
 */

import {
  chipBodyRect,
  chipDump,
  chipDumpFlags,
  chipParse,
  chipPosts,
  drawChip,
  normalizeChipBits,
  type ChipPinDef,
} from './dFlipFlop';
import type { CircuitElement, DrawContext, ElementDef } from '../../types';

/** The bit count the engine accepts: truncated and clamped to the 1..16 its
 *  edit dialog enforces (BusTransceiverElm.java:158-166). */
export function normalizeTransceiverBits(value: number): number {
  return normalizeChipBits(value, 1, 16);
}

function dataBits(e: CircuitElement): number {
  // The width rides `params.bits`, the standard needsBits slot the shared
  // chip machinery reads and writes.
  return normalizeTransceiverBits(e.params.bits ?? 4);
}

function sizeY(e: CircuitElement): number {
  // sizeY = dataBits + 2 with individual pins (setupPins,
  // BusTransceiverElm.java:56-58).
  return dataBits(e) + 2;
}

/** The pin table, from setupPins (BusTransceiverElm.java:53-80): OE at the
 *  top-left with the active-low overline, DIR top-right, then the A and B
 *  banks MSB first (makeBitPins reversed) down the west and east. */
export function busTransceiverPins(e: CircuitElement): ChipPinDef[] {
  const n = dataBits(e);
  const pins: ChipPinDef[] = [
    { side: 'W', pos: 0, text: 'OE', lineOver: true },
    { side: 'E', pos: 0, text: 'DIR' },
  ];
  for (let i = 0; i < n; i++) {
    const bit = n - 1 - i;
    pins.push({ side: 'W', pos: 2 + i, text: `A${bit}` });
  }
  for (let i = 0; i < n; i++) {
    const bit = n - 1 - i;
    pins.push({ side: 'E', pos: 2 + i, text: `B${bit}` });
  }
  return pins;
}

function drawBusTransceiver(g: DrawContext, e: CircuitElement): void {
  drawChip(g, e, 2, sizeY(e), busTransceiverPins(e));
}

export const BUS_TRANSCEIVER_DEF: ElementDef = {
  kind: 'busTransceiver',
  label: 'Bus transceiver',
  category: 'Logic',
  dumpCode: '437',
  postCount: 10,  // 2 + 2*dataBits(4) at the default
  postCountOf: (e) => 2 + 2 * dataBits(e),
  posts: (e) => chipPosts(e, 2, sizeY(e), busTransceiverPins(e)),
  chipExtents: (e) => ({ sx: 2, sy: sizeY(e) }),
  canMirror: true,  // ChipElm.flipX, BusTransceiverElm inherits it
  bodyRect: (e) => chipBodyRect(e, 2, sizeY(e)),
  noDiagonal: true,  // ChipElm.java:44
  defaultLength: 3,  // the chip spans (sizeX + 1) * 32
  defaults: { bits: 4, highVoltage: 5 },
  parse: (t, e, warn) =>
    chipParse(t, e, busTransceiverPins(e), true, normalizeTransceiverBits, 'bus transceiver', warn),
  dump: (e) => chipDump(e, busTransceiverPins(e), true),
  dumpFlags: chipDumpFlags,
  fields: [
    { name: 'bits', label: '# of Bits', min: 1, max: 16, integer: true },
    { name: 'highVoltage', label: 'High logic voltage', unit: 'V' },
  ],
  draw: drawBusTransceiver,
};
