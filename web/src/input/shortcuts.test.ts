import { describe, expect, it } from 'vitest';
import type { StorageLike } from '../state/appPrefs';
import {
  chordOf,
  hasDuplicateChords,
  loadShortcutOverlay,
  matchShortcut,
  overlayFromRows,
  rowsFromOverlay,
  saveShortcutOverlay,
  SHORTCUTS,
  type KeyEventLike,
  type ShortcutOverlay,
} from './shortcuts';

const ev = (partial: Partial<KeyEventLike>): KeyEventLike => ({
  key: '',
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...partial,
});

describe('modifier combos', () => {
  it('Ctrl+Z undoes, Ctrl+Shift+Z and Ctrl+Y redo', () => {
    expect(matchShortcut(ev({ key: 'z', ctrlKey: true }))).toEqual({ type: 'undo' });
    expect(matchShortcut(ev({ key: 'z', ctrlKey: true, shiftKey: true }))).toEqual({
      type: 'redo',
    });
    expect(matchShortcut(ev({ key: 'y', ctrlKey: true }))).toEqual({ type: 'redo' });
  });

  it('Meta acts as ctrl, like upstream getMetaKey()', () => {
    expect(matchShortcut(ev({ key: 'z', metaKey: true }))).toEqual({ type: 'undo' });
    expect(matchShortcut(ev({ key: 's', metaKey: true }))).toEqual({ type: 'save' });
  });

  it('Ctrl/Cmd+C, X, V, D, A map to copy, cut, paste, duplicate, selectAll', () => {
    expect(matchShortcut(ev({ key: 'c', ctrlKey: true }))).toEqual({ type: 'copy' });
    expect(matchShortcut(ev({ key: 'x', ctrlKey: true }))).toEqual({ type: 'cut' });
    expect(matchShortcut(ev({ key: 'v', ctrlKey: true }))).toEqual({ type: 'paste' });
    expect(matchShortcut(ev({ key: 'd', ctrlKey: true }))).toEqual({ type: 'duplicate' });
    expect(matchShortcut(ev({ key: 'a', ctrlKey: true }))).toEqual({ type: 'selectAll' });
    expect(matchShortcut(ev({ key: 'c', metaKey: true }))).toEqual({ type: 'copy' });
  });

  it('Ctrl+S and Ctrl+O map to save and open', () => {
    expect(matchShortcut(ev({ key: 's', ctrlKey: true }))).toEqual({ type: 'save' });
    expect(matchShortcut(ev({ key: 'o', ctrlKey: true }))).toEqual({ type: 'open' });
  });

  it('Ctrl+P prints the schematic, not the page', () => {
    expect(matchShortcut(ev({ key: 'p', ctrlKey: true }))).toEqual({ type: 'print' });
    expect(matchShortcut(ev({ key: 'p', metaKey: true }))).toEqual({ type: 'print' });
    // Plain p stays unbound (P is PMOS placement upstream), and a shifted
    // Ctrl chord is unbound like the rest of the modifier group.
    expect(matchShortcut(ev({ key: 'p' }))).toBeNull();
    expect(matchShortcut(ev({ key: 'p', ctrlKey: true, shiftKey: true }))).toBeNull();
  });
});

