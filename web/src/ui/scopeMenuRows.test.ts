import { describe, expect, it } from 'vitest';
import type { ScopePlot } from '../engine/scopeModel';
import { scopeMenuRows } from './scopeMenuRows';

/** A minimal plot shape standing in for a loaded or created one. */
const plot = (id: number, overrides: Partial<ScopePlot> = {}): ScopePlot =>
  ({
    id,
    elementId: 7,
    value: 'voltage',
    manScale: null,
    manVPosition: 0,
    acCoupled: false,
    measurements: null,
    ...overrides,
  }) as ScopePlot;

/** The clicked scope, holding two samplable plots so Remove Plot is armed. */
const scopeOf = (maxScale = false) => ({
  id: 2,
  maxScale,
  plots: [plot(10), plot(11)],
});

interface Harness {
  rows: ReturnType<typeof scopeMenuRows>;
  calls: string[];
}

/** Builds the rows against a recorder: every command appends its name and
 *  arguments, so the mapping, the argument choice and the Reset pairing are
 *  all observable without a store. */
const harness = (
  overrides: {
    scope?: { id: number; maxScale: boolean; plots: ScopePlot[] };
    previous?: { id: number };
    plotId?: number;
  } = {},
): Harness => {
  const calls: string[] = [];
  const scope = overrides.scope ?? scopeOf();
  const rows = scopeMenuRows({
    scope,
    previous: overrides.previous,
    plotId: overrides.plotId ?? 11,
    exportCsv: () => calls.push('exportCsv'),
    commands: {
      removeScope: (id) => calls.push(`removeScope ${id}`),
      setScopeFlags: (id, patch) => calls.push(`setScopeFlags ${id} maxScale=${patch.maxScale}`),
      stackScope: (id) => calls.push(`stackScope ${id}`),
      unstackScope: (id) => calls.push(`unstackScope ${id}`),
      combineScopes: (intoId, fromId) => calls.push(`combineScopes ${intoId} ${fromId}`),
      removePlot: (scopeId, plotId) => calls.push(`removePlot ${scopeId} ${plotId}`),
      clearScaleStates: (ids) => calls.push(`clearScaleStates ${ids.join(',')}`),
      resetScope: (id) => calls.push(`resetScope ${id}`),
      openScopeProperties: (id) => calls.push(`openScopeProperties ${id}`),
    },
  });
  return { rows, calls };
};

/** Fires one row by label. */
const run = (h: Harness, label: string) => {
  const row = h.rows.find((r) => r.label === label);
  expect(row, `no row labelled ${label}`).toBeDefined();
  row?.action();
};

describe('scopeMenuRows', () => {
  it('lists the nine commands in menu order', () => {
    expect(harness().rows.map((r) => r.label)).toEqual([
      'Remove Scope',
      'Max Scale',
      'Stack',
      'Unstack',
      'Combine',
      'Remove Plot',
      'Reset',
      'Export CSV',
      'Properties',
    ]);
  });

  it('maps Remove Scope to the clicked scope', () => {
    const h = harness({ previous: { id: 1 } });
    run(h, 'Remove Scope');
    expect(h.calls).toEqual(['removeScope 2']);
  });

  it('toggles Max Scale off the scope\'s current mode', () => {
    const h = harness();
    run(h, 'Max Scale');
    expect(h.calls).toEqual(['setScopeFlags 2 maxScale=true']);
    const hot = harness({ scope: { id: 2, maxScale: true, plots: scopeOf().plots } });
    run(hot, 'Max Scale');
    expect(hot.calls).toEqual(['setScopeFlags 2 maxScale=false']);
  });

  it('targets Stack, Unstack and Combine at the previous scope', () => {
    const h = harness({ previous: { id: 1 } });
    run(h, 'Stack');
    run(h, 'Unstack');
    run(h, 'Combine');
    expect(h.calls).toEqual(['stackScope 2', 'unstackScope 2', 'combineScopes 1 2']);
  });

  it('removes the plot under the cursor by identity', () => {
    // Two same-value plots must remove independently: the id decides, not
    // the value.
    const h = harness({ plotId: 11 });
    run(h, 'Remove Plot');
    expect(h.calls).toEqual(['removePlot 2 11']);
  });

  it('pairs Reset as clearScaleStates then resetScope', () => {
    // The sticky scales are per (scope, units family), so the whole entry
    // goes first and the engine reset second, every time.
    const h = harness({ previous: { id: 1 } });
    run(h, 'Reset');
    expect(h.calls).toEqual(['clearScaleStates 2', 'resetScope 2']);
  });

  it('delegates Export CSV to the injected builder', () => {
    const h = harness();
    run(h, 'Export CSV');
    expect(h.calls).toEqual(['exportCsv']);
  });

  it('opens the properties dialog for the clicked scope', () => {
    const h = harness();
    run(h, 'Properties');
    expect(h.calls).toEqual(['openScopeProperties 2']);
  });

  it('disables Stack, Unstack and Combine exactly without a previous scope', () => {
    const alone = harness();
    for (const label of ['Stack', 'Unstack', 'Combine']) {
      expect(alone.rows.find((r) => r.label === label)?.disabled, label).toBe(true);
    }
    const stacked = harness({ previous: { id: 1 } });
    for (const label of ['Stack', 'Unstack', 'Combine']) {
      expect(stacked.rows.find((r) => r.label === label)?.disabled, label).toBeFalsy();
    }
  });

  it('arms Remove Plot exactly when canRemovePlot would allow the click', () => {
    // Stale id: the menu outlived its plot.
    expect(harness({ plotId: 99 }).rows.find((r) => r.label === 'Remove Plot')?.disabled).toBe(true);
    // Raw-only plot, kept only to preserve o line tokens.
    const rawOnly = harness({
      scope: { id: 2, maxScale: false, plots: [plot(10), plot(11, { value: null })] },
      plotId: 11,
    });
    expect(rawOnly.rows.find((r) => r.label === 'Remove Plot')?.disabled).toBe(true);
    // Last plot in the panel.
    const lastOne = harness({
      scope: { id: 2, maxScale: false, plots: [plot(11)] },
      plotId: 11,
    });
    expect(lastOne.rows.find((r) => r.label === 'Remove Plot')?.disabled).toBe(true);
    // The healthy case.
    expect(harness().rows.find((r) => r.label === 'Remove Plot')?.disabled).toBeFalsy();
  });

  it('leaves every other row enabled', () => {
    const gated = new Set(['Stack', 'Unstack', 'Combine', 'Remove Plot']);
    for (const row of harness().rows) {
      if (!gated.has(row.label)) expect(row.disabled?.valueOf(), row.label).toBeFalsy();
    }
  });
});
