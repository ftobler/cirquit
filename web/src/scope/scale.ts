/**
 * Sticky power-of-two auto-scale with hysteresis, porting Scope.java's
 * `calcPlotScale` (doubling), `reduceRange` (halving) and `calcGridParams`
 * (zero placement), plus the 1-2-5-10 grid series.
 *
 * The scale state is keyed by plot id in a module-level map so it survives
 * frame redraws. All functions are pure; the map is the only state and it is
 * pruned by the panel each frame.
 */

/** Sticky per-plot scale state: the power-of-two display maximum and whether
 *  the display has room for negative values. */
export interface ScaleState {
  gridMax: number;
  showNegative: boolean;
}

export interface ScaleOpts {
  /** Pin the scale to the measured max/min instead of doubling (Max Scale). */
  maxScale: boolean;
}

export interface GridParams {
  /** Value mapped to the vertical centre of the canvas. */
  gridMid: number;
  /** Half of the value span the canvas covers, with top/bottom margin. */
  gridMax: number;
  /** Pixels per value unit: `maxy / gridMax`. */
  gridMult: number;
  showNegative: boolean;
}

const states = new Map<number, ScaleState>();

/** Default sticky scale per units, matching upstream's `scale[]` initial
 *  values: V/W/Ohm/C start at 5, A at 0.1 (Scope.java:266-267). */
function defaultGridMax(value?: string): number {
  return value === 'current' ? 0.1 : 5;
}

export function scaleStateFor(plotId: number, value?: string): ScaleState {
  return states.get(plotId) ?? { gridMax: defaultGridMax(value), showNegative: false };
}

export function setScaleState(plotId: number, state: ScaleState): void {
  states.set(plotId, state);
}

/** Drops scale state for ids that no longer exist (a removed scope's plots). */
export function pruneScaleStates(live: Iterable<number>): void {
  const keep = new Set(live);
  for (const id of states.keys()) {
    if (!keep.has(id)) states.delete(id);
  }
}

/** Drops scale state for the given ids (the Reset command). */
export function clearScaleStates(ids: Iterable<number>): void {
  for (const id of ids) states.delete(id);
}

/** Smallest 1-2-5-10 value `>= target` (Scope.java:742-751). Built from base-10
 *  decades instead of the cumulative `*2, *2.5, *2` loop so the result is the
 *  exact series value (the loop drifts: 0.05 comes out as 0.05000...03). */
export function gridStep(target: number): number {
  const k = Math.floor(Math.log10(target));
  const pow = Math.pow(10, k);
  for (const b of [1, 2, 5, 10]) {
    const v = b * pow;
    if (v >= target) return roundNice(v);
  }
  return roundNice(10 * pow);
}

/** Rounds away the trailing float noise a `b * 10^k` product picks up, so
 *  series values compare exactly in tests and labels. */
function roundNice(v: number): number {
  return Number(v.toPrecision(12));
}

/** Time per horizontal division (Scope.calcGridStepX, Scope.java:742-751). */
export function gridStepX(speed: number, timeStep: number): number {
  return gridStep(20 * speed * timeStep);
}

/** Value per vertical division, from the display span (Scope.java:783-786). */
export function gridStepY(state: ScaleState, heightPx: number): number {
  const maxy = Math.floor((heightPx - 1) / 2);
  const display = calcGridParams(state.gridMax, 0, state.gridMax, state.showNegative, heightPx);
  return gridStep((20 * display.gridMax) / maxy);
}

/**
 * Display layout for a scale: where zero sits and how many pixels a unit
 * covers. Ports `Scope.calcGridParams` (Scope.java:760-796), including the
 * max-scale branch that snaps the boundaries to the measured extremes.
 */
