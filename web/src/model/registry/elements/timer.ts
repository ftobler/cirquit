/**
 * The 555 timer (TimerElm.java, dump 165). Not a digital chip in the family
 * sense: it has no voltage-source outputs, so it cannot reuse the engine's
 * `chip.rs` base, but it shares the ChipElm body, pin stubs, labels and the
 * file-format tokens (optional `highVoltage`, then the saved OUT level), so
 * the geometry and token machinery come from `dFlipFlop.ts`.
 *
 * Flags: 2 FLAG_RESET, 4 FLAG_GROUND, 8 FLAG_NUMBERS. The default keeps both
 * the reset and ground pins, for 8 posts; dropping the ground pin still keeps
 * reset (7 posts) because the timer cannot work without a reset input, and
 * dropping both leaves the minimal 6-post part (TimerElm.java:62-63, :129).
 */

import { chipDump, chipDumpFlags, chipParse, chipPosts, drawChip, type ChipPinDef } from './dFlipFlop';
import type { CircuitElement, DrawContext, ElementDef } from '../../types';

export const TIMER_RESET = 2;
export const TIMER_GROUND = 4;
export const TIMER_NUMBERS = 8;

/** The pin table, from `setupPins` (TimerElm.java:43-60). The trig and reset
 *  pins are active-low and carry an overline unless pin numbers are shown.
 *  Post order must match the engine: 0 DIS, 1 TRIG, 2 THRES, 3 VCC, 4 CTL,
 *  5 OUT, 6 RST, 7 GND. */
export function timerPins(e: CircuitElement): ChipPinDef[] {
  const ground = (e.flags & TIMER_GROUND) !== 0;
  // A ground pin forces the reset pin, matching the engine's hasReset()
  // (TimerElm.java:62) and the D flip-flop's set-implies-reset rule.
  const reset = (e.flags & TIMER_RESET) !== 0 || ground;
  const numbers = (e.flags & TIMER_NUMBERS) !== 0;
  // `usePinNames()` is the negation of `usePinNumbers()` (TimerElm.java:64-65).
  const text = (name: string, num: string) => (numbers ? num : name);
  const pins: ChipPinDef[] = [
    { side: 'W', pos: 1, text: text('dis', '7') },
    { side: 'W', pos: 3, text: text('tr', '2'), lineOver: !numbers },
    { side: 'W', pos: 4, text: text('th', '6') },
    { side: 'N', pos: 1, text: text('Vcc', '8') },
    { side: 'S', pos: 1, text: text('ctl', '5') },
    // OUT is the one state pin; its level is saved to the file and restored
    // on load (TimerElm.java:55).
    { side: 'E', pos: 2, text: text('out', '3'), output: true, state: true },
  ];
  if (reset) {
    pins.push({ side: 'E', pos: 1, text: text('rst', '4'), lineOver: !numbers });
  }
  if (ground) {
    pins.push({ side: 'S', pos: 2, text: text('gnd', '1') });
  }
  return pins;
}

function drawTimer(g: DrawContext, e: CircuitElement): void {
  drawChip(g, e, 3, 5, timerPins(e));
}

export const TIMER_DEF: ElementDef = {
  kind: 'timer',
  label: '555 timer',
  category: 'Active',
  dumpCode: '165',
  postCount: 8,
  posts: (e) => chipPosts(e, 3, 5, timerPins(e)),
  noDiagonal: true,  // ChipElm.java:44
  defaultLength: 8,  // the chip spans (sizeX + 1) * 32
  defaults: { highVoltage: 5 },
  defaultFlags: TIMER_RESET | TIMER_GROUND,
  parse: (t, e) => chipParse(t, e, timerPins(e), false),
  dump: (e) => chipDump(e, timerPins(e), false),
  dumpFlags: chipDumpFlags,
  fields: [
    { name: 'highVoltage', label: 'High logic voltage', unit: 'V' },
    { name: 'reset', label: 'Reset Pin', type: 'bool', flag: TIMER_RESET },
    { name: 'ground', label: 'Ground Pin', type: 'bool', flag: TIMER_GROUND },
    { name: 'numbers', label: 'Show Pin Numbers', type: 'bool', flag: TIMER_NUMBERS },
  ],
  draw: drawTimer,
};
