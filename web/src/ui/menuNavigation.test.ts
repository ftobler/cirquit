import { describe, expect, it } from 'vitest';
import {
  firstEnabledIndex,
  lastEnabledIndex,
  stepMenuCursor,
  type MenuRow,
} from './menuNavigation';

// Rows are plain `{ disabled }` stubs; no DOM or timing is involved.
const row = (disabled = false): MenuRow => ({ disabled });

describe('firstEnabledIndex / lastEnabledIndex', () => {
  it('finds the first and last enabled rows across disabled ones', () => {
    const rows = [row(true), row(), row(true), row()];
    expect(firstEnabledIndex(rows)).toBe(1);
    expect(lastEnabledIndex(rows)).toBe(3);
  });

  it('returns null when every row is disabled', () => {
    const rows = [row(true), row(true)];
    expect(firstEnabledIndex(rows)).toBeNull();
    expect(lastEnabledIndex(rows)).toBeNull();
  });

  it('returns null for an empty list', () => {
    expect(firstEnabledIndex([])).toBeNull();
    expect(lastEnabledIndex([])).toBeNull();
  });
});

describe('stepMenuCursor', () => {
  it('moves one row forward and backward, skipping disabled rows', () => {
    const rows = [row(), row(true), row(), row()];
    expect(stepMenuCursor(rows, 0, 'ArrowDown')).toBe(2);
    expect(stepMenuCursor(rows, 3, 'ArrowUp')).toBe(2);
    expect(stepMenuCursor(rows, 2, 'ArrowUp')).toBe(0);
  });

  it('wraps at both edges', () => {
    const rows = [row(), row(), row()];
    expect(stepMenuCursor(rows, 2, 'ArrowDown')).toBe(0);
    expect(stepMenuCursor(rows, 0, 'ArrowUp')).toBe(2);
  });

  it('wraps past a disabled run of rows', () => {
    // Last enabled is index 1; ArrowDown must skip the disabled tail and wrap
    // to the first enabled row.
    const rows = [row(), row(), row(true), row(true)];
    expect(stepMenuCursor(rows, 1, 'ArrowDown')).toBe(0);
    // First enabled is index 0; ArrowUp wraps past the disabled head.
    expect(stepMenuCursor(rows, 0, 'ArrowUp')).toBe(1);
  });

  it('Home and End jump to the first and last enabled rows', () => {
    const rows = [row(true), row(), row(true), row()];
    expect(stepMenuCursor(rows, 3, 'Home')).toBe(1);
    expect(stepMenuCursor(rows, 0, 'End')).toBe(3);
  });

  it('a null cursor opens onto the first enabled row with ArrowDown, the last with ArrowUp', () => {
    const rows = [row(true), row(), row(true)];
    expect(stepMenuCursor(rows, null, 'ArrowDown')).toBe(1);
    expect(stepMenuCursor(rows, null, 'ArrowUp')).toBe(1);
    const mixed = [row(true), row(), row(), row(true)];
    expect(stepMenuCursor(mixed, null, 'ArrowDown')).toBe(1);
    expect(stepMenuCursor(mixed, null, 'ArrowUp')).toBe(2);
  });

  it('an all-disabled menu stays put for every key', () => {
    const rows = [row(true), row(true)];
    expect(stepMenuCursor(rows, 0, 'ArrowDown')).toBeNull();
    expect(stepMenuCursor(rows, 0, 'ArrowUp')).toBeNull();
    expect(stepMenuCursor(rows, 0, 'Home')).toBeNull();
    expect(stepMenuCursor(rows, 0, 'End')).toBeNull();
    expect(stepMenuCursor(rows, null, 'ArrowDown')).toBeNull();
    expect(stepMenuCursor(rows, null, 'ArrowUp')).toBeNull();
  });

  it('a single-enabled-row menu wraps onto itself', () => {
    const rows = [row(true), row(), row(true)];
    expect(stepMenuCursor(rows, 1, 'ArrowDown')).toBe(1);
    expect(stepMenuCursor(rows, 1, 'ArrowUp')).toBe(1);
    expect(stepMenuCursor(rows, null, 'ArrowDown')).toBe(1);
    expect(stepMenuCursor(rows, null, 'ArrowUp')).toBe(1);
  });
});
