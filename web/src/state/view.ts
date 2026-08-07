/** View transforms: the pan/zoom math shared by the wheel and the keyboard. */

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
