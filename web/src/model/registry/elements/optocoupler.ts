/**
 * Optocoupler (OptocouplerElm.java, dump 407): an LED optically coupled to a
 * phototransistor, built as a composite inside the engine. The frontend draws
 * the chip housing with the LED and phototransistor symbols.
 *
 * Token layout after the common fields is one `_`-joined dump token per
 * composite child, the OTA's shape, but the children are rebuilt from
 * defaults on load upstream (OptocouplerElm.java:29-34), so the tokens are
 * opaque on both sides and only the trailing `ctr` scale factor is
 * interpreted. The port appends `ctr` so a set scale survives a save;
 * upstream's own text dump drops it.
 *
 * The geometry is a fixed 2x2 chip anchored at `point1` (OptocouplerElm.java:
 * 125-159): the four posts at the four corners of the body, and the whole body
 * mirrors through FLAG_FLIP_X/Y (the ChipElm bits, OptocouplerElm.java:
 * 161-162).
 */

import {
  arrowHead,
  closedPolyline,
  line,
  voltageColor,
} from '../../../render/draw';
import { CHIP_FLIP_X, CHIP_FLIP_Y } from './dFlipFlop';
import { boxOfPoints } from '../shared';
import type { CircuitElement, DrawContext, ElementDef, Point } from '../../types';

const cspc = 16;
const cspc2 = 32;
const sizeX = 2;
const sizeY = 2;
const xs = sizeX * cspc2;
const ys = sizeY * cspc2 - cspc;

/** The four posts, the fixed setPin offsets of OptocouplerElm.java:145-148
 *  with the flip handling of :185-204. The body is anchored at `point1`, so
 *  the posts are always the same offsets from it. */
function optoPosts(e: CircuitElement): Point[] {
  const flipX = (e.flags & CHIP_FLIP_X) !== 0;
  const flipY = (e.flags & CHIP_FLIP_Y) !== 0;
  const x0 = e.x1 + cspc2;
  const y0 = e.y1;
  const setPin = (
    n: number,
    px: number,
    py: number,
    dx: number,
    dy: number,
    dax: number,
    day: number,
    sx: number,
    sy: number,
  ): Point => {
    const pos = n % 2;
    if (flipX) {
      dx = -dx;
      dax = -dax;
      px += cspc2;
      sx = -sx;
    }
    if (flipY) {
      dy = -dy;
      day = -day;
      py += cspc2;
      sy = -sy;
    }
    const xa = px + cspc2 * dx * pos + sx;
    const ya = py + cspc2 * dy * pos + sy;
    return { x: xa + dax * cspc2, y: ya + day * cspc2 };
  };
  return [
    setPin(0, x0, y0, 0, 1, -1, 0, 0, 0),
    setPin(1, x0, y0, 0, 1, -1, 0, 0, 0),
    setPin(2, x0, y0, 0, 1, 1, 0, xs - cspc2, 0),
    setPin(3, x0, y0, 0, 1, 1, 0, xs - cspc2, 0),
  ];
}

