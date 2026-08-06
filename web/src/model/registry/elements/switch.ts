import { calcLeads, circle, currentDots, drawLeads, line, voltageColor } from '../../../render/draw';
import { SWITCH_LABEL } from '../flags';
import { switchLeverTip, twoPosts } from '../shared';
import type { CircuitElement, DrawContext, ElementDef } from '../../types';

/** The SPST tokens, which the SPDT writes first and then extends. The label
 *  only appears when there is one, matching the flag `labelFlags` writes. */
export function switchTokens(e: CircuitElement): (string | number)[] {
  const tokens: (string | number)[] = [
    e.state ?? e.params.position ?? 0,
    (e.params.momentary ?? 0) !== 0 ? 'true' : 'false',
  ];
  if (e.text) tokens.push(e.text);
  return tokens;
}

/** Clearing FLAG_LABEL when the label goes empty keeps the token count and the
 *  flag in step, as upstream's editor does (SwitchElm.java:258-265). */
export function labelFlags(e: CircuitElement): number {
  return e.text ? e.flags | SWITCH_LABEL : e.flags & ~SWITCH_LABEL;
}

function drawSwitchBody(g: DrawContext, e: CircuitElement): void {
  const [lead1, lead2] = calcLeads(e, 32);
  drawLeads(g, e, lead1, lead2);
  const closed = (e.state ?? e.params.position ?? 0) === 0;
  // The lever is always at the pivot's potential; it is connected to lead1
  // whether it is closed or not.
  const color = voltageColor(g, g.voltages[0]);
  circle(g, lead1, 2.5, color, true, 1);
  circle(g, lead2, 2.5, voltageColor(g, g.voltages[1]), true, 1);
  const tip = switchLeverTip(lead1, lead2, closed);
  line(g, lead1, tip, color);
  if (closed) currentDots(g, lead1, lead2, g.current);
}

export const SWITCH_DEF: ElementDef = {
  kind: 'switch',
  label: 'Switch',
  category: 'Basics',
  dumpCode: 's',
  postCount: 2,
  posts: twoPosts,
  interactive: true,
  defaults: { position: 0, momentary: 0 },
  parse: (t, e) => {
    // The position token is written as `true`/`false` by some versions.
    const p = t[0];
    e.params.position = p === 'true' ? 1 : p === 'false' ? 0 : Number(p) || 0;
    e.params.momentary = t[1] === 'true' ? 1 : 0;
    // The label token only exists under FLAG_LABEL (SwitchElm.java:66-67).
    if ((e.flags & SWITCH_LABEL) !== 0 && t[2] !== undefined) e.text = t[2];
    e.state = e.params.position;
  },
  // The format writes the momentary flag as a literal `true`/`false`.
  dump: switchTokens,
  dumpFlags: labelFlags,
  draw: drawSwitchBody,
};
