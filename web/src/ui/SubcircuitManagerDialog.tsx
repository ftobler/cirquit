/** Subcircuit Manager: lists the stored subcircuit models with their external
 *  pins and offers rename (Edit) and Delete per row, upstream's
 *  SubcircuitDialog (SubcircuitDialog.java). The list is read fresh from the
 *  model library on every render rather than through a `useState` initialiser
 *  that can never re-run; `bump` below forces that re-render after this
 *  dialog's own edits. The rename row's rules live in `subcircuitManager.ts`,
 *  where they are testable without a DOM. */

import { useCallback, useReducer, useState } from 'react';
import { listModels, removeModel, renameModel } from '../io/subcircuits';
import { useStore } from '../state/store';
import { Dialog } from './Dialog';
import {
  commitSubcircuitEdit,
  NO_SUBCIRCUIT_EDIT,
  setSubcircuitDraft,
  startSubcircuitEdit,
  type RenameOutcome,
} from './subcircuitManager';

/** One row edits at a time, so the message under it can have a fixed id for
 *  the input's `aria-describedby` to point at. */
const RENAME_ERROR_ID = 'subcircuit-rename-error';

export function SubcircuitManagerDialog() {
  const closeDialog = useStore((s) => s.closeDialog);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const [edit, setEdit] = useState(NO_SUBCIRCUIT_EDIT);
  const models = listModels();

  // `renameModel`'s boolean is only ever consulted for a name that is neither
  // blank nor unchanged, so a false at this point means the model is gone.
  const rename = (oldName: string, newName: string): RenameOutcome =>
    renameModel(oldName, newName) ? 'renamed' : 'missing';

  const commitEdit = () => {
    const result = commitSubcircuitEdit(edit, rename);
    setEdit(result.state);
    if (result.refresh) bump();
  };

  // Kept stable so `Dialog`'s Escape listener is not re-subscribed per render.
  const cancelEdit = useCallback(() => setEdit(NO_SUBCIRCUIT_EDIT), []);

  const remove = (name: string) => {
    if (!window.confirm(`Delete subcircuit "${name}"?`)) return;
    removeModel(name);
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
              <button type="button" onClick={() => setEdit(startSubcircuitEdit(m.name))}>
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
