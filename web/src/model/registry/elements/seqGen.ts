/**
 * The sequence generator (SeqGenElm.java, dump 188): a clocked part that emits
 * the stored bit pattern one bit per rising edge. FLAG_HAS_RESET adds an
 * active-high reset pin that rewinds to the first bit, FLAG_PLAY_ONCE stops
 * the sequence after its last bit. The bit stream is packed into integer
 * words, one per 32 bits, and the old pre-2009 byte format is upgraded to the
 * new token layout on load exactly as upstream does (SeqGenElm.java:51-61).
 */

import {
  chipBodyRect,
  chipCommonTokens,
  chipDumpFlags,
  chipPosts,
  drawChip,
  type ChipPinDef,
} from './dFlipFlop';
import { readParams } from '../shared';
import type { CircuitElement, DrawContext, ElementDef } from '../../types';

export const SEQ_NEW_VERSION = 2;
export const SEQ_PLAY_ONCE = 4;
export const SEQ_HAS_RESET = 8;

function seqDataNames(bitCount: number): string[] {
  const words = Math.max(1, Math.ceil(bitCount / 32));
  return Array.from({ length: words }, (_, i) => `data${i}`);
}

function seqBitCount(e: CircuitElement): number {
  const n = Number(e.params.bitCount);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 8;
}

/** The pin table, from `setupPins` (SeqGenElm.java:80-91). */
export function seqGenPins(e: CircuitElement): ChipPinDef[] {
  const pins: ChipPinDef[] = [
    { side: 'W', pos: 0, text: '', clock: true },
    { side: 'E', pos: 1, text: 'Q', output: true },
  ];
  if ((e.flags & SEQ_HAS_RESET) !== 0) {
    pins.push({ side: 'W', pos: 1, text: 'R' });
  }
  return pins;
}

function drawSeqGen(g: DrawContext, e: CircuitElement): void {
  drawChip(g, e, 2, 2, seqGenPins(e));
}

export const SEQ_GEN_DEF: ElementDef = {
  kind: 'seqGen',
  label: 'sequence generator',
  category: 'Logic',
  dumpCode: '188',
  postCount: 3,
  posts: (e) => chipPosts(e, 2, 2, seqGenPins(e)),
  bodyRect: (e) => chipBodyRect(e, 2, 2),
  noDiagonal: true,  // ChipElm.java:44
  defaultLength: 3,  // the chip spans (sizeX + 1) * 32
  defaultFlags: SEQ_NEW_VERSION | SEQ_HAS_RESET,  // SeqGenElm.java:43-44
  defaults: { bitCount: 8, data0: 0, highVoltage: 5 },
  parse: (t, e) => {
    const i = chipCommonTokens(t, e, false);
    if ((e.flags & SEQ_NEW_VERSION) === 0) {
      // Old format: one byte, read right-to-left. Upstream's reversal loop is
      // a no-op on the sign-extended byte, so the value survives whole
      // (SeqGenElm.java:56-61), and the next save writes the new layout.
      const old = Number(t[i]);
      e.params.bitCount = 8;
      e.params.data0 = Number.isFinite(old) ? old & 0xff : 0;
      e.flags |= SEQ_NEW_VERSION;
    } else {
      const bc = Number(t[i]);
      if (t[i] !== undefined && Number.isFinite(bc)) e.params.bitCount = bc;
      const bitCount = seqBitCount(e);
      readParams(t.slice(i + 1), e, seqDataNames(bitCount));
    }
  },
  dump: (e) => {
    const out: (string | number)[] = [];
    const hv = e.params.highVoltage;
    if (hv !== undefined && hv !== 5) out.push(hv);
    // The bit count and data words are written even though upstream's own
    // `dump()` drops them: a save must not lose the sequence.
    const bitCount = seqBitCount(e);
    out.push(bitCount);
    for (const name of seqDataNames(bitCount)) out.push(e.params[name] ?? 0);
    return out;
  },
  dumpFlags: chipDumpFlags,
  fields: [
    { name: 'playOnce', label: 'Play Once', type: 'bool', flag: SEQ_PLAY_ONCE },
    { name: 'reset', label: 'Reset Pin', type: 'bool', flag: SEQ_HAS_RESET },
    { name: 'highVoltage', label: 'High logic voltage', unit: 'V' },
  ],
  draw: drawSeqGen,
};
