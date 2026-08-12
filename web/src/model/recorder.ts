/** Data-recorder export helpers: the download text and filename, kept pure so
 *  the byte format is testable headlessly. The Blob download itself is the
 *  OptionsPanel's DOM-bound job (web/src/io/fileIO.ts). */

/** The exported file body, upstream's getEditInfo string assembly
 *  (DataRecorderElm.java:106-114): a `# time step = ...` header line then one
 *  sample per line. `data` is already oldest-first. */
export function recorderDataText(data: number[] | Float64Array, timeStep: number): string {
  let s = `# time step = ${timeStep} sec\n`;
  for (const v of data) s += `${v}\n`;
  return s;
}

/** `yyyyMMdd-HHmm`, the DateTimeFormat upstream uses (DataRecorderElm.java:117). */
export function dataTimestamp(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(
    now.getMinutes(),
  )}`;
}

/** The download filename `data-YYYYMMDD-HHmm.circuitjs.txt`
 *  (DataRecorderElm.java:118). */
export function recorderFilename(now = new Date()): string {
  return `data-${dataTimestamp(now)}.circuitjs.txt`;
}
