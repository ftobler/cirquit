import { describe, expect, it } from 'vitest';
import {
  dcOutcomeReport,
  deferred,
  fileMenuTailRows,
  findDcOperatingPointRow,
  toggleFullScreenRow,
  type MenuItemDef,
} from './menuRows';

// The upstream menu rows the port does not implement, label and reason exactly
// as the menubar renders them. Pinning the list in the test keeps the Menus.java
// audit honest: a row that gets ported must be removed from Menubar.tsx and
// from here together. Find DC Operating Point and Toggle Full Screen left this
// list when their commands landed.
const UNPORTED_ROWS: readonly [label: string, reason: string][] = [];

describe('deferred', () => {
  it('marks a row as deferred and disabled, with the reason as the tooltip', () => {
    const row = deferred('Toolbar', 'The port has no toggleable toolbar; the parts panel is always visible');
    expect(row.deferred).toBe(true);
    expect(row.disabled).toBe(true);
    expect(row.disabledTitle).toBe('The port has no toggleable toolbar; the parts panel is always visible');
    expect(row.onClick()).toBeUndefined();
  });

  it('every unported row is deferred with a non-empty reason', () => {
    expect(UNPORTED_ROWS.length).toBe(0);
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

describe('findDcOperatingPointRow', () => {
  it('is present, enabled, and never struck through', () => {
    // Run-mode like Reset, so the row ignores the editing gate: no disabled
    // flag and no deferral strikethrough may ever appear on it.
    let ran = false;
    const row = findDcOperatingPointRow(() => {
      ran = true;
    });
    expect(row.label).toBe('Find DC Operating Point');
    expect(row.disabled).toBeUndefined();
    expect(row.deferred).toBeUndefined();
    expect(row.shortcut).toBeUndefined(); // upstream carries none (Menus.java:135)
    row.onClick();
    expect(ran).toBe(true);
  });
});

describe('dcOutcomeReport', () => {
  it('maps success to the found notice', () => {
    expect(dcOutcomeReport(null)).toEqual({
      notice: 'Found the DC operating point',
      problem: null,
    });
  });

  it('maps degraded to the notice saying no operating point exists', () => {
    expect(dcOutcomeReport('degraded')).toEqual({
      notice: 'No DC operating point exists; the circuit restarted uncharged',
      problem: null,
    });
  });

  it('maps any other string to the engine message as a sticky problem', () => {
    expect(dcOutcomeReport('The circuit has no solution: check for shorted sources or missing connections.')).toEqual({
      notice: null,
      problem: 'The circuit has no solution: check for shorted sources or missing connections.',
    });
  });
});

describe('toggleFullScreenRow', () => {
  it('is present, enabled, and carries no shortcut, like Menus.java:141', () => {
    let ran = false;
    const row = toggleFullScreenRow(() => {
      ran = true;
    });
    expect(row.label).toBe('Toggle Full Screen');
    expect(row.disabled).toBeUndefined();
    expect(row.deferred).toBeUndefined();
    expect(row.shortcut).toBeUndefined();
    row.onClick();
    expect(ran).toBe(true);
  });
});

describe('fileMenuTailRows', () => {
  const tail = (fired: string[]) => ({
    print: () => void fired.push('Print…'),
    fullScreen: () => void fired.push('Toggle Full Screen'),
    about: () => void fired.push('About…'),
  });

  it('keeps the upstream tail order: Print, Toggle Full Screen, About', () => {
    // Menus.java:139-143 puts the toggle between Print and About. Pinning the
    // assembled tail here keeps the position honest without rendering JSX.
    const fired: string[] = [];
    const rows = fileMenuTailRows(tail(fired));
    expect(rows.map((r) => r.label)).toEqual(['Print…', 'Toggle Full Screen', 'About…']);
    expect(rows[0]?.shortcut).toBe('Ctrl+P');
    for (const r of rows) r.onClick();
    expect(fired).toEqual(['Print…', 'Toggle Full Screen', 'About…']);
  });

  it('separates the toggle from both neighbours, like Menus.java:140,:142', () => {
    const rows = fileMenuTailRows(tail([]));
    expect(rows[0]?.sepBefore).toBeUndefined();
    expect(rows[1]?.sepBefore).toBe(true);
    expect(rows[2]?.sepBefore).toBe(true);
  });
});
