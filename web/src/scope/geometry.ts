/**
 * Scope geometry: width-derived capture sizing, time conversions and the
 * registered canvas widths.
 *
 * Everything here is pure except the width registry, which holds the measured
 * `clientWidth` per scope so the frame loop can size the engine ring without
 * reading the DOM itself. The registry is keyed by scope id and survives frame
 * redraws; the panel fills and clears it on mount and resize.
 */

export const MIN_SPEED = 1;
export const MAX_SPEED = 1024;
export const MIN_COLUMNS = 16;
export const MAX_COLUMNS = 8192;
/** Fallback width until a canvas is measured; the common starter scope size. */
export const DEFAULT_SCOPE_WIDTH = 500;

const widths = new Map<number, number>();

export function registerScopeWidth(id: number, width: number): void {
  widths.set(id, width);
}

export function unregisterScopeWidth(id: number): void {
  widths.delete(id);
}

export function scopeWidth(id: number): number | undefined {
  return widths.get(id);
}

/** Clamps a speed to the engine's 1..1024 range (Scope.java:1129-1136). */
export function scopeSpeed(speed: number): number {
  if (!Number.isFinite(speed)) return 64;
  return Math.min(MAX_SPEED, Math.max(MIN_SPEED, Math.round(speed)));
}

/** Next power of two `>= width`, clamped to the engine's ring bounds
 *  (Scope.resetGraph, Scope.java:187-193). */
export function scopeColumnCount(width: number): number {
  if (!Number.isFinite(width) || width <= 0) return MIN_COLUMNS;
  let n = 1;
  while (n < width) n *= 2;
  return Math.min(MAX_COLUMNS, Math.max(MIN_COLUMNS, n));
}

/** Simulated seconds the capture window spans (Scope.java:746). */
export function windowSeconds(columns: number, speed: number, timeStep: number): number {
  return columns * speed * timeStep;
}

/** Time at pixel `x`. Untriggered this anchors the right edge on `simT`;
 *  when a trigger has fired it anchors the trigger-stabilized window centre,
 *  `anchor.time` at the middle of the canvas (Scope.java:910-915). */
export function xToTime(
  x: number,
  simT: number,
  widthPx: number,
  speed: number,
  timeStep: number,
  anchor?: { time: number } | null,
): number {
  const ts = speed * timeStep;
  if (anchor) return anchor.time + ts * (x - widthPx / 2);
  return simT - ts * (widthPx - x);
}

/** Pixel of time `t`, the inverse of `xToTime` (Scope.java:971-976). */
export function timeToX(
  t: number,
  simT: number,
  widthPx: number,
  speed: number,
  timeStep: number,
  anchor?: { time: number } | null,
): number {
  const ts = speed * timeStep;
  if (anchor) return widthPx / 2 + (t - anchor.time) / ts;
  return widthPx - (simT - t) / ts;
}

/**
 * Which columns of a scope snapshot to draw on a `widthPx` canvas, one column
 * per pixel. Before the ring fills, the written columns draw left-aligned from
 * the origin; once it wraps, the most recent `widthPx` columns fill the
 * canvas. `writtenColumns` is the snapshot's column count (`data.length / 2`).
 */
export function visibleColumnRange(
  writtenColumns: number,
  widthPx: number,
): { start: number; count: number } {
  if (writtenColumns <= 0 || widthPx <= 0) return { start: 0, count: 0 };
  const count = Math.min(writtenColumns, widthPx);
  const start = writtenColumns > widthPx ? writtenColumns - widthPx : 0;
  return { start, count };
}
