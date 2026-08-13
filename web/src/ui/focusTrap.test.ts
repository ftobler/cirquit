import { describe, expect, it, vi } from 'vitest';
import { nextFocusIndex, type Focusable } from './focusTrap';

// Element-shaped stubs, so the trap never needs a DOM. Each carries an id so a
// failure message names the row; only `.focus()` is part of the contract.
function stub(id: string): Focusable {
  return { focus: vi.fn(), id } as unknown as Focusable;
}

describe('nextFocusIndex', () => {
  it('returns null for an empty list', () => {
    expect(nextFocusIndex([], null, false)).toBeNull();
    expect(nextFocusIndex([], null, true)).toBeNull();
  });

  it('moves one row forward and backward', () => {
    const rows = [stub('a'), stub('b'), stub('c')];
    expect(nextFocusIndex(rows, rows[0], false)).toBe(1);
    expect(nextFocusIndex(rows, rows[1], false)).toBe(2);
    expect(nextFocusIndex(rows, rows[2], true)).toBe(1);
    expect(nextFocusIndex(rows, rows[1], true)).toBe(0);
  });

  it('wraps forward from the last to the first and backward from the first to the last', () => {
    const rows = [stub('a'), stub('b'), stub('c')];
    expect(nextFocusIndex(rows, rows[2], false)).toBe(0);
    expect(nextFocusIndex(rows, rows[0], true)).toBe(2);
  });

  it('brings focus outside the list back to the first row forward, the last backward', () => {
    const rows = [stub('a'), stub('b'), stub('c')];
    const outside = stub('outside');
    expect(nextFocusIndex(rows, outside, false)).toBe(0);
    expect(nextFocusIndex(rows, outside, true)).toBe(2);
    // No active element at all: the "panel itself just focused" case.
    expect(nextFocusIndex(rows, null, false)).toBe(0);
    expect(nextFocusIndex(rows, null, true)).toBe(2);
  });

  it('wraps a single-row list onto itself', () => {
    const rows = [stub('only')];
    expect(nextFocusIndex(rows, rows[0], false)).toBe(0);
    expect(nextFocusIndex(rows, rows[0], true)).toBe(0);
  });

  // Disabled filtering is the caller's job: the hook drops disabled elements
  // before building the list, so the helper never sees one and has no
  // disabled logic of its own. Pinned by the comment in focusTrap.ts.
});
