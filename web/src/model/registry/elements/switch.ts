import { calcLeads, currentDotsPath, drawLeads, endpoints, line } from '../../../render/draw';
import { SWITCH_IEC, SWITCH_LABEL } from '../flags';
import { elementColor, switchIecPoints, switchLever, twoPosts } from '../shared';
import type { CircuitElement, DrawContext, ElementDef, Point } from '../../types';

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
  const color = elementColor(g, g.voltages[0], g.power);
  const [pivot, tip] = switchLever(lead1, lead2, closed);
  line(g, pivot, tip, color);
  if ((e.flags & SWITCH_IEC) !== 0) {
    drawSwitchIec(g, lead1, lead2, closed, color, (e.params.momentary ?? 0) !== 0);
  }
  if (closed) {
    const [p1, p2] = endpoints(e);
    currentDotsPath(g, [p1, lead1, lead2, p2], g.current);
  }
}

function drawSwitchIec(
  g: DrawContext,
  lead1: Point,
  lead2: Point,
  closed: boolean,
  color: string,
  momentary: boolean,
): void {
  const [p0, p1, p2, p3, p4, p5, p6] = switchIecPoints(lead1, lead2, closed);
  line(g, p2, p3, color);
  g.ctx.setLineDash([3, 3]);
  if (momentary) {
    line(g, p1, p0, color);
  } else {
    line(g, p6, p0, color);
    line(g, p1, p4, color);
  }
  g.ctx.setLineDash([]);
  if (!momentary) {
    line(g, p4, p5, color);
    line(g, p6, p5, color);
  }
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
  // The keyboard shortcut is session-only: it never appears in the netlist,
  // only in the Options panel and the keydown matcher.
  fields: [{ name: 'keyShortcut', label: 'Keyboard Shortcut', type: 'text', target: 'keyShortcut' }],
  draw: drawSwitchBody,
};
