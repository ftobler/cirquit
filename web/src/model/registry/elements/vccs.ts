/**
 * Voltage-controlled current source (VCCSElm, dump 213): a chip with
 * `inputCount` inputs A.. on the west and C+/C- on the east. The current
 * delivered into the output pair is the expression evaluated against the
 * input voltages (VCCSElm.java:27-41). The VCVS extends this class upstream,
 * so both share the input-count/expression file format and the pin layout;
 * the shared machinery is in vcvs.ts.
 *
 * Token layout after the common fields is `inputCount` then the expression as
 * one escaped token (VCCSElm.java:37-38), the same string that reaches the
 * engine as `e.text` (`spec.label`).
 */

import { chipBodyRect, chipDumpFlags, chipPosts, drawChip } from './dFlipFlop';
import { csDump, csParse, csPins, csSizeY, CS_FIELDS, DEFAULT_EXPR } from './vcvs';
import type { CircuitElement, DrawContext, ElementDef } from '../../types';

function drawVccs(g: DrawContext, e: CircuitElement): void {
  drawChip(g, e, 2, csSizeY(e), csPins(e, ['C+', 'C-'], false));
}

export const VCCS_DEF: ElementDef = {
  kind: 'vccs',
  label: 'Voltage-Controlled Current Source',
  category: 'Sources',
  dumpCode: '213',
  postCount: 4, // two inputs + C+/C- at the default input count
  posts: (e) => chipPosts(e, 2, csSizeY(e), csPins(e, ['C+', 'C-'], false)),
  chipExtents: (e) => ({ sx: 2, sy: csSizeY(e) }),
  canMirror: true,  // ChipElm.flipX, VCCSElm.java:27
  bodyRect: (e) => chipBodyRect(e, 2, csSizeY(e)),
  noDiagonal: true, // ChipElm.java:44
  defaultLength: 6, // the chip spans (sizeX + 1) * 32
  defaults: { inputCount: 2 },
  // A fresh part carries upstream's constructor expression, so the Output
  // Function box opens filled in and the source does something on drop
  // instead of evaluating an empty string (VCCSElm.java:45).
  defaultText: DEFAULT_EXPR,
  parse: csParse,
  dump: csDump,
  dumpFlags: chipDumpFlags,
  fields: CS_FIELDS,
  draw: drawVccs,
};
