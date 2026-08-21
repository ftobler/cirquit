/** What an element's property rows are and what a change to one does, split
 *  out of the rendering so both the options panel and the element properties
 *  dialog build the same list from one place (AGENTS.md: nothing testable
 *  belongs inside a React component). The `.tsx` beside this file owns the
 *  controls; this module owns the rows and the store dispatch. */

import { defFor } from '../model/registry';
import type { CircuitElement, FieldDef } from '../model/types';

/** One row of the property list: the def's field plus the element's value for
 *  it, already resolved from wherever that field reads. */
export interface FieldRow {
  field: FieldDef;
  value: number | string;
}

/** Where a field reads from: free text, a bit of `e.flags`, a named model, or
 *  a param. A flag field is a checkbox, so it is reported as 0 or 1. */
export function fieldValue(e: CircuitElement, f: FieldDef): number | string {
  if (f.target === 'text') return e.text ?? '';
  if (f.target === 'keyShortcut') return e.keyShortcut ?? '';
  if (f.target === 'modelName') return e.modelName ?? '';
  if (f.flag !== undefined) return (e.flags & f.flag) !== 0 ? 1 : 0;
  return e.params[f.name] ?? 0;
}

/** The property rows for one element, in def order. An unknown kind or a def
 *  with no fields (a wire, a ground) has nothing to edit and gives an empty
 *  list, which is what makes the dialog and the panel agree on "no
 *  properties" without either one repeating the check. */
export function fieldRows(e: CircuitElement): FieldRow[] {
  const def = defFor(e.kind);
  return (def?.fields ?? []).map((field) => ({ field, value: fieldValue(e, field) }));
}

/** Rounds an integer field's typed value and holds it inside the def's range,
 *  so the store never sees a fraction or an out-of-range count even though a
 *  number input lets both be typed. */
export function clampInteger(v: number, field: Pick<FieldDef, 'min' | 'max'>): number {
  const n = Math.round(v);
  const lo = field.min ?? Number.NEGATIVE_INFINITY;
  const hi = field.max ?? Number.POSITIVE_INFINITY;
  return Math.min(hi, Math.max(lo, n));
}

/** The store actions a property edit can reach. Passed in rather than read
 *  from the store so the dispatch below stays a pure function of its inputs
 *  and can be tested without a store or a DOM. */
export interface FieldEditActions {
  setParam(id: number, name: string, value: number): void;
  setText(id: number, text: string): void;
  setKeyShortcut(id: number, key: string): void;
  setModelName(id: number, name: string): void;
  updateElement(id: number, patch: Partial<CircuitElement>): void;
}

/**
 * Routes an edited field value to the store action that owns it. `file`
 * fields are not handled here: their read and decode are asynchronous and
 * land through their own store actions once the samples are ready.
 */
export function applyFieldChange(
  e: CircuitElement,
  f: FieldDef,
  v: number | string,
  actions: FieldEditActions,
): void {
  if (f.target === 'text') {
    actions.setText(e.id, String(v));
    return;
  }
  if (f.target === 'keyShortcut') {
    actions.setKeyShortcut(e.id, String(v));
    return;
  }
  if (f.target === 'modelName') {
    actions.setModelName(e.id, String(v));
    return;
  }
  if (f.flag !== undefined) {
    // A file flag is read when the engine builds the circuit and can change
    // the stamp or the node count, so it has to go through `updateElement`,
    // which bumps `revision` and forces a full rebuild. `setParam`'s live path
    // only re-stamps.
    const on = Number(v) !== 0;
    actions.updateElement(e.id, {
      flags: on ? e.flags | f.flag : e.flags & ~f.flag,
    });
    return;
  }
  const value = Number(v);
  // Switching a source to or from pulse restores the duty cycle the other
  // family expects, mirroring VoltageElm.java:617-621: entering pulse takes
  // the legacy 1/(2*pi), leaving it returns to 0.5. The waveform setParam
  // below also keeps the stored pulse-duty flag (bit 4) in step, so an edited
  // duty survives the next rebuild.
  if (f.name === 'waveform' && e.kind === 'voltage') {
    const old = Number(e.params.waveform ?? 0);
    if (value === 5 && old !== 5) actions.setParam(e.id, 'dutyCycle', 1 / (2 * Math.PI));
    else if (old === 5 && value !== 5) actions.setParam(e.id, 'dutyCycle', 0.5);
  }
  actions.setParam(e.id, f.name, value);
}
