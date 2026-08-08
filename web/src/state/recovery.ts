/** Circuit auto-save recovery. The whole netlist is dumped into one
 *  localStorage key (upstream's UndoManager.writeRecoveryToStorage, key
 *  `circuitRecovery`) so a page reload can offer the File>Recover Auto-Save
 *  row. Matching the upstream key means a recovery left behind by the original
 *  app is readable here too. The module is pure and DOM-free, so it is testable
 *  under the node vitest environment. */

import type { StorageLike } from './appPrefs';

export const RECOVERY_STORAGE_KEY = 'circuitRecovery';

/** The recovery backend: the prefs storage plus removeItem for the clear.
 *  Tests inject a plain object. */
export interface RecoveryStorage extends StorageLike {
  removeItem(key: string): void;
}

/** The browser storage, or undefined in a node test environment. */
function defaultStorage(): RecoveryStorage | undefined {
  if (typeof globalThis === 'undefined') return undefined;
  return (globalThis as { localStorage?: RecoveryStorage }).localStorage;
}

/** Dumps the netlist into the recovery slot. A storage failure (private mode,
 *  quota) is swallowed: autosave is a convenience, never a crash. */
export function writeRecovery(
  text: string,
  storage: RecoveryStorage | undefined = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(RECOVERY_STORAGE_KEY, text);
  } catch {
    // Autosave must never take the app down with it.
  }
}

/** The stored recovery, or null when there is none. Plain text: the dump is a
 *  bare netlist, never JSON, so a failed parse is impossible. */
export function readRecovery(
  storage: RecoveryStorage | undefined = defaultStorage(),
): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(RECOVERY_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Drops the recovery. A failure just leaves the stale dump behind. Not wired
 *  into production: upstream never clears the slot on save, so neither does
 *  the port. Exported for tests and for a future explicit "discard recovery"
 *  feature. */
export function clearRecovery(
  storage: RecoveryStorage | undefined = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.removeItem(RECOVERY_STORAGE_KEY);
  } catch {
    // A failed clear leaves the old recovery in place.
  }
}

/** The slice of store state the autosave watcher compares on each change.
 *  Structural edits bump `revision`, value edits bump `paramRevision`;
 *  selection, pan and zoom bump neither. */
export interface AutoSaveState {
  revision: number;
  paramRevision: number;
}

/** The store surface the watcher touches: a zustand-shaped subscribe plus a
 *  getState for the write-time clean check. */
export interface AutoSaveStore {
  subscribe(listener: (state: AutoSaveState, prevState: AutoSaveState) => void): () => void;
  getState(): { lastSaved: string | null };
}

export interface AutoSaveOptions {
  storage?: RecoveryStorage;
  /** Idle time after the last change before the write lands. */
  delayMs?: number;
  /** The clock, injected so tests can drive the trailing edge without real
   *  time. Defaults to the ambient Date.now. */
  now?: () => number;
}

/** Watches the store and writes the current netlist to the recovery slot
 *  after edits. Trailing-edge: each content change resets the timer, so a
 *  burst of edits (a drag, a slider sweep) coalesces into one write of the
 *  final netlist `delayMs` after the last one. Nothing is written on the
 *  initial subscribe, and selection-only or display-only changes never bump
 *  either revision counter, so they do not autosave. A wider net than
 *  upstream on purpose: value edits (paramRevision) and undo/redo (revision)
 *  write recovery too, so a crash can never lose a tweaked value. Returns a
 *  stop handle that unsubscribes and cancels any pending write. */
export function startAutoSave(
  getStore: () => AutoSaveStore,
  toNetlist: () => string,
  options: AutoSaveOptions = {},
): () => void {
  const { storage, delayMs = 1000, now = () => Date.now() } = options;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cancel = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const write = () => {
    timer = null;
    const netlist = toNetlist();
    // A clean circuit (never edited since the last load or export) must not
    // overwrite the slot: a page load bumps revision via loadNetlist, and
    // clobbering the previous session's recovery with the starter circuit
    // would make File>Recover worthless. Checked at fire time, not schedule
    // time, because loadNetlist sets lastSaved a tick after the revision
    // bump. `lastSaved === null` is pre-load and never clean here.
    const lastSaved = getStore().getState().lastSaved;
    if (lastSaved !== null && lastSaved === netlist) return;
    writeRecovery(netlist, storage);
  };

  const unsubscribe = getStore().subscribe((state, prevState) => {
    // Only content changes autosave: structural edits bump `revision`, value
    // edits bump `paramRevision`, and the counters are unchanged for a
    // selection-only, pan or zoom frame. Comparing them also swallows the
    // no-op first snapshot, whose two counters equal the originals.
    if (state.revision === prevState.revision && state.paramRevision === prevState.paramRevision) {
      return;
    }
    // The due time comes from the injected clock; the timeout runs for the
    // remainder, so a write lands at least delayMs after the change that
    // (re)scheduled it.
    const due = now() + delayMs;
    cancel();
    timer = setTimeout(write, Math.max(0, due - now()));
  });

  return () => {
    unsubscribe();
    cancel();
  };
}
