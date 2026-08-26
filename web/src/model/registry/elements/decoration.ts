import { canvasFont, limbColor } from '../../../render/draw';
import { FLAG_ESCAPE, TEXT_BAR } from '../flags';
import { escapeFlags } from '../shared';
import type { ElementDef } from '../../types';

/**
 * The lines a text element paints: upstream's split() (TextElm.java:47-62)
 * walks the stored text, drops every backslash and breaks a line at each
 * `\n` pair. A raw newline breaks too: the stored model can carry one from
 * an edit that bypassed the tokenizer, and fillText would render it as
 * nothing, so the lines would silently join.
 */
export function textLines(text: string): string[] {
  const lines: string[] = [];
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') {
      if (text[i + 1] === 'n') {
        lines.push(cur);
        cur = '';
        i++;
      }
      continue;  // upstream deletes any other backslash (TextElm.java:53)
    }
    if (c === '\n') {
      lines.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  lines.push(cur);
  return lines;
}

export const DECORATION_DEF: ElementDef = {
  kind: 'decoration',
  label: 'Text',
  category: 'Other',
  dumpCode: 'x',
  shortcut: 't',  // TextElm.java
  // Upstream extends GraphicElm, whose post count is zero (GraphicElm.java:35):
  // the anchor is drawing geometry and never connects to a node, draws no
  // junction dot and never splits a wire drawn across it.
  postCount: 0,
  posts: () => [],
  defaults: { size: 24 },  // TextElm.java:44
  // Upstream's placement constructor seeds "hello" (TextElm.java:41), so a
  // dropped part says something instead of saving an empty \0 token.
  defaultText: 'hello',
  fields: [
    { name: 'text', label: 'Text', type: 'text', target: 'text' },
    { name: 'size', label: 'Size', unit: 'px' },
    // "Draw Bar On Top" (TextElm.java:135-138).
    { name: 'bar', label: 'Draw Bar On Top', type: 'bool', flag: TEXT_BAR },
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
    const size = Math.max(1, e.params.size ?? 24);
    g.ctx.font = canvasFont(size);
    g.ctx.textAlign = 'left';
    g.ctx.textBaseline = 'middle';
    // One fillText per line (TextElm.java:63-84), stepped one font size plus
    // three like upstream's cury; the first line keeps the single-line spot.
    const bar = (e.flags & TEXT_BAR) !== 0;
    textLines(e.text ?? '').forEach((s, i) => {
      const y = e.y1 + i * (size + 3);
      g.ctx.fillText(s, e.x1, y);
      if (bar) {
        // The bar sits one em above the baseline (upstream's by = cury -
        // currentFontSize), which in middle-baseline terms is half an em
        // above this line's centre, spanning the measured width of the line.
        g.ctx.strokeStyle = g.ctx.fillStyle;
        g.ctx.lineWidth = 1;
        const w = g.ctx.measureText(s).width;
        g.ctx.beginPath();
        g.ctx.moveTo(e.x1, y - size / 2);
        g.ctx.lineTo(e.x1 + w - 1, y - size / 2);
        g.ctx.stroke();
      }
    });
  },
};
