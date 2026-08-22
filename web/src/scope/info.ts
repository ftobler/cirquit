/** The stacked text readouts drawn at the top-left of a scope canvas. */

import { canvasFont } from '../render/draw';

export interface InfoLine {
  text: string;
  color?: string;
  /** Pixel offset from the left edge; defaults to 4, the shared left margin.
   *  The measurement clusters set it so each trace's block sits beside the
   *  previous one. */
  x?: number;
  y: number;
}

/** Draws stacked info text at the given y positions. `defaultColor` is the
 *  scope's overlay text colour, upstream's `whiteColor`: every readout in
 *  ScopeOverlays.draw is drawn in it (ScopeOverlays.java:186-187), so it is
 *  white on the dark theme and black with White Background on. Passed in
 *  rather than defaulted here so a themeless call site cannot quietly go back
 *  to a dark-only literal. */
export function drawInfo(
  ctx: CanvasRenderingContext2D,
  lines: InfoLine[],
  h: number,
  defaultColor: string,
): void {
  ctx.font = canvasFont(10);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  for (const line of lines) {
    if (line.y < 0 || line.y >= h - 5) continue;
    ctx.fillStyle = line.color ?? defaultColor;
    ctx.fillText(line.text, line.x ?? 4, line.y);
  }
}
