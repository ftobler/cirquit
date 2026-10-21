/** Menu row definitions shared by the menubar dropdowns. A pure module so the
 *  deferred-row construction is node-testable; the menubar fills in the live
 *  commands and the store actions behind them. */

import { commandById } from '../commands/registry';
import { commandState } from '../commands/execute';
import type { AppState } from '../state/types';
import { canRedo, canUndo, redoLabel, undoLabel } from '../state/history';

export { dcOutcomeReport } from '../commands/circuit';

export interface MenuItemDef {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  disabledTitle?: string;
  title?: string;
  onClick: () => void;
  /** Rows the port does not implement: rendered disabled and struck through,
   *  with `disabledTitle` as the reason. Contextually disabled rows (no
   *  selection, editing disabled) leave this unset, so they never strike. */
  deferred?: boolean;
  /** Renders a horizontal separator above the row, the way upstream stacks
   *  addSeparator calls around the Full Screen toggle (Menus.java:140,:142). */
  sepBefore?: boolean;
}

/** A menubar row upstream has but the port does not implement: disabled with
 *  the deferral reason as a tooltip and the red strikethrough, so nothing
 *  half-working is ever bound and an absent feature is visibly absent. */
export function deferred(label: string, reason: string, shortcut?: string): MenuItemDef {
  return {
    label,
    shortcut,
    disabled: true,
    disabledTitle: reason,
    deferred: true,
    onClick: () => undefined,
  };
}

/** The File > Find DC Operating Point row, upstream's Menus.java:135 entry
 *  (icon "magic", no shortcut). Run-mode like Reset, so it ignores the
 *  editing gate and is never struck through. Built by a factory rather than
 *  inline so the headless tests can pin its shape against drift. */
export function findDcOperatingPointRow(onRun: () => void): MenuItemDef {
  return {
    label: 'Find DC Operating Point',
    onClick: onRun,
  };
}

/** The File > Toggle Full Screen row, upstream's Menus.java:141 entry (icon
 *  "resize-full-alt", no shortcut). Built by a factory like the DC row above,
 *  so the headless tests can pin its shape against drift. */
export function toggleFullScreenRow(onToggle: () => void): MenuItemDef {
  return {
    label: 'Toggle Full Screen',
    onClick: onToggle,
  };
}

/** A menu row built from a command definition: the label, disabled state and
 *  disabled reason all come from the registry, never a second copy in the
 *  menubar. `run` is the caller's `fire()` wrapper around execute. */
export function commandRow(
  id: string,
  env: {
    state: AppState;
    args?: unknown;
    shortcut?: string;
    /** Overrides the def label, for a row that names its target. */
    label?: string;
    run: () => void;
    sepBefore?: boolean;
  },
): MenuItemDef {
  const def = commandById(id);
  const check = commandState(id, env.args ?? {}, env.state);
  return {
    label: env.label ?? def?.label ?? id,
    shortcut: env.shortcut,
    disabled: !check.enabled,
    disabledTitle: check.reason,
    onClick: env.run,
    ...(env.sepBefore === undefined ? {} : { sepBefore: env.sepBefore }),
  };
}

/** Edit > Undo/Redo, naming the step from the history entry: `Undo Add
 *  Resistor` rather than a bare `Undo`. A plain label is kept when the stack is
 *  empty so the disabled row still says what it would do. **Diverges from
 *  upstream**, whose Undo row never names the step. */
export function historyRow(
  kind: 'undo' | 'redo',
  state: Pick<AppState, 'history' | 'settings'>,
  onRun: () => void,
): MenuItemDef {
  const undo = kind === 'undo';
  const available = undo ? canUndo(state.history) : canRedo(state.history);
  const step = undo ? undoLabel(state.history) : redoLabel(state.history);
  const base = undo ? 'Undo' : 'Redo';
  return {
    label: step === null ? base : `${base} ${step}`,
    shortcut: undo ? 'Ctrl+Z' : 'Ctrl+Y',
    disabled: !state.settings.editable || !available,
    disabledTitle: !state.settings.editable
      ? 'Editing disabled. Re-enable from the Options menu.'
      : available
        ? undefined
        : undo
          ? 'Nothing to undo'
          : 'Nothing to redo',
    onClick: onRun,
  };
}

/** The File menu's last two rows: Print, then the Full Screen toggle after a
 *  separator like upstream's addSeparator call (Menus.java:139-141). About
 *  is not here: it lives under Help. Built here rather than inline so the
 *  headless tests pin order and separators against drift. */
export function fileMenuTailRows(tail: {
  print: () => void;
  fullScreen: () => void;
}): MenuItemDef[] {
  return [
    { label: 'Print…', shortcut: 'Ctrl+P', onClick: tail.print },
    { ...toggleFullScreenRow(tail.fullScreen), sepBefore: true },
  ];
}

/** Where the command's facade result lands: null means found and flashes the
 *  transient notice, "degraded" means the nonlinear iteration converged on
 *  nothing and says so in the same channel, anything else is the engine's
 *  own message and joins the sticky problem banner like a build failure.
 *  Re-exported from commands/circuit.ts so the command and the menu share one
 *  wording table. */

/** The Help > About row, which opens the About dialog. Sits after the docs
 *  pages behind a separator. */
export function helpAboutRow(onAbout: () => void): MenuItemDef {
  return { label: 'About…', onClick: onAbout, sepBefore: true };
}

/** The Help > GitHub row, opening the project repository in a new tab. */
export function helpGithubRow(onOpen: () => void): MenuItemDef {
  return { label: 'GitHub', onClick: onOpen };
}
