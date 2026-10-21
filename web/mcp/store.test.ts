/** The store has to import and instantiate with no DOM: the MCP server runs it
 *  under Node, where `window` and `localStorage` do not exist. This pins the
 *  contract the server relies on, and the persistence modules' no-storage
 *  no-ops, so a future unguarded storage read fails here rather than in the
 *  server. */

import { describe, expect, it } from 'vitest';
import { loadAppPrefs } from '../src/state/appPrefs';
import { loadStoredClipboard } from '../src/state/clipboardStorage';
import { readRecovery } from '../src/state/recovery';
import { useStore } from '../src/state/store';
import { fresh } from '../src/state/store.test-helpers';

describe('the store under Node', () => {
  it('imports and instantiates without window or localStorage', () => {
    expect(typeof window).toBe('undefined');
    expect(typeof globalThis.localStorage).toBe('undefined');
    // The store singleton is keyed on globalThis, so reset it rather than
    // assuming this file's worker started clean.
    useStore.setState(fresh());
    expect(useStore.getState().settings).toBeDefined();
    expect(useStore.getState().elements).toEqual([]);
  });

  it('degrades the persistence modules to no-ops without storage', () => {
    expect(loadAppPrefs(undefined)).toEqual({});
    expect(loadStoredClipboard(undefined)).toBeNull();
    expect(readRecovery(undefined)).toBeNull();
  });
});
