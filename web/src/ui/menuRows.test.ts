import { describe, expect, it } from 'vitest';
import {
  dcOutcomeReport,
  deferred,
  findDcOperatingPointRow,
  type MenuItemDef,
} from './menuRows';

// The upstream menu rows the port does not implement, label and reason exactly
// as the menubar renders them. Pinning the list in the test keeps the Menus.java
// audit honest: a row that gets ported must be removed from Menubar.tsx and
// from here together. Find DC Operating Point left this list when its one-shot
// command landed.
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
