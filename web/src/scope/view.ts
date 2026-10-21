/**
 * The paused scope's zoom and pan through captured ring history.
 *
 * Kept apart from the horizontal time base (`scope.speed`, which the `o` line
 * carries): this is a viewer state that only applies while the simulation is
 * paused, so zooming time to inspect a capture never rewrites the saved
 * speed token or clears the ring. `zoom` is pixels per captured column;
 * `offsetColumns` is how far the window's right edge sits behind the newest
 * captured column, so 0 shows live data and larger values walk back in time.
 *
 * Pure except the per-scope map at the bottom, which mirrors scale.ts's sticky
 * state pattern so the draw loop and the pointer handlers share one session
 * value without a React re-render per wheel tick.
 */

export interface ScopeView {
  /** Pixels per captured column. 1 is the one-column-per-pixel default. */
  zoom: number;
  /** Columns between the newest capture and the window's right edge. */
  offsetColumns: number;
}

/** Zoom bounds: a quarter pixel per column keeps a whole capture legible, and
 *  sixteen pixels per column magnifies an edge to sample resolution. */
export const MIN_VIEW_ZOOM = 0.125;
export const MAX_VIEW_ZOOM = 16;

export const DEFAULT_SCOPE_VIEW: ScopeView = { zoom: 1, offsetColumns: 0 };

/** Clamps a wanted view into what `written` captured columns and `widthPx`
 *  pixels can show. A non-finite value falls back to the default component. */
export function clampView(view: ScopeView, written: number, widthPx: number): ScopeView {
  const zoom = Number.isFinite(view.zoom)
    ? Math.min(MAX_VIEW_ZOOM, Math.max(MIN_VIEW_ZOOM, view.zoom))
    : 1;
  const visible = visibleColumns({ zoom }, widthPx);
  const maxOffset = Math.max(0, written - visible);
  const offset = Number.isFinite(view.offsetColumns)
    ? Math.min(maxOffset, Math.max(0, view.offsetColumns))
    : 0;
  return { zoom, offsetColumns: offset };
}

/** How many captured columns fit across the canvas at this zoom. */
export function visibleColumns(view: Pick<ScopeView, 'zoom'>, widthPx: number): number {
  if (!(widthPx > 0) || !(view.zoom > 0)) return 0;
  return Math.min(widthPx, widthPx / view.zoom);
}

/** The view after dragging the trace `dxPx` pixels sideways: the content
 *  follows the pointer, so dragging right reveals older columns. */
export function panByPixels(
  view: ScopeView,
  dxPx: number,
  widthPx: number,
  written: number,
): ScopeView {
  if (!Number.isFinite(dxPx)) return view;
  return clampView(
    { zoom: view.zoom, offsetColumns: view.offsetColumns + dxPx / view.zoom },
    written,
    widthPx,
  );
}

/**
 * The view after zooming by `factor` about canvas `cursorX`: the captured
 * column under the pointer stays under it while the visible span grows or
 * shrinks.
 */
export function zoomAboutCursor(
  view: ScopeView,
  factor: number,
  cursorX: number,
  widthPx: number,
  written: number,
): ScopeView {
  if (!(factor > 0) || !Number.isFinite(factor) || !(widthPx > 0)) return view;
  const zoom = Math.min(MAX_VIEW_ZOOM, Math.max(MIN_VIEW_ZOOM, view.zoom * factor));
  // Column distance from the newest capture to the pointer, before and after.
  // Pixels from the right edge become columns by dividing by the zoom.
  const fromRightPx = Math.max(0, widthPx - cursorX);
  const fromRight = view.offsetColumns + fromRightPx / view.zoom;
  const offset = fromRight - fromRightPx / zoom;
  return clampView({ zoom, offsetColumns: offset }, written, widthPx);
}

/** Sim time at the window's right edge: sim time shifted back by the panned
 *  columns. One column spans `speed * timeStep` seconds. */
export function viewRightTime(
  simTime: number,
  view: ScopeView,
  speed: number,
  timeStep: number,
): number {
  return simTime - view.offsetColumns * speed * timeStep;
}

/** The effective seconds per column the draw uses: the time base divided by
 *  the zoom, so `xToTime`/`timeToX` keep working unchanged at a magnified
 *  scale. */
export function viewSpeed(view: ScopeView, speed: number): number {
  return view.zoom > 0 ? speed / view.zoom : speed;
}

/** Whether the view shows anything other than the live window. */
export function isPanned(view: ScopeView): boolean {
  return view.zoom !== 1 || view.offsetColumns !== 0;
}

/** A two-cursor readout: the time difference, its frequency and the value
 *  difference. Null pieces are omitted because the trace may have no sample
 *  at one of the cursor columns. Pure numbers, formatted by the caller. */
export interface CursorReadout {
  dt: number;
  hz: number | null;
  dv: number | null;
}

export function cursorReadout(
  timeA: number,
  timeB: number,
  valueA: number | null,
  valueB: number | null,
): CursorReadout {
  const dt = Math.abs(timeB - timeA);
  return {
    dt,
    // 1/dt for a pair at the same instant has no meaning.
    hz: dt > 0 ? 1 / dt : null,
    dv: valueA !== null && valueB !== null ? valueB - valueA : null,
  };
}

const views = new Map<number, ScopeView>();

export function viewFor(scopeId: number): ScopeView {
  return views.get(scopeId) ?? DEFAULT_SCOPE_VIEW;
}

export function setScopeView(scopeId: number, view: ScopeView): void {
  if (isPanned(view)) views.set(scopeId, view);
  else views.delete(scopeId);
}

/** Back to the live window (resuming, reset, or a fresh capture). */
export function resetScopeView(scopeId: number): void {
  views.delete(scopeId);
}

/** Drops views of scopes that no longer exist, like pruneScaleStates. */
export function pruneScopeViews(live: Iterable<number>): void {
  const keep = new Set(live);
  for (const id of views.keys()) {
    if (!keep.has(id)) views.delete(id);
  }
}
