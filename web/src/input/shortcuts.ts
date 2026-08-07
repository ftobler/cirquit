/** Keyboard shortcut matching. Pure and DOM-free: it maps a plain event
 *  descriptor to an action id, and App.tsx does the dispatch. */

import { GRID_SIZE } from '../model/types';

export type ShortcutAction =
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'delete' }
  | { type: 'escape' }
  | { type: 'selectMode' }
  | { type: 'nudge'; dx: number; dy: number }
  | { type: 'zoomIn' }
  | { type: 'zoomOut' }
  | { type: 'zoomReset' }
  | { type: 'save' }
  | { type: 'open' }
  | { type: 'copy' }
  | { type: 'cut' }
  | { type: 'paste' }
  | { type: 'duplicate' }
  | { type: 'selectAll' }
  | { type: 'rotate' }
  | { type: 'mirror' }
  | { type: 'swap' };

export interface KeyEventLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export interface ShortcutEntry {
  /** Requires ctrl or meta held, and no alt. False requires none of the three. */
  mod: boolean;
  /** Required shift state. Undefined ignores shift, which the `+` zoom key
   *  needs: on most layouts it only exists behind Shift+=. */
  shift?: boolean;
  /** The key, lowercase for a Latin letter; punctuation and named keys exact. */
  key: string;
  action: ShortcutAction;
}

/** The binding table. Stage 3's user-assignable shortcut map is a runtime
 *  overlay on this table, so it must stay enumerable: one row per chord. */
export const SHORTCUTS: ShortcutEntry[] = [
  // Modifier chords, upstream's getCtrlKey() || getMetaKey()
  // (UIManager.java:1198). The shift-specific rows keep Ctrl+Shift+Z
  // distinguishable from Ctrl+Z, and a shifted Ctrl chord is unbound so
  // browser chords (Ctrl+Shift+S) pass through.
  { mod: true, shift: false, key: 'z', action: { type: 'undo' } },
  { mod: true, shift: true, key: 'z', action: { type: 'redo' } },
  { mod: true, shift: false, key: 'y', action: { type: 'redo' } },
  { mod: true, shift: false, key: 'c', action: { type: 'copy' } },
  { mod: true, shift: false, key: 'x', action: { type: 'cut' } },
  { mod: true, shift: false, key: 'v', action: { type: 'paste' } },
  { mod: true, shift: false, key: 'd', action: { type: 'duplicate' } },
  { mod: true, shift: false, key: 'a', action: { type: 'selectAll' } },
  { mod: true, shift: false, key: 's', action: { type: 'save' } },
  { mod: true, shift: false, key: 'o', action: { type: 'open' } },

  // Plain keys. Delete and Backspace both delete (UIManager.java:1134) and
  // the arrows nudge by exactly one grid step per press (UIManager.java:1153).
  // Ctrl+Delete / Ctrl+Backspace pass through to the browser: the mod combos
  // above are exclusive, so a held ctrl unmatches these plain rows, which is
  // the deliberate consequence of the exact-match matcher.
  { mod: false, key: 'Escape', action: { type: 'escape' } },
  { mod: false, key: ' ', action: { type: 'selectMode' } },
  { mod: false, key: 'Delete', action: { type: 'delete' } },
  { mod: false, key: 'Backspace', action: { type: 'delete' } },
  { mod: false, key: 'ArrowUp', action: { type: 'nudge', dx: 0, dy: -GRID_SIZE } },
  { mod: false, key: 'ArrowDown', action: { type: 'nudge', dx: 0, dy: GRID_SIZE } },
  { mod: false, key: 'ArrowLeft', action: { type: 'nudge', dx: -GRID_SIZE, dy: 0 } },
  { mod: false, key: 'ArrowRight', action: { type: 'nudge', dx: GRID_SIZE, dy: 0 } },

  // Zoom keys. '+' and '=' both zoom in and the numpad variants zoom too,
  // which is what upstream's charCode path produces for a numpad
  // (UIManager.java:1091-1099). '0' resets to exactly 100%.
  { mod: false, key: '-', action: { type: 'zoomOut' } },
  { mod: false, key: 'Subtract', action: { type: 'zoomOut' } },
  { mod: false, key: '+', action: { type: 'zoomIn' } },
  { mod: false, key: '=', action: { type: 'zoomIn' } },
  { mod: false, key: 'Add', action: { type: 'zoomIn' } },
  { mod: false, key: '0', action: { type: 'zoomReset' } },
  // Numpad 0 reports the same key '0' as the top row in every modern browser,
  // so this row is never hit; kept for parity with the Add/Subtract rows,
  // which do carry distinct keys ('NumpadAdd'/'NumpadSubtract' are legacy key
  // values some engines still emit).
  { mod: false, key: 'Numpad0', action: { type: 'zoomReset' } },

  // Geometry commands, the landed editing-gestures keys. Shift is excluded so
  // a shifted key cannot trigger them: in Stage 4 every letter of both cases
  // is an element placement char, and those rows would take precedence here.
  { mod: false, shift: false, key: 'r', action: { type: 'rotate' } },
  { mod: false, shift: false, key: 'm', action: { type: 'mirror' } },
  { mod: false, shift: false, key: 't', action: { type: 'swap' } },
];

export function matchShortcut(ev: KeyEventLike): ShortcutAction | null {
  // Alt is excluded from every binding so Alt+key browser and OS gestures pass
  // through. Upstream ignores alt; the port should not swallow it.
  if (ev.altKey) return null;
  // Letters match on the lowercase form (Shift+r is still r), punctuation and
  // named keys on the exact char.
  const key = ev.key.length === 1 && /[a-zA-Z]/.test(ev.key) ? ev.key.toLowerCase() : ev.key;
  for (const entry of SHORTCUTS) {
    if (entry.mod ? !(ev.ctrlKey || ev.metaKey) : ev.ctrlKey || ev.metaKey) continue;
    if (entry.shift !== undefined && entry.shift !== ev.shiftKey) continue;
    if (entry.key !== key) continue;
    return entry.action;
  }
  return null;
}
