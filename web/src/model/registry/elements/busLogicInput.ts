/**
 * The bus logic input (BusLogicInputElm.java, XML type "bli"): an N-bit wide
 * logic driver. One part holds a word; bit i of it drives post i with hiV or
 * loV, and every post sits on the anchor coordinate carrying its own bus bit,
 * so a splitter's bus side or a bus wire meets all N bits at once. Clicking
 * cycles the word 0..2^N-1, upstream's `toggle()` (BusLogicInputElm.java:
 * 116-120).
 *
 * Upstream saves this class only in the XML format (its text dump type is 0),
 * so the port assigns dump code 435, free upstream and beside the other
 * port-assigned XML-era codes (the instruction display's 434).
 */

import { canvasFont, currentDots, elementLength, interp, line, limbColor, voltageColor } from '../../../render/draw';
import type { CircuitElement, DrawContext, ElementDef } from '../../types';

/** The bit count the engine accepts: truncated and clamped to the 2..32 its
 *  constructor enforces (bus_logic_input.rs). */
export function normalizeBusLogicInputWidth(value: number): number {
  if (!Number.isFinite(value)) return 4;
  return Math.min(32, Math.max(2, Math.trunc(value)));
}

function busWidth(e: CircuitElement): number {
  return normalizeBusLogicInputWidth(e.params.busWidth ?? 4);
}

/** The live word: the toggled session state wins over the file token, the
 *  same precedence every interactive part uses. */
export function busInputValue(e: CircuitElement): number {
  const raw = e.state ?? e.params.value ?? 0;
  const max = 2 ** Math.min(31, busWidth(e));
  return Math.max(0, Math.trunc(raw)) % max;
}

function drawBusLogicInput(g: DrawContext, e: CircuitElement): void {
  const p1 = { x: e.x1, y: e.y1 };
  const p2 = { x: e.x2, y: e.y2 };
  const dn = Math.max(1, elementLength(e));
  // A short thick lead from the anchor (drawThickLine at weight 5,
  // BusLogicInputElm.java:100), then the bold value at the drag end.
  const lead1 = interp(p1, p2, 1 - 12 / dn);
  line(g, p1, lead1, voltageColor(g, g.voltages[0]), 5, 'round');
  currentDots(g, lead1, p1, g.current);
  g.ctx.fillStyle = limbColor(g, g.theme.text);
  g.ctx.font = `bold ${canvasFont(20)}`;
  g.ctx.textAlign = 'center';
  g.ctx.textBaseline = 'middle';
  g.ctx.fillText(String(busInputValue(e)), p2.x, p2.y);
}

export const BUS_LOGIC_INPUT_DEF: ElementDef = {
  kind: 'busLogicInput',
  label: 'Bus logic input',
  category: 'Logic',
  dumpCode: '435',
  postCount: 4,  // the busWidth(4) default, for the fresh-part fallback
  postCountOf: (e) => busWidth(e),
  posts: (e) => {
    // Every pin shares the anchor, one per bit (getPost(n) = new Point(x, y,
    // n), BusLogicInputElm.java:61-63); the engine tags them with their bit.
    const n = busWidth(e);
    return Array.from({ length: n }, () => ({ x: e.x1, y: e.y1 }));
  },
  draggablePosts: 2,  // the value end is a control point, not a terminal
  noDiagonal: true,
  interactive: true,
  defaults: { busWidth: 4, hiV: 5, loV: 0 },
  parse: (t, e) => {
    // The port's own stream: width, word, then the two levels.
    const bw = Number(t[0]);
    if (Number.isFinite(bw)) e.params.busWidth = normalizeBusLogicInputWidth(bw);
    const va = Number(t[1]);
    if (Number.isFinite(va)) e.params.value = va;
    const hi = Number(t[2]);
    if (Number.isFinite(hi)) e.params.hiV = hi;
    const lo = Number(t[3]);
    if (Number.isFinite(lo)) e.params.loV = lo;
    e.state = e.params.value ?? 0;
  },
  // The word written is the live toggled state when present, falling back to
  // the file token: every other interactive part saves its session state this
  // way, and a click between save points would otherwise be lost.
  dump: (e) => [
    busWidth(e),
    busInputValue(e),
    e.params.hiV ?? 5,
    e.params.loV ?? 0,
  ],
  fields: [
    { name: 'busWidth', label: 'Bus Width', min: 2, max: 32, integer: true },
    { name: 'value', label: 'Value', integer: true },
    { name: 'hiV', label: 'High logic voltage', unit: 'V' },
    { name: 'loV', label: 'Low voltage', unit: 'V' },
  ],
  draw: drawBusLogicInput,
};
