import { line, voltageColor } from '../../../render/draw';
import { onePost, readParams, writeParams } from '../shared';
import type { CircuitElement, DrawContext, ElementDef } from '../../types';

function drawGroundSymbol(g: DrawContext, e: CircuitElement): void {
  const p = { x: e.x1, y: e.y1 };
  const color = voltageColor(g, 0);
  line(g, p, { x: p.x, y: p.y + 6 }, color);
  for (let i = 0; i < 3; i++) {
    const w = 10 - i * 3;
    const y = p.y + 6 + i * 4;
    line(g, { x: p.x - w, y }, { x: p.x + w, y }, color, 2);
  }
}

export const GROUND_DEF: ElementDef = {
  kind: 'ground',
  label: 'Ground',
  category: 'Basics',
  dumpCode: 'g',
  postCount: 1,
  posts: onePost,
  vertical: true,   // GroundElm.java:36, always placed vertically
  defaultLength: 2, // 32 px, GroundElm.java:140
  parse: (t, e) => readParams(t, e, ['symbolType']),
  dump: writeParams(['symbolType']),
  draw: drawGroundSymbol,
};
