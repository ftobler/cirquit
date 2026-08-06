/** Background grid, drawn in circuit space before the elements. */

import { GRID_SIZE } from '../model/types';

export function drawGrid(
  ctx: CanvasRenderingContext2D,
  originX: number,
  originY: number,
  width: number,
  height: number,
  color: string,
): void {
  const startX = Math.floor(originX / GRID_SIZE) * GRID_SIZE;
  const startY = Math.floor(originY / GRID_SIZE) * GRID_SIZE;
  ctx.fillStyle = color;
  for (let x = startX; x < originX + width; x += GRID_SIZE) {
    for (let y = startY; y < originY + height; y += GRID_SIZE) {
      ctx.fillRect(x, y, 1, 1);
    }
  }
}
