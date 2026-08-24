/** What an element's property rows are and what a change to one does, split
 *  out of the rendering so both the options panel and the element properties
 *  dialog build the same list from one place (AGENTS.md: nothing testable
 *  belongs inside a React component). The `.tsx` beside this file owns the
 *  controls; this module owns the rows and the store dispatch. */

import { defFor } from '../model/registry';
import { DEFAULT_MODEL_NAME } from '../model/registry/elements/customComposite';
import { modelFamilyFor, userModel } from '../model/deviceModels';
import { bytesToHexRun, contentsToText, parseContentsText } from '../model/memoryContents';
import { memoryPairs, normalizeSramBits, SRAM_HEX_DISPLAY } from '../model/registry/elements/sram';
import { batteryTypeDefaults, batteryTypeTables } from '../model/registry/elements/battery';
import { fieldLabel, type CircuitElement, type FieldDef } from '../model/types';

/** One row of the property list: the def's field, its label resolved for the
 *  element (a dynamic label answered by calling the function), plus the
 *  element's value for it, already resolved from wherever that field reads. */
export interface FieldRow {
  field: FieldDef;
  label: string;
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

/** What the composite element's Edit Model button can do for this element, so
 *  the dialog's row is testable without a DOM. `none` hides the row entirely
 *  (not a composite), `default` shows it but clicking alerts that the built-in
 *  stub is not editable (CustomCompositeElm.java:253-255), and `editable`
 *  opens the drill-in. */
export type CompositeEditModelState = 'none' | 'default' | 'editable';

export function compositeEditModelState(e: CircuitElement): CompositeEditModelState {
  if (e.kind !== 'customComposite') return 'none';
  return (e.text ?? DEFAULT_MODEL_NAME) === DEFAULT_MODEL_NAME ? 'default' : 'editable';
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
  if (f.target === 'model') return typeof e.model === 'string' ? e.model : '';
  if (f.flag !== undefined) return (e.flags & f.flag) !== 0 ? 1 : 0;
  // A derived row reads its displayed value through `get`, its stored truth
  // being params the default binding would not name (the High Time row shows
  // dutyCycle/frequency).
  if (f.get !== undefined) return f.get(e);
  return (e.params[f.name] ?? 0) * (f.scale ?? 1);
}

/** The def's fields that show for one element, in def order. A field whose
 *  `visible` predicate the element fails is dropped entirely, so the rows
 *  match the engine's editable surface per element. */
export function visibleFields(e: CircuitElement, fields: FieldDef[]): FieldDef[] {
  return fields.filter((f) => f.visible === undefined || f.visible(e));
}

/** The property rows for one element, in def order. An unknown kind or a def
 *  with no fields (a wire, a ground) has nothing to edit and gives an empty
 *  list, which is what makes the dialog and the panel agree on "no
 *  properties" without either one repeating the check. A field whose `visible`
 *  predicate the element fails is dropped entirely, so the rows match the
 *  engine's editable surface per element (the realistic op-amp hides the
 *  Slew Rate and Output Current Limit rows on the 324v2, whose netlist takes
 *  no such tuning). */
export function fieldRows(e: CircuitElement): FieldRow[] {
  const def = defFor(e.kind);
  return visibleFields(e, def?.fields ?? []).map((field) => ({
    field,
    label: fieldLabel(e, field),
    value: fieldValue(e, field),
  }));
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

/** Commits a loaded binary file as memory contents, upstream's Load Contents
 *  From File row (SRAMElm.java:154, SRAMLoadFile.java:31-48): the raw bytes
 *  are folded to the element's data width and encoded into the editor's
 *  `0x0:` hex run, then handed to the textarea's own commit, so the parse,
 *  the width check and the store action cannot diverge from what typing the
 *  same text would do. Masking keeps every value inside the width, so any
 *  file loads at any data width. */
export function commitBinaryFile(
  e: CircuitElement,
  bytes: ArrayLike<number>,
  alert: (message: string) => void,
  actions: ContentsCommitActions,
): boolean {
  const { dataBits } = contentsOptions(e);
  return commitContentsField(e, bytesToHexRun(bytes, (1 << dataBits) - 1), alert, actions);
}

/** One contents editor's typing buffer, stamped with the external-write token
 *  it was typed under. */
export interface DraftCell {
  token: number;
  text: string | null;
}

/** The live draft: what the cell holds when it was typed under the current
 *  token, else nothing. A landed binary load bumps the token before its pairs
 *  reach the store, so any draft typed earlier drops and a later blur has
 *  nothing to commit; upstream dodges the same race by repopulating the
 *  dialog after a load (SRAMLoadFile.java:47). */
export function draftForToken(cell: DraftCell, token: number): string | null {
  return cell.token === token ? cell.text : null;
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
  if (f.target === 'model') {
    // The battery's SOC table rides `e.model`, which the engine consumes as
    // `spec.model`; a plain updateElement reaches it through the same rebuild
    // every other model edit uses.
    actions.updateElement(e.id, { model: String(v) });
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
  // Choosing a battery preset loads its SOC table and its chemistry defaults
  // (BatteryElm.java:380-399); switching to Custom keeps the current values
  // editable. A preset change is a full element update: the table rides
  // `e.model` and the rebuild carries both it and the new params.
  if (f.name === 'batteryType' && e.kind === 'battery') {
    const old = Number(e.params.batteryType ?? 1);
    actions.setParam(e.id, 'batteryType', value);
    if (value >= 0 && value < batteryTypeDefaults.length) {
      if (value !== old) {
        const [capacityAh, r0, r1, c1] = batteryTypeDefaults[value];
        actions.setParam(e.id, 'capacityAh', capacityAh);
        actions.setParam(e.id, 'r0', r0);
        actions.setParam(e.id, 'r1', r1);
        actions.setParam(e.id, 'c1', c1);
      }
      actions.updateElement(e.id, { model: batteryTypeTables[value] });
    }
    return;
  }
  // Switching a source to or from pulse restores the duty cycle the other
  // family expects, mirroring VoltageElm.java:617-621: entering pulse takes
  // the legacy 1/(2*pi), leaving it returns to 0.5. The rail shares the rule
  // (RailElm extends VoltageElm and inherits the edit table). The waveform
  // setParam below also keeps the stored pulse-duty flag (bit 4) in step, so
  // an edited duty survives the next rebuild.
  if (f.name === 'waveform' && (e.kind === 'voltage' || e.kind === 'rail')) {
    const old = Number(e.params.waveform ?? 0);
    if (value === 5 && old !== 5) actions.setParam(e.id, 'dutyCycle', 1 / (2 * Math.PI));
    else if (old === 5 && value !== 5) actions.setParam(e.id, 'dutyCycle', 0.5);
  }
  // A derived row writes its stored truth back through the element's params:
  // `apply` mutates a draft (never the store's live element) and the caller
  // diffs the result against the stored params, dispatching one setParam per
  // change. Both edits land in the current edit session, so an apply that
  // recomputes two params stays one undo step.
  if (f.apply !== undefined) {
    const draft: CircuitElement = { ...e, params: { ...e.params } };
    f.apply(draft, Number(v));
    for (const name of new Set([...Object.keys(e.params), ...Object.keys(draft.params)])) {
      const next = draft.params[name];
      if (next !== undefined && next !== e.params[name]) {
        actions.setParam(e.id, name, next);
      }
    }
    return;
  }
  // A scaled field (the battery's Initial State of Charge) commits its display
  // unit divided back into the stored param's unit (percent into the 0..1
  // fraction), the inverse of the `fieldValue` multiply.
  actions.setParam(e.id, f.name, value / (f.scale ?? 1));
}
