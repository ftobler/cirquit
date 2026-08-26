/**
 * The scope popup menu's row table, kept out of the component so the command
 * mapping and gating stay testable without a DOM (AGENTS.md: nothing testable
 * belongs inside a React component). ScopeMenu.tsx owns positioning, dismissal
 * listeners and rendering; this module owns what the rows mean.
 */

import type { ScopePlot } from '../engine/simulator';
import { canRemovePlot } from './scopePlotRows';

/** One row of the scope menu: display plus the closure that runs it, the same
 *  shape the element context menu's row tables use. */
export interface ScopeMenuRow {
  label: string;
  disabled?: boolean;
  action: () => void;
}

/**
 * The scope popup's commands, in menu order. `commands` carries the store
 * actions and `exportCsv` the whole build-and-download side effect, injected
 * because Blob and anchor work has no place in a node-testable module.
 */
export function scopeMenuRows(env: {
  /** The clicked scope; every row acts on it. */
  scope: { id: number; maxScale: boolean; plots: ScopePlot[] };
  /** The scope stacked above this one in panel order, when any. */
  previous?: { id: number };
  /** The plot id ScopePanel resolved under the cursor, not a value. */
  plotId: number;
  exportCsv: () => void;
  commands: {
    removeScope(id: number): void;
    setScopeFlags(id: number, patch: { maxScale: boolean }): void;
    stackScope(id: number): void;
    unstackScope(id: number): void;
    combineScopes(intoId: number, fromId: number): void;
    removePlot(scopeId: number, plotId: number): void;
    clearScaleStates(ids: number[]): void;
    resetScope(id: number): void;
    openScopeProperties(id: number): void;
  };
}): ScopeMenuRow[] {
  const { scope, previous, plotId, exportCsv, commands } = env;
  return [
    {
      label: 'Remove Scope',
      action: () => commands.removeScope(scope.id),
    },
    {
      label: 'Max Scale',
      action: () => commands.setScopeFlags(scope.id, { maxScale: !scope.maxScale }),
    },
    {
      label: 'Stack',
      disabled: !previous,
      action: () => commands.stackScope(scope.id),
    },
    {
      label: 'Unstack',
      disabled: !previous,
      action: () => commands.unstackScope(scope.id),
    },
    {
      label: 'Combine',
      disabled: !previous,
      action: () => {
        if (previous) commands.combineScopes(previous.id, scope.id);
      },
    },
    {
      label: 'Remove Plot',
      // The plot id ScopePanel resolved under the cursor, not a value: two
      // same-value plots in one panel must remove independently. Disabled
      // rather than a silent no-op when the target is stale, raw-only, or
      // the panel's last plot.
      disabled: !canRemovePlot(scope.plots, plotId),
      action: () => commands.removePlot(scope.id, plotId),
    },
    {
      label: 'Reset',
      action: () => {
        // The sticky scales are per (scope, units family): wiping the scope's
        // whole entry covers every trace at once, like upstream resetting
        // scale[] in initialize().
        commands.clearScaleStates([scope.id]);
        commands.resetScope(scope.id);
      },
    },
    {
      label: 'Export CSV',
      action: exportCsv,
    },
    {
      label: 'Properties',
      action: () => commands.openScopeProperties(scope.id),
    },
  ];
}
