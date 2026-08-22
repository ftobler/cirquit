import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type CircuitElement } from '../model/types';
import type { ScopeDrawSource } from '../engine/simulator';
import { addResistor, fresh } from './store.test-helpers';
import { useStore } from './store';
import { detachUndockedWindow, noteUndockedHello, pushUndockedScopeFrame } from '../undocked/opener';

/** A fake popup window: postMessage is recorded so the tests can assert what
 *  the mirror pushed, and `closed` is a settable property for the reaper. */
function fakeWindow() {
  const posted: unknown[] = [];
  return {
    posted,
    closed: false,
    close: vi.fn(function (this: { closed: boolean }) {
      this.closed = true;
    }),
    postMessage: vi.fn((message: unknown) => posted.push(message)),
  };
}

type FakeWin = ReturnType<typeof fakeWindow>;

/** Minimal engine surface for the push: every listed plot id gets one min/max
 *  column of samples, like the real engine's trace list. */
function stubSource(plotIds: number[]): ScopeDrawSource {
  const data = new Float32Array([1.5, -1.5]);
  return {
    time: 0.002,
    scopeIndexOf: (id: number) => {
      const index = plotIds.indexOf(id);
      return index < 0 ? undefined : index;
    },
    scopeData: () => data,
    scopeDiverged: () => false,
    triggerInfo: () => ({
      columns: 2,
      snapshot_start: 0,
      start_index: 0,
      state: 0,
      time: 0,
      triggered: false,
      valid_count: 1,
      waiting: true,
      written: 1,
      free: () => undefined,
    }),
    recentSamples: () => new Float32Array(0),
  };
}

describe('undocked scope window', () => {
  let win: FakeWin;

  beforeEach(() => {
    useStore.setState(fresh());
    win = fakeWindow();
    vi.stubGlobal('window', {
      open: vi.fn(() => win),
      // openUndockedScope reads BASE_URL for the page URL; nothing here
      // inspects it, so a plain object satisfies the access.
      location: { href: 'http://localhost/' },
    });
  });

  afterEach(() => {
    // The bridge holds module state across tests; drop it so one test's
    // attachment cannot leak into the next.
    detachUndockedWindow(false);
    vi.unstubAllGlobals();
  });

  it('open creates a scope, records the entry and keeps the docked panel', () => {
    const elementId = addResistor();
    useStore.getState().openUndockedScope(elementId);
    const st = useStore.getState();
    expect(st.undocked).not.toBeNull();
    expect(st.undocked?.windowRef).toBe(win as unknown as Window);
    const scope = st.scopes.find((s) => s.id === st.undocked?.scopeId);
    expect(scope).toBeDefined();
    // Upstream's viewInFloatScope always makes a new scope for the element:
    // a voltage plot plus its current companion.
    expect(scope?.plots.map((p) => p.value)).toEqual(['voltage', 'current']);
    expect(window.open).toHaveBeenCalledTimes(1);
  });

  it('a second open is refused while one is up', () => {
    useStore.getState().openUndockedScope(addResistor());
    const first = useStore.getState().undocked;
    const scopeCount = useStore.getState().scopes.length;
    useStore.getState().openUndockedScope(addResistor());
    expect(useStore.getState().undocked).toBe(first);
    expect(useStore.getState().scopes.length).toBe(scopeCount);
    expect(useStore.getState().notice).toContain('already open');
    expect(window.open).toHaveBeenCalledTimes(1);
  });

  it('close clears the entry and closes the window', () => {
    useStore.getState().openUndockedScope(addResistor());
    useStore.getState().closeUndockedScope();
    expect(useStore.getState().undocked).toBeNull();
    expect(win.close).toHaveBeenCalled();
  });

  it('a blocked pop-up falls back to a visible note instead of failing silently', () => {
    vi.stubGlobal('window', {
      open: vi.fn(() => null),
      location: { href: 'http://localhost/' },
    });
    useStore.getState().openUndockedScope(addResistor());
    expect(useStore.getState().undocked).toBeNull();
    expect(useStore.getState().notice).toContain('blocked');
    // No half-open state, no orphan scope from a window that never appeared.
    expect(useStore.getState().scopes.length).toBe(0);
  });

  it('the opened window receives the scope spec and a first sample frame', () => {
    const elementId = addResistor();
    useStore.getState().openUndockedScope(elementId);
    const { undocked } = useStore.getState();
    const scope = useStore
      .getState()
      .scopes.find((s) => s.id === undocked?.scopeId)!;
    // The child says hello once loaded; only then does the mirror start.
    noteUndockedHello({ source: win as unknown as Window });
    pushUndockedScopeFrame({
      source: stubSource(scope.plots.map((p) => p.id)),
      scopes: useStore.getState().scopes,
      elements: useStore.getState().elements as CircuitElement[],
      settings: DEFAULT_SETTINGS,
      dark: true,
      scopeId: undocked?.scopeId,
    });
    expect(win.postMessage).toHaveBeenCalledTimes(1);
    const message = win.posted[0] as {
      type: string;
      time: number;
      scope: typeof scope;
      traces: { plotId: number; diverged: boolean }[];
      title: string;
    };
    // One message carries both halves of the protocol: the draw state and
    // the samples drawn from it.
    expect(message.type).toBe('undocked-frame');
    expect(message.scope).toEqual(scope);
    expect(message.time).toBeCloseTo(0.002);
    expect(message.traces.map((t) => t.plotId)).toEqual(scope.plots.map((p) => p.id));
    expect(message.title).toContain('Circuit Simulator');
  });
});
