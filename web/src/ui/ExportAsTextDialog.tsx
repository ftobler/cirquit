/** Export As Text: shows the netlist dump in an editable textarea. Re-Import
 *  parses the edited text back in, so the dialog is also an editor, matching
 *  upstream (ExportAsTextDialog.java:77-89). */

import { useState } from 'react';
import { copyTextToClipboard } from '../io/clipboard';
import { useStore } from '../state/store';
import { Dialog } from './Dialog';

export function ExportAsTextDialog() {
  const [text, setText] = useState(() => useStore.getState().saveNetlist());
  const loadNetlist = useStore((s) => s.loadNetlist);
  const setStatus = useStore((s) => s.setStatus);
  const closeDialog = useStore((s) => s.closeDialog);

  const reImport = () => {
    loadNetlist(text);
    setStatus('Circuit re-imported from text');
    closeDialog();
  };

  const copy = async () => {
    const copied = await copyTextToClipboard(text);
    if (copied) setStatus('Circuit text copied to clipboard');
  };

  return (
    <Dialog
      title="Export As Text"
      onClose={closeDialog}
      actions={
        <>
          <button type="button" onClick={() => void copy()}>
            Copy to Clipboard
          </button>
          <button type="button" onClick={reImport}>
            Re-Import
          </button>
          <button type="button" onClick={closeDialog}>
            OK
          </button>
        </>
      }
    >
      <textarea spellCheck={false} value={text} onChange={(ev) => setText(ev.target.value)} />
    </Dialog>
  );
}
