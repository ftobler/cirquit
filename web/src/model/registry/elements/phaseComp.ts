/**
 * Phase comparator registry entry (PhaseCompElm.java, dump 161). A 2x2 chip
 * with two west inputs and one east output; the engine's nonlinear model
 * drives the output high or low from the internal edge-triggered flip-flops.
 * The pin table is fixed, so the geometry helpers and the chip file-format
 * tokens (optional `highVoltage`, no state voltages) come straight from the
 * shared digital-family file.
 */

import { chipBodyRect, chipPosts, chipParse, chipDump, chipDumpFlags, drawChip } from './dFlipFlop';
import type { ChipPinDef } from './dFlipFlop';
import type { CircuitElement, DrawContext, ElementDef } from '../../types';

/** The pin table, from `setupPins` (PhaseCompElm.java:30-38). */
export const phaseCompPins: ChipPinDef[] = [
  { side: 'W', pos: 0, text: 'I1' },
  { side: 'W', pos: 1, text: 'I2' },
  { side: 'E', pos: 0, text: 'O', output: true },
];

function drawPhaseComp(g: DrawContext, e: CircuitElement): void {
  drawChip(g, e, 2, 2, phaseCompPins);
}

export const PHASE_COMP_DEF: ElementDef = {
  kind: 'phaseComp',
  label: 'Phase comparator',
  category: 'Logic',
  dumpCode: '161',
  postCount: 3,
  posts: (e) => chipPosts(e, 2, 2, phaseCompPins),
  chipExtents: () => ({ sx: 2, sy: 2 }),
  canMirror: true,  // ChipElm.flipX, PhaseCompElm inherits it
  bodyRect: (e) => chipBodyRect(e, 2, 2),
  noDiagonal: true,  // ChipElm.java:44
  defaultLength: 6,  // the chip spans (sizeX + 1) * 32
  defaults: { highVoltage: 5 },
  parse: (t, e) => chipParse(t, e, phaseCompPins, false),
  dump: (e) => chipDump(e, phaseCompPins, false),
  dumpFlags: chipDumpFlags,
  fields: [{ name: 'highVoltage', label: 'High logic voltage', unit: 'V' }],
  draw: drawPhaseComp,
};
