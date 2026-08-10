import {
  currentDots,
  currentDotsPath,
  endpoints,
  formatValueShort,
  label,
  labelOnSegment,
  line,
  voltageColor,
} from '../../../render/draw';
import { WIRE_SHOW_CURRENT, WIRE_SHOW_VOLTAGE } from '../flags';
import { twoPosts } from '../shared';
import type { CircuitElement, DrawContext, ElementDef } from '../../types';

/** The value caption upstream draws beside a wire when the Show Current and
 *  Show Voltage checkboxes are on: current as `|I|` in amps then voltage in
 *  volts, joined with a space (WireElm.java:90-102). The magnitude hides the
 *  wire's direction; the voltage is post 0's, and an ideal wire merges both
 *  endpoints into one node, so either post reads the same. */
function wireValueLabel(g: DrawContext, e: CircuitElement): string {
  let s = '';
  if (e.flags & WIRE_SHOW_CURRENT) {
    s = formatValueShort(Math.abs(g.current), 'A', g.valueDigits);
  }
  if (e.flags & WIRE_SHOW_VOLTAGE) {
    s = (s.length > 0 ? s + ' ' : '') + formatValueShort(g.voltages[0], 'V', g.valueDigits);
  }
  return s;
}

export const WIRE_DEF: ElementDef = {
  kind: 'wire',
  label: 'Wire',
  category: 'Basics',
  dumpCode: 'w',
  shortcut: 'w',  // WireElm.java
  postCount: 2,
  posts: twoPosts,
  defaultLength: 4,  // 64 px, upstream's default getDragLength()
  // The two bits ride the generic `flags` token: a `w` line has no tokens of
  // its own, so parse/dump are absent and the bits round-trip through the
  // base reader and writer unchanged.
  fields: [
    { name: 'showCurrent', label: 'Show Current', type: 'bool', flag: WIRE_SHOW_CURRENT },
    { name: 'showVoltage', label: 'Show Voltage', type: 'bool', flag: WIRE_SHOW_VOLTAGE },
  ],
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
      // The routed wire shows the same current/voltage caption as a plain
      // one, on its longest segment (RoutedWireElm.java:307-347). The port has
      // no bus wire, so upstream's bus-value/hex alternative (WireElm.java:
      // 97-104) never applies and the caption cannot conflict with it.
      const s = wireValueLabel(g, e);
      if (s) {
        let best = 0;
        let bestLen = -1;
        for (let i = 0; i < pts.length - 1; i++) {
          const len = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
          if (len > bestLen) {
            bestLen = len;
            best = i;
          }
        }
        labelOnSegment(g, pts[best], pts[best + 1], s);
      }
      return;
    }
    const [p1, p2] = endpoints(e);
    line(g, p1, p2, voltageColor(g, g.voltages[0]), 3, 'round');
    currentDots(g, p1, p2, g.current);
    // The caption clears the wire's own half-width, upstream's offset 4
    // (WireElm.java:103).
    label(g, e, wireValueLabel(g, e), 4);
  },
};
