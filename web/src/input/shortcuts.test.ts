import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { denyGlobalStorage } from '../../test/denyGlobalStorage';
import { ELEMENT_DEFS, PLACEMENT_BY_CHAR, TOOLBOX } from '../model/registry';
import type { StorageLike } from '../state/appPrefs';
import {
  actionLabel,
  chordOf,
  COMMAND_ACTIONS,
  ASSIGNABLE_ACTIONS,
  defaultBindingFor,
  hasChord,
  hasDuplicateChords,
  isDefaultBinding,
  isModifierKey,
  isPlacementAction,
  loadShortcutOverlay,
  matchShortcut,
  overlayFromRows,
  rowsFromOverlay,
  saveShortcutOverlay,
  SHORTCUTS,
  type KeyEventLike,
  type ShortcutOverlay,
  type ShortcutRow,
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
    // A shifted Ctrl chord is unbound like the rest of the modifier group;
    // plain p is the PNP placement char, asserted with the placement cases.
    expect(matchShortcut(ev({ key: 'p', ctrlKey: true, shiftKey: true }))).toBeNull();
  });
});

describe('modifier exclusivity', () => {
  it('plain y and Shift+Z without ctrl return null; z and c are placement chars', () => {
    expect(matchShortcut(ev({ key: 'y' }))).toBeNull();
    // Shift+Z is a capital Z, which no element claims.
    expect(matchShortcut(ev({ key: 'Z', shiftKey: true }))).toBeNull();
    expect(matchShortcut(ev({ key: 'z' }))).toEqual({ type: 'place', kind: 'zener' });
    expect(matchShortcut(ev({ key: 'c' }))).toEqual({ type: 'place', kind: 'capacitor' });
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

  it('space is rotate, which pins the spacebar decision', () => {
    // The owner's call: Space turns the grabbed or selected element. Upstream's
    // Space (temporary select mode) is dropped because Escape already does
    // that job. Space must never mean run/pause here, upstream has no key for
    // it at all (UIManager.java:1285-1291).
    expect(matchShortcut(ev({ key: ' ' }))).toEqual({ type: 'rotate' });
  });

  it('space with a modifier is unbound, so browser and app chords stay apart', () => {
    // Alt is its own matcher dimension and the row carries an explicit
    // shift: false, so neither Alt+Space nor Shift+Space rotates. Space is not
    // a placement char either, so nothing catches them further down.
    expect(matchShortcut(ev({ key: ' ', altKey: true }))).toBeNull();
    expect(matchShortcut(ev({ key: ' ', shiftKey: true }))).toBeNull();
    expect(matchShortcut(ev({ key: ' ', ctrlKey: true }))).toBeNull();
  });

  it('select mode keeps its action arm, reachable only by assigning it a key', () => {
    // The table row is gone but the action stays assignable, so a user who
    // wants upstream's Space behaviour can put it back. actionForChord runs
    // before the table, so the assignment beats the rotate row.
    expect(matchShortcut(ev({ key: ' ' }), { selectMode: 'Space' })).toEqual({
      type: 'selectMode',
    });
  });

  it('p and P arm the PNP and P-MOSFET tools, so run/pause stays button-only', () => {
    // P arms PMOS upstream (PMosfetElm.java:25) and p arms PNP; neither is
    // free for run/pause, which has no key at all.
    expect(matchShortcut(ev({ key: 'p' }))).toEqual({ type: 'place', kind: 'pnp' });
    expect(matchShortcut(ev({ key: 'P', shiftKey: true }))).toEqual({ type: 'place', kind: 'pmos' });
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
  it('plain r and t are upstream placement chars, not rotate and swap', () => {
    // The port's own rotate/mirror/swap used to sit on these letters; upstream
    // owns them (r is a resistor, t is a text label), so the commands moved to
    // Alt and the plain keys arm elements again.
    expect(matchShortcut(ev({ key: 'r' }))).toEqual({ type: 'place', kind: 'resistor' });
    expect(matchShortcut(ev({ key: 't' }))).toEqual({ type: 'place', kind: 'decoration' });
    // m has no upstream element and its command moved to Alt, so it is free.
    expect(matchShortcut(ev({ key: 'm' }))).toBeNull();
  });
});

describe('palette key', () => {
  it('/ opens the palette menu, with modifiers unbound', () => {
    expect(matchShortcut(ev({ key: '/' }))).toEqual({ type: 'openPalette' });
    expect(matchShortcut(ev({ key: '/', ctrlKey: true }))).toBeNull();
    expect(matchShortcut(ev({ key: '/', metaKey: true }))).toBeNull();
    // A shifted slash is '?' on most layouts and must not open the search.
    expect(matchShortcut(ev({ key: '?', shiftKey: true }))).toBeNull();
  });
});

describe('element placement chars', () => {
  it('the reported w and g arm the wire and ground tools', () => {
    expect(matchShortcut(ev({ key: 'w' }))).toEqual({ type: 'place', kind: 'wire' });
    expect(matchShortcut(ev({ key: 'g' }))).toEqual({ type: 'place', kind: 'ground' });
  });

  it('every registry shortcut resolves to its element, case-respectingly', () => {
    const expectKind = (key: string, kind: string, shiftKey = false) => {
      expect(matchShortcut(ev({ key, shiftKey }))).toEqual({ type: 'place', kind });
    };
    expectKind('w', 'wire');
    expectKind('g', 'ground');
    expectKind('r', 'resistor');
    expectKind('c', 'capacitor');
    expectKind('L', 'inductor', true);
    expectKind('d', 'diode');
    expectKind('z', 'zener');
    expectKind('l', 'led');
    expectKind('v', 'voltage');
    expectKind('V', 'rail', true);
    expectKind('s', 'switch');
    expectKind('S', 'switch2', true);
    expectKind('R', 'relay', true);
    expectKind('T', 'transformer', true);
    expectKind('n', 'npn');
    expectKind('p', 'pnp');
    expectKind('N', 'nmos', true);
    expectKind('P', 'pmos', true);
    expectKind('a', 'opamp');
    expectKind('i', 'logicInput');
    expectKind('o', 'logicOutput');
    expectKind('b', 'labeledNode');
    expectKind('t', 'decoration');
    expectKind('1', 'inverter');
    expectKind('2', 'andGate');
    expectKind('3', 'orGate');
    expectKind('4', 'xorGate');
    expectKind('@', 'nandGate', true);
    expectKind('#', 'norGate', true);
    expectKind('$', 'xnorGate', true);
  });

  it('the seven case pairs are distinct, each asserted separately', () => {
    expect(matchShortcut(ev({ key: 'p' }))).toEqual({ type: 'place', kind: 'pnp' });
    expect(matchShortcut(ev({ key: 'P', shiftKey: true }))).toEqual({ type: 'place', kind: 'pmos' });
    expect(matchShortcut(ev({ key: 's' }))).toEqual({ type: 'place', kind: 'switch' });
    expect(matchShortcut(ev({ key: 'S', shiftKey: true }))).toEqual({ type: 'place', kind: 'switch2' });
    expect(matchShortcut(ev({ key: 'c' }))).toEqual({ type: 'place', kind: 'capacitor' });
    expect(matchShortcut(ev({ key: 'C', shiftKey: true }))).toEqual({
      type: 'place',
      kind: 'polarizedCapacitor',
    });
    expect(matchShortcut(ev({ key: 'v' }))).toEqual({ type: 'place', kind: 'voltage' });
    expect(matchShortcut(ev({ key: 'V', shiftKey: true }))).toEqual({ type: 'place', kind: 'rail' });
    expect(matchShortcut(ev({ key: 'a' }))).toEqual({ type: 'place', kind: 'opamp' });
    // A is the swapped op-amp; W (routed wire) has no port tool, so it stays
    // unbound rather than aliasing its lowercase element.
    expect(matchShortcut(ev({ key: 'A', shiftKey: true }))).toEqual({ type: 'place', kind: 'opampSwap' });
    expect(matchShortcut(ev({ key: 'W', shiftKey: true }))).toBeNull();
    expect(matchShortcut(ev({ key: 'w' }))).toEqual({ type: 'place', kind: 'wire' });
    expect(matchShortcut(ev({ key: 'l' }))).toEqual({ type: 'place', kind: 'led' });
    expect(matchShortcut(ev({ key: 'L', shiftKey: true }))).toEqual({ type: 'place', kind: 'inductor' });
  });

  it('chars with no element resolve to null', () => {
    for (const key of ['q', 'e', 'x', 'y']) {
      expect(matchShortcut(ev({ key }))).toBeNull();
    }
  });

  it('modifiers suppress placement: Ctrl+w, Meta+w and Alt+w never arm a tool', () => {
    expect(matchShortcut(ev({ key: 'w', ctrlKey: true }))).toBeNull();
    expect(matchShortcut(ev({ key: 'w', metaKey: true }))).toBeNull();
    expect(matchShortcut(ev({ key: 'w', altKey: true }))).toBeNull();
    expect(matchShortcut(ev({ key: 'w', ctrlKey: true, shiftKey: true }))).toBeNull();
  });

  it('a user-assigned shortcut beats placement for the same char', () => {
    const overlay: ShortcutOverlay = { undo: 'w' };
    expect(matchShortcut(ev({ key: 'w' }), overlay)).toEqual({ type: 'undo' });
    expect(matchShortcut(ev({ key: 'w' }))).toEqual({ type: 'place', kind: 'wire' });
  });

  it('the derived element map and the command table never bind the same plain key', () => {
    // The collision test that would have caught the r/m/t overlap: a plain
    // command key and a placement char on the same letter would make one of
    // them dead, so any future overlap fails loudly.
    const commandKeys = new Set<string>();
    for (const entry of SHORTCUTS) {
      if (entry.mod || entry.alt) continue;
      commandKeys.add(entry.key);
    }
    for (const ch of PLACEMENT_BY_CHAR.keys()) {
      expect(commandKeys.has(ch)).toBe(false);
    }
  });

  it('no two defs or toolbox entries declare the same shortcut', () => {
    // The derived map is keyed by char, so a def-vs-toolbox overlap would
    // silently overwrite (last wins) without failing; scanning the union of
    // the defs and the split toolbox entries catches that too.
    const seen = new Set<string>();
    for (const d of ELEMENT_DEFS) {
      if (d.shortcut === undefined) continue;
      expect(seen.has(d.shortcut)).toBe(false);
      seen.add(d.shortcut);
    }
    for (const t of TOOLBOX) {
      if (t.shortcut === undefined) continue;
      expect(seen.has(t.shortcut)).toBe(false);
      seen.add(t.shortcut);
    }
  });
});

describe('alt geometry chords', () => {
  it('Alt+r, Alt+m and Alt+t rotate, mirror and swap', () => {
    expect(matchShortcut(ev({ key: 'r', altKey: true }))).toEqual({ type: 'rotate' });
    expect(matchShortcut(ev({ key: 'm', altKey: true }))).toEqual({ type: 'mirror' });
    expect(matchShortcut(ev({ key: 't', altKey: true }))).toEqual({ type: 'swap' });
  });

  it('Alt+Shift+r is excluded and other Alt+letter chords pass through', () => {
    expect(matchShortcut(ev({ key: 'r', altKey: true, shiftKey: true }))).toBeNull();
    expect(matchShortcut(ev({ key: 'z', altKey: true }))).toBeNull();
    expect(matchShortcut(ev({ key: 'g', altKey: true }))).toBeNull();
  });

  it('ctrl+alt never matches the alt rows, so the browser keeps those gestures', () => {
    expect(matchShortcut(ev({ key: 'r', altKey: true, ctrlKey: true }))).toBeNull();
  });

  it('a user-assigned Alt chord fires like any other overlay entry', () => {
    const overlay: ShortcutOverlay = { copy: 'Alt+r' };
    expect(matchShortcut(ev({ key: 'r', altKey: true }), overlay)).toEqual({ type: 'copy' });
    // Without the assignment the table default wins.
    expect(matchShortcut(ev({ key: 'r', altKey: true }))).toEqual({ type: 'rotate' });
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
    'openPalette',
    'place',
  ]);

  it('every (modifier, alt, key) triple binds to exactly one action', () => {
    const seen = new Set<string>();
    for (const entry of SHORTCUTS) {
      const signature = `${entry.mod}:${entry.alt ?? false}:${entry.shift ?? 'any'}:${entry.key}`;
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
    expect(matchShortcut(ev({ key: 'q' }), overlay)).toBeNull();
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
    // Without the assignment, p is the PNP placement char.
    expect(matchShortcut(ev({ key: 'p' }))).toEqual({ type: 'place', kind: 'pnp' });
  });

  it('a user assignment to / beats the hardcoded palette row', () => {
    // The overlay is consulted before the table, so assigning '/' to another
    // command wins over the default search binding (UIManager.java:1174).
    const overlay: ShortcutOverlay = { copy: '/' };
    expect(matchShortcut(ev({ key: '/' }), overlay)).toEqual({ type: 'copy' });
    // Without the assignment the default still opens the search.
    expect(matchShortcut(ev({ key: '/' }))).toEqual({ type: 'openPalette' });
  });

  it('an empty-string assignment is unassigned, never a binding', () => {
    // The old matcher guarded with truthiness, so {undo:''} fell through to
    // the defaults; the guard now lives in actionForChord so every caller
    // sees the same rule, the App.tsx repeat guard included. Storage never
    // persists an empty chord, but nothing stops one arriving in memory.
    const overlay: ShortcutOverlay = { undo: '', copy: 'x', 'place:wire': '' };
    expect(matchShortcut(ev({ key: 'z', ctrlKey: true }), overlay)).toEqual({ type: 'undo' });
    expect(matchShortcut(ev({ key: 'w' }), overlay)).toEqual({ type: 'place', kind: 'wire' });
    expect(matchShortcut(ev({ key: 'x' }), overlay)).toEqual({ type: 'copy' });
    expect(hasChord(overlay, 'Ctrl+z')).toBe(false);
    // No event produces the empty chord, but the query API must still refuse
    // to report an empty assignment as bound.
    expect(hasChord(overlay, '')).toBe(false);
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

  it('chordOf folds alt into its own prefix, before shift', () => {
    expect(chordOf(ev({ key: 'r', altKey: true }))).toBe('Alt+r');
    expect(chordOf(ev({ key: 'r', altKey: true, shiftKey: true }))).toBe('Alt+Shift+r');
    expect(chordOf(ev({ key: 'z', ctrlKey: true, altKey: true }))).toBe('Ctrl+Alt+z');
  });

  it('chordOf folds a shifted punctuation key into the key, not a Shift prefix', () => {
    expect(chordOf(ev({ key: '+', shiftKey: true }))).toBe('+');
    expect(chordOf(ev({ key: '=' }))).toBe('=');
    expect(chordOf(ev({ key: ' ' }))).toBe('Space');
  });

  it('rowsFromOverlay shows the table default when nothing is assigned', () => {
    const rows = rowsFromOverlay({});
    expect(rows.find((r) => r.action === 'undo')?.chord).toBe('Ctrl+z');
    // Space became rotate, so select mode shows an empty assignable row like
    // toggleRunning does.
    expect(rows.find((r) => r.action === 'selectMode')?.chord).toBe('');
    // Rotate has two table rows, Space first and Alt+r behind it; the dialog
    // names the first.
    expect(rows.find((r) => r.action === 'rotate')?.chord).toBe('Space');
    expect(rows.find((r) => r.action === 'mirror')?.chord).toBe('Alt+m');
    expect(rows.find((r) => r.action === 'swap')?.chord).toBe('Alt+t');
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
      { action: 'rotate' as const, chord: 'Space' },  // the default
      { action: 'undo' as const, chord: 'Ctrl+y' },  // a real override
      { action: 'toggleRunning' as const, chord: 'p' },
      { action: 'redo' as const, chord: '' },
    ];
    expect(overlayFromRows(rows)).toEqual({ undo: 'Ctrl+y', toggleRunning: 'p' });
  });
});

describe('default bindings and the Default button', () => {
  it('defaultBindingFor returns the table binding, or an empty string when none', () => {
    expect(defaultBindingFor('delete')).toBe('Delete');
    expect(defaultBindingFor('undo')).toBe('Ctrl+z');
    expect(defaultBindingFor('toggleRunning')).toBe('');
    // Two rotate rows, Space first: the dialog names the first, and Alt+r
    // stays a live second default that no row advertises.
    expect(defaultBindingFor('rotate')).toBe('Space');
    // Select mode lost its table row when Space became rotate, so it reads as
    // unassigned and an empty row for it is at its default.
    expect(defaultBindingFor('selectMode')).toBe('');
    expect(isDefaultBinding({ action: 'selectMode', chord: '' })).toBe(true);
  });

  it('isDefaultBinding reports a row at its default and rejects a genuine override', () => {
    // The delete row's default is the Delete key, so the empty chord is an
    // override, not a no-op: Default is the only way back once cleared.
    expect(isDefaultBinding({ action: 'delete', chord: 'Delete' })).toBe(true);
    expect(isDefaultBinding({ action: 'delete', chord: '' })).toBe(false);
    expect(isDefaultBinding({ action: 'undo', chord: 'Ctrl+z' })).toBe(true);
    expect(isDefaultBinding({ action: 'undo', chord: 'Ctrl+y' })).toBe(false);
    // An action with no table binding is at default when unassigned.
    expect(isDefaultBinding({ action: 'toggleRunning', chord: '' })).toBe(true);
    expect(isDefaultBinding({ action: 'toggleRunning', chord: 'p' })).toBe(false);
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

  it('an Alt chord round-trips through storage like any other', () => {
    const storage = fakeStorage();
    saveShortcutOverlay({ rotate: 'Alt+r' }, storage);
    expect(loadShortcutOverlay(storage)).toEqual({ rotate: 'Alt+r' });
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

  it('drops modifier-only and junk named-key chords', () => {
    // Assigning bare Shift would fire on every Shift press anywhere in the
    // editor and persist across reload; CapsLock, Dead and Unidentified are
    // the wider junk family the named-key grammar otherwise lets through
    // (review m1). None of them may survive a load, with or without a prefix.
    const storage = fakeStorage();
    storage.setItem(
      'shortcuts.v1',
      JSON.stringify({
        undo: 'Shift',
        copy: 'Control',
        cut: 'Alt',
        paste: 'Meta',
        redo: 'Ctrl+Shift',
        duplicate: 'CapsLock',
        selectAll: 'Dead',
        rotate: 'Unidentified',
      }),
    );
    expect(loadShortcutOverlay(storage)).toEqual({});
  });

  it('keeps Space assignable through storage', () => {
    const storage = fakeStorage();
    storage.setItem('shortcuts.v1', JSON.stringify({ toggleRunning: 'Space' }));
    expect(loadShortcutOverlay(storage)).toEqual({ toggleRunning: 'Space' });
  });

  it('a Delete chord is not assignable, so the Default button is the only way back', () => {
    // Delete stays a dialog-reserved clear key (NON_ASSIGNABLE_KEYS), so not
    // even a hand-edited delete:'Delete' blob persists. Restoring the cleared
    // delete row is the Default button's job, a pure dialog affordance.
    const storage = fakeStorage();
    storage.setItem('shortcuts.v1', JSON.stringify({ delete: 'Delete' }));
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

describe('denied-storage browsers', () => {
  /** Site data blocked (Firefox "Delete cookies and site data", Chrome
   *  "Block third-party cookies" strictness) makes the localStorage property
   *  access itself throw SecurityError. No injected storage here: the default
   *  argument is what must be guarded. */
  let restore = () => {};
  beforeEach(() => {
    restore = denyGlobalStorage();
  });
  afterEach(() => restore());

  it('loadShortcutOverlay falls back to {} when the storage access itself throws', () => {
    expect(loadShortcutOverlay()).toEqual({});
  });

  it('saveShortcutOverlay is quiet when the storage access itself throws', () => {
    expect(() => saveShortcutOverlay({ undo: 'g' })).not.toThrow();
  });
});

describe('modifier-only keydowns', () => {
  it('isModifierKey names exactly the four keyboard modifiers', () => {
    for (const k of ['Shift', 'Control', 'Alt', 'Meta']) expect(isModifierKey(k)).toBe(true);
    // The junk named keys are rejected by the chord grammar instead; they are
    // not modifiers and a capture box may still want to show them as refused.
    for (const k of ['CapsLock', 'Dead', 'Unidentified', 'Enter', 'a', ' ']) {
      expect(isModifierKey(k)).toBe(false);
    }
  });

  it('chordOf would fold a lone Shift into the bare chord the grammar must refuse', () => {
    // Pinning why the capture guard exists: without it, the row would read
    // 'Shift' and persist, firing paste on every Shift press in the editor.
    expect(chordOf(ev({ key: 'Shift' }))).toBe('Shift');
  });
});

// ─── Rebindable element-placement keys ───

describe('rebindable element-placement keys', () => {
  const fakeStorage = () => {
    const map = new Map<string, string>();
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
    } as StorageLike;
  };
  /** The chord a placement char seeds: uppercase letters fold into Shift+ the
   *  way chordOf reports them; everything else is the char itself. */
  const seedChord = (char: string): string =>
    char >= 'A' && char <= 'Z' ? `Shift+${char.toLowerCase()}` : char;

  it('every placement char gets an assignable row seeded with its registry letter', () => {
    const rows = rowsFromOverlay({});
    const placed = rows.filter((r) => isPlacementAction(r.action));
    expect(placed.length).toBe(PLACEMENT_BY_CHAR.size);
    for (const [char, tool] of PLACEMENT_BY_CHAR) {
      const row = rows.find((r) => r.action === `place:${tool}`);
      expect(row?.chord).toBe(seedChord(char));
    }
  });

  it('the default behaviour is unchanged: every letter still places what it did', () => {
    // The behavioural invariant over the whole table with an empty overlay.
    for (const [char, tool] of PLACEMENT_BY_CHAR) {
      expect(matchShortcut(ev({ key: char, shiftKey: char >= 'A' && char <= 'Z' }))).toEqual({
        type: 'place',
        kind: tool,
      });
    }
  });

  it('rebinding a placement key arms the element on the new chord', () => {
    const overlay: ShortcutOverlay = { 'place:resistor': 'q' };
    expect(matchShortcut(ev({ key: 'q' }), overlay)).toEqual({ type: 'place', kind: 'resistor' });
  });

  it('rebinding frees the old letter', () => {
    const overlay: ShortcutOverlay = { 'place:resistor': 'q' };
    expect(matchShortcut(ev({ key: 'r' }), overlay)).toBeNull();
  });

  it('an Alt chord carries a placement assignment and frees the bare letter', () => {
    const overlay: ShortcutOverlay = { 'place:wire': 'Alt+w' };
    expect(matchShortcut(ev({ key: 'w', altKey: true }), overlay)).toEqual({
      type: 'place',
      kind: 'wire',
    });
    expect(matchShortcut(ev({ key: 'w' }), overlay)).toBeNull();
  });

  it('a placement assignment sharing another row’s chord flags duplicates in the dialog', () => {
    const rows = rowsFromOverlay({ undo: 'g' });
    expect(rows.find((r) => r.action === 'place:ground')?.chord).toBe('g');
    expect(hasDuplicateChords(rows)).toBe(true);
  });

  it('overlayFromRows keeps only genuine placement overrides, never a default letter', () => {
    const rows: ShortcutRow[] = [
      { action: 'place:wire', chord: 'w' },  // the default
      { action: 'place:ground', chord: 'f' },  // a real override
    ];
    expect(overlayFromRows(rows)).toEqual({ 'place:ground': 'f' });
  });

  it('defaultBindingFor reports the seed letter, folding case into Shift', () => {
    expect(defaultBindingFor('place:wire')).toBe('w');
    expect(defaultBindingFor('place:rail')).toBe('Shift+v');
    expect(defaultBindingFor('place:nmos')).toBe('Shift+n');
    expect(defaultBindingFor('place:battery')).toBe('Shift+b');
    expect(defaultBindingFor('place:nandGate')).toBe('@');
    // The Default button restores it after a move.
    expect(isDefaultBinding({ action: 'place:resistor', chord: 'r' })).toBe(true);
    expect(isDefaultBinding({ action: 'place:resistor', chord: 'q' })).toBe(false);
  });

  it('placement assignments round-trip through storage', () => {
    const storage = fakeStorage();
    saveShortcutOverlay({ 'place:zener': 'Shift+k', 'place:nmos': 'Ctrl+m' }, storage);
    expect(loadShortcutOverlay(storage)).toEqual({
      'place:zener': 'Shift+k',
      'place:nmos': 'Ctrl+m',
    });
  });

  it('unknown placement actions and reserved named keys are dropped on load', () => {
    const storage = fakeStorage();
    storage.setItem(
      'shortcuts.v1',
      JSON.stringify({ 'place:bogus': 'q', 'place:wire': 'Enter', 'place:zener': '?' }),
    );
    expect(loadShortcutOverlay(storage)).toEqual({ 'place:zener': '?' });
  });

  it('row labels come from the registry defs, not a second name table', () => {
    expect(actionLabel('undo')).toBe('Undo');
    expect(actionLabel('place:npn')).toBe('NPN');
    expect(actionLabel('place:opampSwap')).toBe('Swapped Op-Amp');
    expect(actionLabel('place:resistor')).toBe(
      ELEMENT_DEFS.find((d) => d.kind === 'resistor')?.label,
    );
  });

  it('the assignable rows stay commands first, one per placement tool', () => {
    expect(ASSIGNABLE_ACTIONS.filter((a) => !isPlacementAction(a))).toEqual([...COMMAND_ACTIONS]);
    expect(ASSIGNABLE_ACTIONS.length).toBe(COMMAND_ACTIONS.length + PLACEMENT_BY_CHAR.size);
  });
});
