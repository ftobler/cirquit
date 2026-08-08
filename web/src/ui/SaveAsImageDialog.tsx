/** Save As Image / Save As SVG: renders the circuit offscreen at the upstream
 *  print margins and downloads it, white background, no grid, no current dots.
 *  The PNG path renders to a canvas; the SVG path serializes the same draw
 *  calls into markup via the recording context. */

import { useState } from 'react';
import type { SimEngine } from '../engine/simulator';
import { saveBlob } from '../io/fileIO';
import { renderCircuitToCanvas } from '../render/export';
import { renderCircuitToSvg } from '../render/svg';
import { useStore } from '../state/store';
import { Dialog } from './Dialog';

interface Props {
  engine: SimEngine | null;
  /** The file format the OK button writes; png is the historical default. */
  format?: 'png' | 'svg';
}

const DEFAULT_NAME: Record<'png' | 'svg', string> = { png: 'circuit.png', svg: 'circuit.svg' };

export function SaveAsImageDialog({ engine, format = 'png' }: Props) {
  const [filename, setFilename] = useState(DEFAULT_NAME[format]);
  const [error, setError] = useState<string | null>(null);
  const setStatus = useStore((s) => s.setStatus);
  const closeDialog = useStore((s) => s.closeDialog);

  const save = async () => {
    const state = useStore.getState();
    try {
      if (format === 'svg') {
        // The print export always renders on white, like the PNG path
        // (ImageExporter.java:184-199); the dark argument is kept for symmetry
        // with renderCircuitToCanvas but the dialog always passes false.
        const svg = renderCircuitToSvg(state.elements, state.settings, false, engine);
        saveBlob(filename.trim() || DEFAULT_NAME.svg, new Blob([svg], { type: 'image/svg+xml' }));
      } else {
        const canvas = document.createElement('canvas');
        // The print export always renders on white, like upstream's forced
        // printable mode for PNG (ImageExporter.java:184-199).
        renderCircuitToCanvas(canvas, state.elements, state.settings, false, engine);
        const dataUrl = canvas.toDataURL('image/png');
        const blob = await (await fetch(dataUrl)).blob();
        saveBlob(filename.trim() || DEFAULT_NAME.png, blob);
      }
      setStatus('Image saved');
      closeDialog();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Dialog
      title={format === 'svg' ? 'Save As SVG' : 'Save As Image'}
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
