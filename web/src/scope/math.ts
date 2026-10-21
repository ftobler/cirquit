/**
 * Math traces: a session-only plot computed from one or two captured traces
 * (A+B, A-B, A*B, d/dt). The engine never sees them: they are derived from
 * the same interleaved min/max rings the renderer draws, and a scope line
 * writes only its real plots, so saving a circuit cannot invent a plot
 * upstream would not understand.
 *
 * The decorator at the bottom gives the draw code a normal `ScopeDrawSource`
 * view in which each math plot has a synthetic trace index.
 */

import type {
  MathOp,
  MathTrace,
  Scope,
  ScopeDrawSource,
  ScopePlot,
  TriggerInfoLike,
} from '../engine/scopeModel';

export type { MathOp, MathTrace };

/** The operations offered by the properties dialog, with their short names. */
export const MATH_OPS: { op: MathOp; label: string }[] = [
  { op: 'add', label: 'A+B' },
  { op: 'sub', label: 'A-B' },
  { op: 'mul', label: 'A*B' },
  { op: 'derivative', label: 'd/dt' },
];

export function mathOpLabel(op: MathOp): string {
  return MATH_OPS.find((m) => m.op === op)?.label ?? op;
}

/** A math trace needs two sources except for the derivative, which differentiates
 *  A. */
export function mathSourceCount(op: MathOp): number {
  return op === 'derivative' ? 1 : 2;
}

/**
 * Combines two interleaved `[min, max, ...]` rings into one. Arithmetic is
 * done per column on the min/max extremes, which keeps the envelope truthful:
 * a sum's low is the sum of the lows, a difference's low is A's low minus B's
 * high. A product takes the min and max of the four corner products. The
 * result is as long as the shorter input.
 */
export function combineMath(op: Exclude<MathOp, 'derivative'>, a: Float32Array, b: Float32Array): Float32Array {
  const columns = Math.min(a.length, b.length) >> 1;
  const out = new Float32Array(columns * 2);
  for (let i = 0; i < columns; i++) {
    const aLo = a[i * 2];
    const aHi = a[i * 2 + 1];
    const bLo = b[i * 2];
    const bHi = b[i * 2 + 1];
    let lo: number;
    let hi: number;
    if (op === 'add') {
      lo = aLo + bLo;
      hi = aHi + bHi;
    } else if (op === 'sub') {
      lo = aLo - bHi;
      hi = aHi - bLo;
    } else {
      const p1 = aLo * bLo;
      const p2 = aLo * bHi;
      const p3 = aHi * bLo;
      const p4 = aHi * bHi;
      lo = Math.min(p1, p2, p3, p4);
      hi = Math.max(p1, p2, p3, p4);
    }
    out[i * 2] = lo;
    out[i * 2 + 1] = hi;
  }
  return out;
}

/**
 * Differentiates the column midline of one ring. `secondsPerColumn` turns the
 * column step into a per-second slope; the first column has no predecessor and
 * reads 0 so the trace starts on the axis.
 */
export function derivativeMath(a: Float32Array, secondsPerColumn: number): Float32Array {
  const columns = a.length >> 1;
  const out = new Float32Array(columns * 2);
  if (!(secondsPerColumn > 0)) return out;
  let prev = (a[0] + a[1]) / 2;
  for (let i = 1; i < columns; i++) {
    const mid = (a[i * 2] + a[i * 2 + 1]) / 2;
    const d = (mid - prev) / secondsPerColumn;
    out[i * 2] = d;
    out[i * 2 + 1] = d;
    prev = mid;
  }
  return out;
}

/** One computed math ring for a plot in this scope, or null when a source
 *  plot is missing or does not resolve to an engine trace. */
export function mathRing(
  plot: ScopePlot,
  scopeData: (plotId: number) => Float32Array | undefined,
  secondsPerColumn: number,
): Float32Array | null {
  const math = plot.math;
  if (!math) return null;
  const a = scopeData(math.a);
  if (a === undefined) return null;
  if (math.op === 'derivative') return derivativeMath(a, secondsPerColumn);
  const b = scopeData(math.b);
  if (b === undefined) return null;
  return combineMath(math.op, a, b);
}

/** Synthetic trace indices start here: far above any real engine index, and
 *  stable for the frame the decorator lives. */
const MATH_INDEX_BASE = 1_000_000_000;

const EMPTY_TRIGGER: TriggerInfoLike = {
  columns: 0,
  snapshot_start: 0,
  start_index: 0,
  state: 0,
  time: 0,
  triggered: false,
  valid_count: 0,
  waiting: false,
  written: 0,
};

/**
 * The draw-time source for a scope carrying math plots: real plots delegate to
 * the engine, math plots answer from `mathRing` under a synthetic index. The
 * decorator is cheap (a few closures) and lives one draw call, so it cannot go
 * stale against the scope.
 */
export function mathScopeSource(
  delegate: ScopeDrawSource,
  scope: Scope,
  timeStep: number,
): ScopeDrawSource {
  const mathPlots = scope.plots.filter((p) => p.math !== null && p.math !== undefined);
  if (mathPlots.length === 0) return delegate;
  const indexOfPlot = (plotId: number): number | undefined => {
    const i = mathPlots.findIndex((p) => p.id === plotId);
    return i < 0 ? undefined : MATH_INDEX_BASE + i;
  };
  const dataOf = (index: number): Float32Array | undefined => {
    const plot = mathPlots[index - MATH_INDEX_BASE];
    if (!plot) return undefined;
    const secondsPerColumn = scope.speed * timeStep;
    const ring = mathRing(
      plot,
      (plotId) => {
        const real = delegate.scopeIndexOf(plotId);
        return real === undefined ? undefined : delegate.scopeData(real);
      },
      secondsPerColumn,
    );
    return ring ?? undefined;
  };
  return {
    get time() {
      return delegate.time;
    },
    scopeIndexOf: (plotId) => indexOfPlot(plotId) ?? delegate.scopeIndexOf(plotId),
    scopeData: (index) => dataOf(index) ?? delegate.scopeData(index),
    scopeDiverged: (index) => (index >= MATH_INDEX_BASE ? false : delegate.scopeDiverged(index)),
    triggerInfo: (index, width) =>
      index >= MATH_INDEX_BASE
        ? { ...EMPTY_TRIGGER, free: () => {} }
        : delegate.triggerInfo(index, width),
    recentSamples: (index) =>
      index >= MATH_INDEX_BASE ? new Float32Array(0) : delegate.recentSamples(index),
  };
}
