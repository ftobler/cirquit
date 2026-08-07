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
      ctx.fillRect(x, y, 1, 1);
    }
  }
}
