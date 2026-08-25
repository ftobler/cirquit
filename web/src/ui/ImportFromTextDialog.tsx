/** Import From Text: paste a netlist and load it through the same path Open
 *  uses, with a live summary so the user sees what a load would bring in. */

import { useState } from 'react';
import { importIsLoadable, summarizeImport } from '../io/importSummary';
import { useStore } from '../state/store';
import { Dialog } from './Dialog';

export function ImportFromTextDialog() {
  const [text, setText] = useState('');
  const loadNetlist = useStore((s) => s.loadNetlist);
  const setStatus = useStore((s) => s.setStatus);
  const closeDialog = useStore((s) => s.closeDialog);

  const importText = () => {
    // A refused load has already routed its reason into the problem banner;
    // the dialog stays open so the text can be fixed without retyping it.
    if (loadNetlist(text) !== null) return;
    setStatus('Imported circuit from text');
    closeDialog();
  };

  return (
    <Dialog
      title="Import From Text"
      onClose={closeDialog}
      actions={
        <>
          {/* Garbage that parses to zero elements must not silently replace
              the working circuit with an empty sheet; blank text stays
              allowed, since clearing the sheet is a real intent. */}
          <button type="button" onClick={importText} disabled={!importIsLoadable(text)}>
            OK
          </button>
          <button type="button" onClick={closeDialog}>
            Cancel
          </button>
        </>
      }
    >
      <textarea
        autoFocus
        spellCheck={false}
        aria-label="Circuit text"
        placeholder="Paste a circuit here"
        value={text}
        onChange={(ev) => setText(ev.target.value)}
      />
      <p className="hint">{summarizeImport(text)}</p>
    </Dialog>
  );
}
