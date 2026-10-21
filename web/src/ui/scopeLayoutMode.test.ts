import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCOPE_LAYOUT,
  SCOPE_LAYOUT_STORAGE_KEY,
  clampActiveTab,
  clampLayoutMode,
  loadScopeLayout,
  saveScopeLayout,
} from './scopeLayoutMode';

function memoryStorage(init: Record<string, string> = {}) {
  const data = { ...init };
  return {
    data,
    getItem: (k: string) => (k in data ? data[k] : null),
    setItem: (k: string, v: string) => {
      data[k] = v;
    },
  };
}

describe('scope layout mode', () => {
  it('defaults to the strip and accepts only the known layouts', () => {
    expect(DEFAULT_SCOPE_LAYOUT).toBe('strip');
    expect(clampLayoutMode('grid')).toBe('grid');
    expect(clampLayoutMode('tabs')).toBe('tabs');
    expect(clampLayoutMode('nonsense')).toBe('strip');
    expect(clampLayoutMode(null)).toBe('strip');
    expect(clampLayoutMode(3)).toBe('strip');
  });

  it('round-trips through storage', () => {
    const s = memoryStorage();
    expect(loadScopeLayout(s)).toBe('strip');
    saveScopeLayout('grid', s);
    expect(s.data[SCOPE_LAYOUT_STORAGE_KEY]).toBe('grid');
    expect(loadScopeLayout(s)).toBe('grid');
  });

  it('falls back to the default on garbage or a throwing backend', () => {
    expect(loadScopeLayout(memoryStorage({ [SCOPE_LAYOUT_STORAGE_KEY]: 'stripe' }))).toBe('strip');
    const throwing = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(loadScopeLayout(throwing)).toBe('strip');
    expect(() => saveScopeLayout('tabs', throwing)).not.toThrow();
  });

  it('clamps the active tab and wraps a step', () => {
    expect(clampActiveTab(0, 3)).toBe(0);
    expect(clampActiveTab(2, 3)).toBe(2);
    expect(clampActiveTab(3, 3)).toBe(0);
    expect(clampActiveTab(-1, 3)).toBe(2);
    // A column count that shrank under the stored index falls back in range.
    expect(clampActiveTab(5, 2)).toBe(1);
    expect(clampActiveTab(0, 0)).toBe(0);
    expect(clampActiveTab(NaN, 4)).toBe(0);
  });
});
