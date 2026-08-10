/** The Subcircuit Manager's rename row, as pure state transitions.
 *
 *  The dialog itself only maps this state to controls, so the rules that are
 *  easy to get wrong (which outcomes close the row and which keep it open for
 *  the user to act on) are testable without a DOM.
 *
 *  The rule: a commit closes the row unless the user has to do something about
 *  it. A blank name is the only such case today; renaming onto a name that is
 *  already taken joins it once `subcircuit-name-collisions` lands, which is why
 *  the outcome is a named union rather than the bare boolean `renameModel`
 *  currently returns. An unchanged name is a successful no-op: treating
 *  `renameModel`'s false for it as a failure left the row stuck in edit mode
 *  with a dead OK button and Escape as the only way out.
 */

/** The row being renamed, plus what to tell the user about it. `editing` is
 *  the model's current name, which is also what an unchanged commit compares
 *  against. */
export interface SubcircuitEditState {
  editing: string | null;
  draftName: string;
  /** The message under the edit row, null when there is none. */
  error: string | null;
}

/** No row in edit mode. */
export const NO_SUBCIRCUIT_EDIT: SubcircuitEditState = {
  editing: null,
  draftName: '',
  error: null,
};

/** What the library made of a rename it was actually asked to do. `missing` is
 *  a model that went away underneath the dialog, which is nothing the user can
 *  retype their way out of, so it closes the row and re-reads the list. */
export type RenameOutcome = 'renamed' | 'missing';

/** How a commit ended. The two the library never sees are decided here:
 *  `blank` keeps the row open, `unchanged` closes it without touching the
 *  library, which rejects an unchanged name anyway. */
export type CommitOutcome = 'blank' | 'unchanged' | RenameOutcome;

/** The result of committing the edit row: the next state, whether the model
 *  list has to be re-read, and which branch got taken. */
export interface SubcircuitCommit {
  state: SubcircuitEditState;
  refresh: boolean;
  outcome: CommitOutcome;
}

/** Opens the row for `name` with the current name as the draft, like
 *  upstream's name field starting from the model being edited. */
export function startSubcircuitEdit(name: string): SubcircuitEditState {
  return { editing: name, draftName: name, error: null };
}

/** Types into the open row. Clearing the error on every keystroke is what lets
 *  a rejected commit be retried without the stale message hanging around. */
export function setSubcircuitDraft(
  state: SubcircuitEditState,
  draftName: string,
): SubcircuitEditState {
  return { ...state, draftName, error: null };
}

/**
 * Commits the open row. `rename` is the library call, injected so the decision
 * table is testable on its own; it is only reached for a name that is both
 * non-blank and actually different, so it never has to answer "nothing to do".
 *
 * An outcome that keeps the row open carries an `error` and never refreshes:
 * the user has to retype. Everything else clears the row.
 */
export function commitSubcircuitEdit(
  state: SubcircuitEditState,
  rename: (oldName: string, newName: string) => RenameOutcome,
): SubcircuitCommit {
  if (state.editing === null) {
    return { state, refresh: false, outcome: 'unchanged' };
  }
  const trimmed = state.draftName.trim();
  if (trimmed === '') {
    return { state: { ...state, error: 'Enter a name.' }, refresh: false, outcome: 'blank' };
  }
  if (trimmed === state.editing) {
    return { state: NO_SUBCIRCUIT_EDIT, refresh: false, outcome: 'unchanged' };
  }
  // Both rename outcomes close the row and re-read the list: a rename moved
  // the model, and a `missing` means the list is showing a row that is no
  // longer there.
  return { state: NO_SUBCIRCUIT_EDIT, refresh: true, outcome: rename(state.editing, trimmed) };
}
