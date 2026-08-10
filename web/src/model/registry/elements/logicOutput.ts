import {
  canvasFont,
  elementLength,
  interp,
  lead,
  limbColor,
  voltageColor,
} from '../../../render/draw';
import { onePost, readParams, writeParams } from '../shared';
import type { CircuitElement, DrawContext, ElementDef } from '../../types';

/** LogicOutputElm.java:26-28. All three flags are display-only as far as this
 *  file's draw is concerned; the engine keys the pull-down stamp (bit 4) off
 *  the same flag, so it round-trips through `e.flags`. */
const LOGIC_OUTPUT_TERNARY = 1;
const LOGIC_OUTPUT_NUMERIC = 2;

/** The bold glyph at the free end, chosen from the node voltage vs threshold
 *  (LogicOutputElm.java:74-84). The ternary case reuses the single threshold
 *  at 1.5x and 0.5x, because there is no second threshold to read. */
function logicGlyph(g: DrawContext, e: CircuitElement): string {
  const v = g.voltages[0] ?? 0;
  const threshold = e.params.threshold ?? 2.5;
  if ((e.flags & LOGIC_OUTPUT_TERNARY) !== 0) {
    if (v > threshold * 1.5) return '2';
    if (v > threshold * 0.5) return '1';
    return '0';
  }
  if ((e.flags & (LOGIC_OUTPUT_TERNARY | LOGIC_OUTPUT_NUMERIC)) !== 0) {
    return v < threshold ? '0' : '1';
  }
  return v < threshold ? 'L' : 'H';
}

export const LOGIC_OUTPUT_DEF: ElementDef = {
  kind: 'logicOutput',
  label: 'Logic output',
  category: 'Logic',
  dumpCode: 'M',
  shortcut: 'o',  // LogicOutputElm.java
  postCount: 1,
  posts: onePost,
  draggablePosts: 2,  // the free end is a control point, not a terminal
  defaultFlags: 0,
  defaults: { threshold: 2.5 },
  parse: (t, e) => readParams(t, e, ['threshold']),
  dump: writeParams(['threshold']),
  fields: [{ name: 'threshold', label: 'Threshold', unit: 'V' }],
  draw(g, e) {
    const p1 = { x: e.x1, y: e.y1 };
    const p2 = { x: e.x2, y: e.y2 };
    const dn = Math.max(1, elementLength(e));
    // The thick lead runs from the post to 12 units short of the free end
    // (LogicOutputElm.java:64-66), like the logic input's.
    const lead1 = interp(p1, p2, 1 - 12 / dn);
    lead(g, p1, lead1, voltageColor(g, g.voltages[0]));
    // Upstream centres the bold letter at the free end, light-grey by default
    // and selection-coloured when highlighted (LogicOutputElm.java:69-87).
    g.ctx.fillStyle = limbColor(g, g.theme.text);
    g.ctx.font = `bold ${canvasFont(20)}`;
    g.ctx.textAlign = 'center';
    g.ctx.textBaseline = 'middle';
    g.ctx.fillText(logicGlyph(g, e), p2.x, p2.y);
  },
};
