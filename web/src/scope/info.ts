/** The stacked text readouts drawn at the top-left of a scope canvas. */

import { canvasFont } from '../render/draw';

export interface InfoLine {
  text: string;
  color?: string;
  y: number;
}

/** Draws stacked info text at the given y positions. */
export function drawInfo(ctx: CanvasRenderingContext2D, lines: InfoLine[], h: number): void {
  ctx.font = canvasFont(10);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  for (const line of lines) {
    if (line.y < 0 || line.y >= h - 5) continue;
    ctx.fillStyle = line.color ?? '#8b949e';
    ctx.fillText(line.text, 4, line.y);
  }
}
