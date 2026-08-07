/** Save As Image: renders the circuit offscreen at the upstream print margins
 *  and downloads it as a PNG, white background, no grid, no current dots. */

import { useState } from 'react';
import type { SimEngine } from '../engine/simulator';
import { saveBlob } from '../io/fileIO';
import { renderCircuitToCanvas } from '../render/export';
import { useStore } from '../state/store';
import { Dialog } from './Dialog';

interface Props {
  engine: SimEngine | null;
}

export function SaveAsImageDialog({ engine }: Props) {
  const [filename, setFilename] = useState('circuit.png');
  const [error, setError] = useState<string | null>(null);
  const setStatus = useStore((s) => s.setStatus);
  const closeDialog = useStore((s) => s.closeDialog);

  const save = async () => {
    const state = useStore.getState();
    try {
      const canvas = document.createElement('canvas');
      // The print export always renders on white, like upstream's forced
      // printable mode for PNG (ImageExporter.java:184-199).
      renderCircuitToCanvas(canvas, state.elements, state.settings, false, engine);
      const dataUrl = canvas.toDataURL('image/png');
      const blob = await (await fetch(dataUrl)).blob();
      saveBlob(filename.trim() || 'circuit.png', blob);
      setStatus('Image saved');
      closeDialog();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Dialog
      title="Save As Image"
      onClose={closeDialog}
      actions={
        <>
          <button type="button" onClick={() => void save()}>
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
            if (ev.key === 'Enter') void save();
          }}
        />
      </label>
      {error && <p className="problem">{error}</p>}
    </Dialog>
  );
}
