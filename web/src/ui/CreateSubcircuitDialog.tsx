/** Create Subcircuit: names the model the File>Create Subcircuit command
 *  derived from the selection, then stores it, mirroring upstream's
 *  EditCompositeModelDialog naming step (EditCompositeModelDialog.java:154-165,
 *  275-283). The model itself was already built into `subcircuitDraft` by the
 *  store action; this dialog only collects the name. */

import { useState } from 'react';
import { useStore } from '../state/store';
import { Dialog } from './Dialog';

export function CreateSubcircuitDialog() {
  const draft = useStore((s) => s.subcircuitDraft);
  const closeDialog = useStore((s) => s.closeDialog);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const save = () => {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setError('Enter a model name.');
      return;
    }
    useStore.getState().saveSubcircuitDraft(trimmed);
  };

  const cancel = () => {
    // A draft dropped without a name is gone; the Cancel path must clear it
    // too, not just close the dialog.
    useStore.getState().cancelSubcircuitDraft();
    closeDialog();
  };

  return (
    <Dialog
      title="Create Subcircuit"
      onClose={cancel}
      actions={
        <>
          <button type="button" onClick={save}>
            OK
          </button>
          <button type="button" onClick={cancel}>
            Cancel
          </button>
        </>
      }
    >
      {/* The pins come from the labeled nodes, not from what the selection
          touches, so the count has to say where to add more. */}
      <p className="hint">
        {draft?.extList.length ?? 0} pin{draft?.extList.length === 1 ? '' : 's'} from the labeled
        nodes in the selection.
      </p>
      <label className="field" htmlFor="subcircuit-name">
        <span>Model Name</span>
        <input
          id="subcircuit-name"
          autoFocus
          type="text"
          value={name}
          placeholder="e.g. MyCircuit"
          onChange={(ev) => {
            setName(ev.target.value);
            setError(null);
          }}
          onKeyDown={(ev) => {
            if (ev.key === 'Enter') save();
          }}
        />
      </label>
      {error && <p className="problem">{error}</p>}
    </Dialog>
  );
}
