/** The subcircuit dialogs' decisions, as pure functions.
 *
 *  The dialogs themselves only map these to controls and to the browser's
 *  prompts, so the rules that are easy to get wrong (which outcomes close the
 *  rename row and which keep it open for the user to act on, when a write asks
 *  before clobbering, what the user is told when a delete or a rename uncovers
 *  a saved model) are testable without a DOM.
 *
 *  The rule for the rename row: a commit closes it unless the user has to do
 *  something about it, which is a blank name or a name another model already
 *  holds. An unchanged name is a successful no-op: treating `renameModel`'s
 *  old false for it as a failure left the row stuck in edit mode with a dead OK
 *  button and Escape as the only way out.
 *
 *  The rule for the writes: replacing your own model is legitimate, so Create
 *  asks and proceeds, while a rename onto a taken name is refused outright.
 *  Rename has no "and merge them" answer to offer, and the name the user typed
 *  is one keystroke from being fixed.
 */

import type { RemoveOutcome, RenameOutcome } from '../io/subcircuits';

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

/** The result of committing the edit row: the next state, whether the model
 *  list has to be re-read, which branch got taken, and any message that has no
 *  row left to sit under once the row closes. */
export interface SubcircuitCommit {
  state: SubcircuitEditState;
  refresh: boolean;
  outcome: RenameOutcome;
  /** Rendered above the list, since a commit that has something to say has
   *  already closed the row its message would have sat under. Null when there
   *  is nothing to say. */
  notice: string | null;
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
    return { state, refresh: false, outcome: 'unchanged', notice: null };
  }
  const trimmed = state.draftName.trim();
  if (trimmed === '') {
    return {
      state: { ...state, error: 'Enter a name.' },
      refresh: false,
      outcome: 'blank',
      notice: null,
    };
  }
  if (trimmed === state.editing) {
    return { state: NO_SUBCIRCUIT_EDIT, refresh: false, outcome: 'unchanged', notice: null };
  }
  const outcome = rename(state.editing, trimmed);
  switch (outcome) {
    case 'taken':
      // The row stays open with the name still in it, so the fix is a
      // keystroke away rather than a re-open of the row.
      return {
        state: { ...state, error: `A subcircuit named "${trimmed}" already exists.` },
        refresh: false,
        outcome,
        notice: null,
      };
    case 'refused':
      // Nothing moved, so the row is still valid; the user's way out is Cancel
      // rather than another name, but leaving the row open is what keeps the
      // message attached to the model it is about.
      return {
        state: { ...state, error: "This browser's storage refused the rename." },
        refresh: false,
        outcome,
        notice: null,
      };
    case 'uncovered':
      // The rename moved the copy the row was showing and a model of the old
      // name is still listed, either the saved one this circuit's copy was
      // hiding or one storage would not delete. Unexplained, the row that
      // stays behind reads as the rename having duplicated it.
      return {
        state: NO_SUBCIRCUIT_EDIT,
        refresh: true,
        outcome,
        notice:
          `Renamed to "${trimmed}". A subcircuit named "${state.editing}" is ` +
          `still in the list.`,
      };
    case 'renamed':
    case 'missing':
      // A rename moved the model, and a `missing` means the list is showing a
      // row that is no longer there. Both close the row and re-read the list.
      return { state: NO_SUBCIRCUIT_EDIT, refresh: true, outcome, notice: null };
    case 'blank':
    case 'unchanged':
      // Unreachable from here: the two guards above apply the library's own
      // blank and unchanged rules to the same pair of names, so it is never
      // asked about a name that is either. Closing the row without a refresh
      // is what those answers would mean anyway.
      return { state: NO_SUBCIRCUIT_EDIT, refresh: false, outcome, notice: null };
  }
}

// ─── Delete ───

/** How a delete ended. `uncovered` deleted the open file's copy and left the
 *  saved model of that name in the list at the user's own say-so; `refused` is
 *  a model storage would not drop, which is the one outcome the user cannot
 *  read off the refreshed list; `missing` found nothing of that name, so the
 *  row was stale. */
export type DeleteOutcome = 'cancelled' | 'deleted' | 'uncovered' | 'refused' | 'missing';

/** The result of a Delete: whether the list has to be re-read, which branch
 *  got taken, and anything the refreshed list does not say by itself. */
export interface SubcircuitDelete {
  refresh: boolean;
  outcome: DeleteOutcome;
  notice: string | null;
}

