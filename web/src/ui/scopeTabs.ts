/** The scope-properties dialog's stack tabs.
 *
 *  Stacked scopes share one column, so each canvas is a fraction of a row
 *  high and its settings wheel is a few pixels across. Reaching the second
 *  scope of a stack to change something meant hitting that. The dialog
 *  therefore carries a tab per scope in the stack, so once it is open every
 *  scope stacked with the one it opened on is one click away.
 *
 *  Pure so the tab list is testable without a DOM (AGENTS.md).
 */

import type { Scope } from '../engine/scopeModel';

export interface ScopeTab {
  id: number;
  /** What the tab reads. The scope's own label when it has one, otherwise
   *  "Scope N" with N the scope's place in the whole scope list, which is how
   *  the element context menu names them too. */
  label: string;
  current: boolean;
}

/**
 * The tabs for the scope `scopeId` belongs to: every scope sharing its
 * stacking position, in panel order.
 *
 * An empty list means there is nothing to switch between: the scope stands
 * alone in its column, or the id names no scope at all. The caller renders no
 * tab strip then, so an unstacked scope's dialog is unchanged.
 */
export function stackTabs(scopes: Scope[], scopeId: number): ScopeTab[] {
  const scope = scopes.find((s) => s.id === scopeId);
  if (scope === undefined) return [];
  const stacked = scopes.filter((s) => s.position === scope.position);
  if (stacked.length < 2) return [];
  return stacked.map((s) => ({
    id: s.id,
    label: s.label.trim() !== '' ? s.label.trim() : `Scope ${scopes.indexOf(s) + 1}`,
    current: s.id === scopeId,
  }));
}
