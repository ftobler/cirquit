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
import { WIRE_SHOW_BUS_VALUE, WIRE_SHOW_BUS_VALUE_HEX, WIRE_SHOW_CURRENT, WIRE_SHOW_VOLTAGE } from '../flags';
import { warnOnClamp } from '../shared';
import type { CircuitElement, DrawContext, ElementDef, Point } from '../../types';

/** The stored width token of a wire, 1 when absent. Lives here rather than in
 *  the width resolver so this file stays import-cycle-free: the resolver
 *  (model/busWidths.ts) reads the registry, which reads this def. */
export function storedBusWidth(e: CircuitElement): number {
  const raw = e.params.busWidth;
  if (raw === undefined || !Number.isFinite(raw)) return 1;
  return Math.min(32, Math.max(1, Math.trunc(raw)));
}

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

/** The bus value caption: the integer the bit levels form, decimal and/or hex
 *  per the Show Bus Value checkboxes (WireElm.getBusValue and the draw
 *  branches, WireElm.java:72-78, 91-96). Bit i reads terminal i's level
 *  against the logic threshold, the same rule every wide pin uses; `voltages`
 *  must therefore be indexed by the resolved width, which is what
 *  `postsForRender` guarantees. */
export function busValueLabel(voltages: number[], flags: number, width: number): string {
  let value = 0;
  for (let i = 0; i < width; i++) {
    if ((voltages[i] ?? 0) > 2.5) value |= 1 << i;
  }
  let s = '';
  if (flags & WIRE_SHOW_BUS_VALUE) s = String(value);
  if (flags & WIRE_SHOW_BUS_VALUE_HEX) {
    s = (s.length > 0 ? s + ' ' : '') + '0x' + value.toString(16).toUpperCase();
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
  posts: (e) => {
    // A bus wire presents one terminal per bit at each endpoint, all N at
    // each coordinate exactly like upstream's getPost (WireElm.java:43-49).
    // The engine tags those coincident terminals with their bit index and
    // keeps them separate nodes.
    const n = storedBusWidth(e);
    if (n === 1) {
      return [
        { x: e.x1, y: e.y1 },
        { x: e.x2, y: e.y2 },
      ];
    }
    const posts: Point[] = [];
    for (let i = 0; i < n; i++) posts.push({ x: e.x1, y: e.y1 });
    for (let i = 0; i < n; i++) posts.push({ x: e.x2, y: e.y2 });
    return posts;
  },
  defaultLength: 4,  // 64 px, upstream's default getDragLength()
  // The show-current/show-voltage bits ride the generic `flags` token; the
  // optional trailing width token is this port's extension (upstream's text
  // format never saves a wire's busWidth, it re-derives it from topology on
  // every analysis). Absent means plain.
  parse: (t, e, warn) => {
    if (t[0] === undefined) return;
    const raw = Number(t[0]);
    if (!Number.isFinite(raw)) return;
    const clamped = Math.min(32, Math.max(1, Math.trunc(raw)));
    warnOnClamp(warn, 'Wire', 'busWidth', raw, clamped);
    if (clamped > 1) e.params.busWidth = clamped;
    else delete e.params.busWidth;
  },
  dump: (e) => {
    const n = storedBusWidth(e);
    return n > 1 ? [n] : [];
  },
  fields: [
    { name: 'showCurrent', label: 'Show Current', type: 'bool', flag: WIRE_SHOW_CURRENT },
    { name: 'showVoltage', label: 'Show Voltage', type: 'bool', flag: WIRE_SHOW_VOLTAGE },
    { name: 'showBusValue', label: 'Show Bus Value', type: 'bool', flag: WIRE_SHOW_BUS_VALUE },
    {
      name: 'showBusValueHex',
      label: 'Show Bus Value (Hex)',
      type: 'bool',
      flag: WIRE_SHOW_BUS_VALUE_HEX,
    },
  ],
  draw(g, e) {
    // The effective width: the saved token widened by whatever the frame
    // loop resolved from the surrounding wide pins (DrawContext.busWidth).
    const width = Math.max(storedBusWidth(e), g.busWidth ?? 1);
    const weight = width > 1 ? 5 : 3;
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
        // Upstream draws with drawThickLine, weight 5 for a bus
        // (RoutedWireElm.java:282, WireElm.java:87).
        line(g, pts[i], pts[i + 1], color, weight, 'round');
      }
      currentDotsPath(g, pts, g.current);
      // The routed wire shows the same caption as a plain one, on its longest
      // segment (RoutedWireElm.java:307-347); a wide wire swaps it for the
      // bus value (RoutedWireElm.java:301-305).
      const s = width > 1 ? busValueLabel(g.voltages, e.flags, width) : wireValueLabel(g, e);
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
    line(g, p1, p2, voltageColor(g, g.voltages[0]), weight, 'round');
    currentDots(g, p1, p2, g.current);
    // The caption clears the wire's own half-width, upstream's offset 4
    // (WireElm.java:103).
    const s = width > 1 ? busValueLabel(g.voltages, e.flags, width) : wireValueLabel(g, e);
    label(g, e, s, 4);
  },
};
