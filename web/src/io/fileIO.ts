/** Browser file download and open, shared by the Menubar buttons and the
 *  Ctrl+S / Ctrl+O shortcuts so the two input paths stay one implementation. */

/** The filename the Save As dialog prefills, upstream's `defaultFileName(".txt")`
 *  with no circuit name to derive one from. */
export function defaultSaveFilename(): string {
  return 'circuit.txt';
}

/** Saves `text` to a local file named `filename` via a Blob download. */
export function saveCircuit(filename: string, text: string): void {
  saveBlob(filename, new Blob([text], { type: 'text/plain' }));
}

/** Downloads any Blob (an image, a CSV) under `filename`. */
export function saveBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  // Revoked on a later task, never inside this synchronous block: Safari has
  // historically cancelled a download whose object URL was already gone by
  // the time the click's download task came to consume it.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Formats the notice for a chosen file whose bytes could not be read: the
 *  name, so the user knows which pick failed, and the cause, so a pulled
 *  drive reads differently from a permission error. Pure. */
export function formatReadFailure(name: string, err: unknown): string {
  const cause = err instanceof Error ? err.message : String(err);
  return `Could not read "${name}": ${cause}`;
}

/** Reads one chosen file and routes the outcome: text and name to `onLoad`,
 *  a failed read to `onError` with [`formatReadFailure`] text. Split from
 *  `openCircuit` so the promise handling takes an injected file stub and is
 *  node-testable without a DOM input. Only the read is guarded; a throw from
 *  `onLoad` stays the caller's problem, since load refusals report through
 *  their own banner channel. */
export async function readChosenFile(
  file: { name: string; text: () => Promise<string> },
  onLoad: (text: string, name: string) => void,
  onError: (message: string) => void,
): Promise<void> {
  let text: string;
  try {
    text = await file.text();
  } catch (err) {
    onError(formatReadFailure(file.name, err));
    return;
  }
  onLoad(text, file.name);
}

/** Opens the file picker and hands the first chosen file's text and name to
 *  `onLoad`, so the caller can show which file was opened; a read failure
 *  goes to `onError` instead of dying as an unhandled rejection inside this
 *  async handler with nothing on screen. A fresh input is created per call
 *  so an ignored open leaves no stale listener behind, and the value is
 *  cleared once the read settles either way, so choosing the same file again
 *  still fires the change event even after a failure. */
export function openCircuit(
  onLoad: (text: string, name: string) => void,
  onError: (message: string) => void,
): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.txt,.circuitjs,text/plain';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    await readChosenFile(file, onLoad, onError);
    input.value = '';
  };
  input.click();
}
