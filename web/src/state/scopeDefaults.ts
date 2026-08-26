/**
 * Scope-defaults persistence, the port of upstream's `saveAsDefault` and
 * `loadDefaults` (ScopeSerializer.java:291-318): the modelled display flags,
 * speed and trigger level of one scope, stored as a single JSON blob under one
 * localStorage key and seeded into every new scope. The storage shape follows
 * the `appPrefs` pattern: one key, a pure module, an injectable backend, and a
 * quiet fallback on any storage failure.
 */

import type { Scope } from '../engine/scopeModel';
import { scopeDisplayFlags, scopeFieldsFromFlags } from '../io/scopeLine';
import { scopeSpeed } from '../scope/geometry';
import type { StorageLike } from './appPrefs';

export const SCOPE_DEFAULTS_STORAGE_KEY = 'scopeDefaults';

/** The patch `makeScope` merges over a fresh scope: the modelled display
 *  fields from the stored flag word, plus the speed and trigger level. */
export type ScopeDefaultsPatch = ReturnType<typeof scopeFieldsFromFlags> & {
  speed: number;
  trigger: { level: number };
};

/** The browser storage, or undefined in a node test environment. Guarded
 *  because the callers reach it through a default argument: with site data
 *  blocked the property access itself throws SecurityError, and makeScope
 *  runs this while loading any circuit with scopes. */
function defaultStorage(): StorageLike | undefined {
  try {
    if (typeof globalThis === 'undefined') return undefined;
    return (globalThis as { localStorage?: StorageLike }).localStorage;
  } catch {
    // Storage denied: run without persistence rather than crash.
    return undefined;
  }
}

/** Writes a scope's modelled display flags, speed and trigger level, exactly
 *  the three things upstream's `loadDefaults` restores. A storage failure
 *  (private mode, quota) is swallowed: defaults are a convenience, never a
 *  crash. */
export function saveScopeDefaults(
  scope: Scope,
  storage: StorageLike | undefined = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(
      SCOPE_DEFAULTS_STORAGE_KEY,
      JSON.stringify({
        flags: scopeDisplayFlags(scope),
        speed: scope.speed,
        level: scope.trigger.level,
      }),
    );
  } catch {
    // Defaults must never take the app down with them.
  }
}

/** Reads the stored scope defaults as the patch `makeScope` applies to a new
 *  scope. A missing, corrupt or wrong-typed blob yields null, so a fresh scope
 *  falls back to its plain defaults; a wrong-typed entry (a string where the
 *  flag word should be) cannot reach the flag decoder. */
export function loadScopeDefaults(
  storage: StorageLike | undefined = defaultStorage(),
): ScopeDefaultsPatch | null {
  if (!storage) return null;
  let raw: string | null = null;
  try {
    raw = storage.getItem(SCOPE_DEFAULTS_STORAGE_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const blob = parsed as Record<string, unknown>;
  const { flags, speed, level } = blob;
  if (
    typeof flags !== 'number' ||
    !Number.isInteger(flags) ||
    typeof speed !== 'number' ||
    !Number.isFinite(speed) ||
    typeof level !== 'number' ||
    !Number.isFinite(level)
  ) {
    return null;
  }
  return {
    ...scopeFieldsFromFlags(flags),
    speed: scopeSpeed(speed),
    // The text `o` line carries no trigger state, so upstream restores the
    // stored level into the freeRun default it always starts from
    // (ScopeSerializer.java:315-317); the port merges just the level the same
    // way.
    trigger: { level },
  };
}
