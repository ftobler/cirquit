/** Circuit printing: render the schematic offscreen, then print just that
 *  image. The print-only CSS lives in the static stylesheet (styles.css, under
 *  `#circuit-print-overlay` and `@media print`); the DOM injection,
 *  window.print() and cleanup follow upstream's printCanvas
 *  (ImageExporter.java:72-95). */

import type { SimEngine } from '../engine/simulator';
import type { CircuitElement, SimSettings } from '../model/types';
import { renderCircuitToCanvas } from './export';

/** Prints the schematic only, on white like upstream's forced-printable image
 *  export (ImageExporter.java:187-189): the offscreen canvas is rendered, its
 *  PNG data URL is placed in a hidden overlay, and window.print() is called
 *  once the image has decoded. The stylesheet rules that isolate the page are
 *  the app's static styles.css, keyed to this overlay id, so no CSS is built
 *  here. The overlay is removed on afterprint with a timeout fallback for
 *  browsers that never fire it. */
export function printCircuit(
  elements: CircuitElement[],
  settings: SimSettings,
  dark: boolean,
  engine: SimEngine | null,
): void {
  const canvas = document.createElement('canvas');
  renderCircuitToCanvas(canvas, elements, settings, dark, engine);

  const overlay = document.createElement('div');
  overlay.id = 'circuit-print-overlay';
  const img = document.createElement('img');
  img.src = canvas.toDataURL('image/png');
  overlay.appendChild(img);
  document.body.appendChild(overlay);

  // The listener is removed inside cleanup, not with `once`, so a browser that
  // never fires afterprint does not accumulate one listener per print. Both
  // paths may run; the second cleanup is a no-op.
  const cleanup = () => {
    window.removeEventListener('afterprint', cleanup);
    overlay.remove();
  };
  const print = () => {
    window.addEventListener('afterprint', cleanup);
    // afterprint does not fire in every browser; a timeout is the fallback
    // upstream's own printCanvas relies on (ImageExporter.java:84-88).
    setTimeout(cleanup, 1000);
    window.print();
  };
  // A data URL image decodes asynchronously; printing before the decode would
  // put a blank schematic on paper. Wait for the load unless it already fired.
  if (img.complete) print();
  else img.onload = print;
  // A failed decode fires onerror, not onload, so without this the overlay
  // would stay stranded forever (afterprint/timeout never run).
  img.onerror = cleanup;
}
