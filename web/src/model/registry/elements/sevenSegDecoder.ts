/**
 * The seven-, 14- and 16-segment decoder (SevenSegDecoderElm.java, dump 197):
 * a chip that turns a 4-bit hex digit into the segment pattern that displays
 * it. The `segmentType` token selects the segment count (0, 1 or 2), the four
 * inputs sit on the west MSB first, the segment outputs on the east (bit 0 is
 * segment `a`), and FLAG_ENABLE adds an active-low blank pin. Under
 * FLAG_BLANK_F the all-ones input blanks instead of lighting the digit F.
 * Upstream's own `dump()` drops the segmentType token, so this writer puts it
 * back: a save must not silently shrink a 14- or 16-segment part.
 */

import {
  chipBodyRect,
  chipCommonTokens,
  chipDumpFlags,
  chipPosts,
  drawChip,
  type ChipPinDef,
} from './dFlipFlop';
import type { CircuitElement, DrawContext, ElementDef } from '../../types';

/** The active-low blank input pin (SevenSegDecoderElm.java:91). */
export const SEVEN_SEG_ENABLE = 1 << 1;
/** The all-ones input blanks all segments instead of lighting digit F
 *  (SevenSegDecoderElm.java:92). */
export const SEVEN_SEG_BLANK_F = 1 << 2;

/** Segment count from the `segmentType` token (SevenSegDecoderElm.java:117-121). */
function sevenSegSegmentCount(e: CircuitElement): number {
  const st = Math.round(e.params.segmentType ?? 0);
  if (st === 1) return 14;
  if (st === 2) return 16;
  return 7;
}

function sevenSegSizeY(e: CircuitElement): number {
  const segCount = sevenSegSegmentCount(e);
  const hasBlank = (e.flags & SEVEN_SEG_ENABLE) !== 0;
  // The body height covers the taller of the two pin groups; the blank pin
  // takes one extra row below the four inputs (SevenSegDecoderElm.java:141).
  return Math.max(segCount, 4 + (hasBlank ? 1 : 0));
}

/** The pin table, from `setupPins` (SevenSegDecoderElm.java:135-160): the
 *  segment outputs down the east, the four inputs on the west MSB first (the
 *  reversed makeBitPins puts I3 at row 0 and I0 at row 3), then the active-low
 *  blank pin when FLAG_ENABLE adds one. */
export function sevenSegDecoderPins(e: CircuitElement): ChipPinDef[] {
  const segCount = sevenSegSegmentCount(e);
  const pins: ChipPinDef[] = [];
  for (let i = 0; i < segCount; i++) {
    pins.push({ side: 'E', pos: i, text: String.fromCharCode(97 + i), output: true });
  }
  for (let i = 0; i < 4; i++) {
    pins.push({ side: 'W', pos: i, text: `I${3 - i}` });
  }
  if ((e.flags & SEVEN_SEG_ENABLE) !== 0) {
    pins.push({ side: 'W', pos: 4, text: 'BI', bubble: true });
  }
  return pins;
}

function drawSevenSegDecoder(g: DrawContext, e: CircuitElement): void {
  drawChip(g, e, 3, sevenSegSizeY(e), sevenSegDecoderPins(e));
}

export const SEVEN_SEG_DECODER_DEF: ElementDef = {
  kind: 'sevenSegDecoder',
  label: '7-segment decoder',
  category: 'Logic',
  dumpCode: '197',
  postCount: 11,  // the default 7-segment layout: 7 + 4 inputs
  posts: (e) => chipPosts(e, 3, sevenSegSizeY(e), sevenSegDecoderPins(e)),
  chipExtents: (e) => ({ sx: 3, sy: sevenSegSizeY(e) }),
  canMirror: true,  // ChipElm.flipX, SevenSegDecoderElm inherits it
  bodyRect: (e) => chipBodyRect(e, 3, sevenSegSizeY(e)),
  noDiagonal: true,  // ChipElm.java:44
  defaultLength: 8,  // the chip spans (sizeX + 1) * 32 with sizeX 3
  defaults: { segmentType: 0, highVoltage: 5 },
  parse: (t, e) => {
    // The segment count token follows the optional high voltage and there are
    // no saved output levels (ChipElm.java:48-68, SevenSegDecoderElm.java:
    // 97-105).
    const i = chipCommonTokens(t, e, false);
    const st = Number(t[i]);
    if (t[i] !== undefined && Number.isFinite(st)) e.params.segmentType = st;
  },
  dump: (e) => {
    const out: (string | number)[] = [];
    const hv = e.params.highVoltage;
    if (hv !== undefined && hv !== 5) out.push(hv);
    out.push(e.params.segmentType ?? 0);
    return out;
  },
  dumpFlags: chipDumpFlags,
  fields: [
    {
      name: 'segmentType',
      label: 'Segments',
      type: 'choice',
      choices: [
        { value: 0, label: '7 Segment' },
        { value: 1, label: '14 Segment' },
        { value: 2, label: '16 Segment' },
      ],
    },
    { name: 'blankPin', label: 'Blank Pin', type: 'bool', flag: SEVEN_SEG_ENABLE },
    { name: 'blankOnF', label: 'Blank on 1111', type: 'bool', flag: SEVEN_SEG_BLANK_F },
    { name: 'highVoltage', label: 'High logic voltage', unit: 'V' },
  ],
  draw: drawSevenSegDecoder,
};
