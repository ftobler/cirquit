import { describe, expect, it } from 'vitest';
import { deferred, type MenuItemDef } from './menuRows';

// The upstream menu rows the port does not implement, label and reason exactly
// as the menubar renders them. Pinning the list in the test keeps the Menus.java
// audit honest: a row that gets ported must be removed from Menubar.tsx and
// from here together.
const UNPORTED_ROWS: readonly [label: string, reason: string][] = [
  ['Find DC Operating Point', 'The DC operating point runs on reset; the one-shot command is not ported'],
  ['Toolbar', 'The port has no toggleable toolbar; the parts panel is always visible'],
  ['Toggle Dev Tools', 'The port is a web app, not Electron; there is no dev tools toggle'],
];

describe('deferred', () => {
  it('marks a row as deferred and disabled, with the reason as the tooltip', () => {
    const row = deferred('Toolbar', 'The port has no toggleable toolbar; the parts panel is always visible');
    expect(row.deferred).toBe(true);
    expect(row.disabled).toBe(true);
    expect(row.disabledTitle).toBe('The port has no toggleable toolbar; the parts panel is always visible');
    expect(row.onClick()).toBeUndefined();
  });

  it('every unported row is deferred with a non-empty reason', () => {
    expect(UNPORTED_ROWS.length).toBe(3);
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
    expect(deferred('Toolbar', 'not ported').deferred).toBe(true);
    expect(noSelection.deferred).toBeUndefined();
  });
});
