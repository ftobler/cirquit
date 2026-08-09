import {
  canvasFont,
  currentDots,
  elementLength,
  interp,
  limbColor,
  line,
  voltageColor,
} from '../../../render/draw';
import { LOGIC_INPUT_TERNARY, SWITCH_LABEL } from '../flags';
import { onePost, readParams } from '../shared';
import { labelFlags, switchTokens } from './switch';
import type { CircuitElement, DrawContext, ElementDef } from '../../types';

/** LogicInputElm.java:26-27. Bit 1 turns the third (mid) position on, bit 2
 *  swaps the glyph from L/H to the position number. Both are display-only;
 *  the engine needs only bit 1. */
const LOGIC_INPUT_NUMERIC = 2;

/** The bold glyph at the free end: L or H, or the position under the numeric
 *  and ternary flags (LogicInputElm.java:79-81). */
function logicGlyph(e: CircuitElement): string {
  const position = e.state ?? e.params.position ?? 0;
  const numeric = (e.flags & (LOGIC_INPUT_TERNARY | LOGIC_INPUT_NUMERIC)) !== 0;
  return numeric ? String(position) : position === 0 ? 'L' : 'H';
}

function drawLogicInput(g: DrawContext, e: CircuitElement): void {
  const p1 = { x: e.x1, y: e.y1 };
  const p2 = { x: e.x2, y: e.y2 };
  const dn = Math.max(1, elementLength(e));
  // The thick lead runs from the post to 12 units short of the label end
  // (LogicInputElm.java:70-73).
  const lead1 = interp(p1, p2, 1 - 12 / dn);
  line(g, p1, lead1, voltageColor(g, g.voltages[0]));
  currentDots(g, p1, lead1, g.current);
  // Upstream centres the bold letter at the free end and colours it by
  // selection like the lead is coloured by voltage (LogicInputElm.java:75-83).
  g.ctx.fillStyle = limbColor(g, g.theme.text);
  g.ctx.font = `bold ${canvasFont(20)}`;
  g.ctx.textAlign = 'center';
  g.ctx.textBaseline = 'middle';
  g.ctx.fillText(logicGlyph(e), p2.x, p2.y);
}

export const LOGIC_INPUT_DEF: ElementDef = {
  kind: 'logicInput',
  label: 'Logic input',
  category: 'Logic',
  dumpCode: 'L',
  postCount: 1,
  posts: onePost,
  draggablePosts: 2,  // the free end is a control point, not a terminal
  interactive: true,
  defaults: { hiV: 5, loV: 0, position: 0, momentary: 0 },
  parse: (t, e) => {
    // The position token is written as `true`/`false` by some versions, the
    // same legacy form the switch's parse normalises.
    const p = t[0];
    e.params.position = p === 'true' ? 1 : p === 'false' ? 0 : Number(p) || 0;
    e.params.momentary = t[1] === 'true' ? 1 : 0;
    // The label token only exists under FLAG_LABEL and shifts hiV/loV one
    // token along: SwitchElm reads it before LogicInputElm appends its two
    // values (SwitchElm.java:66-67, LogicInputElm.java:38-40).
    let i = 2;
    if ((e.flags & SWITCH_LABEL) !== 0 && t[i] !== undefined) e.text = t[i++];
    readParams(t.slice(i), e, ['hiV', 'loV']);
    e.state = e.params.position;
  },
  // The momentary flag is written as a literal `true`/`false`, like the
  // switch's, then the two levels follow (LogicInputElm.java:51-53).
  dump: (e) => [...switchTokens(e), e.params.hiV ?? 5, e.params.loV ?? 0],
  dumpFlags: labelFlags,
  fields: [
    { name: 'hiV', label: 'High logic voltage', unit: 'V' },
    { name: 'loV', label: 'Low voltage', unit: 'V' },
  ],
  draw: drawLogicInput,
};