export function calcGridParams(
  max: number,
  min: number,
  scale: number,
  showNegative: boolean,
  heightPx: number,
  opts: ScaleOpts = { maxScale: false },
): GridParams {
  const maxy = Math.floor((heightPx - 1) / 2);
  let mx = scale;
  let mn = 0;
  if (opts.maxScale) {
    mx = max;
    mn = min;
  } else if (showNegative || min < (mx + mn) * 0.5 - (mx - mn) * 0.55) {
    mn = -scale;
    showNegative = true;
  }
  const gridMid = (mx + mn) * 0.5;
  const gridMax = (mx - mn) * 0.55;
  const gridMult = maxy / gridMax;
  return { gridMid, gridMax, gridMult, showNegative };
}

/**
 * The `reduceRange` band check (Scope.java:856-857, 881-884): every sample the
 * frame *drew* must sit within a 10 px band around *zero*, or the scale must
 * not come down. The caller passes the extremes of the drawn window, which is
 * all the test needs: a band is an absolute bound, so the whole window fits
 * exactly when its largest and smallest samples do.
 *
 * The window, not the whole capture ring. The ring holds the next power of two
 * columns at or above the canvas width, so up to half of it can be older than
 * the leftmost pixel; upstream walks only the `drawWidth` columns it plotted
 * (Scope.java:875-884), so a spike that has already scrolled off the left edge
 * stops holding the scope zoomed out.
 *
 * Zero, not the display centre, even though the display centre is where the
 * band looks like it sits upstream. Upstream compares the plotted pixel
 * `gridMult * (v - gridMid)` against `±10 - gridMid * gridMult`, and the
 * `gridMid` term cancels out of both sides: the surviving test is
 * `|gridMult * v| <= 10`. Centring the band on `gridMid` instead makes a
 * steady signal near half the grid maximum read as reducible while its own
 * peak still needs the full scale, and the scope then halves and doubles on
 * alternate frames -- a 60 Hz flicker that is at its most visible with the
 * simulation paused, where the samples never change.
 */
export function extremesFit(
  maxSample: number,
  minSample: number,
  state: ScaleState,
  heightPx: number,
  opts: ScaleOpts = { maxScale: false },
): boolean {
  const { gridMult } = calcGridParams(
    state.gridMax,
    0,
    state.gridMax,
    state.showNegative,
    heightPx,
    opts,
  );
  return Math.max(Math.abs(maxSample), Math.abs(minSample)) * gridMult <= 10;
}

/**
 * One frame's scale update, porting `calcPlotScale` plus the post-draw halving
 * (Scope.java:690-740): double in powers of two until the peak fits, then
 * halve once when the whole trace stayed inside the reduce-range band.
 */
export function nextScaleState(
  prev: ScaleState,
  maxSample: number,
  minSample: number,
  fit: boolean,
  opts: ScaleOpts,
): ScaleState {
  let gridMax = prev.gridMax;
  const max = Math.max(Math.abs(maxSample), Math.abs(minSample));
  if (opts.maxScale) {
    // Upstream resets the scale to 1e-4 every frame and pins it to the
    // current frame's peak (Scope.java:622-624, 733-734), so a decaying
    // signal's max scale follows it down instead of staying zoomed out.
    gridMax = Math.max(max, 1e-4);
  } else {
    while (max > gridMax) gridMax *= 2;
  }
  if (!opts.maxScale && fit && gridMax > 1e-4) gridMax /= 2;
  return { gridMax, showNegative: prev.showNegative };
}

/** Sticky X-Y axis scales, keyed by scope id. The X axis defaults to 5 (a
 *  voltage-like scale), the Y axis to 0.1 (a current-like scale), matching
 *  ScopePlot2d.java:31-32. */
const xyScales = new Map<number, { x: number; y: number }>();

export function xyScaleFor(scopeId: number): { x: number; y: number } {
  return xyScales.get(scopeId) ?? { x: 5, y: 0.1 };
}

export function setXYScale(scopeId: number, scale: { x: number; y: number }): void {
  xyScales.set(scopeId, scale);
}

/** Drops a scope's X-Y axis scales (called when the scope is removed). */
export function clearXYScale(scopeId: number): void {
  xyScales.delete(scopeId);
}

