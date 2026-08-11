/** Pure store helpers: grid snapping, dirty tracking and element construction. */

import { defFor, toolboxEntry } from '../model/registry';
import { GRID_SIZE } from '../model/types';
import { getModel, modelToEngineSpec } from '../io/subcircuits';
import type { CompositeEngineSpec } from '../io/netlist/types';

/** Rounds a coordinate to the nearest grid intersection. `grid` defaults to
 *  the full-size grid so existing call sites keep their 16-unit step. */
export function snap(v: number, grid: number = GRID_SIZE): number {
  return Math.round(v / grid) * grid;
}

/** True when reloading the page would lose edits since the last export. */
export function hasUnsavedChanges(lastSaved: string | null, current: string): boolean {
  return lastSaved !== null && current !== lastSaved;
}

/** A `lastSaved` value that can never equal a serialised netlist, which always
 *  opens with the `$` header line, so `hasUnsavedChanges` always reports dirty.
 *  `recoverAutoSave` stores it: a recovered circuit has never been exported,
 *  matching upstream's allowSave(false) after a recover (UndoManager.java:87),
 *  and `loadNetlist` would otherwise baseline it as clean. */
export const RECOVERED_UNSAVED = '\u0000';

/** Placement-time model resolution. `parseCircuit` is deliberately pure, so a
 *  custom-composite element can only resolve its model name against the
 *  session/storage library here, at placement: a name the merged library
 *  holds becomes the `CompositeEngineSpec` the engine parses, the same payload
 *  the netlist second pass fills for a loaded file's `.` line. A miss leaves
 *  the part on its fallback body with the name intact. The paste and duplicate
 *  paths map inserted elements through this too, so a part whose `.` line did
 *  not travel with the text (a duplicate of a document-defined model, a copy
 *  of a library-only one) still simulates. */
export function resolveCompositeModel<T extends { kind: string; text?: string }>(
  e: T,
): T & { model?: CompositeEngineSpec } {
  if (e.kind !== 'customComposite' || e.text === undefined) return e;
  const model = getModel(e.text);
  if (model === undefined) return e;
  return { ...e, model: modelToEngineSpec(model) };
}

/** Builds a new element of `kind` spanning the given points. Coordinates are
 *  rounded so the store invariant "every stored endpoint is an integer" holds
 *  regardless of caller. */
export function makeElement(kind: string, x1: number, y1: number, x2: number, y2: number) {
  const def = defFor(kind);
  return resolveCompositeModel({
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
    text: def?.defaultText,
    state: def?.interactive ? 0 : undefined,
  });
}

/** Builds a new element from a toolbox tool id, which may carry its own
 *  defaults on top of the kind's (the NPN/PNP and N-/P-channel splits). */
export function makeToolElement(tool: string, x1: number, y1: number, x2: number, y2: number) {
  const entry = toolboxEntry(tool);
  const def = defFor(entry.kind);
  return resolveCompositeModel({
    kind: entry.kind,
    x1: Math.round(x1),
    y1: Math.round(y1),
    x2: Math.round(x2),
    y2: Math.round(y2),
    flags: def?.defaultFlags ?? 0,
    params: { ...(def?.defaults ?? {}), ...(entry.defaults ?? {}) },
    text: def?.defaultText,
    state: def?.interactive ? 0 : undefined,
  });
}
