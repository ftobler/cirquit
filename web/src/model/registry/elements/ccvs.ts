/**
 * Current-controlled voltage source (CCVSElm, dump 214): a chip with
 * `inputCount` input pins arranged as pairs A+/A-, B+/B-.. on the west and
 * V+/V- on the east. Each pair is shorted by a 0 V sensing voltage source
 * whose current is the expression variable, and the output pair is one ideal
 * voltage source whose value is the expression (CCVSElm.java:29-63).
 * Upstream models it as a subclass of the VCCS, so the token layout is the
 * same `inputCount` then the escaped expression (VCCSElm.java:37-38); the
 * shared parse/dump machinery comes from the VCVS and the pair helpers live
 * here for the CCCS to import.
 */

import {
  chipBodyRect,
  chipDumpFlags,
  chipPosts,
  drawChip,
  type ChipPinDef,
} from './dFlipFlop';
import { csInputCount, csParse, CS_FIELDS } from './vcvs';
import type { CircuitElement, DrawContext, ElementDef } from '../../types';

/** Default expression for a fresh source, inherited by both current-
 *  controlled flavours (CCVSElm.java:39, CCCSElm.java:38). */
export const CCS_DEFAULT_EXPR = '2*a';

/** The number of input pairs, an odd count truncated to the even value below
 *  so a file never produces a dangling half-pair (CCVSElm.setChipEditValue,
 *  CCVSElm.java:187-193). */
export function ccsPairCount(e: CircuitElement): number {
  return Math.floor(csInputCount(e) / 2);
}

/** The pin table, from `setupPins` (CCVSElm.java:46-63): the input pairs
 *  A+/A-, B+/B-.. on the west rows 0.. and the output pair on the east rows 0
 *  and 1. The east labels and whether the first is a voltage-source output
 *  differ between the two flavours. */
export function ccsPairPins(
  e: CircuitElement,
  eastText: [string, string],
  eastOutput: boolean,
): ChipPinDef[] {
  const pairs = ccsPairCount(e);
  const pins: ChipPinDef[] = [];
  for (let i = 0; i < pairs; i++) {
    const tag = String.fromCharCode(65 + i);
    pins.push({ side: 'W', pos: 2 * i, text: tag + '+' });
    pins.push({ side: 'W', pos: 2 * i + 1, text: tag + '-', output: true });
  }
  pins.push({ side: 'E', pos: 0, text: eastText[0], output: eastOutput });
  pins.push({ side: 'E', pos: 1, text: eastText[1] });
  return pins;
}

/** The cell height, `sizeY` from setupPins: the paired input count, never
 *  fewer than 2 rows (CCVSElm.java:47). */
export function ccsSizeY(e: CircuitElement): number {
  return Math.max(ccsPairCount(e) * 2, 2);
}

/** The shared file-format dump: the input count and the expression. A fresh
 *  part without a label falls back to the upstream constructor expression so
 *  a save never writes an empty token (CCVSElm.java:39, CCCSElm.java:38). */
export function ccsDump(e: CircuitElement): (string | number)[] {
  return [csInputCount(e), e.text ?? CCS_DEFAULT_EXPR];
}

function drawCcvs(g: DrawContext, e: CircuitElement): void {
  drawChip(g, e, 2, ccsSizeY(e), ccsPairPins(e, ['V+', 'V-'], true));
}

export const CCVS_DEF: ElementDef = {
  kind: 'ccvs',
  label: 'Current-Controlled Voltage Source',
  category: 'Sources',
  dumpCode: '214',
  postCount: 4, // one input pair + V+/V- at the default input count
  posts: (e) => chipPosts(e, 2, ccsSizeY(e), ccsPairPins(e, ['V+', 'V-'], true)),
  bodyRect: (e) => chipBodyRect(e, 2, ccsSizeY(e)),
  noDiagonal: true, // ChipElm.java:44
  defaultLength: 6, // the chip spans (sizeX + 1) * 32
  defaults: { inputCount: 2 },
  // A fresh part carries upstream's constructor expression, so the Output
  // Function box opens filled in and the source does something on drop
  // instead of evaluating an empty string (CCVSElm.java:39).
  defaultText: CCS_DEFAULT_EXPR,
  parse: csParse,
  dump: ccsDump,
  dumpFlags: chipDumpFlags,
  fields: CS_FIELDS,
  draw: drawCcvs,
};
