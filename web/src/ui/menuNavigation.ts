/** Flat-menu cursor arithmetic shared by the menubar dropdowns. No DOM: rows
 *  are `{ disabled }` stubs and the cursor is a plain index, so the numeric
 *  rules are node-testable. The caller queries the real `.menu-item` buttons
 *  and hands the disabled flags in. */

export interface MenuRow {
  disabled?: boolean;
}

/** The first row a menu can focus, or null for an all-disabled menu. */
export function firstEnabledIndex(rows: readonly MenuRow[]): number | null {
  const i = rows.findIndex((r) => !r.disabled);
  return i === -1 ? null : i;
}

/** The last row a menu can focus, or null for an all-disabled menu. */
export function lastEnabledIndex(rows: readonly MenuRow[]): number | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (!rows[i].disabled) return i;
  }
  return null;
}

/** The row to focus after a navigation key, or null when no enabled row
 *  exists (nothing can move). `cursor` is the currently focused row, or null
 *  when focus is on the trigger, so ArrowDown opens onto the first enabled
 *  row and ArrowUp onto the last. Movement skips `disabled` rows and wraps at
 *  both edges; Home/End jump to the first/last enabled row. */
export function stepMenuCursor(
  rows: readonly MenuRow[],
  cursor: number | null,
  key: 'ArrowDown' | 'ArrowUp' | 'Home' | 'End',
): number | null {
  if (key === 'Home') return firstEnabledIndex(rows);
  if (key === 'End') return lastEnabledIndex(rows);
  const step = key === 'ArrowDown' ? 1 : -1;
  // A null cursor starts one row off-screen, so the first iteration lands on
  // the matching edge row (first for ArrowDown, last for ArrowUp).
  const start = cursor === null ? (step === 1 ? -1 : rows.length) : cursor;
  for (let i = start + step; i >= 0 && i < rows.length; i += step) {
    if (!rows[i].disabled) return i;
  }
  // Past an edge: wrap to the other end and scan back toward the cursor. A
  // single-enabled-row menu wraps onto itself here.
  for (let i = step === 1 ? 0 : rows.length - 1; i >= 0 && i < rows.length; i += step) {
    if (!rows[i].disabled) return i;
  }
  return null;
}