/** The library and the browser prompt behind a Delete, injected so the
 *  two-store rule is testable without either. */
export interface SubcircuitDeleteDeps {
  remove(name: string): RemoveOutcome;
  /** Whether a model of this name is still there afterwards. */
  exists(name: string): boolean;
  confirm(message: string): boolean;
}

/**
 * Deletes a row. A row that shadows a saved model of the same name only loses
 * the open file's copy, which used to leave the user clicking Delete twice on
 * a row that never seemed to go: the second prompt says why the name is still
 * listed and offers to finish the job in the same breath.
 */
export function deleteSubcircuit(name: string, deps: SubcircuitDeleteDeps): SubcircuitDelete {
  if (!deps.confirm(`Delete subcircuit "${name}"?`)) {
    return { refresh: false, outcome: 'cancelled', notice: null };
  }
  // A `default`-less switch, like `commitSubcircuitEdit`: the store a delete
  // emptied decides everything below it, so a `RemoveOutcome` member added
  // later has to be answered here rather than falling into the shadowed-row
  // branch and prompting to delete something that was never there.
  switch (deps.remove(name)) {
    case 'none':
      // Nothing of that name was there, so the list on screen is out of date.
      return { refresh: true, outcome: 'missing', notice: null };
    case 'refused':
      // Nothing changed, so the row the user clicked is still the truth.
      return { refresh: false, outcome: 'refused', notice: refusedDeleteNotice(name) };
    case 'stored':
      // The saved model was the only copy, so the name is gone with it.
      return { refresh: true, outcome: 'deleted', notice: null };
    case 'session':
      return deleteUncovered(name, deps);
  }
}

/** The second half of a Delete that only took the open file's copy: nothing
 *  more to do unless it uncovered a saved model of the same name, in which
 *  case the user is asked whether that one should go too. */
function deleteUncovered(name: string, deps: SubcircuitDeleteDeps): SubcircuitDelete {
  if (!deps.exists(name)) return { refresh: true, outcome: 'deleted', notice: null };
  const deleteThrough = deps.confirm(
    `"${name}" was this circuit's own copy. A saved subcircuit of that name is ` +
      `still there. Delete the saved one too?`,
  );
  if (!deleteThrough) return { refresh: true, outcome: 'uncovered', notice: null };
  // The file's copy is already gone whatever this second delete does, so the
  // list has to be re-read either way.
  if (deps.remove(name) === 'refused') {
    return { refresh: true, outcome: 'refused', notice: refusedDeleteNotice(name) };
  }
  return { refresh: true, outcome: 'deleted', notice: null };
}

/** Why a name the user just deleted is still on the list. */
function refusedDeleteNotice(name: string): string {
  return `This browser's storage refused to delete the saved subcircuit "${name}".`;
}

// ─── Create ───

/** How the Create dialog's OK ended. `cancelled` is the user declining the
 *  overwrite, which leaves the dialog open with the name they typed. */
export type CreateOutcome = 'blank' | 'cancelled' | 'saved';

/** The result of a Create commit: the branch taken and the message for the
 *  dialog's error paragraph. */
export interface SubcircuitCreate {
  outcome: CreateOutcome;
  error: string | null;
}

/** The library, the browser prompt and the store action behind Create,
 *  injected so the overwrite rule is testable without any of them. */
export interface SubcircuitCreateDeps {
  taken(name: string): boolean;
  confirm(message: string): boolean;
  save(name: string): void;
}

/**
 * Commits the Create dialog. Replacing a model of your own is a legitimate
 * action, so a taken name asks rather than refuses (upstream's
 * EditCompositeModelDialog warns before replacing too); before this, the save
 * simply overwrote whatever was stored under the name without a word.
 */
export function commitSubcircuitCreate(
  rawName: string,
  deps: SubcircuitCreateDeps,
): SubcircuitCreate {
  const trimmed = rawName.trim();
  if (trimmed === '') return { outcome: 'blank', error: 'Enter a model name.' };
  if (deps.taken(trimmed) && !deps.confirm(`Replace the existing subcircuit "${trimmed}"?`)) {
    // No error text: the user said no to their own prompt, and the dialog
    // stays open with the name still in the box to edit.
    return { outcome: 'cancelled', error: null };
  }
  deps.save(trimmed);
  return { outcome: 'saved', error: null };
}
