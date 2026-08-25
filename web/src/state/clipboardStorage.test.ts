/** I-M3 regression: the internal clipboard must survive a page reload.
 *  Upstream persists its clipboard netlist to storage and reads it back when
 *  the in-memory copy is null (CommandManager.java:441-453, :517-523); a
 *  reload used to grey Paste out here. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StorageLike } from './appPrefs';
import {
  CLIPBOARD_STORAGE_KEY,
  loadStoredClipboard,
  saveStoredClipboard,
} from './clipboardStorage';

function fakeStorage(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
  };
}

describe('clipboard storage', () => {
  it('round-trips the text through the injected storage', () => {
    const storage = fakeStorage();
    const text = '$ 1 0.000005\nr 0 0 16 0 0 100\n';
    saveStoredClipboard(text, storage);
    expect(storage.map.get(CLIPBOARD_STORAGE_KEY)).toBe(text);
    expect(loadStoredClipboard(storage)).toBe(text);
  });

  it('treats a missing or empty entry as no clipboard', () => {
    const storage = fakeStorage();
    expect(loadStoredClipboard(storage)).toBeNull();
    saveStoredClipboard('', storage);
    expect(loadStoredClipboard(storage)).toBeNull();
  });

  it('skips the write past the size guard instead of gambling the quota', () => {
    const storage = fakeStorage();
    saveStoredClipboard('x'.repeat(1_000_001), storage);
    expect(storage.map.has(CLIPBOARD_STORAGE_KEY)).toBe(false);
  });

  it('a throwing backend is swallowed by both directions', () => {
    const boom = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(loadStoredClipboard(boom)).toBeNull();
    expect(() => saveStoredClipboard('text', boom)).not.toThrow();
  });
});

describe('copy survives a store restart', () => {
  const prevStorage = globalThis.localStorage;
  let restore = () => {};

  afterEach(() => restore());

  // The module re-import instantiates the wasm engine, which brushes the
  // default budget when the full suite runs beside heavy sibling workers.
  it('a fresh module registry reads the stored clipboard at creation', { timeout: 30000 }, async () => {
    const map = new Map<string, string>();
    const fake = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
    };
    Object.defineProperty(globalThis, 'localStorage', { value: fake, configurable: true });
    restore = () =>
      Object.defineProperty(globalThis, 'localStorage', {
        value: prevStorage,
        configurable: true,
      });

    // Copy through the live store, exactly as the user would.
    vi.resetModules();
    const first = await import('./store');
    const id = first.useStore.getState().addElement({
      kind: 'resistor',
      x1: 0,
      y1: 0,
      x2: 160,
      y2: 0,
      flags: 0,
      params: { resistance: 1000 },
    });
    first.useStore.getState().select([id]);
    first.useStore.getState().copySelection();
    expect(map.get(CLIPBOARD_STORAGE_KEY)).toBe(first.useStore.getState().clipboard);

    // A fresh module registry re-runs the initializer that boots at import
    // time: the simulated F5. The store also caches its instance on globalThis,
    // which resetModules does not clear, so that slot has to go too or the
    // second import would hand back the very store that did the copy instead
    // of creating one whose clipboard is read from storage.
    vi.resetModules();
    Reflect.deleteProperty(globalThis, '__falstadCirquitStore');
    const second = await import('./store');
    expect(second.useStore.getState().clipboard).not.toBeNull();
    expect(second.useStore.getState().clipboard).toBe(map.get(CLIPBOARD_STORAGE_KEY));

    // Cut persists too, sharing copy's write path.
    const cutId = second.useStore.getState().addElement({
      kind: 'resistor',
      x1: 0,
      y1: 0,
      x2: 160,
      y2: 0,
      flags: 0,
      params: { resistance: 1000 },
    });
    second.useStore.getState().select([cutId]);
    second.useStore.getState().cutSelection();
    expect(second.useStore.getState().elements).toHaveLength(0);
    expect(map.get(CLIPBOARD_STORAGE_KEY)).toBe(second.useStore.getState().clipboard);
  });
});