function drawOptocoupler(g: DrawContext, e: CircuitElement): void {
  const posts = optoPosts(e);
  const dx = (e.flags & CHIP_FLIP_X) !== 0 ? -1 : 1;
  const midp = (posts[2].y + posts[3].y) / 2;

  // The housing, a stroked rect (OptocouplerElm.java:89-90, 133-139).
  const xr = e.x1 + cspc2 - cspc;
  const yr = e.y1 - cspc / 2;
  const body: Point[] = [
    { x: xr, y: yr },
    { x: xr + xs, y: yr },
    { x: xr + xs, y: yr + ys },
    { x: xr, y: yr + ys },
  ];
  closedPolyline(g, body, g.theme.lightGray);

  // The four corner stubs, each voltage-coloured (OptocouplerElm.java:93-99).
  const stub0 = { x: posts[0].x + cspc, y: posts[0].y };
  const stub1 = { x: posts[1].x + cspc, y: posts[1].y };
  const stub2 = { x: posts[2].x - cspc, y: posts[2].y };
  const stub3 = { x: posts[3].x - cspc, y: posts[3].y };
  line(g, posts[0], stub0, voltageColor(g, g.voltages[0]));
  line(g, posts[1], stub1, voltageColor(g, g.voltages[1]));
  line(g, posts[2], stub2, voltageColor(g, g.voltages[2]));
  line(g, posts[3], stub3, voltageColor(g, g.voltages[3]));

  // The LED between the two west stubs, inset 32 beyond the housing edge
  // (OptocouplerElm.java:150): the triangle pointing into the body with the
  // cathode bar, the port's usual diode symbol at body weight.
  const ledA = { x: posts[0].x + 32 * dx, y: posts[0].y };
  const ledK = { x: posts[1].x + 32 * dx, y: posts[1].y };
  line(g, stub0, ledA, voltageColor(g, g.voltages[0]));
  line(g, stub1, ledK, voltageColor(g, g.voltages[1]));
  const ledColour = g.theme.wire;
  line(g, { x: ledA.x, y: ledA.y - 8 }, { x: ledA.x, y: ledA.y + 8 }, ledColour);
  const [barA, barK] = [
    { x: ledK.x - 8, y: ledK.y },
    { x: ledK.x + 8, y: ledK.y },
  ];
  line(g, ledA, { x: ledK.x, y: ledK.y - 8 }, ledColour);
  line(g, ledA, { x: ledK.x, y: ledK.y + 8 }, ledColour);
  line(g, barA, barK, ledColour);

  // The phototransistor between the two east stubs, inset 24..40 beyond the
  // housing (OptocouplerElm.java:156): a bar with the emitter arrow.
  const tA = { x: posts[2].x - 40 * dx, y: midp };
  const tB = { x: posts[2].x - 24 * dx, y: midp };
  line(g, stub2, tA, voltageColor(g, g.voltages[2]));
  line(g, stub3, tA, voltageColor(g, g.voltages[3]));
  line(g, { x: tA.x, y: tA.y - 8 }, { x: tA.x, y: tA.y + 8 }, g.theme.wire);
  line(g, tA, { x: tB.x, y: tB.y - 8 }, g.theme.wire);
  line(g, tA, { x: tB.x, y: tB.y + 8 }, g.theme.wire);
  line(g, tB, { x: tB.x, y: tB.y + 6 }, g.theme.wire);
  arrowHead(g, { x: tB.x - 8, y: tB.y + 6 }, { x: tB.x, y: tB.y + 6 }, 8, g.theme.wire);
}

export const OPTOCOUPLER_DEF: ElementDef = {
  kind: 'optocoupler',
  label: 'Optocoupler',
  category: 'Semiconductors',
  dumpCode: '407',
  postCount: 4,
  posts: optoPosts,
  noDiagonal: true,  // OptocouplerElm.java:23, 32
  // The child dump tokens are raw on both sides (the OTA's shape); the
  // trailing `ctr` token is the only interpreted field. A line without one
  // (upstream's own text saves never write it) keeps the default 1.0.
  rawTokens: true,
  defaults: { ctr: 1 },
  parse: (t, e) => {
    // The child dumps always carry a `_` (flags plus fields); only the
    // port's appended ctr scale is a bare number, so a last plain-number
    // token is the ctr and everything before it the child dumps. An upstream
    // line without one keeps the default.
    const n = t.length;
    const last = t[n - 1];
    const ctr = last === undefined || last.includes('_') ? NaN : Number(last);
    e.model = Number.isFinite(ctr) ? t.slice(0, n - 1) : t;
    if (Number.isFinite(ctr)) e.params.ctr = ctr;
  },
  dump: (e) => [...(Array.isArray(e.model) ? e.model : []), e.params.ctr ?? 1],
  fields: [{ name: 'ctr', label: 'CTR Scale', min: 1 }],
  // The housing rectangle is a solid pick zone (OptocouplerElm.java:133-139);
  // the LED and phototransistor sit inside it.
  bodyRect: (e) => {
    const xr = e.x1 + cspc2 - cspc;
    const yr = e.y1 - cspc / 2;
    return boxOfPoints([
      { x: xr, y: yr },
      { x: xr + xs, y: yr + ys },
    ]);
  },
  draw: drawOptocoupler,
};
