import { canvasFont, limbColor, voltageColor } from '../../../render/draw';
import { escapeFlags, onePost, boxOfPoints } from '../shared';
import type { ElementDef } from '../../types';

export const LABELED_NODE_DEF: ElementDef = {
  kind: 'labeledNode',
  label: 'Labeled node',
  category: 'Other',
  dumpCode: '207',
  shortcut: 'b',  // LabeledNodeElm.java
  postCount: 1,
  posts: onePost,
  fields: [{ name: 'text', label: 'Text', type: 'text', target: 'text' }],
  parse: (t, e) => {
    // Both upstream readers end up with the same string: the new-style one
    // unescapes a single token (done by the netlist layer), the old-style
    // one joins the rest with spaces (LabeledNodeElm.java:41-49).
    e.text = t.join(' ');
  },
  dump: (e) => [e.text ?? ''],
  dumpFlags: escapeFlags,
  // The label box is a solid pick zone, roughly its drawn extent: an 11px
  // glyph is about 9 units wide per character plus the 10-unit pad, so the
  // box scales with the text (LabeledNodeElm.java's rect at y-8, h 16).
  bodyRect: (e) => {
    const p = { x: e.x1, y: e.y1 };
    const w = Math.max(20, (e.text?.length ?? 1) * 9 + 10);
    return boxOfPoints([
      { x: p.x, y: p.y - 8 },
      { x: p.x + w, y: p.y + 8 },
    ]);
  },
  draw(g, e) {
    const p = { x: e.x1, y: e.y1 };
    const text = e.text ?? '';
    g.ctx.font = canvasFont(11);
    const w = g.ctx.measureText(text).width + 10;
    g.ctx.fillStyle = g.theme.panel;
    g.ctx.strokeStyle = limbColor(g, voltageColor(g, g.voltages[0]));
    g.ctx.lineWidth = 1.5;
    g.ctx.beginPath();
    g.ctx.rect(p.x, p.y - 8, w, 16);
    g.ctx.fill();
    g.ctx.stroke();
    g.ctx.fillStyle = g.theme.text;
    g.ctx.textAlign = 'center';
    g.ctx.textBaseline = 'middle';
    g.ctx.fillText(text, p.x + w / 2, p.y);
  },
};
