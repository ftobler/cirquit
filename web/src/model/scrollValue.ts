/** The mouse-wheel value popover's pure session logic: opening, stepping,
 *  selection and revert. Kept out of the DOM so it is testable headlessly,
 *  mirroring upstream's `ScrollValuePopup` (ScrollValuePopup.java). */

import { e12Values, linearValues } from './e12';

/** The value ladder a scrollable kind's candidate list is built from. */
type Ladder = (current: number) => { values: number[]; index: number };

/** The editable primary physical field and its value ladder per scrollable
 *  element kind, the single place a future kind gets added. Resistor,
 *  capacitor and inductor are the three upstream's popup serves
 *  (ScrollValuePopup.java:90-101); the sources are not scrollable upstream at
 *  all, so stepping them 1 V / 1 mA is a deliberate extension of the owner's
 *  request, not a parity fix. */
export const SCROLLABLE_PARAMS: Record<string, { param: string; ladder: Ladder }> = {
  resistor: { param: 'resistance', ladder: (c) => e12Values('resistor', c) },
  capacitor: { param: 'capacitance', ladder: (c) => e12Values('capacitor', c) },
  inductor: { param: 'inductance', ladder: (c) => e12Values('inductor', c) },
  voltage: { param: 'maxVoltage', ladder: (c) => linearValues(1, c) },
  rail: { param: 'maxVoltage', ladder: (c) => linearValues(1, c) },
  varRail: { param: 'maxVoltage', ladder: (c) => linearValues(1, c) },
  current: { param: 'current', ladder: (c) => linearValues(1e-3, c) },
};

/** Wheel travel, in pixels, at or above which one wheel event is one discrete
 *  notch. 40 px sits below the smallest real notch (48 px for a 3-line
 *  Firefox notch, 100/120 px in Chrome's pixel mode) and above a single
 *  trackpad tick, so it separates the two gestures. Upstream divided
 *  accumulated pixels by 6 (`ScrollValuePopup.scale`, ScrollValuePopup.java:
 *  187), which a notch came out as 8-17 E12 steps; this port deliberately
 *  differs, the owner's statement is the spec: one step per notch. */
export const NOTCH_THRESHOLD = 40;

/** The primary physical field name for a scrollable kind, or undefined for
 *  kinds the popover does not serve. Transistors and MOSFETs use a different
 *  popup upstream (a model picker), which is out of scope here. */
export function scrollableParam(kind: string): string | undefined {
  return SCROLLABLE_PARAMS[kind]?.param;
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
  /** Whole steps from the opening index; fractional when `wheelSensitivity`
   *  is not a whole number. */
  steps: number;
  /** Sub-notch wheel travel in pixels toward the next step, upstream's
   *  accumulated `deltaY` only the part a notch has not consumed. */
  remainder: number;
}

export function openScrollValue(kind: string, id: number, current: number): ScrollValueSession {
  const entry = SCROLLABLE_PARAMS[kind];
  const { values, index } = entry ? entry.ladder(current) : { values: [], index: 0 };
  // The param is the table's own, not a caller's choice: the ladder and the
  // write target are coupled in SCROLLABLE_PARAMS, so deriving keeps them from
  // ever disagreeing.
  return { id, kind, param: entry?.param ?? '', values, index, original: current, steps: 0, remainder: 0 };
}

/** Advance the session by one wheel event. `deltaY` is normalized to pixels.
 *  `sensitivity` is `wheelSensitivity`, steps per notch, multiplied into the
 *  conversion like upstream's `getSelIdx` (ScrollValuePopup.java:214). */
export function stepScrollValue(
  session: ScrollValueSession,
  deltaY: number,
  sensitivity = 1,
): ScrollValueSession {
  // A discrete notch is one event at or above the notch threshold: exactly one
  // step per notch at the default sensitivity, in every browser and every
  // deltaMode, and the travel inside it is fully accounted for so the
  // remainder is dropped rather than double-counted later.
  if (Math.abs(deltaY) >= NOTCH_THRESHOLD) {
    return {
      ...session,
      steps: session.steps + Math.sign(deltaY) * sensitivity,
      remainder: 0,
    };
  }
  // Below the threshold an event is a trackpad tick: accumulate sub-notch
  // travel and emit a step per threshold crossing, so a continuous swipe steps
  // without firing per event. A sign flip resets the accumulator so a
  // reversing gesture acts immediately instead of unwinding the tail.
  const flipped =
    deltaY !== 0 &&
    Math.sign(session.remainder) !== 0 &&
    Math.sign(deltaY) !== Math.sign(session.remainder);
  const remainder = flipped ? deltaY : session.remainder + deltaY;
  const crossed = Math.floor(Math.abs(remainder) / NOTCH_THRESHOLD);
  return {
    ...session,
    steps: session.steps + Math.sign(remainder) * crossed * sensitivity,
    remainder: (Math.abs(remainder) % NOTCH_THRESHOLD) * Math.sign(remainder),
  };
}

/** The highlighted slot, clamped to the list like upstream's `getSelIdx`
 *  (ScrollValuePopup.java:212-219). */
export function selectionIndex(session: ScrollValueSession): number {
  if (session.values.length === 0) return 0;
  const sel = session.index + Math.round(session.steps);
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
