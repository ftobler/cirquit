/**
 * The canvas backing-store size for a CSS size at a device pixel ratio,
 * rounded once. The width/height attributes are integers, so comparing them
 * against the raw fractional product never settles at dpr 1.25 or 1.5 with an
 * odd CSS width (or ~1.1 under browser zoom): every frame saw a mismatch,
 * reallocated the bitmap and cleared it. Rounding here mirrors export.ts's
 * export canvas sizing, and makes the second frame's compare agree with what
 * was assigned. Pure, so the settle is testable without a DOM.
 *
 * Every canvas that sizes its backing store from clientWidth or
 * clientHeight must go through this helper; a raw `w * dpr` compare-and-assign
 * is the churn bug this exists to prevent.
 */
export function backingStoreSize(
  width: number,
  height: number,
  dpr: number,
): { width: number; height: number } {
  return { width: Math.round(width * dpr), height: Math.round(height * dpr) };
}
