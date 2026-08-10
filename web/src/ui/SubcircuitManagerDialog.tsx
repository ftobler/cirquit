/** Subcircuit Manager: lists the stored subcircuit models with their external
 *  pins and offers rename (Edit) and Delete per row, upstream's
 *  SubcircuitDialog (SubcircuitDialog.java). The list is read fresh from the
 *  model library on every render rather than through a `useState` initialiser
 *  that can never re-run; `bump` below forces that re-render after this
 *  dialog's own edits. The rename row's rules live in `subcircuitManager.ts`,
 *  where they are testable without a DOM. */

import { useCallback, useReducer, useState } from 'react';
import { listModels, nameTaken, removeModel, renameModel } from '../io/subcircuits';
import { useStore } from '../state/store';
import { Dialog } from './Dialog';
import {
  commitSubcircuitEdit,
  deleteSubcircuit,
  NO_SUBCIRCUIT_EDIT,
  setSubcircuitDraft,
  startSubcircuitEdit,
} from './subcircuitManager';

/** One row edits at a time, so the message under it can have a fixed id for
 *  the input's `aria-describedby` to point at. */
const RENAME_ERROR_ID = 'subcircuit-rename-error';

export function SubcircuitManagerDialog() {
  const closeDialog = useStore((s) => s.closeDialog);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const [edit, setEdit] = useState(NO_SUBCIRCUIT_EDIT);
  /** What an action left behind that the list itself does not explain: the row
   *  a rename or a delete left under the old name. It sits above the list
   *  rather than in a `window.alert`, which would be read against the list as
   *  it was before this render flushed and so contradict the screen. */
  const [notice, setNotice] = useState<string | null>(null);
  const models = listModels();

  const commitEdit = () => {
    // `renameModel` speaks the outcome union the edit row decides on, so this
    // is a pass-through and not a translation.
    const result = commitSubcircuitEdit(edit, renameModel);
    setEdit(result.state);
    setNotice(result.notice);
    if (result.refresh) bump();
  };

  // Kept stable so `Dialog`'s Escape listener is not re-subscribed per render.
  const cancelEdit = useCallback(() => {
    setEdit(NO_SUBCIRCUIT_EDIT);
    setNotice(null);
  }, []);

  const startEdit = (name: string) => {
    setEdit(startSubcircuitEdit(name));
    // Starting over drops the last message, the same rule `setSubcircuitDraft`
    // applies to the row's own error.
    setNotice(null);
  };

  const remove = (name: string) => {
    const result = deleteSubcircuit(name, {
      remove: removeModel,
      exists: nameTaken,
      confirm: (message) => window.confirm(message),
    });
    setNotice(result.notice);
    if (!result.refresh) return;
    setEdit(NO_SUBCIRCUIT_EDIT);
    // `bump` is what puts the shortened list on screen: with no row being
    // edited `edit` is already this very object, so the setEdit above changes
    // nothing and React skips the re-render.
    bump();
  };

  return (
    <Dialog
      title="Subcircuit Manager"
      onClose={closeDialog}
      // While a row is being renamed Escape belongs to that row, from anywhere
      // in the dialog: focus is just as likely to be on the row's OK button.
      onEscape={edit.editing !== null ? cancelEdit : undefined}
      actions={
        <>
          <button type="button" onClick={closeDialog}>
            OK
          </button>
        </>
      }
    >
      {models.length === 0 && (
        <p className="hint">
          No subcircuits yet. Select part of a circuit and choose File &gt; Create Subcircuit.
        </p>
      )}
      {/* `status`, not `alert`: this explains what happened, it does not
          refuse anything, so it is announced politely. */}
      {notice && (
        <p className="problem" role="status">
          {notice}
        </p>
      )}
      <ul className="subcircuit-list">
        {models.map((m) =>
          edit.editing === m.name ? (
            <li key={m.name} className="editing">
              <input
                autoFocus
                type="text"
                aria-label={`Rename ${m.name}`}
                aria-describedby={edit.error ? RENAME_ERROR_ID : undefined}
                value={edit.draftName}
                onChange={(ev) => setEdit(setSubcircuitDraft(edit, ev.target.value))}
                onKeyDown={(ev) => {
                  if (ev.key === 'Enter') commitEdit();
                }}
              />
              <button type="button" onClick={commitEdit}>
                OK
              </button>
              <button type="button" onClick={cancelEdit}>
                Cancel
              </button>
              {edit.error && (
                <p className="problem" id={RENAME_ERROR_ID} role="alert">
                  {edit.error}
                </p>
              )}
            </li>
          ) : (
            <li key={m.name}>
              <span className="name">{m.name}</span>
              <span className="meta">
                {m.extList.length} pin{m.extList.length === 1 ? '' : 's'}
              </span>
              <button type="button" onClick={() => startEdit(m.name)}>
                Edit
              </button>
              <button type="button" className="danger" onClick={() => remove(m.name)}>
                Delete
              </button>
            </li>
          ),
        )}
      </ul>
    </Dialog>
  );
}
