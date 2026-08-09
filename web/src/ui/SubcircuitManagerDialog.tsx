/** Subcircuit Manager: lists the stored subcircuit models with their external
 *  pins and offers rename (Edit) and Delete per row, upstream's
 *  SubcircuitDialog (SubcircuitDialog.java). The list is read fresh from the
 *  model library on every render, so a Create Subcircuit that stored a model
 *  while this dialog was open is picked up on the next open. */

import { useState } from 'react';
import { listModels, removeModel, renameModel } from '../io/subcircuits';
import { useStore } from '../state/store';
import { Dialog } from './Dialog';

export function SubcircuitManagerDialog() {
  const closeDialog = useStore((s) => s.closeDialog);
  const [models, setModels] = useState(() => listModels());
  const [editing, setEditing] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');

  const refresh = () => {
    setModels(listModels());
    setEditing(null);
  };

  const commitEdit = () => {
    if (editing === null) return;
    const trimmed = draftName.trim();
    if (trimmed !== '' && renameModel(editing, trimmed)) refresh();
  };

  const remove = (name: string) => {
    if (!window.confirm(`Delete subcircuit "${name}"?`)) return;
    removeModel(name);
    refresh();
  };

  const startEdit = (name: string) => {
    setEditing(name);
    setDraftName(name);
  };

  return (
    <Dialog
      title="Subcircuit Manager"
      onClose={closeDialog}
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
          editing === m.name ? (
            <li key={m.name} className="editing">
              <input
                autoFocus
                type="text"
                value={draftName}
                onChange={(ev) => setDraftName(ev.target.value)}
                onKeyDown={(ev) => {
                  if (ev.key === 'Enter') commitEdit();
                  if (ev.key === 'Escape') setEditing(null);
                }}
              />
              <button type="button" onClick={commitEdit}>
                OK
              </button>
              <button type="button" onClick={() => setEditing(null)}>
                Cancel
              </button>
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
