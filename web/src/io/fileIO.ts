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

/** Opens the file picker and hands the first chosen file's text and name to
 *  `onLoad`, so the caller can show which file was opened. A fresh input is
 *  created per call so an ignored open leaves no stale listener behind, and
 *  the value is cleared so choosing the same file again still fires the change
 *  event. */
export function openCircuit(onLoad: (text: string, name: string) => void): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.txt,.circuitjs,text/plain';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    onLoad(await file.text(), file.name);
    input.value = '';
  };
  input.click();
}
