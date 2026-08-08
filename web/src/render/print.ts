/** Circuit printing: render the schematic offscreen, then print just that
 *  image. The CSS that isolates the print page is pure and tested; the DOM
 *  injection, window.print() and cleanup follow upstream's printCanvas
 *  (ImageExporter.java:72-95). */

import type { SimEngine } from '../engine/simulator';
import type { CircuitElement, SimSettings } from '../model/types';
import { renderCircuitToCanvas } from './export';

/** The print-only stylesheet. On paper every body child except the overlay
 *  hides and the schematic fills the page; on screen the overlay itself is
 *  hidden, so injecting it never flashes over the app. Mirrors
 *  ImageExporter.java:76's injected style, plus the modern `break-inside`
 *  spelling of upstream's `page-break-inside`. */
export function printStyle(): string {
  return (
    '@media print { body > *:not(#circuit-print-overlay) { display: none !important; } }' +
    '#circuit-print-overlay { display: none; }' +
    '@media print { @page { size: auto; margin: 10mm; }' +
    '#circuit-print-overlay { display: block !important; width: 100%; height: 100%; }' +
    '#circuit-print-overlay img { max-width: 100%; max-height: 100%; width: auto; height: auto;' +
    ' display: block; margin: 0 auto; break-inside: avoid; } }'
  );
}

/** Prints the schematic only, on white like upstream's forced-printable image
 *  export (ImageExporter.java:187-189): the offscreen canvas is rendered, its
 *  PNG data URL is placed in a hidden overlay, and window.print() is called
 *  once the image has decoded. The overlay and style are removed on afterprint
 *  with a timeout fallback for browsers that never fire it. */
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
  const style = document.createElement('style');
  style.textContent = printStyle();
  document.body.appendChild(overlay);
  document.head.appendChild(style);

  // The listener is removed inside cleanup, not with `once`, so a browser that
  // never fires afterprint does not accumulate one listener per print. Both
  // paths may run; the second cleanup is a no-op.
  const cleanup = () => {
    window.removeEventListener('afterprint', cleanup);
    overlay.remove();
    style.remove();
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
}
