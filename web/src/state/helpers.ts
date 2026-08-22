/** Pure store helpers: grid snapping, dirty tracking and element construction. */

import { defFor, toolboxEntry, toolDef } from '../model/registry';
import { rotateElement } from '../model/transform';
import { GRID_SIZE } from '../model/types';
import type { CircuitElement } from '../model/types';
import { getModel, modelToEngineSpec } from '../io/subcircuits';
import type { CompositeEngineSpec } from '../io/netlist/types';

/** Rounds a coordinate to the nearest grid intersection. `grid` defaults to
 *  the full-size grid so existing call sites keep their 16-unit step. */
export function snap(v: number, grid: number = GRID_SIZE): number {
  return Math.round(v / grid) * grid;
}

/** Maps a range-input position in [min, max] to a step count on a log scale,
 *  so small step counts spread across the slider instead of cramming into the
 *  low end. Both ends land exactly on min and max; a position outside the
 *  range clamps. A degenerate range (non-positive min, or max <= min) degrades
 *  to linear, the same guard the slider mapping in model/sliders.ts uses. */
export function stepsFromSlider(bar: number, min: number, max: number): number {
  const span = max - min;
  const t = span > 0 ? Math.min(1, Math.max(0, (bar - min) / span)) : 0;
  if (min > 0 && span > 0) {
    return Math.min(
      max,
      Math.max(min, Math.round(10 ** (Math.log10(min) + t * (Math.log10(max) - Math.log10(min))))),
    );
  }
  return Math.min(max, Math.max(min, Math.round(min + t * span)));
}

/** The inverse of stepsFromSlider: the range-input position that displays the
 *  given step count, so a stored stepsPerFrame restores the slider thumb. The
 *  count clamps to [min, max]; a degenerate range degrades to linear. */
export function sliderFromSteps(n: number, min: number, max: number): number {
  const span = max - min;
  if (span <= 0) return min;
  const clamped = Math.min(max, Math.max(min, n));
  if (min > 0) {
    return min + ((Math.log10(clamped) - Math.log10(min)) / (Math.log10(max) - Math.log10(min))) * span;
  }
  return clamped;
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
    // A default model (the battery's SOC table) must ride the same carrier
    // the load path fills, or a fresh part would reach the engine tableless.
    ...(def?.defaultModel !== undefined ? { model: def.defaultModel } : {}),
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
    flags: (def?.defaultFlags ?? 0) | (entry.flags ?? 0),
    params: { ...(def?.defaults ?? {}), ...(entry.defaults ?? {}) },
    text: def?.defaultText,
    ...(def?.defaultModel !== undefined ? { model: def.defaultModel } : {}),
    state: def?.interactive ? 0 : undefined,
  });
}

/** The length a click-placed part gets when its def declares no
 *  `defaultLength`: upstream's base `getDragLength()` of 64 px. Four grid
 *  squares and not three, even though 48 px is the commoner resistor length
 *  in the bundled corpus, because `L/2` is the settled-selection rotate's
 *  pivot and a part whose half-length lands on the grid turns in place:
 *  64/2 = 32 = 2*GRID_SIZE, while 48/2 = 24 is not a multiple of 16. An odd
 *  length still stays on the grid (`rotateElement` snaps the turn axis, as
 *  upstream does), but it shifts up to one square per turn, which the default
 *  has no reason to pay. `renderToolIcon` needs the same fallback for its own
 *  reasons, so both read this constant and cannot drift apart. */
export const DEFAULT_PLACEMENT_LENGTH = 4;

/** The element an armed tool would place at the grid-snapped point `(x,y)`,
 *  turned `turns` quarter turns about that point. `(x,y)` is post 1, exactly
 *  where a placement drag anchors it, so the ghost the user sees and the part
 *  the press creates are the same element and it cannot jump under the cursor
 *  on click. The turn goes through `rotateElement` rather than raw coordinate
 *  arithmetic so the orientation flags come with it: an op-amp, transistor,
 *  mosfet, relay, triode, transformer, UJT, comparator or opampReal placed
 *  turned carries the same flag bit it would have carried had it been placed
 *  flat and then rotated. */
export function makeGhostElement(
  tool: string,
  x: number,
  y: number,
  turns: number,
): Omit<CircuitElement, 'id'> {
  const def = toolDef(tool);
  const len = (def?.defaultLength ?? DEFAULT_PLACEMENT_LENGTH) * GRID_SIZE;
  // Grounds and voltage sources drop vertically, the rest horizontally,
  // matching upstream's getDragVertical override.
  const x2 = def?.vertical ? x : x + len;
  const y2 = def?.vertical ? y + len : y;
  // `rotateElement` takes a stored element, so the turn runs on a placeholder
  // id the caller replaces: the press hands the result to `addElement`, which
  // assigns the real one, and the ghost draw substitutes -1.
  let e: CircuitElement = { ...makeToolElement(tool, x, y, x2, y2), id: 0 };
  const n = ((turns % 4) + 4) % 4;
  for (let i = 0; i < n; i++) e = rotateElement(e, { x, y });
  const { id: _id, ...rest } = e;
  return rest;
}
