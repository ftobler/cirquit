import { canvasFont, circle, formatValue, voltageColor } from '../../../render/draw';
import { onePost, readParams, writeParams } from '../shared';
import type { ElementDef } from '../../types';

export const OUTPUT_DEF: ElementDef = {
  kind: 'output',
  label: 'Voltage readout',
  category: 'Other',
  dumpCode: 'O',
  postCount: 1,
  posts: onePost,
  parse: (t, e) => readParams(t, e, ['scale']),
  dump: writeParams(['scale']),
  draw(g, e) {
    const p = { x: e.x1, y: e.y1 };
    circle(g, p, 4, voltageColor(g, g.voltages[0]), false, 2);
    g.ctx.fillStyle = g.theme.text;
    g.ctx.font = canvasFont(11);
    g.ctx.textAlign = 'left';
    g.ctx.textBaseline = 'middle';
    g.ctx.fillText(formatValue(g.voltages[0] ?? 0, 'V'), p.x + 8, p.y);
  },
};
