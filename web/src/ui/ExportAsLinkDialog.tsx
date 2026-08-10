/** Export As Link: shows the compressed share URL, warns when it exceeds the
 *  2000-character limit, and copies it. No "Create short URL" button: the
 *  upstream shortener is a backend service and the port is a static site. */

import { useState } from 'react';
import { copyTextToClipboard } from '../io/clipboard';
import { circuitToUrl, isLongUrl } from '../io/urlShare';
import { useStore } from '../state/store';
import { Dialog } from './Dialog';

export function ExportAsLinkDialog() {
  // The dialog mounts fresh per open, so the URL is captured once; the circuit
  // cannot change while this overlay is up.
  const [url] = useState(() => circuitToUrl(useStore.getState().saveNetlist()));
  const setStatus = useStore((s) => s.setStatus);
  const closeDialog = useStore((s) => s.closeDialog);

  const copy = async () => {
    const copied = await copyTextToClipboard(url);
    if (copied) setStatus('Link copied to clipboard');
    closeDialog();
  };

  return (
    <Dialog
      title="Export As Link"
      onClose={closeDialog}
      actions={
        <>
          <button type="button" onClick={() => void copy()}>
            Copy to Clipboard
          </button>
          <button type="button" onClick={closeDialog}>
            OK
          </button>
        </>
      }
    >
      <textarea readOnly spellCheck={false} value={url} />
      {isLongUrl(url) && (
        <p className="problem">
          This link is over 2000 characters and may be rejected by some services.
        </p>
      )}
    </Dialog>
  );
}
