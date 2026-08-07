import { describe, expect, it } from 'vitest';
import { GRID_SIZE } from '../model/types';
import { matchShortcut, SHORTCUTS, type KeyEventLike } from './shortcuts';

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
  it('arrows nudge by exactly one grid step, derived from the exported GRID_SIZE', () => {
    expect(matchShortcut(ev({ key: 'ArrowUp' }))).toEqual({ type: 'nudge', dx: 0, dy: -GRID_SIZE });
    expect(matchShortcut(ev({ key: 'ArrowDown' }))).toEqual({ type: 'nudge', dx: 0, dy: GRID_SIZE });
    expect(matchShortcut(ev({ key: 'ArrowLeft' }))).toEqual({ type: 'nudge', dx: -GRID_SIZE, dy: 0 });
    expect(matchShortcut(ev({ key: 'ArrowRight' }))).toEqual({ type: 'nudge', dx: GRID_SIZE, dy: 0 });
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
      expect([Math.abs(n.dx), Math.abs(n.dy)]).toContain(GRID_SIZE);
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
    expect(first).toEqual({ type: 'nudge', dx: GRID_SIZE, dy: 0 });
  });
});
