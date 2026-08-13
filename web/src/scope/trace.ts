/**
 * Trace geometry: the continuous polyline that joins a scope trace's min/max
 * columns. Pure and DOM-free; `draw.ts` strokes the points it returns.
 */

/** A point of the continuous trace polyline. */
export interface TracePoint {
  x: number;
  y: number;
}

/** The drawn window over a snapshot's columns (`draw.ts`'s `Window`). */
export interface TraceWindow {
  count: number;
  /** Pixel offset of drawn column 0; 0 when the window fills the canvas or is
   *  trigger-anchored, positive before the ring wraps so the newest column
   *  sits at the right edge. */
  xOffset: number;
  posOf: (k: number) => number;
}

/** The subset of the vertical transform `tracePolyline` needs (`draw.ts`'s
 *  `PlotTransform` is structurally compatible). */
export interface TraceTransform {
  gridMid: number;
  gridMult: number;
  positionOffset: number;
}

/** The continuous midline polyline across the drawn window: one point per
 *  drawn column, at the midpoint of that column's min/max, mapped to pixels.
 *  A column with no data (`posOf` returns -1) yields `null`, which breaks the
 *  path so a partial ring never connects across the blank region. */
export function tracePolyline(
  data: Float32Array,
  win: TraceWindow,
  t: TraceTransform,
  maxy: number,
): (TracePoint | null)[] {
  const points: (TracePoint | null)[] = [];
  for (let k = 0; k < win.count; k++) {
    const pos = win.posOf(k);
    if (pos < 0) {
      points.push(null);
      continue;
    }
    const mid = (data[pos * 2] + data[pos * 2 + 1]) / 2;
    points.push({
      x: win.xOffset + k + 0.5,
      y: maxy - t.gridMult * (mid - t.gridMid + t.positionOffset),
    });
  }
  return points;
}
