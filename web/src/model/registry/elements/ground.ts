import { line } from '../../../render/draw';
import { elementColor, groundBars, onePost, readParams, writeParams } from '../shared';
import type { CircuitElement, DrawContext, ElementDef } from '../../types';

function drawGroundSymbol(g: DrawContext, e: CircuitElement): void {
  const p1 = { x: e.x1, y: e.y1 };
  const p2 = { x: e.x2, y: e.y2 };
  const color = elementColor(g, 0, g.power);
  // The stem is the whole dragged span; the symbol hangs off the far end,
  // the end opposite the post (GroundElm.java:65).
  line(g, p1, p2, color);
  for (const [a, b] of groundBars(p1, p2, e.params.symbolType ?? 0)) {
    line(g, a, b, color);
  }
}

export const GROUND_DEF: ElementDef = {
  kind: 'ground',
  label: 'Ground',
  category: 'Basics',
  dumpCode: 'g',
  postCount: 1,
  posts: onePost,
  draggablePosts: 2,  // the free end is a control point, not a terminal
  vertical: true,   // GroundElm.java:36, always placed vertically
  defaultLength: 2, // 32 px, GroundElm.java:140
  parse: (t, e) => readParams(t, e, ['symbolType']),
  dump: writeParams(['symbolType']),
  draw: drawGroundSymbol,
};