/** Drops X-Y axis scales for scopes that no longer exist. */
export function pruneXYScales(live: Iterable<number>): void {
  const keep = new Set(live);
  for (const id of xyScales.keys()) {
    if (!keep.has(id)) xyScales.delete(id);
  }
}

/** Per-axis sticky X-Y scale update (ScopePlot2d.java:149-163). Reuses the 1d
 *  auto-scale rule: double in powers of two until the frame's peak fits, then
 *  halve once when every sample stayed inside the reduce-range band. */
export function nextAxisScale(
  prev: number,
  maxSample: number,
  minSample: number,
  fit: boolean,
): number {
  return nextScaleState(
    { gridMax: prev, showNegative: false },
    maxSample,
    minSample,
    fit,
    { maxScale: false },
  ).gridMax;
}

/** The X-Y band check, the 1d `extremesFit` applied to one axis: every sample
 *  must sit within 10 px of the axis centre, or the scale must not come down. */
export function axisSamplesFit(
  samples: ArrayLike<number>,
  scale: number,
  axisPx: number,
): boolean {
  if (scale <= 0 || axisPx <= 0) return false;
  const gridMult = (0.499 * axisPx) / scale;
  for (let i = 0; i < samples.length; i++) {
    if (Math.abs(samples[i]) * gridMult > 10) return false;
  }
  return true;
}

/** Smallest 1-2-5-10 value comfortably above `d` (ScopePropertiesDialog
 *  nextHighestScale, Scope.java:158-166). */
export function nextHighestScale(d: number): number {
  return gridStep(d * 1.001);
}

/** Largest 1-2-5-10 series value strictly below `d`, the down-stepper's
 *  inverse of `nextHighestScale` (ScopePropertiesDialog downClickHandler,
 *  ScopePropertiesDialog.java:126-134). */
export function nextLowestScale(d: number): number {
  if (!Number.isFinite(d) || d <= 0) return d;
  // gridStep(d*0.999) is the smallest series value >= just-below-d, which is
  // already the previous checkpoint unless d sits exactly on one, in which
  // case it lands back on d and one more step down is needed.
  const s = gridStep(d * 0.999);
  if (s < d) return s;
  return previousGridStep(s);
}

/** The 1-2-5-10 series value immediately below `s` (assumed a series value):
 *  within a decade 2 falls to 1, 5 to 2 and 10 to 5, and 1 rolls into the
 *  previous decade's 5. The `<` thresholds absorb float noise around the exact
 *  mantissa. */
function previousGridStep(s: number): number {
  const k = Math.floor(Math.log10(s / 1.0001));
  const pow = Math.pow(10, k);
  const b = s / pow;
  if (b < 1.5) return roundNice((5 * pow) / 10);
  if (b < 3.5) return roundNice(1 * pow);
  if (b < 7.5) return roundNice(2 * pow);
  return roundNice(5 * pow);
}

/** Logarithmic speed slider: bar 0..10 maps to `2^(10 - bar)`
 *  (ScopePropertiesDialog.java:789). */
export function barToSpeed(bar: number): number {
  return Math.pow(2, 10 - bar);
}

export function speedToBar(speed: number): number {
  return 10 - Math.round(Math.log2(speed));
}

/** Manual-scale seed: `2 * gridMax / divisions` on the 1-2-5-10 series
 *  (Scope.getManScaleFromMaxScale, Scope.java:1461-1472). */
export function seedManScale(gridMax: number, divisions: number): number {
  return nextHighestScale((2 * gridMax) / divisions);
}

/** Vertical-position clamp, upstream's `+-V_POSITION_STEPS` span
 *  (Scope.java:1227-1228). */
export function positionToOffset(v: number): number {
  return Math.max(-200, Math.min(200, Math.round(v)));
}

/** Vertical drag: pixels to manVPosition (Scope.dragPlotY, Scope.java:1222-1230). */
export function dragPlotYPosition(initial: number, dy: number, maxy: number): number {
  const maxySafe = Math.max(1, maxy);
  const next = initial - Math.round((dy * 200) / (2 * maxySafe));
  return positionToOffset(next);
}
