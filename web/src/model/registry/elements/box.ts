import { limbColor } from '../../../render/draw';
import { boxOfPoints } from '../shared';
import type { ElementDef } from '../../types';

export const BOX_DEF: ElementDef = {
  kind: 'box',
  label: 'Box',
  category: 'Other',
  dumpCode: 'b',
  // Upstream extends GraphicElm, whose post count is zero (GraphicElm.java:35):
  // the box is pure drawing and never connects to a node.
  postCount: 0,
  posts: () => [],
  // The `b` line carries no tokens after the flags (BoxElm.java:31-37).
  // The whole dashed rectangle is a solid pick zone (BoxElm.java:54-62).
  bodyRect: (e) =>
    boxOfPoints([
      { x: Math.min(e.x1, e.x2), y: Math.min(e.y1, e.y2) },
      { x: Math.max(e.x1, e.x2), y: Math.max(e.y1, e.y2) },
    ]),
  draw(g, e) {
    g.ctx.strokeStyle = limbColor(g, g.theme.text);
    g.ctx.lineWidth = 2;
    // Upstream's dashed outline (BoxElm.java:54), a corner-order-independent
    // version of its four drawRect branches (BoxElm.java:55-62).
    g.ctx.setLineDash([16, 6]);
    g.ctx.beginPath();
    g.ctx.rect(
      Math.min(e.x1, e.x2),
      Math.min(e.y1, e.y2),
      Math.abs(e.x2 - e.x1),
      Math.abs(e.y2 - e.y1),
    );
    g.ctx.stroke();
    g.ctx.setLineDash([]);
  },
};
