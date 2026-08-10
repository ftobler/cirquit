/** Save As: downloads the netlist under a user-typed filename, replacing the
 *  fixed `circuit.txt` download. The File>Save row and Ctrl+S open this dialog,
 *  one implementation per command. */

import { useState } from 'react';
import { defaultSaveFilename, saveCircuit } from '../io/fileIO';
import { useStore } from '../state/store';
import { Dialog } from './Dialog';

export function SaveAsDialog() {
  const [filename, setFilename] = useState(defaultSaveFilename());
  const saveNetlist = useStore((s) => s.saveNetlist);
  const markSaved = useStore((s) => s.markSaved);
  const setStatus = useStore((s) => s.setStatus);
  const closeDialog = useStore((s) => s.closeDialog);

  const save = () => {
    const text = saveNetlist();
    // Exporting counts as saved for the F5 guard, exactly like the old Save
    // button; an empty filename falls back to the default. The baseline is the
    // non-live document, not the live bytes just written: the F5 and autosave
    // checks compare against `toNetlist`, so recording the overlay here would
    // make every circuit look permanently dirty.
    markSaved();
    const name = filename.trim() || defaultSaveFilename();
    saveCircuit(name, text);
    setStatus(`Saved as ${name}`);
    closeDialog();
  };

  return (
    <Dialog
      title="Save As"
      onClose={closeDialog}
      actions={
        <>
          <button type="button" onClick={save}>
            OK
          </button>
          <button type="button" onClick={closeDialog}>
            Cancel
          </button>
        </>
      }
    >
      <label className="field">
        <span>File name</span>
        <input
          autoFocus
          type="text"
          value={filename}
          onFocus={(ev) => ev.target.select()}
          onChange={(ev) => setFilename(ev.target.value)}
          onKeyDown={(ev) => {
            if (ev.key === 'Enter') save();
          }}
        />
      </label>
    </Dialog>
  );
}
