/** Import From Text: paste a netlist and load it through the same path Open
 *  uses, with a live summary so the user sees what a load would bring in. */

import { useState } from 'react';
import { summarizeImport } from '../io/importSummary';
import { useStore } from '../state/store';
import { Dialog } from './Dialog';

export function ImportFromTextDialog() {
  const [text, setText] = useState('');
  const loadNetlist = useStore((s) => s.loadNetlist);
  const setStatus = useStore((s) => s.setStatus);
  const closeDialog = useStore((s) => s.closeDialog);

  const importText = () => {
    loadNetlist(text);
    setStatus('Imported circuit from text');
    closeDialog();
  };

  return (
    <Dialog
      title="Import From Text"
      onClose={closeDialog}
      actions={
        <>
          <button type="button" onClick={importText}>
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
        placeholder="Paste a circuit here"
        value={text}
        onChange={(ev) => setText(ev.target.value)}
      />
      <p className="hint">{summarizeImport(text)}</p>
    </Dialog>
  );
}
