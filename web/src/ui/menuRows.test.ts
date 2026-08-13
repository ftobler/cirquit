import { describe, expect, it } from 'vitest';
import { deferred, type MenuItemDef } from './menuRows';

// The upstream menu rows the port does not implement, label and reason exactly
// as the menubar renders them. Pinning the list in the test keeps the Menus.java
// audit honest: a row that gets ported must be removed from Menubar.tsx and
// from here together.
const UNPORTED_ROWS: readonly [label: string, reason: string][] = [
  ['New Window…', 'The port is a single-window static site; there is no multi-window support'],
  ['Import From Dropbox…', 'Dropbox import needs a backend service; not available'],
  ['Find DC Operating Point', 'The DC operating point runs on reset; the one-shot command is not ported'],
  ['Small Grid', 'The grid spacing is fixed; the small-grid toggle is not ported'],
  ['Toolbar', 'The port has no toggleable toolbar; the parts panel is always visible'],
  ['Edit Values With Mouse Wheel', 'The wheel value stepper is always on; there is no toggle'],
  ['Toggle Dev Tools', 'The port is a web app, not Electron; there is no dev tools toggle'],
];

describe('deferred', () => {
  it('marks a row as deferred and disabled, with the reason as the tooltip', () => {
    const row = deferred('Small Grid', 'The grid spacing is fixed; the small-grid toggle is not ported');
    expect(row.deferred).toBe(true);
    expect(row.disabled).toBe(true);
    expect(row.disabledTitle).toBe('The grid spacing is fixed; the small-grid toggle is not ported');
    expect(row.onClick()).toBeUndefined();
  });

  it('every unported row is deferred with a non-empty reason', () => {
    expect(UNPORTED_ROWS.length).toBe(7);
    for (const [label, reason] of UNPORTED_ROWS) {
      const row = deferred(label, reason);
      expect(row.deferred).toBe(true);
      expect(row.disabled).toBe(true);
      expect(row.disabledTitle).toBe(reason);
      expect(row.shortcut).toBeUndefined();
    }
  });

  it('is distinguishable from a contextually disabled row', () => {
    const noSelection: MenuItemDef = {
      label: 'Cut',
      disabled: true,
      onClick: () => undefined,
    };
    expect(deferred('Small Grid', 'not ported').deferred).toBe(true);
    expect(noSelection.deferred).toBeUndefined();
  });
});
