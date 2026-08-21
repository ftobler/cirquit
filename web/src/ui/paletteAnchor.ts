/** Where the keyboard palette opens.
 *
 *  The '/' key opens the same right-click menu the mouse opens, but there is
 *  no click to anchor it to. The canvas records the pointer as it moves (in
 *  viewport pixels, plus the circuit point under it), and the key reads the
 *  last record back. The record is deliberately module state rather than store
 *  state: the pointer moves far more often than a frame, and putting it in the
 *  store would re-render the tree on every move.
 */

import type { Point } from '../model/types';

export interface PaletteAnchor {
  /** Viewport pixels, what `openContextMenu` positions the menu with. */
  client: Point;
  /** The circuit point under the pointer, for the rows that act at a location. */
  circuit: Point;
}

let anchor: PaletteAnchor | null = null;

export function setPaletteAnchor(client: Point, circuit: Point): void {
  anchor = { client, circuit };
}

/** Forgets the anchor: the pointer left the canvas, so the last position it
 *  had is no longer a place to open the menu over. */
export function clearPaletteAnchor(): void {
  anchor = null;
}

/** The recorded anchor, or `fallback` when the pointer has not been over the
 *  canvas. Callers pass the viewport centre, the best guess when there is no
 *  cursor to open under. */
export function paletteAnchor(fallback: Point): PaletteAnchor {
  return anchor ?? { client: fallback, circuit: { x: 0, y: 0 } };
}
