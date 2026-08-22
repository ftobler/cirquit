/** What an element's property rows are and what a change to one does, split
 *  out of the rendering so both the options panel and the element properties
 *  dialog build the same list from one place (AGENTS.md: nothing testable
 *  belongs inside a React component). The `.tsx` beside this file owns the
 *  controls; this module owns the rows and the store dispatch. */

import { defFor } from '../model/registry';
import { modelFamilyFor, userModel } from '../model/deviceModels';
import { contentsToText, parseContentsText } from '../model/memoryContents';
import { memoryPairs, normalizeSramBits, SRAM_HEX_DISPLAY } from '../model/registry/elements/sram';
import type { CircuitElement, FieldDef } from '../model/types';

/** One row of the property list: the def's field plus the element's value for
 *  it, already resolved from wherever that field reads. */
export interface FieldRow {
  field: FieldDef;
  value: number | string;
}

/** Which device-model buttons the `modelChoice` row of an element shows, the
 *  port of upstream's create/edit rows (DiodeElm.java:211-227,
 *  TransistorElm.java:632-643, MosfetElm.java:738-745). The diode family gets
 *  the simple and advanced create buttons, every other model-naming family one
 *  generic Create Model; Edit Model shows only when the current name resolves
 *  to a writable entry, the readOnly rule that hides it for built-ins. */
export interface ModelButtons {
  createSimple: boolean;
  createAdvanced: boolean;
  create: boolean;
  edit: boolean;
}

export function deviceModelButtons(e: CircuitElement): ModelButtons {
  const family = modelFamilyFor(e.kind);
  const none: ModelButtons = { createSimple: false, createAdvanced: false, create: false, edit: false };
  if (family === undefined) return none;
  return {
    createSimple: family === 'diode',
    createAdvanced: family === 'diode',
    create: family !== 'diode',
    edit: e.modelName !== undefined && userModel(family, e.modelName) !== undefined,
  };
}

/** The contents editor's radix and mask, derived from the element like the
 *  engine derives them: the hex-display flag bit and the clamped data width.
 *  Shared by the value synthesis (fieldValue) and the commit parser so the two
 *  can never disagree about what the text means. */
export function contentsOptions(e: CircuitElement): { hex: boolean; dataBits: number } {
  return {
    hex: (e.flags & SRAM_HEX_DISPLAY) !== 0,
    dataBits: normalizeSramBits(e.params.dataBits ?? 4),
  };
}

/** Where a field reads from: free text, a bit of `e.flags`, a named model, or
 *  a param. A flag field is a checkbox, so it is reported as 0 or 1. A
 *  `contents` field binds no scalar value: its row value is the rendered text,
 *  re-derived per render so a hex-display toggle redraws the textarea in the
 *  new radix without re-parsing the stored pairs. */
export function fieldValue(e: CircuitElement, f: FieldDef): number | string {
  if (f.type === 'contents') return contentsToText(memoryPairs(e), contentsOptions(e));
  if (f.target === 'text') return e.text ?? '';
  if (f.target === 'keyShortcut') return e.keyShortcut ?? '';
  if (f.target === 'modelName') return e.modelName ?? '';
  if (f.flag !== undefined) return (e.flags & f.flag) !== 0 ? 1 : 0;
  return e.params[f.name] ?? 0;
}

/** The property rows for one element, in def order. An unknown kind or a def
 *  with no fields (a wire, a ground) has nothing to edit and gives an empty
 *  list, which is what makes the dialog and the panel agree on "no
 *  properties" without either one repeating the check. A field whose `when`
 *  predicate the element fails is dropped entirely, so the rows match the
 *  engine's editable surface per element (the realistic op-amp hides the
 *  Slew Rate and Output Current Limit rows on the 324v2, whose netlist takes
 *  no such tuning). */
export function fieldRows(e: CircuitElement): FieldRow[] {
  const def = defFor(e.kind);
  return (def?.fields ?? [])
    .filter((field) => field.when === undefined || field.when(e))
    .map((field) => ({ field, value: fieldValue(e, field) }));
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

/** The one store action a contents commit can reach. Split out so the commit
 *  stays testable without a store, like FieldEditActions. */
export interface ContentsCommitActions {
  setMemoryContents(id: number, pairs: [number, number][]): void;
}

/** Commits the contents textarea: parse through the codec (never the raw
 *  text, so two users typing different whitespace save identical files) and,
 *  on success, hand the pairs to the store. A parse error alerts the message
 *  and returns false so the caller keeps the bad value on screen, matching how
 *  the data-file loader alerts. */
export function commitContentsField(
  e: CircuitElement,
  text: string,
  alert: (message: string) => void,
  actions: ContentsCommitActions,
): boolean {
  const parsed = parseContentsText(text, contentsOptions(e));
  if (parsed.error !== null) {
    alert(parsed.error);
    return false;
  }
  actions.setMemoryContents(e.id, parsed.pairs);
  return true;
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
