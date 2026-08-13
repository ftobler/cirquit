/**
 * Resolves a slider's `editItem` to a `set_param` name on the target element.
 *
 * Upstream binds by index into `getEditInfo()` (Adjustable.java:124-130), but
 * that ordering has drifted over the years: the corpus files were saved against
 * an older edit list, so a faithful index lookup reproduces upstream's own
 * current (broken) bindings on those files. Resolving the caption against the
 * element's field labels first binds every corpus slider to the parameter its
 * text names, which is the user-visible intent; the index fallback keeps files
 * saved against current upstream correct, and a miss is inert-but-preserved.
 * The alias table is the documented divergence (see sliders-bound-to-parameters).
 *
 * Pure and DOM-free, so the resolution is node-testable.
 */

import { defFor } from './registry';
import type { FieldDef } from './types';

/** Captions whose words do not line up with the field label they mean. Keys
 *  and captions are compared case- and separator-insensitive. */
const ALIASES: Record<string, string> = {
  'beta/hfe': 'beta',
  'phase control': 'resistance',
  'duty cycle': 'dutyCycle',
  'temperature': 'position',  // the thermistor slider drives its temperature
  'light brightness': 'position',  // the LDR slider drives its light level
};

/** Lowercase, with every non-alphanumeric separator stripped, so "Beta/hFE",
 *  "Duty Cycle" and "Phase Control" all land on one key. */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * The numeric fields an element can host a slider on: the `getEditInfo` rows
 * that carry a value a slider can set, in field order. The choice, checkbox,
 * text, model-choice, file and download rows are excluded (upstream's
 * `canCreateAdjustable`, EditInfo.java:103): `choice`/`checkbox`/`textArea`
 * have no numeric value, the model picker is a choice by another name, and the
 * widget/button rows are the file and download fields, whose only "value" is
 * the loaded-file index a slider drag would silently overwrite on save. The
 * editItem index a slider line carries is the index into this list, so the
 * list is the shared source of truth for both resolving a slider line and
 * creating one from the Sliders dialog.
 */
export function adjustableFields(kind: string): FieldDef[] {
  const def = defFor(kind);
  return (def?.fields ?? []).filter(
    (f) =>
      f.type !== 'choice' &&
      f.type !== 'bool' &&
      f.type !== 'text' &&
      f.type !== 'modelChoice' &&
      f.type !== 'file' &&
      f.type !== 'download',
  );
}

/**
 * The `set_param` name and field a slider drives, or null when the target
 * element has no field this caption or index can name. A null means the slider
 * stays inert-but-preserved: it round-trips and simply does not render.
 */
export function resolveParam(
  kind: string,
  editItem: number,
  caption: string,
): { name: string; field: FieldDef } | null {
  const def = defFor(kind);
  if (!def) return null;
  const fields = def.fields ?? [];

  const key = normalize(caption);
  if (key.length > 0) {
    const alias = ALIASES[key];
    if (alias !== undefined) {
      const field = fields.find((f) => f.name === alias);
      if (field) return { name: alias, field };
    }
    for (const f of fields) {
      if (normalize(f.label) === key) return { name: f.name, field: f };
    }
  }

  // Fallback: index into the numeric edit items, the port's field order with
  // the choice/checkbox/text/modelChoice rows skipped (upstream's getEditInfo
  // mixes the same kinds of entries in; only the numeric ones carry a value a
  // slider can set). A text or modelChoice row would resolve to a phantom
  // param name and force a full engine rebuild on set_param, so they are
  // excluded with the other non-numeric rows. An out-of-range index resolves
  // to null.
  const field = adjustableFields(kind)[editItem];
  if (field) return { name: field.name, field };
  return null;
}

/**
 * The factor between a slider's file range and the param's unit. Upstream's
 * duty-cycle edit item carries the percent value, times 100 (VoltageElm.java:
 * 578), and divides it back in setEditValue (:660), while this port's
 * `dutyCycle` param is a fraction in [0, 1]. setSliderValue applies the scale
 * after the min..max position conversion; the thumb read-back keeps the raw
 * param against the file range. General so a caption-to-unit gap behind the
 * temperature/light aliases only needs an entry.
 */
const PARAM_SCALE: Record<string, number> = {
  dutyCycle: 0.01,
};

/** The scale from a slider's file range to the named param's unit, 1 when they
 *  already agree. */
export function paramScale(name: string): number {
  return PARAM_SCALE[name] ?? 1;
}

/** Convert a value to the slider position 0..100, the port of
 *  `Adjustable.valueToSliderPosition` (Adjustable.java:142-149). Logarithmic
 *  mapping needs a strictly positive range, and a hand-edited line can invert
 *  or flatten min/max, so the log branch only runs for a range that is
 *  actually log-mappable; otherwise it degrades to linear. */
export function sliderValueToPosition(
  value: number,
  min: number,
  max: number,
  log: boolean,
): number {
  if (log && min > 0 && max > min) {
    const logMin = Math.log(min);
    const logMax = Math.log(max);
    return ((Math.log(value) - logMin) / (logMax - logMin)) * 100;
  }
  return ((value - min) * 100) / (max - min);
}

/** Convert a slider position 0..100 back to a value, rounding to `step` when
 *  one is set (Adjustable.java:132-139, 152-159). */
export function sliderPositionToValue(
  pos: number,
  min: number,
  max: number,
  log: boolean,
  step: number,
): number {
  let result: number;
  if (log && min > 0 && max > min) {
    const logMin = Math.log(min);
    const logMax = Math.log(max);
    result = Math.exp(logMin + (logMax - logMin) * (pos / 100));
  } else {
    result = min + (max - min) * (pos / 100);
  }
  if (step > 0) result = min + Math.round((result - min) / step) * step;
  return result;
}
