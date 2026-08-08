/**
 * The multiplexer (MultiplexerElm.java, dump 184): a chip that routes one of
 * its data inputs to the output, chosen by the select bits. The text format
 * carries the select-bit count as its only element token; the bus-input modes
 * are XML-only upstream, so this port implements the individual-inputs layout,
 * mode 0.
 *
 * The engine model reads the same pin table through the shared chip base; this
 * file owns the geometry: the data inputs down the west, the select bits along
 * the south, the output on the east, and the optional inverted output and
 * strobe.
 */

import {
  chipCommonTokens,
  chipDump,
  chipDumpFlags,
  chipPosts,
  drawChip,
  type ChipPinDef,
} from './dFlipFlop';
import type { CircuitElement, DrawContext, ElementDef } from '../../types';

export const MUX_INVERTED_OUTPUT = 2;
export const MUX_STROBE = 4;
export const MUX_BUS_SELECT = 8;

/** The select-bit count, clamped to the 1..6 the edit dialog allows
 *  (MultiplexerElm.java:326-334). The text token, `selectBitCount`. */
function muxBits(e: CircuitElement): number {
  return Math.max(1, Math.min(6, Math.round(e.params.bits ?? 2)));
}

/** Number of data inputs, `1 << selectBitCount` (MultiplexerElm.java:84). */
function muxInputCount(e: CircuitElement): number {
  return 1 << muxBits(e);
}

/** The pin table, from `setupPins` mode 0 (MultiplexerElm.java:200-240): the
 *  data inputs on the west, the select bits on the south, the output on the
 *  east, then the optional inverted output and strobe. Under FLAG_BUS_SELECT
 *  every select pin shares the south position 0, so they merge into one node
 *  exactly as upstream's bus pins do; only the first carries the label. */
function muxPins(e: CircuitElement): ChipPinDef[] {
  const bits = muxBits(e);
  const inputCount = muxInputCount(e);
  const inverted = (e.flags & MUX_INVERTED_OUTPUT) !== 0;
  const strobe = (e.flags & MUX_STROBE) !== 0;
  const busSelect = (e.flags & MUX_BUS_SELECT) !== 0;
  const pins: ChipPinDef[] = [];
  for (let i = 0; i < inputCount; i++) {
    pins.push({ side: 'W', pos: i, text: `I${i}` });
  }
  for (let i = 0; i < bits; i++) {
    pins.push({
      side: 'S',
      pos: busSelect ? 0 : i + 1,
      text: busSelect ? (i === 0 ? 'S' : '') : `S${i}`,
    });
  }
  pins.push({ side: 'E', pos: 0, text: 'Q', output: true });
  if (inverted) {
    pins.push({ side: 'E', pos: 1, text: 'Q', output: true, lineOver: true, bubble: true });
  }
  if (strobe) {
    pins.push({ side: 'S', pos: 0, text: 'STR' });
  }
  return pins;
}

function drawMux(g: DrawContext, e: CircuitElement): void {
  drawChip(g, e, muxBits(e) + 1, muxInputCount(e) + 1, muxPins(e));
}

export const MULTIPLEXER_DEF: ElementDef = {
  kind: 'multiplexer',
  label: 'Multiplexer',
  category: 'Logic',
  dumpCode: '184',
  postCount: 7, // the default 2-select-bit, 4-input layout: 4 + 2 + 1
  posts: (e) => chipPosts(e, muxBits(e) + 1, muxInputCount(e) + 1, muxPins(e)),
  noDiagonal: true, // ChipElm.java:44
  defaultLength: 8, // the default 2-select-bit chip spans (sizeX + 1) * 32
  defaults: { bits: 2, highVoltage: 5 },
  parse: (t, e) => {
    // The ChipElm base writes an optional high-voltage token before the
    // subclass's own count, and the multiplexer has no saved output levels
    // (no `state` pins), so `chipCommonTokens` with `hasBits: false` walks the
    // right prefix (ChipElm.java:48-68, MultiplexerElm.java:55-63).
    const i = chipCommonTokens(t, e, false);
    const bits = Math.round(Number(t[i]));
    if (t[i] !== undefined && Number.isFinite(bits)) e.params.bits = bits;
  },
  dump: (e) => [...chipDump(e, muxPins(e), false), e.params.bits ?? 2],
  dumpFlags: chipDumpFlags,
  fields: [
    { name: 'bits', label: '# of Select Bits', min: 1, max: 6 },
    { name: 'highVoltage', label: 'High logic voltage', unit: 'V' },
    {
      name: 'invertedOutput',
      label: 'Inverted Output',
      type: 'bool',
      flag: MUX_INVERTED_OUTPUT,
    },
    { name: 'strobe', label: 'Strobe Pin', type: 'bool', flag: MUX_STROBE },
    { name: 'busSelect', label: 'Bus Select', type: 'bool', flag: MUX_BUS_SELECT },
  ],
  draw: drawMux,
};
