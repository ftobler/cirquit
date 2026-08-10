/**
 * The demultiplexer chip (DeMultiplexerElm.java, dump 185): one data input
 * routed to the output the select bits choose. A ChipElm subclass whose text
 * format is always the individual-output mode: the outputs on the east, the
 * select bits on the south, the data input on the west, and one trailing
 * token for the select-bit count.
 *
 * FLAG_BUS_SELECT draws the select bits as one bus (all on the same south
 * slot); it is display-only, the engine reads the same pins either way.
 * FLAG_INVERT_OUTPUTS is the 74139 rule: inactive outputs idle high instead
 * of low, an electrical choice.
 */

import {
  chipBodyRect,
  chipCommonTokens,
  chipDump,
  chipDumpFlags,
  chipPosts,
  drawChip,
  type ChipPinDef,
} from './dFlipFlop';
import type { CircuitElement, DrawContext, ElementDef } from '../../types';

export const DEMUX_BUS_SELECT = 1 << 3;
export const DEMUX_INVERT_OUTPUTS = 1 << 4;

function demuxSelectBits(e: CircuitElement): number {
  // The token constructor turns 0 into 2 (DeMultiplexerElm.java:82-83), and
  // the edit dialog caps the count at 6, which is 64 outputs.
  const b = Math.round(e.params.selectBits ?? 2);
  return Math.min(6, b === 0 ? 2 : b);
}

function demuxOutputCount(e: CircuitElement): number {
  return 1 << demuxSelectBits(e);
}

/** The pin table, from `setupPins` (DeMultiplexerElm.java:162-191). Post order
 *  must match the engine: the outputs, then the select bits, then the data
 *  input. No output carries file state, so none is marked `state`. */
export function demuxPins(e: CircuitElement): ChipPinDef[] {
  const bits = demuxSelectBits(e);
  const outputCount = demuxOutputCount(e);
  const busSelect = (e.flags & DEMUX_BUS_SELECT) !== 0;
  const pins: ChipPinDef[] = [];
  for (let i = 0; i < outputCount; i++) {
    pins.push({ side: 'E', pos: i, text: `Q${i}`, output: true });
  }
  for (let i = 0; i < bits; i++) {
    pins.push({
      side: 'S',
      pos: busSelect ? 0 : i,
      text: busSelect ? 'S' : `S${i}`,
    });
  }
  pins.push({ side: 'W', pos: 0, text: 'Q' });
  return pins;
}

function drawDemux(g: DrawContext, e: CircuitElement): void {
  drawChip(g, e, 1 + demuxSelectBits(e), 1 + demuxOutputCount(e), demuxPins(e));
}

export const DEMULTIPLEXER_DEF: ElementDef = {
  kind: 'deMultiplexer',
  label: 'demultiplexer',
  category: 'Logic',
  dumpCode: '185',
  postCount: 7, // 2 select bits and 4 outputs at the default
  posts: (e) => chipPosts(e, 1 + demuxSelectBits(e), 1 + demuxOutputCount(e), demuxPins(e)),
  bodyRect: (e) => chipBodyRect(e, 1 + demuxSelectBits(e), 1 + demuxOutputCount(e)),
  noDiagonal: true, // ChipElm.java:44
  defaultLength: 8, // the default chip spans (sizeX + 1) * 32 with sizeX 3
  defaults: { selectBits: 2, highVoltage: 5 },
  parse: (t, e) => {
    // The ChipElm base writes an optional high-voltage token (only under
    // FLAG_CUSTOM_VOLTAGE) before this element's own select-bit count
    // (ChipElm.java:356-366, DeMultiplexerElm.java:61).
    const i = chipCommonTokens(t, e, false);
    const bits = Number(t[i]);
    if (t[i] !== undefined && Number.isFinite(bits)) e.params.selectBits = bits;
  },
  dump: (e) => [...chipDump(e, demuxPins(e), false), e.params.selectBits ?? 2],
  dumpFlags: chipDumpFlags,
  fields: [
    { name: 'selectBits', label: '# of Select Bits', min: 1, max: 6 },
    { name: 'highVoltage', label: 'High logic voltage', unit: 'V' },
    { name: 'busSelect', label: 'Bus Select', type: 'bool', flag: DEMUX_BUS_SELECT },
    {
      name: 'invertOutputs',
      label: 'Keep Inactive Outputs High (74139)',
      type: 'bool',
      flag: DEMUX_INVERT_OUTPUTS,
    },
  ],
  draw: drawDemux,
};