describe('modifier exclusivity', () => {
  it('plain z, y, c and Shift+Z without ctrl all return null', () => {
    expect(matchShortcut(ev({ key: 'z' }))).toBeNull();
    expect(matchShortcut(ev({ key: 'y' }))).toBeNull();
    expect(matchShortcut(ev({ key: 'c' }))).toBeNull();
    expect(matchShortcut(ev({ key: 'z', shiftKey: true }))).toBeNull();
  });

  it('Ctrl+Alt+Z returns null, so Alt chords pass through', () => {
    expect(matchShortcut(ev({ key: 'z', ctrlKey: true, altKey: true }))).toBeNull();
  });

  it('arrow keys with ctrl or meta held return null, so Ctrl+arrow gestures pass through', () => {
    expect(matchShortcut(ev({ key: 'ArrowUp', ctrlKey: true }))).toBeNull();
    expect(matchShortcut(ev({ key: 'ArrowDown', ctrlKey: true }))).toBeNull();
    expect(matchShortcut(ev({ key: 'ArrowLeft', metaKey: true }))).toBeNull();
    expect(matchShortcut(ev({ key: 'ArrowRight', ctrlKey: true, shiftKey: true }))).toBeNull();
  });

  it('a shifted Ctrl chord is unbound, so browser combos like Ctrl+Shift+S pass through', () => {
    expect(matchShortcut(ev({ key: 's', ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(matchShortcut(ev({ key: 'c', ctrlKey: true, shiftKey: true }))).toBeNull();
  });
});

describe('delete keys', () => {
  it('Delete and Backspace both delete', () => {
    expect(matchShortcut(ev({ key: 'Delete' }))).toEqual({ type: 'delete' });
    expect(matchShortcut(ev({ key: 'Backspace' }))).toEqual({ type: 'delete' });
  });
});

describe('space, P and Escape', () => {
  it('Escape returns to select mode', () => {
    expect(matchShortcut(ev({ key: 'Escape' }))).toEqual({ type: 'escape' });
  });

  it('space is select mode, which pins the spacebar decision', () => {
    // Upstream: Space is temporary select mode, run/pause has no key
    // (UIManager.java:1285-1291). Space must never mean run/pause here.
    expect(matchShortcut(ev({ key: ' ' }))).toEqual({ type: 'selectMode' });
  });

  it('p and P are unbound: P is PMOS placement upstream, run/pause is button-only', () => {
    // The corrected decision recorded in the plan: the earlier draft's
    // P-as-run/pause is wrong because P arms PMOS upstream (PMosfetElm.java:25)
    // and p arms PNP. No letter is free, so run/pause has no key at all.
    expect(matchShortcut(ev({ key: 'p' }))).toBeNull();
    expect(matchShortcut(ev({ key: 'P', shiftKey: true }))).toBeNull();
  });
});

describe('nudge magnitude and sign', () => {
  it('arrows nudge by one unit-less grid step, resolved by the app against the grid size', () => {
    expect(matchShortcut(ev({ key: 'ArrowUp' }))).toEqual({ type: 'nudge', dx: 0, dy: -1 });
    expect(matchShortcut(ev({ key: 'ArrowDown' }))).toEqual({ type: 'nudge', dx: 0, dy: 1 });
    expect(matchShortcut(ev({ key: 'ArrowLeft' }))).toEqual({ type: 'nudge', dx: -1, dy: 0 });
    expect(matchShortcut(ev({ key: 'ArrowRight' }))).toEqual({ type: 'nudge', dx: 1, dy: 0 });
  });
});

describe('zoom keys', () => {
  it('-, +, = and 0 zoom out, in and reset, with numpad variants', () => {
    // '+' only exists behind Shift on most layouts, so the matcher must not
    // treat shift as a modifier here.
    expect(matchShortcut(ev({ key: '-', shiftKey: false }))).toEqual({ type: 'zoomOut' });
    expect(matchShortcut(ev({ key: 'Subtract' }))).toEqual({ type: 'zoomOut' });
    expect(matchShortcut(ev({ key: '+', shiftKey: true }))).toEqual({ type: 'zoomIn' });
    expect(matchShortcut(ev({ key: '=' }))).toEqual({ type: 'zoomIn' });
    expect(matchShortcut(ev({ key: 'Add' }))).toEqual({ type: 'zoomIn' });
    expect(matchShortcut(ev({ key: '0' }))).toEqual({ type: 'zoomReset' });
    expect(matchShortcut(ev({ key: 'Numpad0' }))).toEqual({ type: 'zoomReset' });
  });

  it('with ctrl held the zoom keys return null, so the browser page still zooms', () => {
    expect(matchShortcut(ev({ key: '+', ctrlKey: true }))).toBeNull();
    expect(matchShortcut(ev({ key: '-', ctrlKey: true }))).toBeNull();
    expect(matchShortcut(ev({ key: '0', ctrlKey: true }))).toBeNull();
  });
});

describe('geometry keys', () => {
  it('bare r, m, t rotate, mirror and swap; shift excludes them', () => {
    expect(matchShortcut(ev({ key: 'r' }))).toEqual({ type: 'rotate' });
    expect(matchShortcut(ev({ key: 'm' }))).toEqual({ type: 'mirror' });
    expect(matchShortcut(ev({ key: 't' }))).toEqual({ type: 'swap' });
    expect(matchShortcut(ev({ key: 'r', shiftKey: true }))).toBeNull();
    expect(matchShortcut(ev({ key: 'M', shiftKey: true }))).toBeNull();
  });
});

describe('find component key', () => {
  it('/ opens the search, with modifiers unbound', () => {
    expect(matchShortcut(ev({ key: '/' }))).toEqual({ type: 'findComponent' });
    expect(matchShortcut(ev({ key: '/', ctrlKey: true }))).toBeNull();
    expect(matchShortcut(ev({ key: '/', metaKey: true }))).toBeNull();
    // A shifted slash is '?' on most layouts and must not open the search.
    expect(matchShortcut(ev({ key: '?', shiftKey: true }))).toBeNull();
  });
});

describe('no conflicts in the SHORTCUTS table', () => {
  const VALID_TYPES = new Set([
    'undo',
    'redo',
    'delete',
    'escape',
    'selectMode',
    'nudge',
    'zoomIn',
    'zoomOut',
    'zoomReset',
    'save',
    'open',
    'copy',
    'cut',
    'paste',
    'duplicate',
    'selectAll',
    'rotate',
    'mirror',
    'swap',
    'print',
    'findComponent',
  ]);

  it('every (modifier, key) pair binds to exactly one action', () => {
    const seen = new Set<string>();
    for (const entry of SHORTCUTS) {
      const signature = `${entry.mod}:${entry.shift ?? 'any'}:${entry.key}`;
      // A duplicate chord would make the earlier row dead; fail loudly.
      expect(seen.has(signature)).toBe(false);
      seen.add(signature);
      expect(VALID_TYPES.has(entry.action.type)).toBe(true);
    }
  });

  it('every nudge binding carries a finite delta of exactly one grid step', () => {
    for (const entry of SHORTCUTS) {
      if (entry.action.type !== 'nudge') continue;
      const n = entry.action;
      expect([n.dx, n.dy].every(Number.isFinite)).toBe(true);
      expect([Math.abs(n.dx), Math.abs(n.dy)]).toContain(1);
    }
  });
});

// Test 8 is a design note, not an assertion: matchShortcut takes no repeat flag
// and is repeat-agnostic on purpose, so nudge, delete and zoom repeat freely
// while the caller decides whether a repeat toggles. There is no repeat field
// on KeyEventLike and none is wanted.
describe("repeat is the caller's concern", () => {
  it('resolves a repeated key identically every time, with no shared state', () => {
    const first = matchShortcut(ev({ key: 'ArrowRight' }));
    const second = matchShortcut(ev({ key: 'ArrowRight' }));
    expect(first).toEqual(second);
    expect(first).toEqual({ type: 'nudge', dx: 1, dy: 0 });
  });
});

describe('the user-assigned overlay', () => {
  it('a user-assigned chord overrides the hardcoded combo', () => {
    const overlay: ShortcutOverlay = { copy: 'Ctrl+z' };
    expect(matchShortcut(ev({ key: 'z', ctrlKey: true }), overlay)).toEqual({ type: 'copy' });
    // Meta counts as ctrl, exactly like the hardcoded rows.
    expect(matchShortcut(ev({ key: 'z', metaKey: true }), overlay)).toEqual({ type: 'copy' });
  });

  it('a user-assigned plain key fires where nothing hardcoded was bound', () => {
    const overlay: ShortcutOverlay = { undo: 'g' };
    expect(matchShortcut(ev({ key: 'g' }), overlay)).toEqual({ type: 'undo' });
    // Shift is its own chord dimension for a letter, like the hardcoded rows:
    // a user-assigned 'g' does not swallow Shift+G.
    expect(matchShortcut(ev({ key: 'G', shiftKey: true }), overlay)).toBeNull();
  });

  it('an assignment does not leak into other rows', () => {
    const overlay: ShortcutOverlay = { copy: 'x' };
    // Plain x is the assignment; Ctrl+x is untouched and still hardcoded cut,
    // and an unrelated key stays unbound.
    expect(matchShortcut(ev({ key: 'x' }), overlay)).toEqual({ type: 'copy' });
    expect(matchShortcut(ev({ key: 'x', ctrlKey: true }), overlay)).toEqual({ type: 'cut' });
    expect(matchShortcut(ev({ key: 'z' }), overlay)).toBeNull();
  });

  it('clearing a binding restores the hardcoded one', () => {
    const overlay: ShortcutOverlay = { copy: 'Ctrl+z' };
    expect(matchShortcut(ev({ key: 'z', ctrlKey: true }), overlay)).toEqual({ type: 'copy' });
    const cleared: ShortcutOverlay = { ...overlay, copy: '' };
    expect(matchShortcut(ev({ key: 'z', ctrlKey: true }), cleared)).toEqual({ type: 'undo' });
  });

  it('the overlay is pure data: an empty one changes nothing', () => {
    expect(matchShortcut(ev({ key: 'z', ctrlKey: true }), {})).toEqual({ type: 'undo' });
    expect(matchShortcut(ev({ key: 'z', ctrlKey: true }))).toEqual({ type: 'undo' });
  });

  it('a user-assigned Ctrl+z does not swallow Ctrl+Shift+Z', () => {
    const overlay: ShortcutOverlay = { copy: 'Ctrl+z' };
    expect(matchShortcut(ev({ key: 'z', ctrlKey: true, shiftKey: true }), overlay)).toEqual({
      type: 'redo',
    });
  });

  it('a user-assigned toggleRunning is the only way run/pause binds a key', () => {
    const overlay: ShortcutOverlay = { toggleRunning: 'p' };
    expect(matchShortcut(ev({ key: 'p' }), overlay)).toEqual({ type: 'toggleRunning' });
    expect(matchShortcut(ev({ key: 'p' }))).toBeNull();
  });

  it('a user assignment to / beats the hardcoded findComponent row', () => {
    // The overlay is consulted before the table, so assigning '/' to another
    // command wins over the default search binding (UIManager.java:1174).
    const overlay: ShortcutOverlay = { copy: '/' };
    expect(matchShortcut(ev({ key: '/' }), overlay)).toEqual({ type: 'copy' });
    // Without the assignment the default still opens the search.
    expect(matchShortcut(ev({ key: '/' }))).toEqual({ type: 'findComponent' });
  });
});

describe('chord signatures', () => {
  it('chordOf normalizes letters and reserves shift for letters only', () => {
    expect(chordOf(ev({ key: 'z' }))).toBe('z');
    expect(chordOf(ev({ key: 'Z', shiftKey: true }))).toBe('Shift+z');
    expect(chordOf(ev({ key: 'z', ctrlKey: true }))).toBe('Ctrl+z');
    expect(chordOf(ev({ key: 'z', ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+z');
    expect(chordOf(ev({ key: 'z', metaKey: true }))).toBe('Ctrl+z');
  });

  it('chordOf folds a shifted punctuation key into the key, not a Shift prefix', () => {
    expect(chordOf(ev({ key: '+', shiftKey: true }))).toBe('+');
    expect(chordOf(ev({ key: '=' }))).toBe('=');
    expect(chordOf(ev({ key: ' ' }))).toBe('Space');
  });

  it('rowsFromOverlay shows the table default when nothing is assigned', () => {
    const rows = rowsFromOverlay({});
    expect(rows.find((r) => r.action === 'undo')?.chord).toBe('Ctrl+z');
    expect(rows.find((r) => r.action === 'selectMode')?.chord).toBe('Space');
    expect(rows.find((r) => r.action === 'toggleRunning')?.chord).toBe('');
  });

  it('overlayFromRows skips unassigned rows and hasDuplicateChords flags clashes', () => {
    const rows = [
      { action: 'undo' as const, chord: 'g' },
      { action: 'copy' as const, chord: 'g' },
      { action: 'redo' as const, chord: '' },
    ];
    expect(hasDuplicateChords(rows)).toBe(true);
    const deduped = [
      { action: 'undo' as const, chord: 'g' },
      { action: 'copy' as const, chord: '' },
    ];
    expect(hasDuplicateChords(deduped)).toBe(false);
    expect(overlayFromRows(deduped)).toEqual({ undo: 'g' });
  });

  it('overlayFromRows keeps only genuine overrides, never a default row', () => {
    // A no-op OK must not write delete:'Delete', zoomIn:'+', zoomOut:'-',
    // zoomReset:'0' etc into the overlay: those would trip the App.tsx repeat
    // guard (ev.repeat && hasChord) on keys that must repeat. A row showing
    // its table default is an override of nothing and is omitted.
    const rows = [
      { action: 'delete' as const, chord: 'Delete' },  // the default
      { action: 'zoomIn' as const, chord: '+' },  // the default
      { action: 'undo' as const, chord: 'Ctrl+y' },  // a real override
      { action: 'toggleRunning' as const, chord: 'p' },
      { action: 'redo' as const, chord: '' },
    ];
    expect(overlayFromRows(rows)).toEqual({ undo: 'Ctrl+y', toggleRunning: 'p' });
  });
});

describe('shortcut overlay persistence', () => {
  /** A plain-object storage, injected so the module never touches the real
   *  DOM localStorage under the node test environment. */
  const fakeStorage = () => {
    const map = new Map<string, string>();
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
    } as StorageLike;
  };

  it('round-trips through injected storage', () => {
    const storage = fakeStorage();
    saveShortcutOverlay({ copy: 'Ctrl+z', toggleRunning: 'p' }, storage);
    expect(loadShortcutOverlay(storage)).toEqual({ copy: 'Ctrl+z', toggleRunning: 'p' });
  });

  it('a corrupt blob is a fallback, not a crash', () => {
    const storage = fakeStorage();
    storage.setItem('shortcuts.v1', '{not json');
    expect(loadShortcutOverlay(storage)).toEqual({});
  });

  it('drops unknown actions and malformed chords on load', () => {
    const storage = fakeStorage();
    storage.setItem(
      'shortcuts.v1',
      JSON.stringify({ copy: 'Ctrl+z', bogus: 'x', undo: 'not a chord!!', redo: '' }),
    );
    expect(loadShortcutOverlay(storage)).toEqual({ copy: 'Ctrl+z' });
  });

  it('drops host-reserved named keys so a hand-edited blob cannot persist them', () => {
    const storage = fakeStorage();
    storage.setItem(
      'shortcuts.v1',
      JSON.stringify({
        undo: 'Enter',
        copy: 'ArrowUp',
        redo: 'Ctrl+Enter',
        paste: 'Escape',
        selectAll: 'Shift+Tab',
      }),
    );
    expect(loadShortcutOverlay(storage)).toEqual({});
  });

  it('a missing blob and a missing storage both yield the defaults', () => {
    expect(loadShortcutOverlay(fakeStorage())).toEqual({});
    expect(loadShortcutOverlay(undefined)).toEqual({});
  });

  it('save is quiet when the storage throws', () => {
    const throwing = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota');
      },
    } as StorageLike;
    expect(() => saveShortcutOverlay({ undo: 'g' }, throwing)).not.toThrow();
    expect(() => saveShortcutOverlay({ undo: 'g' }, undefined)).not.toThrow();
  });
});
