import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STRIP_HEIGHT,
  MIN_STRIP_HEIGHT,
  SCOPE_STRIP_STORAGE_KEY,
  clampStripHeight,
  loadStripHeight,
  saveStripHeight,
} from './scopeStrip';

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

describe('scope strip height', () => {
  it('clamps to the minimum and to 85% of the centre area', () => {
    expect(clampStripHeight(10, 1000)).toBe(MIN_STRIP_HEIGHT);
    expect(clampStripHeight(400, 1000)).toBe(400);
    expect(clampStripHeight(990, 1000)).toBe(850);
  });

  it('applies only the lower bound before layout', () => {
    expect(clampStripHeight(5000, 0)).toBe(5000);
    expect(clampStripHeight(NaN, 0)).toBe(DEFAULT_STRIP_HEIGHT);
  });

  it('never clamps below the minimum in a tiny window', () => {
    expect(clampStripHeight(200, 50)).toBe(MIN_STRIP_HEIGHT);
  });

  it('round-trips through storage', () => {
    const s = memoryStorage();
    expect(loadStripHeight(s)).toBe(DEFAULT_STRIP_HEIGHT);
    saveStripHeight(321.4, s);
    expect(s.data[SCOPE_STRIP_STORAGE_KEY]).toBe('321');
    expect(loadStripHeight(s)).toBe(321);
  });

  it('falls back to the default on garbage or a throwing backend', () => {
    expect(loadStripHeight(memoryStorage({ [SCOPE_STRIP_STORAGE_KEY]: 'abc' }))).toBe(
      DEFAULT_STRIP_HEIGHT,
    );
    expect(loadStripHeight(memoryStorage({ [SCOPE_STRIP_STORAGE_KEY]: '3' }))).toBe(
      DEFAULT_STRIP_HEIGHT,
    );
    const throwing = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(loadStripHeight(throwing)).toBe(DEFAULT_STRIP_HEIGHT);
    expect(() => saveStripHeight(200, throwing)).not.toThrow();
  });
});
