/**
 * Geometry of the floating scope panels: scopes taken out of the dock to sit
 * over the schematic as movable, resizable panels inside the app. Rects are
 * CSS pixels relative to the centre area (the schematic plus the dock), the
 * layer the panels are positioned in. Pure so the clamping and the drag maths
 * are testable without a DOM.
 */

export interface FloatRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Bounds {
  w: number;
  h: number;
}

/** Smallest panel that still fits a trace with its header and scale. */
export const MIN_FLOAT_W = 200;
export const MIN_FLOAT_H = 120;

/** A freshly floated panel's size. */
export const DEFAULT_FLOAT_W = 420;
export const DEFAULT_FLOAT_H = 240;

/** Height of the panel's title bar, the part that must stay reachable. */
export const FLOAT_TITLE_H = 24;

/** How much of a panel must stay inside the area horizontally, so it can
 *  always be grabbed back even when pushed mostly off one side. */
const KEEP_VISIBLE_W = 80;

/** Cascade step between successive new panels, so they do not stack exactly
 *  on top of each other. */
const CASCADE = 28;

/**
 * Keeps a panel usable inside `bounds`: at least the minimum size, no larger
 * than the area, its title bar never above the top or below the bottom, and
 * at least a grabbable strip of it inside horizontally. Unknown bounds (0,
 * before layout) only apply the minimum size.
 */
export function clampFloatRect(r: FloatRect, bounds: Bounds): FloatRect {
  const finite = (v: number, d: number) => (Number.isFinite(v) ? v : d);
  let w = Math.max(MIN_FLOAT_W, finite(r.w, DEFAULT_FLOAT_W));
  let h = Math.max(MIN_FLOAT_H, finite(r.h, DEFAULT_FLOAT_H));
  let x = finite(r.x, 0);
  // The title bar never goes above the area, known size or not.
  let y = Math.max(0, finite(r.y, 0));
  if (bounds.w > 0) {
    w = Math.min(w, Math.max(MIN_FLOAT_W, bounds.w));
    x = Math.min(Math.max(x, KEEP_VISIBLE_W - w), bounds.w - KEEP_VISIBLE_W);
  }
  if (bounds.h > 0) {
    h = Math.min(h, Math.max(MIN_FLOAT_H, bounds.h));
    y = Math.min(y, Math.max(0, bounds.h - FLOAT_TITLE_H));
  }
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

/** Where the `index`-th floating panel first appears: the top-right corner of
 *  the schematic, cascading down and left so each new one stays visible. */
export function defaultFloatRect(index: number, bounds: Bounds): FloatRect {
  const step = (index % 6) * CASCADE;
  const x = bounds.w > 0 ? bounds.w - DEFAULT_FLOAT_W - 16 - step : 16 + step;
  return clampFloatRect(
    { x, y: 16 + step, w: DEFAULT_FLOAT_W, h: DEFAULT_FLOAT_H },
    bounds,
  );
}

/** The rect after dragging the title bar by (dx, dy) from `start`. */
export function movedRect(start: FloatRect, dx: number, dy: number, bounds: Bounds): FloatRect {
  return clampFloatRect({ ...start, x: start.x + dx, y: start.y + dy }, bounds);
}

/** The rect after dragging the bottom-right grip by (dx, dy) from `start`.
 *  The top-left corner stays put; the size stops at the area's edge. */
export function resizedRect(start: FloatRect, dx: number, dy: number, bounds: Bounds): FloatRect {
  let w = Math.max(MIN_FLOAT_W, start.w + dx);
  let h = Math.max(MIN_FLOAT_H, start.h + dy);
  if (bounds.w > 0) w = Math.min(w, Math.max(MIN_FLOAT_W, bounds.w - start.x));
  if (bounds.h > 0) h = Math.min(h, Math.max(MIN_FLOAT_H, bounds.h - start.y));
  return { ...start, w: Math.round(w), h: Math.round(h) };
}
