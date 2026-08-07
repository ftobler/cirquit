/** Pure store helpers: grid snapping, dirty tracking and element construction. */

import { defFor, toolboxEntry } from '../model/registry';
import { GRID_SIZE } from '../model/types';

/** Rounds a coordinate to the nearest grid intersection. */
export function snap(v: number): number {
  return Math.round(v / GRID_SIZE) * GRID_SIZE;
}

/** True when reloading the page would lose edits since the last export. */
export function hasUnsavedChanges(lastSaved: string | null, current: string): boolean {
  return lastSaved !== null && current !== lastSaved;
}

/** Builds a new element of `kind` spanning the given points. Coordinates are
 *  rounded so the store invariant "every stored endpoint is an integer" holds
 *  regardless of caller. */
export function makeElement(kind: string, x1: number, y1: number, x2: number, y2: number) {
  const def = defFor(kind);
  return {
    kind,
    x1: Math.round(x1),
    y1: Math.round(y1),
    x2: Math.round(x2),
    y2: Math.round(y2),
    // The per-kind default flags are part of the file format: a new voltage
    // source must save FLAG_SHOW_VOLTAGE or upstream loads it with the value
    // hidden, and so on. Unknown kinds default to 0.
    flags: def?.defaultFlags ?? 0,
    params: { ...(def?.defaults ?? {}) },
    state: def?.interactive ? 0 : undefined,
  };
}

/** Builds a new element from a toolbox tool id, which may carry its own
 *  defaults on top of the kind's (the NPN/PNP and N-/P-channel splits). */
export function makeToolElement(tool: string, x1: number, y1: number, x2: number, y2: number) {
  const entry = toolboxEntry(tool);
  const def = defFor(entry.kind);
  return {
    kind: entry.kind,
    x1: Math.round(x1),
    y1: Math.round(y1),
    x2: Math.round(x2),
    y2: Math.round(y2),
    flags: def?.defaultFlags ?? 0,
    params: { ...(def?.defaults ?? {}), ...(entry.defaults ?? {}) },
    state: def?.interactive ? 0 : undefined,
  };
}
