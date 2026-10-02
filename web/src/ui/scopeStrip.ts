/**
 * The docked scope strip's height: the drag handle on its top edge sets it,
 * and it survives a reload as a per-viewer convenience. Nothing about it is in
 * the circuit file; upstream's strip height is a fixed share of the canvas.
 * Pure and DOM-free like appPrefs.ts, so the clamp and the storage round trip
 * are testable under node.
 */

import type { StorageLike } from '../state/appPrefs';

export const SCOPE_STRIP_STORAGE_KEY = 'scopeStrip.height';

/** The strip height before anyone drags it, the port's long-standing 150. */
export const DEFAULT_STRIP_HEIGHT = 150;

/** Below this a trace has no room for its header and scale labels. */
export const MIN_STRIP_HEIGHT = 80;

/** The schematic keeps at least this share of the centre area, so a strip
 *  dragged all the way up never buries the canvas it is measuring. */
const MAX_STRIP_SHARE = 0.85;

/**
 * Clamps a wanted height into what the centre area can hold. `available` is
 * the centre area's height; while it is unknown (0, before layout) only the
 * lower bound applies. A non-finite wish falls back to the default.
 */
export function clampStripHeight(wanted: number, available: number): number {
  const h = Number.isFinite(wanted) ? wanted : DEFAULT_STRIP_HEIGHT;
  const max = available > 0 ? Math.max(MIN_STRIP_HEIGHT, Math.floor(available * MAX_STRIP_SHARE)) : Infinity;
  return Math.round(Math.min(max, Math.max(MIN_STRIP_HEIGHT, h)));
}

/** The browser storage, or undefined under node or with site data blocked,
 *  where the property access itself throws. */
function defaultStorage(): StorageLike | undefined {
  try {
    return (globalThis as { localStorage?: StorageLike }).localStorage;
  } catch {
    return undefined;
  }
}

/** The stored height, or the default when none is stored or it is garbage. */
export function loadStripHeight(storage: StorageLike | undefined = defaultStorage()): number {
  try {
    const raw = storage?.getItem(SCOPE_STRIP_STORAGE_KEY);
    const n = raw == null ? NaN : Number(raw);
    return Number.isFinite(n) && n >= MIN_STRIP_HEIGHT ? Math.round(n) : DEFAULT_STRIP_HEIGHT;
  } catch {
    return DEFAULT_STRIP_HEIGHT;
  }
}

/** Remembers the height; a storage failure only costs the memory. */
export function saveStripHeight(
  height: number,
  storage: StorageLike | undefined = defaultStorage(),
): void {
  try {
    storage?.setItem(SCOPE_STRIP_STORAGE_KEY, String(Math.round(height)));
  } catch {
    // Private mode or quota: the strip still works, it just forgets.
  }
}

