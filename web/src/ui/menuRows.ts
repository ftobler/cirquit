/** Menu row definitions shared by the menubar dropdowns. A pure module so the
 *  deferred-row construction is node-testable; the menubar fills in the live
 *  commands and the store actions behind them. */

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

/** Where the command's facade result lands: null means found and flashes the
 *  transient notice, "degraded" means the nonlinear iteration converged on
 *  nothing and says so in the same channel, anything else is the engine's
 *  own message and joins the sticky problem banner like a build failure.
 *  Pure, so the wording and routing stay node-testable. */
export function dcOutcomeReport(result: string | null): {
  notice: string | null;
  problem: string | null;
} {
  if (result === null) {
    return { notice: 'Found the DC operating point', problem: null };
  }
  if (result === 'degraded') {
    return { notice: 'No DC operating point exists; the circuit restarted uncharged', problem: null };
  }
  return { notice: null, problem: result };
}
