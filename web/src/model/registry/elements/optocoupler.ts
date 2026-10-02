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
  currentDotsFrom,
  line,
  voltageColor,
} from '../../../render/draw';
import { CHIP_FLIP_X, CHIP_FLIP_Y } from './dFlipFlop';
import { drawDiodeBody } from './diode';
import { TRANSISTOR_DEF } from './transistor';
import { TRANSISTOR_FLIP } from '../flags';
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

/** The optocoupler's inner parts, laid out as upstream places its composite
 *  children (OptocouplerElm.java:150-157): the LED a vertical diode from
 *  post 0 to post 1, inset 32 toward the body, so it points from anode to
 *  cathode; the phototransistor a 16-unit horizontal NPN on the midline of
 *  the east posts, inset 24..40, whose collector and emitter sit level with
 *  posts 2 and 3. FLAG_FLIP_Y flips the transistor so its collector follows
 *  post 2. Each post wires straight across to its inner terminal. */
export function optoGeometry(e: CircuitElement): {
  posts: Point[];
  led: CircuitElement;
  phototransistor: CircuitElement;
  inner: Point[];
} {
  const posts = optoPosts(e);
  const dx = (e.flags & CHIP_FLIP_X) !== 0 ? -1 : 1;
  const midp = (posts[2].y + posts[3].y) / 2;
  const led: CircuitElement = {
    id: e.id,
    kind: 'diode',
    x1: posts[0].x + 32 * dx,
    y1: posts[0].y,
    x2: posts[1].x + 32 * dx,
    y2: posts[1].y,
    flags: 0,
    params: {},
  };
  const phototransistor: CircuitElement = {
    id: e.id,
    kind: 'transistor',
    x1: posts[2].x - 40 * dx,
    y1: midp,
    x2: posts[2].x - 24 * dx,
    y2: midp,
    flags: (e.flags & CHIP_FLIP_Y) !== 0 ? TRANSISTOR_FLIP : 0,
    params: { pnp: 1 },
  };
  const [, coll, emit] = TRANSISTOR_DEF.posts(phototransistor);
  const inner = [
    { x: led.x1, y: led.y1 },
    { x: led.x2, y: led.y2 },
    coll,
    emit,
  ];
  return { posts, led, phototransistor, inner };
}

function drawOptocoupler(g: DrawContext, e: CircuitElement): void {
  const { posts, led, phototransistor, inner } = optoGeometry(e);
  const dx = (e.flags & CHIP_FLIP_X) !== 0 ? -1 : 1;

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

  // Each post wires across to its inner terminal, voltage-coloured and
  // carrying its own terminal current (OptocouplerElm.java:93-99). The
  // phototransistor's own dot runs are off below, so these are its only ones.
  for (let i = 0; i < 4; i++) {
    line(g, posts[i], inner[i], voltageColor(g, g.voltages[i]));
    currentDotsFrom(g, inner[i], posts[i], g.postCurrents[i] ?? 0, g.postDotPhases[i] ?? 0);
  }

  // The children draw with the port's own diode and transistor symbols, fed
  // the slice of this element's terminal state each one owns. The LED's
  // current is post 0's, sign-flipped as for any two-terminal part; the
  // phototransistor's base is internal, so it gets the emitter voltage and no
  // current.
  drawDiodeBody(
    {
      ...g,
      voltages: [g.voltages[0], g.voltages[1]],
      current: -(g.postCurrents[0] ?? 0),
      dotPhase: g.postDotPhases[0] ?? g.dotPhase,
    },
    led,
    false,
  );
  TRANSISTOR_DEF.draw(
    {
      ...g,
      voltages: [g.voltages[3], g.voltages[2], g.voltages[3]],
      postCurrents: [0, 0, 0],
      postDotPhases: [0, 0, 0],
      showCurrent: false,
    },
    phototransistor,
  );

  // The light: two short arrows from the LED across to the phototransistor
  // (OptocouplerElm.java:105-114), 10 units apart about the LED's midline.
  const sx = led.x1 + 4 * dx;
  const sy = (led.y1 + led.y2) / 2;
  for (const y of [sy - 5, sy + 5]) {
    const from = { x: sx, y };
    const tip = { x: sx + 18 * dx, y };
    line(g, from, { x: tip.x - 4 * dx, y }, g.theme.lightGray, 1);
    arrowHead(g, from, tip, 5, g.theme.lightGray);
  }
}

export const OPTOCOUPLER_DEF: ElementDef = {
  kind: 'optocoupler',
  label: 'Optocoupler',
  category: 'Semiconductors',
  dumpCode: '407',
  postCount: 4,
  posts: optoPosts,
  // The fixed 2x2 body at full spacing that flipX shifts by (the hardcoded
  // 3*cspc2 of OptocouplerElm.java:167).
  chipExtents: () => ({ sx: 2, sy: 2 }),
  canMirror: true,  // OptocouplerElm.java:165-180
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
