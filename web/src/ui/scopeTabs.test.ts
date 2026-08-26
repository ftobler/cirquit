import { describe, expect, it } from 'vitest';
import type { Scope } from '../engine/scopeModel';
import { stackTabs } from './scopeTabs';

/** Only the fields stackTabs reads; the rest of a Scope is irrelevant here. */
const scope = (id: number, position: number, label = ''): Scope =>
  ({ id, position, label }) as Scope;

describe('stackTabs', () => {
  it('offers no tabs when the scope stands alone in its column', () => {
    const scopes = [scope(1, 0), scope(2, 1), scope(3, 2)];
    expect(stackTabs(scopes, 2)).toEqual([]);
  });

  it('offers no tabs for an id that names no scope', () => {
    expect(stackTabs([scope(1, 0)], 99)).toEqual([]);
  });

  it('lists every scope sharing the column, marking the current one', () => {
    const scopes = [scope(1, 0), scope(2, 0), scope(3, 1), scope(4, 0)];
    expect(stackTabs(scopes, 2)).toEqual([
      { id: 1, label: 'Scope 1', current: false },
      { id: 2, label: 'Scope 2', current: true },
      { id: 4, label: 'Scope 4', current: false },
    ]);
  });

  it('numbers tabs by the scope list, not by the position within the stack', () => {
    // Scope 4 keeps its "Scope 4" name even though it is the third in the
    // stack: the same numbering the element context menu's "Add to Existing
    // Scope" rows use, so the two agree about which scope is which.
    const labels = stackTabs([scope(1, 0), scope(2, 1), scope(3, 0), scope(4, 0)], 1).map(
      (t) => t.label,
    );
    expect(labels).toEqual(['Scope 1', 'Scope 3', 'Scope 4']);
  });

  it('prefers the scope own label when it has one', () => {
    const scopes = [scope(1, 0, 'Input'), scope(2, 0, '  '), scope(3, 0, ' Output ')];
    expect(stackTabs(scopes, 1).map((t) => t.label)).toEqual(['Input', 'Scope 2', 'Output']);
  });
});
