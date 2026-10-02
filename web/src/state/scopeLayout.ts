/**
 * Rearranging scopes by drag and drop. The file carries one layout fact per
 * scope, its stacking `position` (scopes sharing one share a column), and
 * upstream assumes positions never decrease along the scope list, which its
 * stack and unstack commands rely on (ScopeManager.java:253-274). A move
 * therefore rebuilds the whole list column by column and renumbers the
 * positions 0, 1, 2, ..., so the result saves as a plain upstream layout.
 * Pure, so it is tested without the store.
 */

import type { Scope } from '../engine/scopeModel';

/** Where a dragged scope lands. Columns are named by a scope they contain,
 *  since positions are renumbered by every move. */
export type ScopeDropTarget =
  /** Into the column holding `withId`, at its bottom. */
  | { kind: 'stack'; withId: number }
  /** As a column of its own, left of the column holding `beforeId`, or
   *  after every column when null. */
  | { kind: 'column'; beforeId: number | null };

/** The scope ids grouped into columns, in position order and, inside a
 *  column, in list order. */
export function scopeColumns(scopes: readonly Scope[]): number[][] {
  const byPos = new Map<number, number[]>();
  for (const s of scopes) {
    const col = byPos.get(s.position);
    if (col) col.push(s.id);
    else byPos.set(s.position, [s.id]);
  }
  return [...byPos.keys()].sort((a, b) => a - b).map((p) => byPos.get(p)!);
}

/**
 * The scope list after moving `id` to `target`: reordered column by column
 * with contiguous positions. Null when nothing would change (an unknown id or
 * target, a drop onto the column it already ends, a new column where it
 * already stands alone), so the caller pushes no undo entry for a no-op.
 */
export function moveScopeTo(
  scopes: readonly Scope[],
  id: number,
  target: ScopeDropTarget,
): Scope[] | null {
  if (!scopes.some((s) => s.id === id)) return null;
  const before = scopeColumns(scopes);
  const cols = before.map((c) => c.filter((x) => x !== id)).filter((c) => c.length > 0);
  if (target.kind === 'stack') {
    if (target.withId === id) return null;
    const col = cols.find((c) => c.includes(target.withId));
    if (!col) return null;
    col.push(id);
  } else {
    const at =
      target.beforeId === null ? cols.length : cols.findIndex((c) => c.includes(target.beforeId!));
    if (at < 0) return null;
    cols.splice(at, 0, [id]);
  }
  if (JSON.stringify(cols) === JSON.stringify(before)) return null;
  const byId = new Map(scopes.map((s) => [s.id, s]));
  return cols.flatMap((col, position) =>
    col.map((sid) => {
      const s = byId.get(sid)!;
      return s.position === position ? s : { ...s, position };
    }),
  );
}
