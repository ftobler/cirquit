/** K-M1 regression: with site data blocked, the localStorage property access
 *  itself throws SecurityError. Store creation loads the shortcut overlay and
 *  the app prefs on module scope through default parameters, which evaluate
 *  before any body-level try/catch, so an unguarded storage lookup killed the
 *  whole bundle at boot: white screen instead of an editor. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { denyGlobalStorage } from '../../test/denyGlobalStorage';

let restoreStorage = () => {};

afterEach(() => restoreStorage());

describe('boot with site data blocked', () => {
  // The resetModules re-import rebuilds the whole module graph and
  // instantiates the wasm engine again, several seconds on its own; under a
  // loaded parallel suite run the default 5s budget is not enough.
  it('store creation survives a throwing localStorage access', { timeout: 30_000 }, async () => {
    restoreStorage = denyGlobalStorage();

    // A fresh module registry re-runs the store initializer that boots at
    // import time in the real app.
    vi.resetModules();
    const { useStore } = await import('./store');

    expect(useStore.getState().shortcuts).toEqual({});
  });
});
