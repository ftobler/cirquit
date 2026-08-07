/** Browser file download and open, shared by the Menubar buttons and the
 *  Ctrl+S / Ctrl+O shortcuts so the two input paths stay one implementation. */

/** Saves `text` to a local file named `filename` via a Blob download. */
export function saveCircuit(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
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
