import { canvasFont, limbColor } from '../../../render/draw';
import { FLAG_ESCAPE } from '../flags';
import { escapeFlags, onePost } from '../shared';
import type { ElementDef } from '../../types';

export const DECORATION_DEF: ElementDef = {
  kind: 'decoration',
  label: 'Text',
  category: 'Other',
  dumpCode: 'x',
  shortcut: 't',  // TextElm.java
  postCount: 1,
  posts: onePost,
  defaults: { size: 24 },  // TextElm.java:44
  fields: [
    { name: 'text', label: 'Text', type: 'text', target: 'text' },
    { name: 'size', label: 'Size', unit: 'px' },
  ],
  parse: (t, e) => {
    e.params.size = Number(t[0]) || 24;
    let text = t.slice(1).join(' ');
    // Dumps older than the escape scheme URL-encoded the plus sign, because
    // upstream's tokenizer treats `+` as a separator (TextElm.java:55).
    if ((e.flags & FLAG_ESCAPE) === 0) text = text.replace(/%2[bB]/g, '+');
    e.text = text;
  },
  dump: (e) => [e.params.size ?? 24, e.text ?? ''],
  dumpFlags: escapeFlags,
  draw(g, e) {
    g.ctx.fillStyle = limbColor(g, g.theme.text);
    // A zero or negative size would make an invalid font string and blank
    // the whole frame's drawing, so clamp at one pixel.
    g.ctx.font = canvasFont(Math.max(1, e.params.size ?? 24));
    g.ctx.textAlign = 'left';
    g.ctx.textBaseline = 'middle';
    g.ctx.fillText(e.text ?? '', e.x1, e.y1);
  },
};
