/**
 * The multiplexer (MultiplexerElm.java, dump 184): a chip that routes one of
 * its data inputs to the output, chosen by the select bits. The text format
 * carries the select-bit count as its only element token in input mode 0
 * (individual inputs / single output). Input mode 2 (bus/bus) models upstream's
 * bus-in/bus-out layout faithfully: the west side is `outputCount` buses of
 * `dataBusWidth` bits and the east side one `dataBusWidth`-wide output bus.
 * Input mode 1 (bus/bit) is deferred: it has no text-format home and no corpus
 * user, so the engine treats it as mode 0 and the converter parks a trace
 * comment.
 *
 * The engine model reads the same pin table through the shared chip base; this
 * file owns the geometry: the data buses on the west, the select bits along the
 * south, the output bus on the east, and the optional inverted output bus and
 * strobe.
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

export const MUX_INVERTED_OUTPUT = 2;
export const MUX_STROBE = 4;
export const MUX_BUS_SELECT = 8;

/** Upstream's INPUT_MODE_BUS_BUS (MultiplexerElm.java:37), the one faithful
 *  bus/bus mode this port implements. Mode 1 is deferred. */
export const MUX_INPUT_MODE_BUS_BUS = 2;

/**
 * The integer select-bit count both halves derive from a value: truncated and
 * clamped to the 1..6 range, the engine's `(x as usize)` cast and clamp
 * (multiplexer.rs:63). The store's `setParam`, the parser and the geometry all
 * normalise to this, so a fractional edit never draws a post list the engine's
 * build rejects (circuit.rs:261-269).
 */
export function normalizeMuxBits(value: number): number {
  if (!Number.isFinite(value)) return 2;
  const n = Math.trunc(value);
  if (n < 1) return 1;
  if (n > 6) return 6;
  return n;
}

/** The select-bit count, clamped to the 1..6 the edit dialog allows
 *  (MultiplexerElm.java:326-334). The text token, `selectBitCount`. */
function muxBits(e: CircuitElement): number {
  return normalizeMuxBits(e.params.bits ?? 2);
}

/** Number of data-input groups, `1 << selectBitCount`
 *  (MultiplexerElm.java:84). In bus/bus mode each group is one input bus. */
function muxGroupCount(e: CircuitElement): number {
  return 1 << muxBits(e);
}

/** The input mode, 0 individual or 2 bus/bus (MultiplexerElm.java:35-37). Mode
 *  1 is deferred and falls back to 0. */
function muxInputMode(e: CircuitElement): number {
  return e.params.inputMode === MUX_INPUT_MODE_BUS_BUS ? MUX_INPUT_MODE_BUS_BUS : 0;
}

/** The data bus width in bus/bus mode, defaulting to 4 (MultiplexerElm.java:41). */
function muxDataWidth(e: CircuitElement): number {
  return normalizeDataWidth(e.params.dataBusWidth ?? 4);
}

/** Clamps a data bus width to the 1..32 upstream allows (MultiplexerElm.java:
 * 322), the same bound the engine's `clamp(1, 32)` applies. */
export function normalizeDataWidth(value: number): number {
  const n = Math.trunc(value);
  if (n < 1) return 1;
  if (n > 32) return 32;
  return n;
}

/** The pin table. In bus/bus mode (MultiplexerElm.java:99-150) the west side
 *  is `outputCount` groups of `dataBusWidth` bus pins tagged per bit (`busZ`),
 *  the south holds the select bits (the optional FLAG_BUS_SELECT collapse only
 *  moves their draw position, the engine still reads them as plain pins), the
 *  east holds one `dataBusWidth`-wide output bus, then the optional inverted
 *  bus and strobe. Mode 0 (and the deferred mode 1) keeps the original single
 *  input per group layout (MultiplexerElm.java:200-240). */
export function muxPins(e: CircuitElement): ChipPinDef[] {
  const bits = muxBits(e);
  const inputMode = muxInputMode(e);
  const inverted = (e.flags & MUX_INVERTED_OUTPUT) !== 0;
  const strobe = (e.flags & MUX_STROBE) !== 0;
  const busSelect = (e.flags & MUX_BUS_SELECT) !== 0;
  const pins: ChipPinDef[] = [];
  if (inputMode === MUX_INPUT_MODE_BUS_BUS) {
    const groups = muxGroupCount(e);
    const dw = muxDataWidth(e);
    for (let g = 0; g < groups; g++) {
      for (let i = 0; i < dw; i++) {
        pins.push({ side: 'W', pos: g, busWidth: dw, busZ: i, text: `I${g}` });
      }
    }
    for (let i = 0; i < bits; i++) {
      pins.push({
        side: 'S',
        pos: busSelect ? 0 : i + 1,
        text: busSelect ? (i === 0 ? 'S' : '') : `S${i}`,
      });
    }
    for (let i = 0; i < dw; i++) {
      pins.push({ side: 'E', pos: 0, busWidth: dw, busZ: i, text: 'Q', output: true });
    }
    if (inverted) {
      for (let i = 0; i < dw; i++) {
        pins.push({
          side: 'E',
          pos: 1,
          busWidth: dw,
          busZ: i,
          text: 'Q',
          output: true,
          lineOver: true,
          bubble: i === 0,
        });
      }
    }
    if (strobe) {
      pins.push({ side: 'S', pos: 0, text: 'STR' });
    }
  } else {
    const inputCount = muxGroupCount(e);
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
  }
  return pins;
}

