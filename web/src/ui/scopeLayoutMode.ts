/**
 * How the dock arranges its scope columns: the classic strip (one row, side
 * by side), tabs (one column visible, a tab per column) and grid (columns wrap
 * into rows). Per-viewer and session-only: upstream's file carries nothing
 * about it, so nothing here touches the `o` line. Pure and DOM-free like
 * scopeStrip.ts, so the clamp and the storage round trip are testable under
 * node.
 */

import type { StorageLike } from '../state/appPrefs';

export const SCOPE_LAYOUT_STORAGE_KEY = 'scopeStrip.layout';

export type ScopeLayoutMode = 'strip' | 'tabs' | 'grid';

/** The layouts in picker order, with the labels the Scopes menu shows. */
export const SCOPE_LAYOUT_MODES: { id: ScopeLayoutMode; label: string; title: string }[] = [
  { id: 'strip', label: 'Strip', title: 'All columns side by side' },
  { id: 'tabs', label: 'Tabs', title: 'One column at a time, a tab per column' },
  { id: 'grid', label: 'Grid', title: 'Columns wrap into rows' },
];

/** The layout a fresh viewer gets: the strip the dock has always been. */
export const DEFAULT_SCOPE_LAYOUT: ScopeLayoutMode = 'strip';

/** A stored or received value as a layout, or the default for anything else. */
export function clampLayoutMode(value: unknown): ScopeLayoutMode {
  return SCOPE_LAYOUT_MODES.some((m) => m.id === value)
    ? (value as ScopeLayoutMode)
    : DEFAULT_SCOPE_LAYOUT;
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

/** The stored layout, or the default when none is stored or it is garbage. */
export function loadScopeLayout(
  storage: StorageLike | undefined = defaultStorage(),
): ScopeLayoutMode {
  try {
    return clampLayoutMode(storage?.getItem(SCOPE_LAYOUT_STORAGE_KEY));
  } catch {
    return DEFAULT_SCOPE_LAYOUT;
  }
}

/** Remembers the layout; a storage failure only costs the memory. */
export function saveScopeLayout(
  mode: ScopeLayoutMode,
  storage: StorageLike | undefined = defaultStorage(),
): void {
  try {
    storage?.setItem(SCOPE_LAYOUT_STORAGE_KEY, mode);
  } catch {
    // Private mode or quota: the layout still works, it just forgets.
  }
}

/** Keeps the tabs layout's active column inside the list, wrapping a step and
 *  falling back to 0 when the column count shrank under it. */
export function clampActiveTab(index: number, count: number): number {
  if (count <= 0) return 0;
  if (!Number.isFinite(index)) return 0;
  return ((Math.round(index) % count) + count) % count;
}
