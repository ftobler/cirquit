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

/**
 * The integer select-bit count both halves derive from a value: the engine
 * rounds it, turns any non-positive result into the default 2 and caps it at 6
 * (de_multiplexer.rs:42-46), the edit dialog's 64-output ceiling. The store's
 * `setParam`, the parser and the geometry all normalise to this, so a
 * fractional edit never draws a post list the engine's build rejects
 * (circuit.rs:261-269).
 */
export function normalizeDemuxBits(value: number): number {
  if (!Number.isFinite(value)) return 2;
  const b = Math.round(value);
  if (b <= 0) return 2;
  return Math.min(6, b);
}

function demuxSelectBits(e: CircuitElement): number {
  return normalizeDemuxBits(e.params.selectBits ?? 2);
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
  chipExtents: (e) => ({ sx: 1 + demuxSelectBits(e), sy: 1 + demuxOutputCount(e) }),
  canMirror: true,  // ChipElm.flipX, DemuxElm inherits it
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
    if (t[i] !== undefined && Number.isFinite(bits)) e.params.selectBits = normalizeDemuxBits(bits);
  },
  dump: (e) => [...chipDump(e, demuxPins(e), false), e.params.selectBits ?? 2],
  dumpFlags: chipDumpFlags,
  fields: [
    { name: 'selectBits', label: '# of Select Bits', min: 1, max: 6, integer: true },
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
