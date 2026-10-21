import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../model/types';
import type { HistoryEntry } from '../state/history';
import type { AppState } from '../state/types';
import {
  commandRow,
  dcOutcomeReport,
  deferred,
  fileMenuTailRows,
  helpAboutRow,
  helpGithubRow,
  findDcOperatingPointRow,
  historyRow,
  toggleFullScreenRow,
  type MenuItemDef,
} from './menuRows';

const stateWith = (undo: HistoryEntry[], redo: HistoryEntry[] = []) =>
  ({
    history: { undo, redo, open: null },
    settings: DEFAULT_SETTINGS,
  }) as Pick<AppState, 'history' | 'settings'>;

const entry = (label: string): HistoryEntry => ({
  snap: {} as HistoryEntry['snap'],
  label,
  source: 'user',
});

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
  });

  it('ends with Print then Toggle Full Screen, and no About', () => {
    const fired: string[] = [];
    const rows = fileMenuTailRows(tail(fired));
    expect(rows.map((r) => r.label)).toEqual(['Print…', 'Toggle Full Screen']);
    expect(rows[0]?.shortcut).toBe('Ctrl+P');
    for (const r of rows) r.onClick();
    expect(fired).toEqual(['Print…', 'Toggle Full Screen']);
  });

  it('separates the toggle from Print, like Menus.java:140', () => {
    const rows = fileMenuTailRows(tail([]));
    expect(rows[0]?.sepBefore).toBeUndefined();
    expect(rows[1]?.sepBefore).toBe(true);
  });
});

describe('helpAboutRow', () => {
  it('is the About row, set off by a separator, and fires its handler', () => {
    let ran = false;
    const row = helpAboutRow(() => void (ran = true));
    expect(row.label).toBe('About…');
    expect(row.sepBefore).toBe(true);
    row.onClick();
    expect(ran).toBe(true);
  });
});

describe('historyRow', () => {
  it('names the step in the Undo and Redo rows', () => {
    const undo = historyRow('undo', stateWith([entry('Add Resistor')]), () => undefined);
    expect(undo.label).toBe('Undo Add Resistor');
    expect(undo.disabled).toBe(false);
    expect(undo.shortcut).toBe('Ctrl+Z');

    const redo = historyRow(
      'redo',
      stateWith([], [{ ...entry('Move'), source: 'agent' }]),
      () => undefined,
    );
    expect(redo.label).toBe('Redo Move');
    expect(redo.disabled).toBe(false);
  });

  it('stays labelled plain and disabled with no history', () => {
    const undo = historyRow('undo', stateWith([]), () => undefined);
    expect(undo.label).toBe('Undo');
    expect(undo.disabled).toBe(true);
    expect(undo.disabledTitle).toBe('Nothing to undo');

    const redo = historyRow('redo', stateWith([]), () => undefined);
    expect(redo.label).toBe('Redo');
    expect(redo.disabled).toBe(true);
    expect(redo.disabledTitle).toBe('Nothing to redo');
  });

  it('is refused while editing is disabled, whatever the stack holds', () => {
    const state = stateWith([entry('Add Resistor')]);
    state.settings = { ...state.settings, editable: false };
    const row = historyRow('undo', state, () => undefined);
    expect(row.disabled).toBe(true);
    expect(row.disabledTitle).toBe('Editing disabled. Re-enable from the Options menu.');
  });

  it('runs its handler when clicked', () => {
    let ran = false;
    historyRow('undo', stateWith([entry('Add Resistor')]), () => {
      ran = true;
    }).onClick();
    expect(ran).toBe(true);
  });
});

describe('commandRow', () => {
  it('takes its label and enabled state from the command definition', () => {
    const state = stateWith([]);
    const row = commandRow('view.zoomIn', { state: state as AppState, run: () => undefined });
    expect(row.label).toBe('Zoom In');
    expect(row.disabled).toBe(false);
    expect(row.disabledTitle).toBeUndefined();
  });

  it('shows the command own reason when it is disabled', () => {
    const state = stateWith([]);
    const row = commandRow('history.undo', {
      state: state as AppState,
      run: () => undefined,
      label: 'Undo',
    });
    expect(row.disabled).toBe(true);
    expect(row.disabledTitle).toBe('Nothing to undo.');
  });
});

describe('helpGithubRow', () => {
  it('is a plain GitHub row that fires its handler', () => {
    let ran = false;
    const row = helpGithubRow(() => void (ran = true));
    expect(row.label).toBe('GitHub');
    row.onClick();
    expect(ran).toBe(true);
  });
});
