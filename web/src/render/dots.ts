/** Current-flow dot animation, kept headless so it can be unit tested. */

/** Spacing between current-flow dots, in circuit units. */
export const DOT_SPACING = 8;

/** Sentinel: the dots would alias, so the segment is drawn as a flow line. */
export const TOO_FAST = Number.POSITIVE_INFINITY;

/**
 * Dot phase advance for one frame, in circuit units.
 *
 * `dt` is wall-clock frame time, matching upstream: the animation is a
 * legibility aid, and users bring expectations from the original. Do not
 * switch this to simulated time.
 *
 * The speed law is upstream's exponential (`1.08` per slider step from a base
 * of 50) so saved circuits keep the look their `currentSpeed` token implies.
 */
export function dotPhaseStep(current: number, currentSpeed: number, dt: number): number {
  if (!Number.isFinite(current) || current === 0 || !Number.isFinite(currentSpeed)) return 0;
  const speedFactor = Math.pow(1.08, currentSpeed - 50) * 8;
  const rate = Math.sign(current) * Math.log1p(Math.abs(current) * 1e4) * speedFactor;
  const step = rate * dt;
  // More than half a spacing per frame aliases backwards (the wagon-wheel
  // effect); signal it so the renderer can draw a flow line instead.
  if (Math.abs(step) > DOT_SPACING / 2) return TOO_FAST;
  return step;
}

/** Wraps an accumulated phase into `[0, DOT_SPACING)`, keeping it bounded. */
export function wrapPhase(phase: number): number {
  const w = phase % DOT_SPACING;
  return w < 0 ? w + DOT_SPACING : w;
}
