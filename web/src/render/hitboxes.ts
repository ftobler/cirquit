/**
 * The hitbox debug overlay: draws the regions the pointer picker measures
 * against, so a mis-pick can be seen instead of guessed at. Every shape comes
 * from `hitRegions`, the same function `distanceToElement` walks. Nothing here
 * recomputes pick geometry: an overlay that drew its own idea of the hitboxes
 * would lie exactly when it is needed most.
 *
 * Draw-only. It reads elements and the view scale and touches nothing else.
 */

import type { Box, CircuitElement, Point } from '../model/types';
import { hitRegions } from './geometry';

/** One hue per region category, so the overlay says which shape grabbed the
 *  click. Fixed debug colours rather than theme tokens: they must stay
 *  recognisable and mutually distinct in both themes, and they are never part
 *  of the schematic itself. */
export const HITBOX_COLORS: Record<'post' | 'axis' | 'wire' | 'body' | 'switch', string> = {
  post: '#00b8d4',  // terminal grab circles
  axis: '#ff9100',  // the body axis band between the stored endpoints
  wire: '#00c853',  // routed wire segment bands
  body: '#ff1744',  // a solid pick zone (chips, capacitor, voltage, lamp)
  switch: '#ff1744',  // an interactive part's lever rect, same pink as the bodies
};

/** Alpha for the whole overlay, low enough to read the schematic through it. */
const HITBOX_ALPHA = 0.7;

/** The outline of every point within `r` of the segment `a`-`b`: a capsule,
 *  two half-circle caps joined by the offset sides. Drawing the segment plus a
 *  radius as a fat line would be a different shape from the one the distance
 *  test uses; this is the exact level set. A zero-length segment degenerates
 *  to a circle, which is also correct. */
function strokeCapsule(ctx: CanvasRenderingContext2D, a: Point, b: Point, r: number): void {
  const angle = Math.atan2(b.y - a.y, b.x - a.x);
  ctx.beginPath();
  ctx.arc(a.x, a.y, r, angle + Math.PI / 2, angle - Math.PI / 2);
  ctx.arc(b.x, b.y, r, angle - Math.PI / 2, angle + Math.PI / 2);
  ctx.closePath();
  ctx.stroke();
}

/** The outline of every point within `r` of `box`: the box grown by `r` with
 *  quarter-circle corners, which is what `distanceToBox` measures. Normalises
 *  the corners first, so a def may hand them out in any order. */
function strokeGrownBox(ctx: CanvasRenderingContext2D, box: Box, r: number): void {
  const x0 = Math.min(box.x0, box.x1);
  const x1 = Math.max(box.x0, box.x1);
  const y0 = Math.min(box.y0, box.y1);
  const y1 = Math.max(box.y0, box.y1);
  const half = Math.PI / 2;
  ctx.beginPath();
  ctx.moveTo(x0, y0 - r);
  ctx.lineTo(x1, y0 - r);
  ctx.arc(x1, y0, r, -half, 0);
  ctx.lineTo(x1 + r, y1);
  ctx.arc(x1, y1, r, 0, half);
  ctx.lineTo(x0, y1 + r);
  ctx.arc(x0, y1, r, half, Math.PI);
  ctx.lineTo(x0 - r, y0);
  ctx.arc(x0, y0, r, Math.PI, Math.PI + half);
  ctx.closePath();
  ctx.stroke();
}

/**
 * Draws every element's pick geometry. `reach` is the circuit-space slop the
 * picker allows (`HIT_TOLERANCE_PX / view.scale`), so each region is drawn
 * grown by exactly the distance that still counts as a hit; `lineWidth` is
 * likewise in circuit units, so the caller can ask for a hairline at any zoom.
 * Runs inside the view transform, alongside the element draw pass.
 */
export function drawHitboxes(
  ctx: CanvasRenderingContext2D,
  elements: readonly CircuitElement[],
  reach: number,
  lineWidth: number,
): void {
  ctx.save();
  ctx.globalAlpha = HITBOX_ALPHA;
  ctx.lineWidth = lineWidth;
  ctx.setLineDash([]);
  for (const e of elements) {
    for (const region of hitRegions(e)) {
      ctx.strokeStyle = HITBOX_COLORS[region.type];
      if (region.type === 'post') {
        ctx.beginPath();
        ctx.arc(region.x, region.y, reach, 0, Math.PI * 2);
        ctx.stroke();
      } else if (region.type === 'body' || region.type === 'switch') {
        // Every solid pick zone draws the same rounded, reach-grown level set:
        // the box grown by `reach` with quarter-circle corners, the exact shape
        // `distanceToBox` measures. A sharp rect would lie about the corners,
        // where a click up to `reach` away diagonally still counts as a hit.
        strokeGrownBox(ctx, region.box, reach);
      } else {
        strokeCapsule(ctx, region.a, region.b, reach);
      }
    }
  }
  ctx.restore();
}
