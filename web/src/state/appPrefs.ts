/** App-preference persistence. The Other Options keys that are neither
 *  header-borne circuit settings nor plain UI settings survive a page reload,
 *  stored as one JSON blob under a single localStorage key. Upstream scatters
 *  keys (`decimalDigits`, `valueFontSize`, `wheelSensitivity`, `crossHair`,
 *  the five colours); the port keeps them together. Pure and DOM-free, so it
 *  is testable under the node vitest environment. */

import type { SimSettings } from '../model/types';

export const APP_PREF_STORAGE_KEY = 'options.prefs.v1';

/** The settings keys that are app prefs. Circuit settings (header-borne, e.g.
 *  `autoDC`) and plain settings (`stepsPerFrame`, `showGrid`, ...) are
 *  deliberately absent: New resets the first and both ride in the state. */
export const APP_PREF_KEYS = [
  'showCrosshair',
  'showHitboxes',
  'euroResistors',
  'euroGates',
  'positiveColor',
  'negativeColor',
  'neutralColor',
  'selectionColor',
  'currentColor',
  'valueFontSize',
  'shortDecimalDigits',
  'decimalDigits',
  'wheelSensitivity',
  'mouseWheelEdit',
] as const;

export type AppPrefKey = (typeof APP_PREF_KEYS)[number];

/** Per-key range for the numeric prefs. A value outside these (or a string
 *  like `"abc"`) would otherwise reach `formatValue`'s `toFixed(digits)` and
 *  throw RangeError, killing the frame loop, so out-of-range and wrong-typed
 *  entries are dropped on load. The bounds mirror the Other Options controls. */
const NUMBER_RANGES: Partial<Record<AppPrefKey, { min: number; max: number }>> = {
  valueFontSize: { min: 8, max: 40 },
  shortDecimalDigits: { min: 0, max: 6 },
  decimalDigits: { min: 0, max: 6 },
  wheelSensitivity: { min: 0.1, max: 10 },
};

/** The five colour keys, validated as a hex string or null (theme default). */
const COLOR_KEYS = ['positiveColor', 'negativeColor', 'neutralColor', 'selectionColor', 'currentColor'] as const;

/** The boolean app prefs, validated as exactly a true/false. */
const BOOLEAN_KEYS = ['showCrosshair', 'showHitboxes', 'euroResistors', 'euroGates', 'mouseWheelEdit'] as const;

/** True when a stored value is a safe, in-range pref value of the right type. */
function isValidPref(key: AppPrefKey, value: unknown): value is number | string | boolean | null {
  const range = NUMBER_RANGES[key];
  if (range) {
    return typeof value === 'number' && Number.isFinite(value) && value >= range.min && value <= range.max;
  }
  if ((BOOLEAN_KEYS as readonly string[]).includes(key)) return typeof value === 'boolean';
  if ((COLOR_KEYS as readonly string[]).includes(key)) {
    return value === null || (typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value));
  }
  return false;
}

/** The subset of a storage backend the prefs touch, so tests can inject a
 *  plain object instead of the DOM localStorage. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The browser storage, or undefined in a node test environment. Guarded
 *  because both callers reach it through a default argument, which evaluates
 *  before any body-level try/catch: with site data blocked the property
 *  access itself throws SecurityError, and this sits at store creation on
 *  module scope, so an unguarded read was a white screen at boot. */
function defaultStorage(): StorageLike | undefined {
  try {
    if (typeof globalThis === 'undefined') return undefined;
    return (globalThis as { localStorage?: StorageLike }).localStorage;
  } catch {
    // Storage denied: run without persistence rather than crash.
    return undefined;
  }
}

/**
 * Reads the stored app prefs. A missing, corrupt or non-object blob yields {},
 * and unknown keys are dropped so a stale key from an older build never leaks
 * into the settings object. Values are validated per key: an out-of-range
 * number or a wrong-typed entry is dropped too, so a parseable-but-garbage
 * blob (a string where the digit count should be, a negative digit count)
 * cannot reach `formatValue` and crash the render loop. Upstream alerts and
 * falls back to defaults on a corrupt entry (CircuitElm.java:140-146); the
 * port is quiet, same result.
 */
export function loadAppPrefs(storage: StorageLike | undefined = defaultStorage()): Partial<SimSettings> {
  if (!storage) return {};
  let raw: string | null = null;
  try {
    raw = storage.getItem(APP_PREF_STORAGE_KEY);
  } catch {
    return {};
  }
  if (raw === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  const record = parsed as Record<string, unknown>;
  const out: Partial<SimSettings> = {};
  const target = out as Record<AppPrefKey, unknown>;
  for (const key of APP_PREF_KEYS) {
    if (key in record && isValidPref(key, record[key])) target[key] = record[key];
  }
  return out;
}

/** Writes exactly the app-pref keys under one key. A storage failure (private
 *  mode, quota) is swallowed: prefs are a convenience, never a crash. */
export function saveAppPrefs(
  settings: SimSettings,
  storage: StorageLike | undefined = defaultStorage(),
): void {
  if (!storage) return;
  const blob: Record<string, unknown> = {};
  for (const key of APP_PREF_KEYS) blob[key] = settings[key];
  try {
    storage.setItem(APP_PREF_STORAGE_KEY, JSON.stringify(blob));
  } catch {
    // Prefs must never take the app down with them.
  }
}

/** True when a settings patch touches at least one app-pref key. */
export function touchesAppPrefs(patch: Partial<SimSettings>): boolean {
  const keys = APP_PREF_KEYS as readonly string[];
  return (Object.keys(patch) as (keyof SimSettings)[]).some((k) => keys.includes(k));
}
