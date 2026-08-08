import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RECOVERY_STORAGE_KEY,
  clearRecovery,
  readRecovery,
  startAutoSave,
  writeRecovery,
  type AutoSaveState,
  type RecoveryStorage,
} from './recovery';

/** A plain-object recovery storage, injected so the module never touches the
 *  real DOM localStorage under the node test environment. */
const fakeStorage = () => {
  const map = new Map<string, string>();
  return {
    storage: {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    } as RecoveryStorage,
    raw: () => map.get(RECOVERY_STORAGE_KEY) ?? null,
  };
};

/** A minimal zustand-shaped store the watcher can subscribe to. `text` stands
 *  in for the serialised netlist the store's own toNetlist would produce, and
 *  `lastSaved` for the export/load baseline the write-time clean check reads. */
function fakeStore(initial = { revision: 0, paramRevision: 0, text: '', lastSaved: '' }) {
  let state = { ...initial };
  const listeners = new Set<(s: AutoSaveState, p: AutoSaveState) => void>();
  return {
    getState: () => state,
    setState: (next: Partial<typeof initial>) => {
      const prev = state;
      state = { ...state, ...next };
      for (const l of [...listeners]) l(state, prev);
    },
    subscribe: (l: (s: AutoSaveState, p: AutoSaveState) => void) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
  };
}

/** The common watcher wiring the autosave tests share. */
function watch(store: ReturnType<typeof fakeStore>, storage: RecoveryStorage, now: () => number = () => 0) {
  return startAutoSave(() => store, () => store.getState().text, { storage, delayMs: 1000, now });
}

afterEach(() => vi.useRealTimers());

