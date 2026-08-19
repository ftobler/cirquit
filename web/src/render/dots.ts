/** Current-flow dot animation, kept headless so it can be unit tested. */

/** Spacing between current-flow dots, in circuit units. */
export const DOT_SPACING = 16;

/** Sentinel: the dots would alias, so the segment is drawn as a flow line. */
export const TOO_FAST = Number.POSITIVE_INFINITY;

/**
 * Dot phase advance for one frame, in circuit units.
 *
 * `dt` is wall-clock frame time, matching upstream: the animation is a
 * legibility aid, and users bring expectations from the original. Do not
 * switch this to simulated time.
 *
 * The law is upstream's `currentMult` (UIManager.java:611-615): the
 * wall-clock interval in milliseconds times `1.7 * exp(currentSpeed / 3.5 -
 * 14.2)`, times the current. The phase is linear in current, so doubling the
 * current doubles the dot speed, and one slider step multiplies the speed by
 * `exp(1/3.5) = 1.331`. Electron flow negates the whole multiplier, which
 * reverses the dots for the same current.
 */
export function dotPhaseStep(
  current: number,
  currentSpeed: number,
  dt: number,
  conventional = true,
): number {
  if (!Number.isFinite(current) || current === 0 || !Number.isFinite(currentSpeed)) return 0;
  const currentMult = 1.7 * dt * 1000 * Math.exp(currentSpeed / 3.5 - 14.2);
  const cadd = current * currentMult;
  // More than 6 circuit units of phase per frame would alias backwards (the
  // wagon-wheel effect); signal it so the renderer can draw a flow line. The
  // check is on the signed value before the electron-flow sign flip, so both
  // directions trip at the same current.
  if (cadd > 6 || cadd < -6) return TOO_FAST;
  return conventional ? cadd : -cadd;
}

/** Wraps an accumulated phase into `[0, DOT_SPACING)`, keeping it bounded. */
export function wrapPhase(phase: number): number {
  const w = phase % DOT_SPACING;
  return w < 0 ? w + DOT_SPACING : w;
}

/** Phase for a run continuing after `distance` circuit units of the same path. */
export function dotPhaseAfter(phase: number, distance: number): number {
  // A too-fast phase is the `CURRENT_TOO_FAST` sentinel, not a position: a
  // chain must keep signalling it so every segment after the first still draws
  // the flow line. Wrapping it would turn Infinity into NaN and blank the
  // rest of the run (upstream's `addCurCount` passes it through,
  // CircuitElm.java:514-518).
  if (phase === TOO_FAST) return TOO_FAST;
  return wrapPhase(phase + distance);
}

/**
 * Advances a per-post phase array one frame, in place while running, returning
 * the drawn phases for the frame. Each post steps on its own current, so a
 * saturated terminal cannot drag its neighbours into `TOO_FAST` or speed them
 * up; a post that is too fast draws the flow line and is rewound to a clean
 * phase in storage so it resumes without a jump once its current drops back
 * under the threshold. Paused, the drawn phase is the stored one: the step is
 * proportional to the frame's wall-clock interval, so drawing `phase + step`
 * on a frozen circuit would jitter the dots by however much that interval
 * varies from frame to frame. The step is still computed, because its
 * `TOO_FAST` verdict decides between dots and a flow line and that must not
 * change under the user on pause.
 */
export function stepPostPhases(
  phases: number[],
  currents: number[],
  currentSpeed: number,
  dt: number,
  conventional: boolean,
  running: boolean,
): number[] {
  return phases.map((phase, i) => {
    const step = dotPhaseStep(currents[i] ?? 0, currentSpeed, dt, conventional);
    if (step === TOO_FAST) {
      if (running) phases[i] = 0;
      return TOO_FAST;
    }
    const next = wrapPhase(phase + (running ? step : 0));
    if (running) phases[i] = next;
    return next;
  });
}
