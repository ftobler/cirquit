import {
  canvasFont,
  currentDotsFrom,
  elementLength,
  endpoints,
  formatValueShort,
  interp,
  lead,
  limbColor,
  polyline,
  voltageColor,
} from '../../../render/draw';
import { GRID_SIZE } from '../../types';
import { readParams, writeParams, boxOfPoints } from '../shared';
import type { CircuitElement, ElementDef, Point } from '../../types';

/** Posts for a stored width, upstream's setPoints (WattmeterElm.java:95-114):
 *  the two bottom stubs are offset perpendicular by `width` from the two axis
 *  ends, ordered so the lower-numbered (bottom) posts come first and get
 *  auto-grounded when unconnected. */
export function wattmeterPosts(e: CircuitElement): Point[] {
  const [p1, p2] = endpoints(e);
  const ds = p2.y === p1.y ? Math.sign(p2.x - p1.x) : -Math.sign(p2.y - p1.y);
  const width = e.params.width ?? GRID_SIZE;
  const p3 = interp(p1, p2, 0, -width * ds);
  const p4 = interp(p1, p2, 1, -width * ds);
  return [p3, p4, p1, p2];
}

/** The width a placement or post drag gives the wattmeter, upstream's drag()
 *  (WattmeterElm.java:75-89): the weaker of the two drag components becomes
 *  the width, the stronger one the body axis, floored at one grid square. */
export function wattmeterWidth(start: Point, pointer: Point): number {
  const w1 = Math.abs(pointer.y - start.y);
  const w2 = Math.abs(pointer.x - start.x);
  return Math.max(GRID_SIZE, w1 > w2 ? w2 : w1);
}

export const WATTMETER_DEF: ElementDef = {
  kind: 'wattmeter',
  label: 'Wattmeter',
  category: 'Other',
  dumpCode: '420',
  postCount: 4,
  posts: wattmeterPosts,
  defaults: { width: GRID_SIZE, meter: 0 },  // width >= gridSize (WattmeterElm.java:78-79)
  parse: (t, e) => readParams(t, e, ['width', 'meter']),
  dump: writeParams(['width', 'meter']),
  // The placement and post-drag paths call this with the drag start and the
  // snapped pointer, so the perpendicular component becomes the width before
  // the axis snap discards it (WattmeterElm.java:75-89).
  dragParams: (start, pointer) => ({ width: wattmeterWidth(start, pointer) }),
  fields: [
    {
      name: 'meter',
      label: 'Value',
      type: 'choice',
      choices: [
        { value: 0, label: 'Instantaneous' },
        { value: 1, label: 'Average' },
      ],
    },
  ],
  // The light-gray body rectangle is a solid pick zone; the four stubs to the
  // posts stay out of it, reached by their own posts (WattmeterElm.java:229).
  bodyRect: (e) => {
    const [p1, p2] = endpoints(e);
    const dn = elementLength(e);
    if (dn === 0) return { x0: 0, y0: 0, x1: 0, y1: 0 };
    const ds = p2.y === p1.y ? Math.sign(p2.x - p1.x) : -Math.sign(p2.y - p1.y);
    const width = e.params.width ?? GRID_SIZE;
    const r1 = interp(p1, p2, GRID_SIZE / dn, ds * GRID_SIZE);
    const r2 = interp(p1, p2, 1 - GRID_SIZE / dn, ds * GRID_SIZE);
    const r3 = interp(p1, p2, GRID_SIZE / dn, -ds * (GRID_SIZE + width));
    const r4 = interp(p1, p2, 1 - GRID_SIZE / dn, -ds * (GRID_SIZE + width));
    return boxOfPoints([r1, r2, r3, r4]);
  },
  draw(g, e) {
    const [p1, p2] = endpoints(e);
    const dn = elementLength(e);
    if (dn === 0) return;
    const sep = GRID_SIZE;
    const ds = p2.y === p1.y ? Math.sign(p2.x - p1.x) : -Math.sign(p2.y - p1.y);
    const width = e.params.width ?? GRID_SIZE;
    const posts = wattmeterPosts(e);

    // Stubs from each post to its inner point, with the per-channel current
    // dots (WattmeterElm.java:217-227).
    const inner = [
      interp(posts[0], posts[1], sep / dn),
      interp(posts[0], posts[1], 1 - sep / dn),
      interp(p1, p2, sep / dn),
      interp(p1, p2, 1 - sep / dn),
    ];
    for (let i = 0; i < 4; i++) {
      lead(g, posts[i], inner[i], limbColor(g, voltageColor(g, g.voltages[i])));
      if (g.postDotPhases[i] !== undefined) {
        currentDotsFrom(g, posts[i], inner[i], g.postCurrents[i], g.postDotPhases[i]);
      }
    }

    // The rectangle body between the inner stubs, light gray or the selection
    // colour when highlighted (WattmeterElm.java:229-230, :117-127).
    const r1 = interp(p1, p2, sep / dn, ds * sep);
    const r2 = interp(p1, p2, 1 - sep / dn, ds * sep);
    const r3 = interp(p1, p2, sep / dn, -ds * (sep + width));
    const r4 = interp(p1, p2, 1 - sep / dn, -ds * (sep + width));
    polyline(g, [r1, r2, r4, r3, r1], limbColor(g, g.theme.lightGray));

    // The power text, centred in the body and shrunk to fit (WattmeterElm.java:
    // 235-254).
    const center = interp(r1, r4, 0.5);
    const maxTextLen = Math.max(Math.abs(r1.x - r4.x) - 5, 5);
    const meter = e.params.meter ?? 0;
    const text = formatValueShort(g.value, meter === 1 ? 'W(avg)' : 'W', g.valueDigits);
    let fsize = 15;
    g.ctx.font = canvasFont(fsize);
    while (g.ctx.measureText(text).width >= maxTextLen && fsize > 1) {
      fsize -= 1;
      g.ctx.font = canvasFont(fsize);
    }
    g.ctx.fillStyle = g.theme.whiteColor;
    g.ctx.textAlign = 'center';
    g.ctx.textBaseline = 'middle';
    g.ctx.fillText(text, center.x, center.y);
  },
};
