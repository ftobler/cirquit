import {
  currentDots,
  currentDotsPath,
  endpoints,
  line,
  voltageColor,
} from '../../../render/draw';
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
    if (e.route && e.route.length >= 2) {
      // A routed wire draws each segment of the polyline and chains the
      // current dots across them, so dots stay exactly DOT_SPACING apart
      // across the bends (RoutedWireElm.draw and doDots, RoutedWireElm.java:
      // 279-288, 349-364).
      const pts = e.route.map(([x, y]) => ({ x, y }));
      const color = voltageColor(g, g.voltages[0]);
      for (let i = 0; i < pts.length - 1; i++) {
        // Round caps close each segment's corners, since a routed wire strokes
        // independent segments rather than one path; miter joins never apply.
        // Upstream draws wires with drawThickLine (WireElm.java:87), so the
        // weight is 3, never the ambient 1.
        line(g, pts[i], pts[i + 1], color, 3, 'round');
      }
      currentDotsPath(g, pts, g.current);
      return;
    }
    const [p1, p2] = endpoints(e);
    line(g, p1, p2, voltageColor(g, g.voltages[0]), 3, 'round');
    currentDots(g, p1, p2, g.current);
  },
};
