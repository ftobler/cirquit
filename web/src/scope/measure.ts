/**
 * Measurement overlays computed from the visible min/max column window,
 * porting ScopeOverlays.java. All functions are pure over column arrays.
 *
 * `min`/`max` hold the visible columns oldest first, `count` how many are
 * valid. Columns are one capture slot (speed timesteps) wide.
 */

/** The shared cycle walk (ScopeOverlays.java:61-89). Returns the span between
 *  the first and last rising edge. `onSample` fires with the current column
 *  index for every column after the first rising edge, `onCycleEnd` on each
 *  later one. */
export function iterateCycles(
  min: ArrayLike<number>,
  max: ArrayLike<number>,
  count: number,
  mid: number,
  onCycleStart: () => void,
  onSample: (i: number) => void,
  onCycleEnd: (i: number) => void,
): number {
  // skipNonzeroValues: the walk starts at the first column with a non-zero
  // max, and the initial state follows whether that sample sits above mid.
  let startIndex = 0;
  let fnz = 0;
  for (; startIndex < count; startIndex++) {
    if (max[startIndex] !== 0) {
      fnz = max[startIndex];
      break;
    }
  }
  let state = fnz > mid ? 1 : -1;
  let waveCount = 0;
  let start = 0;
  let end = 0;
  for (let i = startIndex; i < count; i++) {
    let sw = false;
    if (state === 1) {
      if (max[i] < mid) sw = true;
    } else if (min[i] > mid) {
      sw = true;
    }
    if (sw) {
      state = -state;
      if (state === 1) {
        if (waveCount === 0) {
          start = i;
          onCycleStart();
        } else {
          end = i;
          onCycleEnd(i);
        }
        waveCount++;
      }
    }
    if (waveCount > 0) onSample(i);
  }
  return end - start;
}

/** RMS over the visible cycles (ScopeOverlays.java:91-109). Null when no full
 *  cycle fits the window, matching upstream's `span > 0` guard: a DC or flat
 *  trace draws no readout at all instead of a misleading zero. */
export function rms(min: ArrayLike<number>, max: ArrayLike<number>, count: number, mid: number): number | null {
  let avg = 0;
  let endAvg = 0;
  const span = iterateCycles(
    min,
    max,
    count,
    mid,
    () => {
      avg = 0;
    },
    (i) => {
      const m = (max[i] + min[i]) * 0.5;
      avg += m * m;
    },
    () => {
      endAvg = avg;
    },
  );
  if (span <= 0) return null;
  return Math.sqrt(endAvg / span);
}

/** Average over the visible cycles (ScopeOverlays.java:111-122). Null when no
 *  full cycle fits the window, like upstream. */
export function average(min: ArrayLike<number>, max: ArrayLike<number>, count: number, mid: number): number | null {
  let avg = 0;
  let endAvg = 0;
  const span = iterateCycles(
    min,
    max,
    count,
    mid,
    () => {
      avg = 0;
    },
    (i) => {
      avg += (max[i] + min[i]) * 0.5;
    },
    () => {
      endAvg = avg;
    },
  );
  if (span <= 0) return null;
  return endAvg / span;
}

/** Duty cycle in percent over the visible cycles (ScopeOverlays.java:124-135).
 *  Null when no full cycle fits the window, like upstream. */
export function dutyCycle(min: ArrayLike<number>, max: ArrayLike<number>, count: number, mid: number): number | null {
  let dutyLen = 0;
  let prevDuty = 0;
  const span = iterateCycles(
    min,
    max,
    count,
    mid,
    () => {
      dutyLen = 0;
    },
    (i) => {
      if (max[i] > mid) dutyLen++;
    },
    () => {
      prevDuty = dutyLen;
    },
  );
  if (span <= 0) return null;
  return (100 * prevDuty) / span;
}

/** Frequency from the period average, with the stability guard
 *  (ScopeOverlays.java:137-177). Returns 0 when the period variance trips the
 *  guard or there is not a full period. */
export function estimateFrequency(
  min: ArrayLike<number>,
  max: ArrayLike<number>,
  count: number,
  speed: number,
  timeStep: number,
): number {
  let avg = 0;
  for (let i = 0; i < count; i++) avg += min[i] + max[i];
  avg /= count * 2;
  const thresh = avg * 0.05;
  let state = 0;
  let oi = 0;
  let avperiod = 0;
  let avperiod2 = 0;
  let periodct = -1;
  for (let i = 0; i < count; i++) {
    const q = max[i] - avg;
    const os = state;
    if (q < thresh) state = 1;
    else if (q > -thresh) state = 2;
    if (state === 2 && os === 1) {
      const pd = i - oi;
      oi = i;
      if (pd < 12) continue;
      if (periodct >= 0) {
        avperiod += pd;
        avperiod2 += pd * pd;
      }
      periodct++;
    }
  }
  avperiod /= periodct;
  avperiod2 /= periodct;
  const periodstd = Math.sqrt(avperiod2 - avperiod * avperiod);
  let freq = 1 / (avperiod * timeStep * speed);
  if (periodct < 1 || periodstd > 2) freq = 0;
  return freq;
}

/** Maximum of the visible window (ScopeOverlays.java:197-204). */
export function maxValue(min: ArrayLike<number>, max: ArrayLike<number>, count: number): number {
  let m = -Infinity;
  for (let i = 0; i < count; i++) m = Math.max(m, min[i], max[i]);
  return m;
}

/** Minimum of the visible window. */
export function minValue(min: ArrayLike<number>, max: ArrayLike<number>, count: number): number {
  let m = Infinity;
  for (let i = 0; i < count; i++) m = Math.min(m, min[i], max[i]);
  return m;
}
