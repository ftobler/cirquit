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
