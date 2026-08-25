/** Clipboard persistence. Upstream writes its clipboard netlist to storage
 *  under "circuitClipboard" and falls back to reading storage whenever the
 *  in-memory copy is null (CommandManager.java:441-453, :517-523), so a Copy
 *  survives an F5 and reaches another tab of the same browser. The port keeps
 *  that shape: a storage-backed key, deliberately not navigator.clipboard,
 *  which upstream does not use either. Pure and DOM-free like appPrefs.ts, so
 *  it is testable under the node vitest environment. */

import type { StorageLike } from './appPrefs';

export const CLIPBOARD_STORAGE_KEY = 'circuitClipboard';

/** Largest clipboard text written to storage. A circuit dump is a few
 *  kilobytes; a selection near this bound would gamble the tab's whole quota
 *  on a paste nobody will make, so the write is skipped and only the session
 *  copy works. */
const MAX_STORED_LENGTH = 1_000_000;

/** The browser storage, or undefined in a node test environment. Guarded
 *  because the store initializer calls this at creation, and with site data
 *  blocked the property access itself throws SecurityError (the same guard
 *  appPrefs.defaultStorage carries). */
function defaultStorage(): StorageLike | undefined {
  try {
    if (typeof globalThis === 'undefined') return undefined;
    return (globalThis as { localStorage?: StorageLike }).localStorage;
  } catch {
    // Storage denied: run without persistence rather than crash.
    return undefined;
  }
}

/** Reads the stored clipboard, or null when storage is missing, denied,
 *  empty, or holds nothing usable. An empty string counts as no clipboard,
 *  matching upstream's `clipboard != null && clipboard.length() > 0` probe. */
export function loadStoredClipboard(
  storage: StorageLike | undefined = defaultStorage(),
): string | null {
  if (!storage) return null;
  let raw: string | null = null;
  try {
    raw = storage.getItem(CLIPBOARD_STORAGE_KEY);
  } catch {
    return null;
  }
  return raw !== null && raw !== '' ? raw : null;
}

/** Writes the clipboard beside the app prefs. A storage failure (private
 *  mode, quota, a string past the size guard) is swallowed: the in-session
 *  copy keeps working, exactly as upstream's null-storage branch does. */
export function saveStoredClipboard(
  text: string,
  storage: StorageLike | undefined = defaultStorage(),
): void {
  if (!storage || text.length > MAX_STORED_LENGTH) return;
  try {
    storage.setItem(CLIPBOARD_STORAGE_KEY, text);
  } catch {
    // Persistence is a convenience here, never a crash.
  }
}
