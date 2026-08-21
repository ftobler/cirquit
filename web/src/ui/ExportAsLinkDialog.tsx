/** Export As Link: shows the compressed share URL, warns when it exceeds the
 *  2000-character limit, and copies it. No "Create short URL" button: the
 *  upstream shortener is a backend service and the port is a static site. */

import { useMemo, useState } from 'react';
import { copyTextToClipboard } from '../io/clipboard';
import { circuitToUrl, FALSTAD_BASE, isLongUrl } from '../io/urlShare';
import { useStore } from '../state/store';
import { Dialog } from './Dialog';

export function ExportAsLinkDialog() {
  // The dialog mounts fresh per open, so the netlist is captured once; the
  // circuit cannot change while this overlay is up. Only the base changes with
  // the toggle, so the link is rebuilt from the captured text rather than from
  // a second read of the store.
  const [netlist] = useState(() => useStore.getState().saveNetlist());
  const [upstream, setUpstream] = useState(false);
  const url = useMemo(
    () => circuitToUrl(netlist, upstream ? FALSTAD_BASE : window.location.href),
    [netlist, upstream],
  );
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
      <textarea readOnly spellCheck={false} aria-label="Share link" value={url} />
      {/* Both sites read the same `ctz` parameter, so the circuit travels
          unchanged; the toggle only decides which simulator opens it. Useful
          for sending a circuit to someone who knows the original, and for
          checking this port against upstream on the same file. */}
      <label className="check">
        <input type="checkbox" checked={upstream} onChange={(e) => setUpstream(e.target.checked)} />
        <span>Open in the original simulator at falstad.com</span>
      </label>
      {isLongUrl(url) && (
        <p className="problem">
          This link is over 2000 characters and may be rejected by some services.
        </p>
      )}
    </Dialog>
  );
}
