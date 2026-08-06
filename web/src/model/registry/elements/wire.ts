import { currentDots, endpoints, line, voltageColor } from '../../../render/draw';
import { twoPosts } from '../shared';
import type { ElementDef } from '../../types';

export const WIRE_DEF: ElementDef = {
  kind: 'wire',
  label: 'Wire',
  category: 'Basics',
  dumpCode: 'w',
  postCount: 2,
  posts: twoPosts,
  defaultLength: 4,  // 64 px, upstream's default getDragLength()
  draw(g, e) {
    const [p1, p2] = endpoints(e);
    line(g, p1, p2, voltageColor(g, g.voltages[0]));
    currentDots(g, p1, p2, g.current);
  },
};