function drawMux(g: DrawContext, e: CircuitElement): void {
  drawChip(g, e, muxBits(e) + 1, muxGroupCount(e) + 1, muxPins(e));
}

/** Per-element terminal count, the file's getPostCount
 *  (MultiplexerElm.java:245-254): the bus/bus layout adds `outputCount *
 *  dataBusWidth` input pins and `dataBusWidth` output pins, plus the optional
 *  inverted bus and strobe. Mode 0 keeps the original sum. */
function muxPostCount(e: CircuitElement): number {
  const bits = muxBits(e);
  const groups = muxGroupCount(e);
  const inverted = (e.flags & MUX_INVERTED_OUTPUT) !== 0;
  const strobe = (e.flags & MUX_STROBE) !== 0;
  if (muxInputMode(e) === MUX_INPUT_MODE_BUS_BUS) {
    const dw = muxDataWidth(e);
    return groups * dw + bits + dw + (inverted ? dw : 0) + (strobe ? 1 : 0);
  }
  return groups + bits + 1 + (inverted ? 1 : 0) + (strobe ? 1 : 0);
}

export const MULTIPLEXER_DEF: ElementDef = {
  kind: 'multiplexer',
  label: 'Multiplexer',
  category: 'Logic',
  dumpCode: '184',
  postCount: 7, // the default 2-select-bit, 4-input layout: 4 + 2 + 1
  postCountOf: muxPostCount,
  posts: (e) => chipPosts(e, muxBits(e) + 1, muxGroupCount(e) + 1, muxPins(e)),
  bodyRect: (e) => chipBodyRect(e, muxBits(e) + 1, muxGroupCount(e) + 1),
  noDiagonal: true, // ChipElm.java:44
  defaultLength: 8, // the default 2-select-bit chip spans (sizeX + 1) * 32
  defaults: { bits: 2, highVoltage: 5 },
  parse: (t, e) => {
    // The ChipElm base writes an optional high-voltage token before the
    // subclass's own count, and the multiplexer has no saved output levels
    // (no `state` pins), so `chipCommonTokens` with `hasBits: false` walks the
    // right prefix (ChipElm.java:48-68, MultiplexerElm.java:55-63). The bus/bus
    // mode then reads the optional inputMode and dataBusWidth tokens upstream
    // writes only when non-default (MultiplexerElm.java:69-72), so old files
    // stay byte-for-byte.
    const i = chipCommonTokens(t, e, false);
    const bits = Number(t[i]);
    if (t[i] !== undefined && Number.isFinite(bits)) e.params.bits = normalizeMuxBits(bits);
    const extra = t
      .slice(i + 1)
      .map(Number)
      .filter((v) => Number.isFinite(v));
    // The `<inputMode> <dataBusWidth>` pair is recognised only as exactly two
    // trailing tokens led by 1 or 2. The dump writes a bare dataBusWidth in
    // mode 0 whenever it differs from the default 4, so a lone small token
    // must stay a width: reading it as an input mode would silently flip a
    // hand-edited mode-0 line into the grouped bus/bus layout.
    if (extra.length === 2 && (extra[0] === 1 || extra[0] === MUX_INPUT_MODE_BUS_BUS)) {
      if (extra[0] === MUX_INPUT_MODE_BUS_BUS) e.params.inputMode = MUX_INPUT_MODE_BUS_BUS;
      e.params.dataBusWidth = normalizeDataWidth(extra[1]);
    } else if (extra.length >= 1) {
      e.params.dataBusWidth = normalizeDataWidth(extra[0]);
    }
  },
  dump: (e) => {
    const parts = [...chipDump(e, muxPins(e), false), e.params.bits ?? 2];
    const inputMode = muxInputMode(e);
    const dw = muxDataWidth(e);
    // inputMode rides the line whenever non-zero; dataBusWidth rides it in
    // bus/bus mode (where it is essential) and otherwise only when it differs
    // from the default 4 (MultiplexerElm.java:69-72).
    if (inputMode !== 0) parts.push(inputMode);
    if (inputMode !== 0 || dw !== 4) parts.push(dw);
    return parts;
  },
  dumpFlags: chipDumpFlags,
  fields: [
    { name: 'bits', label: '# of Select Bits', min: 1, max: 6, integer: true },
    { name: 'highVoltage', label: 'High logic voltage', unit: 'V' },
    {
      name: 'invertedOutput',
      label: 'Inverted Output',
      type: 'bool',
      flag: MUX_INVERTED_OUTPUT,
    },
    { name: 'strobe', label: 'Strobe Pin', type: 'bool', flag: MUX_STROBE },
    { name: 'busSelect', label: 'Bus Select', type: 'bool', flag: MUX_BUS_SELECT },
    {
      name: 'inputMode',
      label: 'Input Mode',
      type: 'choice',
      choices: [
        { value: 0, label: 'Individual' },
        { value: MUX_INPUT_MODE_BUS_BUS, label: 'Bus-Bus' },
      ],
    },
    {
      name: 'dataBusWidth',
      label: 'Data Bus Width',
      type: 'number',
      min: 1,
      max: 32,
      integer: true,
      visible: (e) => muxInputMode(e) === MUX_INPUT_MODE_BUS_BUS,
    },
  ],
  draw: drawMux,
};
