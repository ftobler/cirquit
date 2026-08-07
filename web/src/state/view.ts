/** View transforms: the pan/zoom math shared by the wheel and the keyboard. */

import type { CircuitElement } from '../model/types';
import type { ViewTransform } from './types';

/** Wheel zoom step per notch; the keyboard reuses it so the two input paths
 *  cannot drift (the wheel's constant in useCanvasInteractions.ts). */
export const ZOOM_FACTOR = 1.12;
/** The wheel's zoom clamp, applied to keyboard zoom too. */
export const ZOOM_MIN = 0.15;
export const ZOOM_MAX = 6;

/** Returns `view` scaled by `factor` about the circuit-space focal point
 *  (cx, cy), so the point under that screen position stays fixed. The clamp is
 *  the wheel's, so keyboard zoom cannot leave the wheel's range. */
export function zoomAbout(
  view: ViewTransform,
  cx: number,
  cy: number,
  factor: number,
): ViewTransform {
  const scale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, view.scale * factor));
  return {
    scale,
    x: cx - (cx - view.x) * (view.scale / scale),
    y: cy - (cy - view.y) * (view.scale / scale),
  };
}

/** Axis-aligned bounding box of a circuit in circuit space. */
export interface Rect {
  minX: number;
  minY: number;
  width: number;
  height: number;
}

/** Margins the circuit is inset within the viewport for Center Circuit and the
 *  image export, upstream's "add some space on edges because bounds calculation
 *  is not perfect" (UIManager.java:467-469, ImageExporter.java:142-144). */
export const CENTER_MARGIN_W = 140;
export const CENTER_MARGIN_H = 100;

/** Bounding box of the circuit from the stored endpoints, the port's analogue
 *  of UIManager.getCircuitBounds (UIManager.java:479-503). Stored endpoints are
 *  used, not `posts()`, because upstream reads the element fields and the port
 *  has no parts whose symbol is wider than their terminals. An empty circuit
 *  has no bounds and returns null. */
export function circuitBounds(elements: CircuitElement[]): Rect | null {
  if (elements.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const e of elements) {
    minX = Math.min(minX, e.x1, e.x2);
    minY = Math.min(minY, e.y1, e.y2);
    maxX = Math.max(maxX, e.x1, e.x2);
    maxY = Math.max(maxY, e.y1, e.y2);
  }
  return { minX, minY, width: maxX - minX, height: maxY - minY };
}

/** The view that centres `bounds` in a viewport, mirroring UIManager.centerCircuit
 *  (UIManager.java:466-476): scale fits the bounds plus the shared margins and
 *  is capped at `maxScale`, then the bounds centre lands on the viewport
 *  centre. The screen convention is `screen = (circuit - view) * scale`, so the
 *  translation offsets the bounds centre by half the viewport in circuit units. */
export function fitView(
  bounds: Rect,
  viewportW: number,
  viewportH: number,
  maxScale = 1.5,
): ViewTransform {
  const scale = Math.min(
    maxScale,
    viewportW / (bounds.width + CENTER_MARGIN_W),
    viewportH / (bounds.height + CENTER_MARGIN_H),
  );
  const cx = bounds.minX + bounds.width / 2;
  const cy = bounds.minY + bounds.height / 2;
  return {
    scale,
    x: cx - viewportW / (2 * scale),
    y: cy - viewportH / (2 * scale),
  };
}