describe('recovery storage', () => {
  it('write then read round-trips the plain text', () => {
    const { storage } = fakeStorage();
    const dump = '$ 1 0.000005 10.2 50 5 43 5e-11\nr 0 0 16 0 0 100\n';
    writeRecovery(dump, storage);
    expect(readRecovery(storage)).toBe(dump);
  });

  it('an absent key reads as null', () => {
    const { storage } = fakeStorage();
    expect(readRecovery(storage)).toBeNull();
  });

  it('clear removes the stored recovery', () => {
    const { storage } = fakeStorage();
    writeRecovery('recovered', storage);
    clearRecovery(storage);
    expect(readRecovery(storage)).toBeNull();
  });

  it('a storage that throws degrades to a no-op and never crashes', () => {
    const throwing = {
      getItem: () => {
        throw new Error('quota');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {
        throw new Error('quota');
      },
    } as unknown as RecoveryStorage;
    expect(() => writeRecovery('x', throwing)).not.toThrow();
    expect(() => readRecovery(throwing)).not.toThrow();
    expect(readRecovery(throwing)).toBeNull();
    expect(() => clearRecovery(throwing)).not.toThrow();
  });
});

describe('startAutoSave', () => {
  it('does not write on the initial subscribe', () => {
    vi.useFakeTimers();
    const store = fakeStore();
    const { storage, raw } = fakeStorage();
    watch(store, storage);
    vi.advanceTimersByTime(5000);
    expect(raw()).toBeNull();
  });

  it('a content change schedules one write after the delay', () => {
    vi.useFakeTimers();
    const store = fakeStore();
    const { storage, raw } = fakeStorage();
    watch(store, storage);
    store.setState({ revision: 1, text: 'changed' });
    expect(raw()).toBeNull();
    vi.advanceTimersByTime(999);
    expect(raw()).toBeNull();
    vi.advanceTimersByTime(1);
    expect(raw()).toBe('changed');
  });

  it('a burst of changes within the delay coalesces to one write of the final text', () => {
    vi.useFakeTimers();
    const store = fakeStore();
    const { storage, raw } = fakeStorage();
    watch(store, storage);
    store.setState({ revision: 1, text: 'a' });
    store.setState({ revision: 2, text: 'b' });
    store.setState({ revision: 3, text: 'c' });
    expect(raw()).toBeNull();
    vi.advanceTimersByTime(1000);
    expect(raw()).toBe('c');
    vi.advanceTimersByTime(5000);
    expect(raw()).toBe('c');
  });

  it('a change after the timer fired schedules a fresh write', () => {
    vi.useFakeTimers();
    const store = fakeStore();
    const { storage, raw } = fakeStorage();
    watch(store, storage);
    store.setState({ revision: 1, text: 'first' });
    vi.advanceTimersByTime(1000);
    expect(raw()).toBe('first');
    store.setState({ revision: 2, text: 'second' });
    vi.advanceTimersByTime(1000);
    expect(raw()).toBe('second');
  });

  it('a value-only edit bumps paramRevision and autosaves too', () => {
    vi.useFakeTimers();
    const store = fakeStore();
    const { storage, raw } = fakeStorage();
    watch(store, storage);
    store.setState({ paramRevision: 1, text: 'value changed' });
    vi.advanceTimersByTime(1000);
    expect(raw()).toBe('value changed');
  });

  it('a selection-only change (no revision or paramRevision bump) does not write', () => {
    vi.useFakeTimers();
    const store = fakeStore();
    const { storage, raw } = fakeStorage();
    watch(store, storage);
    store.setState({ text: 'same netlist' });
    vi.advanceTimersByTime(5000);
    expect(raw()).toBeNull();
  });

  it('the injected clock drives the due time', () => {
    vi.useFakeTimers();
    let clock = 0;
    const store = fakeStore();
    const { storage, raw } = fakeStorage();
    watch(store, storage, () => clock);
    clock = 100;
    store.setState({ revision: 1, text: 't' });
    expect(raw()).toBeNull();
    clock += 1000;
    vi.advanceTimersByTime(1000);
    expect(raw()).toBe('t');
  });

  it('a revision bump on a clean circuit (the starter-load case) does not write', () => {
    vi.useFakeTimers();
    // The store loaded a netlist: lastSaved equals what toNetlist produces,
    // exactly as loadNetlist sets both. The load bumped revision, so the
    // watcher schedules a write, but the write must be skipped at fire time.
    const store = fakeStore({ revision: 0, paramRevision: 0, text: 'starter', lastSaved: 'starter' });
    const { storage, raw } = fakeStorage();
    writeRecovery('stale recovery from a previous session', storage);
    watch(store, storage);
    store.setState({ revision: 1 });
    vi.advanceTimersByTime(5000);
    expect(raw()).toBe('stale recovery from a previous session');
  });

  it('a revision bump that changes the netlist writes', () => {
    vi.useFakeTimers();
    const store = fakeStore({ revision: 0, paramRevision: 0, text: 'starter', lastSaved: 'starter' });
    const { storage, raw } = fakeStorage();
    watch(store, storage);
    store.setState({ revision: 1, text: 'edited' });
    vi.advanceTimersByTime(1000);
    expect(raw()).toBe('edited');
  });

  it('the clean check reads lastSaved at fire time, not schedule time', () => {
    vi.useFakeTimers();
    // loadNetlist bumps revision before it settles lastSaved: at schedule time
    // lastSaved still points at the pre-load baseline, which would wrongly look
    // dirty; by fire time the baseline equals the loaded netlist, so the write
    // must be skipped.
    const store = fakeStore({ revision: 0, paramRevision: 0, text: 'edited', lastSaved: 'old baseline' });
    const { storage, raw } = fakeStorage();
    writeRecovery('stale', storage);
    watch(store, storage);
    store.setState({ revision: 1, text: 'loaded', lastSaved: 'old baseline' });  // the revision-bump set
    store.setState({ lastSaved: 'loaded' });  // the baseline-settle set
    vi.advanceTimersByTime(5000);
    expect(raw()).toBe('stale');
  });

  it('the stop handle unsubscribes and cancels a pending write', () => {
    vi.useFakeTimers();
    const store = fakeStore();
    const { storage, raw } = fakeStorage();
    const stop = watch(store, storage);
    store.setState({ revision: 1, text: 't' });
    stop();
    // A change after stop must neither schedule a write nor re-subscribe.
    store.setState({ revision: 2, text: 'u' });
    vi.advanceTimersByTime(5000);
    expect(raw()).toBeNull();
  });
});
