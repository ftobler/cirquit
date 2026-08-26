/**
 * Time-delay relay (TimeDelayRelayElm.java, dump 414). A ChipElm that is NOT
 * a digital chip: no voltage-source outputs, so it is not built on the
 * engine's Chip base, but it shares the ChipElm housing, pin stubs and labels,
 * so the geometry and drawing come from `dFlipFlop.ts` like the timer's.
 *
 * The four pins, in post order (TimeDelayRelayElm.java:69-77): the coil
 * sense on the west/east top row (Vin and gnd, posts 0-1) and the switched
 * path on the west/east bottom row (in and out, posts 2-3), on a 2x2 body.
 */

import { chipBodyRect, chipPosts, drawChip, type ChipPinDef } from './dFlipFlop';
import { readParams } from '../shared';
import type { CircuitElement, DrawContext, ElementDef } from '../../types';

/** The pin table, from `setupPins` (TimeDelayRelayElm.java:69-77). Post order
 *  must match the engine: 0 Vin, 1 gnd, 2 in, 3 out. */
export function timeDelayRelayPins(): ChipPinDef[] {
  return [
    { side: 'W', pos: 1, text: 'Vin' },
    { side: 'E', pos: 1, text: 'gnd' },
    { side: 'W', pos: 0, text: 'in' },
    { side: 'E', pos: 0, text: 'out' },
  ];
}

function drawTimeDelayRelay(g: DrawContext, e: CircuitElement): void {
  drawChip(g, e, 2, 2, timeDelayRelayPins());
}

export const TIME_DELAY_RELAY_DEF: ElementDef = {
  kind: 'timeDelayRelay',
  label: 'Time delay relay',
  category: 'Basics',
  dumpCode: '414',
  postCount: 4,
  posts: (e) => chipPosts(e, 2, 2, timeDelayRelayPins()),
  chipExtents: () => ({ sx: 2, sy: 2 }),
  canMirror: true,  // ChipElm.flipX, TimeDelayRelayElm inherits it
  bodyRect: (e) => chipBodyRect(e, 2, 2),
  noDiagonal: true, // ChipElm.java:44
  defaultLength: 6, // the chip spans (sizeX + 1) * 32
  // Token order `onDelay offDelay onResistance offResistance`
  // (TimeDelayRelayElm.java:44-47), the constructor defaults at :36-39.
  defaults: { onDelay: 1, offDelay: 0, onResistance: 1, offResistance: 10e6 },
  parse: (t, e) => readParams(t, e, ['onDelay', 'offDelay', 'onResistance', 'offResistance']),
  dump: (e) => [
    e.params.onDelay ?? 1,
    e.params.offDelay ?? 0,
    e.params.onResistance ?? 1,
    e.params.offResistance ?? 10e6,
  ],
  fields: [
    { name: 'onDelay', label: 'On Delay', unit: 's' },
    { name: 'offDelay', label: 'Off Delay', unit: 's' },
    { name: 'onResistance', label: 'On Resistance', unit: 'Ω' },
    { name: 'offResistance', label: 'Off Resistance', unit: 'Ω' },
  ],
  draw: drawTimeDelayRelay,
};
