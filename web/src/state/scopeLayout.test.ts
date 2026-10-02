import { describe, expect, it } from 'vitest';
import type { Scope } from '../engine/scopeModel';
import { moveScopeTo, scopeColumns } from './scopeLayout';

/** Only id and position matter to the layout. */
const scopes = (...cols: number[][]): Scope[] =>
  cols.flatMap((ids, position) => ids.map((id) => ({ id, position }) as Scope));

const layout = (list: Scope[] | null) => (list === null ? null : scopeColumns(list));

describe('scope layout moves', () => {
  it('groups columns by position, keeping list order inside a column', () => {
    expect(scopeColumns(scopes([1, 2], [3]))).toEqual([[1, 2], [3]]);
  });

  it('stacks a scope at the bottom of another column', () => {
    expect(layout(moveScopeTo(scopes([1], [2], [3]), 3, { kind: 'stack', withId: 1 }))).toEqual([
      [1, 3],
      [2],
    ]);
  });

  it('pulls a scope out of a stack into a new column anywhere', () => {
    const start = scopes([1, 2], [3]);
    expect(layout(moveScopeTo(start, 2, { kind: 'column', beforeId: null }))).toEqual([[1], [3], [2]]);
    expect(layout(moveScopeTo(start, 2, { kind: 'column', beforeId: 1 }))).toEqual([[2], [1], [3]]);
    expect(layout(moveScopeTo(start, 2, { kind: 'column', beforeId: 3 }))).toEqual([[1], [2], [3]]);
  });

  it('pulls a scope out to the left of the stack it came from', () => {
    expect(layout(moveScopeTo(scopes([1, 2], [3]), 1, { kind: 'column', beforeId: 2 }))).toEqual([
      [1],
      [2],
      [3],
    ]);
  });

  it('closes the gap a moved column leaves and renumbers contiguously', () => {
    const moved = moveScopeTo(scopes([1], [2], [3]), 2, { kind: 'stack', withId: 3 })!;
    expect(moved.map((s) => [s.id, s.position])).toEqual([
      [1, 0],
      [3, 1],
      [2, 1],
    ]);
    // Upstream's invariant: positions never decrease along the list.
    const pos = moved.map((s) => s.position);
    expect(pos).toEqual([...pos].sort((a, b) => a - b));
  });

  it('reports a no-op as null', () => {
    const start = scopes([1, 2], [3]);
    // Already the bottom of that column.
    expect(moveScopeTo(start, 2, { kind: 'stack', withId: 1 })).toBeNull();
    // Already alone in a column at that place.
    expect(moveScopeTo(start, 3, { kind: 'column', beforeId: null })).toBeNull();
    expect(moveScopeTo(start, 1, { kind: 'stack', withId: 1 })).toBeNull();
    expect(moveScopeTo(start, 99, { kind: 'column', beforeId: null })).toBeNull();
    expect(moveScopeTo(start, 1, { kind: 'stack', withId: 99 })).toBeNull();
  });

  it('keeps the object of a scope whose position did not change', () => {
    const start = scopes([1], [2], [3]);
    const moved = moveScopeTo(start, 3, { kind: 'stack', withId: 2 })!;
    expect(moved.find((s) => s.id === 1)).toBe(start[0]);
    expect(moved.find((s) => s.id === 3)).not.toBe(start[2]);
  });
});
