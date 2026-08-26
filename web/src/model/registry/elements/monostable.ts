/**
 * The monostable one-shot (MonostableElm.java, dump 194): a rising edge on the
 * trigger drives Q high and Qbar low for `delay` seconds, then returns. A new
 * edge while the pulse is in flight restarts it only when retriggerable. The
 * two tokens after the common chip fields are the retriggerable Boolean and
 * the delay in seconds; upstream's own `dump()` drops both, so this writer
 * puts them back to keep a save lossless.
 */

import {
  chipBodyRect,
  chipCommonTokens,
  chipDumpFlags,
  chipPosts,
  drawChip,
  type ChipPinDef,
} from './dFlipFlop';
import { boolToken } from './switch';
import type { CircuitElement, DrawContext, ElementDef } from '../../types';

/** The pin table, from `setupPins` (MonostableElm.java:46-57). */
export function monostablePins(): ChipPinDef[] {
  return [
    { side: 'W', pos: 0, text: '', clock: true },
    { side: 'E', pos: 0, text: 'Q', output: true },
    { side: 'E', pos: 1, text: 'Q', output: true, lineOver: true },
  ];
}

function drawMonostable(g: DrawContext, e: CircuitElement): void {
  drawChip(g, e, 2, 2, monostablePins());
}

export const MONOSTABLE_DEF: ElementDef = {
  kind: 'monostable',
  label: 'monostable',
  category: 'Logic',
  dumpCode: '194',
  postCount: 3,
  posts: (e) => chipPosts(e, 2, 2, monostablePins()),
  chipExtents: () => ({ sx: 2, sy: 2 }),
  canMirror: true,  // ChipElm.flipX, MonostableElm inherits it
  bodyRect: (e) => chipBodyRect(e, 2, 2),
  noDiagonal: true,  // ChipElm.java:44
  defaultLength: 3,  // the chip spans (sizeX + 1) * 32
  defaults: { retriggerable: 0, delay: 0.01, highVoltage: 5 },
  parse: (t, e) => {
    const i = chipCommonTokens(t, e, false);
    const rt = t[i];
    if (rt !== undefined) e.params.retriggerable = boolToken(rt);
    const dl = Number(t[i + 1]);
    if (t[i + 1] !== undefined && Number.isFinite(dl)) e.params.delay = dl;
  },
  dump: (e) => {
    const out: (string | number)[] = [];
    const hv = e.params.highVoltage;
    if (hv !== undefined && hv !== 5) out.push(hv);
    out.push((e.params.retriggerable ?? 0) ? 'true' : 'false');
    out.push(e.params.delay ?? 0.01);
    return out;
  },
  dumpFlags: chipDumpFlags,
  fields: [
    { name: 'retriggerable', label: 'Retriggerable', type: 'bool' },
    { name: 'delay', label: 'Period (s)', unit: 's' },
    { name: 'highVoltage', label: 'High logic voltage', unit: 'V' },
  ],
  draw: drawMonostable,
};
