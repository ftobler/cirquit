/** Background grid, drawn in circuit space before the elements. */

import { GRID_SIZE } from '../model/types';

export function drawGrid(
  ctx: CanvasRenderingContext2D,
  originX: number,
  originY: number,
  width: number,
  height: number,
  color: string,
  grid: number = GRID_SIZE,
): void {
  const startX = Math.floor(originX / grid) * grid;
  const startY = Math.floor(originY / grid) * grid;
  ctx.fillStyle = color;
  for (let x = startX; x < originX + width; x += grid) {
    for (let y = startY; y < originY + height; y += grid) {
      // The 1x1 dot is anchored half a pixel up-left of the grid intersection
      // so its centre sits exactly on the wire centreline (elements snap to
      // GRID_SIZE multiples in the same space, so anything else reads as a
      // half-pixel offset against the cursor crosshair). The cost of that
      // fractional anchor is that at devicePixelRatio 1 the dot anti-aliases
      // into a soft 2x2 blob at 25% alpha, the intended tradeoff; at dpr 2 it
      // lands squarely on device pixels as a solid 2x2 dot.
      ctx.fillRect(x - 0.5, y - 0.5, 1, 1);
    }
  }
}
