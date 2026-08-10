/**
 * Current-controlled current source (CCCSElm, dump 215): a chip with
 * `inputCount` input pins arranged as pairs A+/A-, B+/B-.. on the west and
 * O+/O- on the east. Each pair is shorted by a 0 V sensing voltage source
 * whose current is the expression variable, and the current delivered into
 * the output pair is the expression value (CCCSElm.java:29-62). Upstream
 * models it as a subclass of the VCCS, so the token layout is the same
 * `inputCount` then the escaped expression (VCCSElm.java:37-38); the shared
 * parse/dump machinery comes from the VCVS and the pair helpers from the
 * CCVS.
 */

import { chipBodyRect, chipDumpFlags, chipPosts, drawChip } from './dFlipFlop';
import { ccsDump, ccsPairPins, ccsSizeY } from './ccvs';
import { csParse, CS_FIELDS } from './vcvs';
import type { CircuitElement, DrawContext, ElementDef } from '../../types';

function drawCccs(g: DrawContext, e: CircuitElement): void {
  drawChip(g, e, 2, ccsSizeY(e), ccsPairPins(e, ['O+', 'O-'], false));
}

export const CCCS_DEF: ElementDef = {
  kind: 'cccs',
  label: 'Current-Controlled Current Source',
  category: 'Sources',
  dumpCode: '215',
  postCount: 4, // one input pair + O+/O- at the default input count
  posts: (e) => chipPosts(e, 2, ccsSizeY(e), ccsPairPins(e, ['O+', 'O-'], false)),
  bodyRect: (e) => chipBodyRect(e, 2, ccsSizeY(e)),
  noDiagonal: true, // ChipElm.java:44
  defaultLength: 6, // the chip spans (sizeX + 1) * 32
  defaults: { inputCount: 2 },
  parse: csParse,
  dump: ccsDump,
  dumpFlags: chipDumpFlags,
  fields: CS_FIELDS,
  draw: drawCccs,
};
