/** The mouse-wheel value popover's pure session logic: opening, stepping,
 *  selection and revert. Kept out of the DOM so it is testable headlessly,
 *  mirroring upstream's `ScrollValuePopup` (ScrollValuePopup.java). */

import { e12Values } from './e12';

/** The editable primary physical field per scrollable element kind, matching
 *  upstream's `getEditInfo(0)` (ScrollValuePopup.java:112). */
export const SCROLLABLE_PARAMS: Record<string, string> = {
  resistor: 'resistance',
  capacitor: 'capacitance',
  inductor: 'inductance',
};

/** Wheel travel, in pixels, that moves the selection by one E12 step.
 *  Upstream's `ScrollValuePopup.scale` is 6 (ScrollValuePopup.java:187). */
export const WHEEL_STEP_DIVISOR = 6;

/** The primary physical field name for a scrollable kind, or undefined for
 *  kinds the popover does not serve. Transistors and MOSFETs use a different
 *  popup upstream (a model picker), which is out of scope here. */
export function scrollableParam(kind: string): string | undefined {
  return SCROLLABLE_PARAMS[kind];
}

/** One open popover session. Immutable; stepping spreads a new one. */
export interface ScrollValueSession {
  id: number;
  kind: string;
  param: string;
  /** Full candidate list, the current value spliced in if off-grid. */
  values: number[];
  /** Index of the value the session opened on; the popover highlights it. */
  index: number;
  /** The value a revert restores, the param's value on open. */
  original: number;
  /** Accumulated wheel travel in pixels, upstream's `deltaY`. */
  deltaY: number;
}

export function openScrollValue(
  kind: string,
  id: number,
  param: string,
  current: number,
): ScrollValueSession {
  const { values, index } = e12Values(kind, current);
  return { id, kind, param, values, index, original: current, deltaY: 0 };
}

/** Advance the session by one wheel event. `deltaY` is normalized to pixels
 *  so a notch means the same distance in every browser. */
export function stepScrollValue(session: ScrollValueSession, deltaY: number): ScrollValueSession {
  return { ...session, deltaY: session.deltaY + deltaY };
}

/** The highlighted slot, clamped to the list like upstream's `getSelIdx`
 *  (ScrollValuePopup.java:212-219). */
export function selectionIndex(session: ScrollValueSession): number {
  if (session.values.length === 0) return 0;
  const sel = session.index + Math.round(session.deltaY / WHEEL_STEP_DIVISOR);
  return Math.max(0, Math.min(session.values.length - 1, sel));
}

/** The value a commit writes for the current selection. */
export function selectionValue(session: ScrollValueSession): number {
  return session.values[selectionIndex(session)];
}

/** Normalize a browser wheel delta to pixels: line and page modes use other
 *  units, and without the conversion one notch would move the selection a
 *  different distance in every browser. */
export function wheelPixels(deltaY: number, deltaMode: number): number {
  if (deltaMode === 1) return deltaY * 16;
  if (deltaMode === 2) return deltaY * 100;
  return deltaY;
}

/** Milliseconds after a zoom during which the wheel stays zoom-only, so a
 *  sweep from empty canvas onto an element cannot accidentally edit a value
 *  (MouseManager.java:1302-1304). */
export const ZOOM_ONLY_WINDOW_MS = 1000;

/** Whether a wheel event at `now` must keep zooming because a zoom happened
 *  within `ZOOM_ONLY_WINDOW_MS` of `lastZoomAt`, exactly upstream's
 *  `System.currentTimeMillis() < zoomTime+1000` (MouseManager.java:1304). */
export function isZoomOnly(lastZoomAt: number | null, now: number): boolean {
  return lastZoomAt !== null && now < lastZoomAt + ZOOM_ONLY_WINDOW_MS;
}
