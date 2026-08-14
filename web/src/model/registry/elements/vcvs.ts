/**
 * Voltage-controlled voltage source (VCVSElm, dump 212): a chip with
 * `inputCount` inputs A.. on the west and V+/V- on the east. The output pair
 * is one ideal voltage source whose value is the expression evaluated against
 * the input voltages (VCVSElm.java:22-43). Upstream models it as a subclass
 * of the VCCS, so both share the input-count/expression file format and the
 * pin layout; the shared machinery lives here and the VCCS imports it.
 *
 * Token layout after the common fields is `inputCount` then the expression as
 * one escaped token (VCCSElm.java:37-38). The expression reaches the engine as
 * `e.text` (the label carrier, `spec.label` in the engine), which the VCCS
 * base parses in `ExprSource::new`.
 */

import {
  chipBodyRect,
  chipDumpFlags,
  chipPosts,
  drawChip,
  type ChipPinDef,
} from './dFlipFlop';
import { normalizeInputCount, readParams, warnOnClamp } from '../shared';
import type { CircuitElement, DrawContext, ElementDef } from '../../types';

/** Default expression for a fresh source, inherited from the VCCS base
 *  (VCCSElm.java:45). */
export const DEFAULT_EXPR = '.1*(a-b)';

/** The four controlled-source kinds whose `inputCount` the store normalises
 *  on edit, so the renderer and the engine always agree on the post count. */
export const CS_INPUT_COUNT_KINDS: ReadonlySet<string> = new Set(['vcvs', 'vccs', 'ccvs', 'cccs']);

/** The editable input count, the integer the engine truncates `inputCount`
 *  to (VCCSElm.java:202-205). */
export function csInputCount(e: CircuitElement): number {
  return normalizeInputCount(e.params.inputCount ?? 2);
}

/** The pin table, from `setupPins` (VCCSElm.java:65-77, VCVSElm.java:31-44):
 *  the inputs A.. on the west rows 0..i-1 and the output pair on the east
 *  rows 0 and 1. The east labels and whether the first is a voltage-source
 *  output differ between the two flavours. */
export function csPins(
  e: CircuitElement,
  eastText: [string, string],
  eastOutput: boolean,
): ChipPinDef[] {
  const n = csInputCount(e);
  const pins: ChipPinDef[] = [];
  for (let i = 0; i < n; i++) {
    pins.push({ side: 'W', pos: i, text: String.fromCharCode(65 + i) });
  }
  pins.push({ side: 'E', pos: 0, text: eastText[0], output: eastOutput });
  pins.push({ side: 'E', pos: 1, text: eastText[1] });
  return pins;
}

/** The cell height, `sizeY` from setupPins: the input count, never fewer
 *  than 2 rows (VCCSElm.java:66). */
export function csSizeY(e: CircuitElement): number {
  return Math.max(csInputCount(e), 2);
}

/** The shared file-format parse: `inputCount` then the expression, which the
 *  netlist layer has already unescaped. A fractional count from a hand-edited
 *  file is clamped to the integer the engine truncates to, the same guard the
 *  gate applies on its own input count (gate.ts:312). The clamp-on-load policy
 *  warns when the token is out of the 1..8 range, so a file that loads wider
 *  than it saves is surfaced instead of silently rewritten. */
export function csParse(t: string[], e: CircuitElement, warn?: (message: string) => void): void {
  readParams(t, e, ['inputCount']);
  if (e.params.inputCount !== undefined) {
    const clamped = normalizeInputCount(e.params.inputCount);
    warnOnClamp(warn, CS_LABEL[e.kind] ?? 'Controlled source', 'inputs', e.params.inputCount, clamped);
    e.params.inputCount = clamped;
  }
  if (t[1] !== undefined) e.text = t[1];
}

/** The controlled-source kinds' display names, for the clamp-on-load warning. */
const CS_LABEL: Record<string, string> = {
  vcvs: 'Voltage-Controlled Voltage Source',
  vccs: 'Voltage-Controlled Current Source',
  ccvs: 'Current-Controlled Voltage Source',
  cccs: 'Current-Controlled Current Source',
};

/** The shared file-format dump: the input count and the expression. A fresh
 *  part without a label falls back to the upstream constructor expression so
 *  a save never writes an empty token. */
export function csDump(e: CircuitElement): (string | number)[] {
  return [csInputCount(e), e.text ?? DEFAULT_EXPR];
}

/** Both flavours expose the input count and the output function string. */
export const CS_FIELDS = [
  { name: 'inputCount', label: '# of Inputs', min: 1, max: 8 },
  { name: 'exprString', label: 'Output Function', type: 'text' as const, target: 'text' as const },
];

function drawVcvs(g: DrawContext, e: CircuitElement): void {
  drawChip(g, e, 2, csSizeY(e), csPins(e, ['V+', 'V-'], true));
}

export const VCVS_DEF: ElementDef = {
  kind: 'vcvs',
  label: 'Voltage-Controlled Voltage Source',
  category: 'Sources',
  dumpCode: '212',
  postCount: 4, // two inputs + V+/V- at the default input count
  posts: (e) => chipPosts(e, 2, csSizeY(e), csPins(e, ['V+', 'V-'], true)),
  bodyRect: (e) => chipBodyRect(e, 2, csSizeY(e)),
  noDiagonal: true, // ChipElm.java:44
  defaultLength: 6, // the chip spans (sizeX + 1) * 32
  defaults: { inputCount: 2 },
  parse: csParse,
  dump: csDump,
  dumpFlags: chipDumpFlags,
  fields: CS_FIELDS,
  draw: drawVcvs,
};
