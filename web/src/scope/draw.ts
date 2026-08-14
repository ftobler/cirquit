/**
 * Scope canvas drawing. Everything here is a pure function of its canvas
 * context and the engine/store data; the panel owns the frame loop and the
 * pointer state, this module owns the pixels.
 *
 * The per-plot sticky auto-scale state lives in `scale.ts`, keyed by plot id,
 * so it survives frame redraws here.
 */

import type { Scope, ScopePlot, ScopeValue, SimEngine } from '../engine/simulator';
import { canvasFont, formatValue, makeTheme } from '../render/draw';
import type { ThemeColors } from '../model/types';
import { defFor } from '../model/registry';
import { scopeSpeed, timeToX } from './geometry';
import {
  axisSamplesFit,
  calcGridParams,
  gridStepX,
  gridStepY,
  nextAxisScale,
  nextScaleState,
  samplesFit,
  scaleStateFor,
  seedManScale,
  setScaleState,
  setXYScale,
  xyScaleFor,
} from './scale';
import { average, dutyCycle, estimateFrequency, maxValue, minValue, rms } from './measure';
import { buildCsv } from './csv';
import { tracePolyline } from './trace';
import { drawInfo, type InfoLine } from './info';
import { drawFFT } from './spectrum';

export const UNIT: Record<ScopeValue, string> = {
  voltage: 'V',
  current: 'A',
  power: 'W',
  charge: 'C',
};

/** Cursor and drag state, kept in a ref so it survives frame redraws. */
export interface ScopeCursor {
  cursorTime: number;
  dragStartTime: number;
  hover: boolean;
  /** Canvas x of the pointer, for the FFT readout. */
  mouseX: number;
  /** Index into the visible-plot list of the trace the cursor dot reads,
   *  which the showV/showI flags can shorten between frames. */
  selectedPlot: number;
  /** Plot id grabbed at pointer-down for the vertical drag. Stored by id
   *  rather than by index: `selectedPlot` is a visible-list index, and the
   *  full `scope.plots` list is longer when a plot is hidden. */
  dragPlotId: number;
  draggingPlotY: boolean;
  dragPlotYStart: number;
  dragPlotYInitial: number;
}

export function emptyCursor(): ScopeCursor {
  return {
    cursorTime: -1,
    dragStartTime: -1,
    hover: false,
    mouseX: 0,
    selectedPlot: -1,
    dragPlotId: -1,
    draggingPlotY: false,
    dragPlotYStart: 0,
    dragPlotYInitial: 0,
  };
}

export const MAN_DIVISIONS = 8;

const GRID_MINOR = '#1b2230';
const GRID_MAJOR = '#2b3648';
const TRIGGER_COLOR = '#ff8000';
const TRACE_COLORS = ['#ff5555', '#ffd866', '#ff7edb', '#58a6ff', '#a371f7', '#56d4dd', '#7ee787'];

export const isDrawable = (plot: ScopePlot): plot is DrawablePlot =>
  plot.elementId !== null && plot.value !== null;

export type DrawablePlot = ScopePlot & { elementId: number; value: ScopeValue };

/** The plots actually drawn, the port of `calcVisiblePlots` (Scope.java:289-315):
 *  a voltage plot is visible only when showV is on, a current plot only when
 *  showI is on, anything else (power, charge) always. X-Y mode shows every
 *  plot so the axis scales can be adjusted for any of them, exactly as
 *  upstream's 2D branch does. */
export function visiblePlotsOf(scope: Scope): ScopePlot[] {
  if (scope.plotXY) return scope.plots;
  return scope.plots.filter((p) => showPlot(scope, p));
}

function showPlot(scope: Scope, p: ScopePlot): boolean {
  if (p.value === 'voltage') return scope.showV;
  if (p.value === 'current') return scope.showI;
  return true;
}

function colorOf(plot: ScopePlot, dark: boolean, colors?: ThemeColors): string {
  // The default V/I palette mirrors upstream (ScopePlot.assignColor): voltage
  // is the theme's positive green, current the theme's current yellow. Extra
  // plots cycle. The current colour rides the theme's `currentDot`, which the
  // light palette re-tunes for a white background.
  if (plot.value === 'voltage') return makeTheme(dark, colors).positive;
  if (plot.value === 'current') return makeTheme(dark, colors).currentDot;
  return TRACE_COLORS[(plot.id % TRACE_COLORS.length)];
}

/** Which columns of a trace's snapshot to draw, given the trigger anchor or
 *  the plain visible window. `posOf(k)` maps drawn column `k` to a snapshot
 *  slot, or -1 when that ring slot holds no valid data. `xOffset` is the
 *  pixel of drawn column 0, so a right-anchored pre-wrap trace can grow from
 *  the right edge while the trigger window stays left-aligned. */
interface Window {
  count: number;
  xOffset: number;
  posOf: (k: number) => number;
}

function plainWindow(data: Float32Array, w: number): Window {
  const columns = data.length / 2;
  const count = Math.min(columns, w);
  const start = columns > w ? columns - w : 0;
  // Right-anchor before the ring wraps: the newest column draws at pixel
  // w - 1, matching the grid's timeToX (right edge is sim time). Once the
  // ring is full the newest w columns fill the canvas and xOffset is 0.
  return { count, xOffset: w - count, posOf: (k) => start + k };
}

interface TriggerInfoLike {
  start_index: number;
  valid_count: number;
  columns: number;
  snapshot_start: number;
  written: number;
  state: number;
  triggered: boolean;
  /** Armed with no trigger yet, the WAIT status (ScopeTrigger.java:198-204). */
  waiting: boolean;
  /** Sim time at the trigger, for anchored time conversions. */
  time: number;
}

function triggerWindow(data: Float32Array, info: TriggerInfoLike, w: number): Window {
  const columns = data.length / 2;
  const count = Math.max(0, Math.min(info.valid_count, w));
  const cap = info.columns;
  return {
    count,
    xOffset: 0,
    posOf: (k) => {
      const ring = (info.start_index + k) % cap;
      const pos = (ring + cap - info.snapshot_start) % cap;
      return pos < info.written && pos < columns ? pos : -1;
    },
  };
}

/** Scans the drawn window for the min and max sample values. */
function scanWindow(data: Float32Array, win: Window): { maxSample: number; minSample: number } {
  let maxSample = -Infinity;
  let minSample = Infinity;
  for (let k = 0; k < win.count; k++) {
    const pos = win.posOf(k);
    if (pos < 0) continue;
    const lo = data[pos * 2];
    const hi = data[pos * 2 + 1];
    if (lo > maxSample) maxSample = lo;
    if (hi > maxSample) maxSample = hi;
    if (lo < minSample) minSample = lo;
    if (hi < minSample) minSample = hi;
  }
  if (!Number.isFinite(maxSample)) maxSample = 0;
  if (!Number.isFinite(minSample)) minSample = 0;
  return { maxSample, minSample };
}

/** The horizontal and vertical transform for one plot's trace. */
interface PlotTransform {
  gridMid: number;
  gridMult: number;
  gridMax: number;
  showNegative: boolean;
  positionOffset: number;
  stepY: number;
}

function transformFor(
  scope: Scope,
  plot: ScopePlot,
  state: { gridMax: number; showNegative: boolean },
  maxSample: number,
  minSample: number,
  h: number,
): PlotTransform {
  const maxy = Math.floor((h - 1) / 2);
  if (scope.manualScale) {
    // Manual mode: the grid is driven by the plot's manScale and the vertical
    // position by manVPosition (Scope.java:787-792).
    const divisions = scope.manDivisions || MAN_DIVISIONS;
    const manScale = plot.manScale ?? seedManScale(5, divisions);
    const gridMax = (divisions / 2 + 0.05) * manScale;
    return {
      gridMid: 0,
      gridMult: maxy / gridMax,
      gridMax,
      showNegative: true,
      positionOffset: (gridMax * 2 * (plot.manVPosition || 0)) / 200,
      stepY: manScale,
    };
  }
  const opts = { maxScale: scope.maxScale };
  const grid = calcGridParams(maxSample, minSample, state.gridMax, state.showNegative, h, opts);
  return {
    gridMid: grid.gridMid,
    gridMult: grid.gridMult,
    gridMax: grid.gridMax,
    showNegative: grid.showNegative,
    positionOffset: 0,
    stepY: gridStepY(state, h),
  };
}

function yOf(t: PlotTransform, maxy: number, v: number): number {
  return maxy - t.gridMult * (v - t.gridMid + t.positionOffset);
}

/** Draws one plot's min/max column spans across its window, plus the
 *  continuous midline polyline that joins them. */
function drawTrace(
  ctx: CanvasRenderingContext2D,
  data: Float32Array,
  win: Window,
  t: PlotTransform,
  maxy: number,
  color: string,
): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  // The midline polyline first: it is what makes a sparse trace read as a
  // continuous line instead of isolated dots. The min/max spans stroke on top
  // so a fast spike keeps its envelope.
  const points = tracePolyline(data, win, t, maxy);
  ctx.beginPath();
  let started = false;
  for (const p of points) {
    if (p === null) {
      started = false;
      continue;
    }
    if (started) ctx.lineTo(p.x, p.y);
    else {
      ctx.moveTo(p.x, p.y);
      started = true;
    }
  }
  ctx.stroke();
  ctx.beginPath();
  for (let k = 0; k < win.count; k++) {
    const pos = win.posOf(k);
    if (pos < 0) continue;
    const lo = yOf(t, maxy, data[pos * 2]);
    const hi = yOf(t, maxy, data[pos * 2 + 1]);
    const x = win.xOffset + k + 0.5;
    if (hi === lo) {
      ctx.moveTo(x, lo);
      ctx.lineTo(x, lo + 0.5);
    } else {
      ctx.moveTo(x, lo);
      ctx.lineTo(x, hi);
    }
  }
  ctx.stroke();
}

function drawGridLines(
  ctx: CanvasRenderingContext2D,
  t: PlotTransform,
  w: number,
  h: number,
  simTime: number,
  speed: number,
  timeStep: number,
  allSameUnits: boolean,
  triggerAnchor?: { time: number } | null,
): void {
  const maxy = Math.floor((h - 1) / 2);
  const stepX = gridStepX(speed, timeStep);
  // Horizontal lines: only the centre line unless every plot shares units
  // (Scope.java:657-661, 812-821).
  const showH = allSameUnits;
  for (let ll = -100; ll <= 100; ll++) {
    if (ll !== 0 && !showH) continue;
    const yl = maxy - (ll * t.stepY - t.gridMid) * t.gridMult;
    if (yl < 0 || yl >= h - 1) continue;
    ctx.strokeStyle = ll === 0 ? GRID_MAJOR : GRID_MINOR;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, yl);
    ctx.lineTo(w, yl);
    ctx.stroke();
  }
  // Vertical (time) lines. Untriggered they anchor the right edge on sim
  // time; with a fired trigger they anchor the trigger-stabilized window
  // centre, `trigger.time + ts*w/2` at the right edge (Scope.java:823-837).
  const ts = speed * timeStep;
  const tRight = triggerAnchor ? triggerAnchor.time + (ts * w) / 2 : simTime;
  const tstart = tRight - ts * w;
  const tx = tRight - (tRight % stepX);
  for (let ll = 0; ; ll++) {
    const tl = tx - stepX * ll;
    const gx = (tl - tstart) / ts;
    if (gx < 0) break;
    if (gx >= w || tl < 0) continue;
    const major = (tl + stepX / 4) % (stepX * 10) < stepX;
    ctx.strokeStyle = major ? GRID_MAJOR : GRID_MINOR;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(gx, 0);
    ctx.lineTo(gx, h - 1);
    ctx.stroke();
  }
}

/** The scope's own label as a title line, in the theme text colour, drawn
 *  only when it is set (ScopeOverlays.draw / Scope.getScopeLabelOrText). */
function drawScopeLabel(ctx: CanvasRenderingContext2D, scope: Scope, h: number): void {
  if (!scope.label) return;
  drawInfo(ctx, [{ text: scope.label, y: 4 }], h);
}

/** The trigger-stabilized time anchor for a scope's canvas: the sim time at
 *  the trigger, mapped to the horizontal centre, or null when the trigger has
 *  not fired (Scope.java:910-915). Returns null for a free-run scope or one
 *  whose trigger is still waiting. */
export function triggerTimeAnchor(
  engine: SimEngine,
  scope: Scope,
  w: number,
): { time: number } | null {
  if (scope.trigger.mode === 'freeRun') return null;
  // The anchored window is drawn from the first visible trace (drawScope),
  // so the cursor time conversion must anchor off that same trace: with plot 0
  // hidden by showV/showI, `scope.plots[0]` is a different trace's ring and
  // the cursor dot would sit a column off the pointer.
  const index = visiblePlotsOf(scope)
    .filter(isDrawable)
    .map((plot) => engine.scopeIndexOf(plot.id))
    .find((i): i is number => i !== undefined);
  if (index === undefined) return null;
  const trig = engine.triggerInfo(index, w);
  const anchor = trig.triggered ? { time: trig.time } : null;
  trig.free();
  return anchor;
}

function drawHeader(
  ctx: CanvasRenderingContext2D,
  scope: Scope,
  firstTransform: PlotTransform,
  firstPlot: DrawablePlot,
  speed: number,
  timeStep: number,
  h: number,
  dark: boolean,
  decimalDigits: number,
  kindOf: (elementId: number) => string | null,
): void {
  const lines: InfoLine[] = [];
  // The scope's own label renders as a title line above the scale, in the
  // theme text colour, and only when it is set (ScopeOverlays.draw:
  // getScopeLabelOrText). Show Extended Info takes its place and draws the
  // plotted element's name instead, the port of `drawElmInfo`'s first line
  // (ScopeOverlays.java:179-184); the full getInfo array (current, power, ...)
  // is deferred as element-model work the port has no table for.
  let y = 4;
  if (scope.label) {
    lines.push({ text: scope.label, y });
    y += 15;
  } else if (scope.showElmInfo && firstPlot.elementId !== null) {
    const kind = kindOf(firstPlot.elementId);
    const name = kind === null ? null : (defFor(kind)?.label ?? kind);
    if (name) {
      lines.push({ text: name, y });
      y += 15;
    }
  }
  const hs = `H=${formatValue(gridStepX(speed, timeStep), 's', decimalDigits)}/div`;
  if (scope.manualScale) {
    // Per-plot coloured /div labels (ScopeOverlays.drawScale, manual mode).
    lines.push({ text: hs, y });
    let x = 0;
    // Only the visible plots get a bullet and /div label (ScopeOverlays.drawScale
    // iterates `visiblePlots`), so a plot hidden by showV/showI stays off the
    // header.
    for (const p of visiblePlotsOf(scope).filter(isDrawable)) {
      const divisions = scope.manDivisions || MAN_DIVISIONS;
      const manScale = p.manScale ?? seedManScale(5, divisions);
      const s = `=${formatValue(manScale, UNIT[p.value], decimalDigits)}/div`;
      ctx.font = canvasFont(10);
      const width = ctx.measureText(s).width + 20;
      if (x + width > ctx.canvas.width) break;
      ctx.fillStyle = colorOf(p, dark);
      ctx.beginPath();
      ctx.arc(4 + x + 8, y + 5, 4, 0, Math.PI * 2);
      ctx.fill();
      lines.push({ text: s, y, color: '#8b949e' });
      x += width;
    }
  } else {
    // Auto scale: the V label is hidden when both V and I plots are shown
    // (ScopeOverlays.drawScale, ScopeOverlays.java:21-25).
    const vs =
      scope.showV && scope.showI
        ? ''
        : ` V=${formatValue(firstTransform.stepY, UNIT[firstPlot.value], decimalDigits)}/div`;
    lines.push({ text: hs + vs, y });
  }
  drawInfo(ctx, lines, h);
}

function drawMeasurements(
  ctx: CanvasRenderingContext2D,
  scope: Scope,
  first: MeasurableState,
  h: number,
  speed: number,
  timeStep: number,
  decimalDigits: number,
): void {
  if (first.count === 0) return;
  const mid = (maxValue(first.min, first.max, first.count) + minValue(first.min, first.max, first.count)) / 2;
  const lines: InfoLine[] = [];
  let y = 20;
  const push = (text: string) => lines.push({ text, y: (y += 15) });
  if (scope.showMax)
    push(`Max=${formatValue(maxValue(first.min, first.max, first.count), UNIT[first.plot.value], decimalDigits)}`);
  if (scope.showMin)
    lines.push({
      text: `Min=${formatValue(minValue(first.min, first.max, first.count), UNIT[first.plot.value], decimalDigits)}`,
      y: h - 18,
    });
  if (scope.showP2P)
    push(
      `P-P=${formatValue(
        maxValue(first.min, first.max, first.count) - minValue(first.min, first.max, first.count),
        UNIT[first.plot.value],
        decimalDigits,
      )}`,
    );
  if (scope.showRMS)
    push(`${formatValue(rms(first.min, first.max, first.count, mid), UNIT[first.plot.value], decimalDigits)}rms`);
  if (scope.showAverage)
    push(`${formatValue(average(first.min, first.max, first.count, mid), UNIT[first.plot.value], decimalDigits)} average`);
  if (scope.showDutyCycle)
    push(`Duty cycle ${Math.round(dutyCycle(first.min, first.max, first.count, mid))}%`);
  if (scope.showFreq) {
    const f = estimateFrequency(first.min, first.max, first.count, speed, timeStep);
    if (f !== 0) push(formatValue(f, 'Hz', decimalDigits));
  }
  drawInfo(ctx, lines, h);
}

interface MeasurableState {
  plot: DrawablePlot;
  index: number;
  data: Float32Array;
  win: Window;
  transform: PlotTransform;
  min: Float32Array;
  max: Float32Array;
  count: number;
}

function toMeasurable(data: Float32Array, win: Window): { min: Float32Array; max: Float32Array; count: number } {
  const min = new Float32Array(win.count);
  const max = new Float32Array(win.count);
  for (let k = 0; k < win.count; k++) {
    const pos = win.posOf(k);
    if (pos < 0) continue;
    min[k] = data[pos * 2];
    max[k] = data[pos * 2 + 1];
  }
  return { min, max, count: win.count };
}

/** The cursor: a vertical line with a value dot, plus the drag dt/delta box
 *  (Scope.drawCursor, Scope.java:993-1074). */
function drawCursor(
  ctx: CanvasRenderingContext2D,
  cursor: ScopeCursor,
  states: MeasurableState[],
  simTime: number,
  speed: number,
  timeStep: number,
  w: number,
  h: number,
  triggerAnchor?: { time: number } | null,
  dark = true,
  decimalDigits = 3,
): void {
  if (!cursor.hover || cursor.cursorTime < 0 || states.length === 0) return;
  const maxy = Math.floor((h - 1) / 2);
  // The selected plot is an index into the visible list, which the showV/
  // showI flags can shorten between frames; a stale index falls back to the
  // first plot rather than reading a gap.
  const selected =
    states[cursor.selectedPlot >= 0 && cursor.selectedPlot < states.length ? cursor.selectedPlot : 0];
  const x = timeToX(cursor.cursorTime, simTime, w, speed, timeStep, triggerAnchor);
  if (x < 0 || x >= w) return;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, h);
  ctx.stroke();

  const lines: InfoLine[] = [];
  let y = -10;
  const k = Math.round(x) - selected.win.xOffset;
  const cursorValue = k >= 0 && k < selected.count ? selected.max[k] : null;
  if (cursorValue !== null) {
    const dotY = yOf(selected.transform, maxy, cursorValue);
    ctx.fillStyle = colorOf(selected.plot, dark);
    ctx.beginPath();
    ctx.arc(x, dotY, 2.5, 0, Math.PI * 2);
    ctx.fill();
    if (cursor.dragStartTime < 0)
      lines.push({
        text: formatValue(cursorValue, UNIT[selected.plot.value], decimalDigits),
        y: (y += 15),
      });
  }
  // Drag-start line and delta readout.
  if (cursor.dragStartTime >= 0) {
    const dragX = timeToX(cursor.dragStartTime, simTime, w, speed, timeStep, triggerAnchor);
    if (dragX >= 0 && dragX < w) {
      ctx.strokeStyle = '#c0c0c0';
      ctx.beginPath();
      ctx.moveTo(dragX, 0);
      ctx.lineTo(dragX, h);
      ctx.stroke();
      const dragK = Math.round(dragX) - selected.win.xOffset;
      const startValue = dragK >= 0 && dragK < selected.count ? selected.max[dragK] : null;
      const deltaT = cursor.cursorTime - cursor.dragStartTime;
      lines.push({ text: `Δt=${formatValue(Math.abs(deltaT), 's', decimalDigits)}`, y: (y += 15) });
      if (startValue !== null && cursorValue !== null) {
        lines.push({
          text: `Δ=${formatValue(cursorValue - startValue, UNIT[selected.plot.value], decimalDigits)}`,
          y: (y += 15),
        });
        lines.push({
          text: formatValue(cursorValue, UNIT[selected.plot.value], decimalDigits),
          y: (y += 15),
        });
      }
    }
  }
  lines.push({ text: formatValue(cursor.cursorTime, 's', decimalDigits), y: (y += 15) });
  drawInfo(ctx, lines, h);
}

/** Draws the FFT spectrum overlay (ScopeFFT.java), from `fft.ts`'s windowing
 *  math plus the frequency grid and cursor readout in `spectrum.ts`. */


/** Offscreen persistence canvases for X-Y mode, keyed by scope id. The locus
 *  is drawn into one and faded over time, so slow signals leave a trail
 *  (ScopePlot2d.java:191-221). */
const xyPersistence = new Map<number, { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D | null; w: number; h: number }>();

/** Drops a scope's X-Y persistence canvas (called when a scope is removed). */
export function clearXYPersistence(id: number): void {
  xyPersistence.delete(id);
}

/** Draws the X-Y locus from the recent-sample rings (ScopePlot2d.java). */
function drawXY(
  ctx: CanvasRenderingContext2D,
  engine: SimEngine,
  scope: Scope,
  w: number,
  h: number,
): void {
  const plots = scope.plots
    .filter(isDrawable)
    .map((plot) => ({ plot, index: engine.scopeIndexOf(plot.id) }))
    .filter((x): x is { plot: DrawablePlot; index: number } => x.index !== undefined);
  const px = plots[0];
  const py = plots[1] ?? plots[0];
  if (!px) return;
  const xs = engine.recentSamples(px.index);
  const ys = engine.recentSamples(py.index);
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return;
  // Per-axis sticky power-of-two auto scale (ScopePlot2d.java:31-32,
  // 149-163): the X axis defaults to 5, the Y axis to 0.1, each doubles to
  // contain and halves once when the whole locus stayed inside the band. The
  // scale persists across frames, so a small current trace stays legible.
  let maxX = -Infinity;
  let minX = Infinity;
  let maxY = -Infinity;
  let minY = Infinity;
  for (let i = 0; i < n; i++) {
    if (xs[i] > maxX) maxX = xs[i];
    if (xs[i] < minX) minX = xs[i];
    if (ys[i] > maxY) maxY = ys[i];
    if (ys[i] < minY) minY = ys[i];
  }
  if (!Number.isFinite(maxX)) maxX = 0;
  if (!Number.isFinite(minX)) minX = 0;
  if (!Number.isFinite(maxY)) maxY = 0;
  if (!Number.isFinite(minY)) minY = 0;
  const prev = xyScaleFor(scope.id);
  const scale = {
    x: nextAxisScale(prev.x, maxX, minX, axisSamplesFit(xs, prev.x, w)),
    y: nextAxisScale(prev.y, maxY, minY, axisSamplesFit(ys, prev.y, h)),
  };
  setXYScale(scope.id, scale);
  const xsTo = (v: number) => (w * (1 + v / scale.x) * 0.499) | 0;
  const ysTo = (v: number) => (h * (1 - v / scale.y) * 0.499) | 0;

  let entry = xyPersistence.get(scope.id);
  if (!entry || entry.w !== w || entry.h !== h) {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    entry = { canvas, ctx: canvas.getContext('2d'), w, h };
    xyPersistence.set(scope.id, entry);
  }
  const pctx = entry.ctx;
  if (!pctx) return;
  // Fade the previous trace by repainting the background with low alpha.
  pctx.fillStyle = 'rgba(13, 17, 23, 0.02)';
  pctx.fillRect(0, 0, w, h);
  pctx.strokeStyle = '#ffffff';
  pctx.lineWidth = 1;
  pctx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = xsTo(xs[i]);
    const y = ysTo(ys[i]);
    if (i === 0) pctx.moveTo(x, y);
    else pctx.lineTo(x, y);
  }
  pctx.stroke();
  ctx.drawImage(entry.canvas, 0, 0);
  // Centre cross (ScopePlot2d.java:227-230).
  ctx.strokeStyle = GRID_MAJOR;
  ctx.beginPath();
  ctx.moveTo(w / 2, 0);
  ctx.lineTo(w / 2, h);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();
}

/** Draws the trigger level line and status (ScopeTrigger.java:173-214). */
function drawTrigger(
  ctx: CanvasRenderingContext2D,
  scope: Scope,
  t: PlotTransform,
  trig: { state: number; triggered: boolean; waiting: boolean } | null,
  w: number,
  h: number,
): void {
  if (scope.trigger.mode === 'freeRun') return;
  const maxy = Math.floor((h - 1) / 2);
  const trigY = yOf(t, maxy, scope.trigger.level);
  if (trigY >= 0 && trigY < h) {
    ctx.strokeStyle = TRIGGER_COLOR;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, trigY);
    ctx.lineTo(w, trigY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = canvasFont(9);
    ctx.fillText(scope.trigger.edge === 'rising' ? 'T↑' : 'T↓', w - 25, trigY - 3);
  }
  // The status text keys off the tracker state and its `waiting` flag, never
  // off `triggered`: `fired` stays latched across a re-arm, so it cannot tell
  // WAIT from ARMED (ScopeTrigger.drawIndicator, ScopeTrigger.java:198-204).
  const status =
    trig?.state === 1 ? 'TRIG' : trig?.state === 2 ? 'AUTO' : trig?.waiting ? 'WAIT' : 'ARMED';
  ctx.font = canvasFont(10);
  const sw = ctx.measureText(status).width;
  ctx.fillStyle = TRIGGER_COLOR;
  ctx.fillText(status, w - sw - 5, h - 5);
}

/** The per-frame entry point: draws one scope canvas. `dark` follows the White
 *  Background setting so the panel, text and trace colours stay legible on a
 *  white backdrop. `decimalDigits` is the readout digit count and `colors` the
 *  user's colour overrides, both from the Other Options settings. */
export function drawScope(
  ctx: CanvasRenderingContext2D,
  engine: SimEngine,
  scope: Scope,
  w: number,
  h: number,
  cursor: ScopeCursor,
  simTime: number,
  timeStep: number,
  dark: boolean,
  decimalDigits = 3,
  colors?: ThemeColors,
  kindOf?: (elementId: number) => string | null,
): void {
  const theme = makeTheme(dark, colors);
  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, w, h);
  if (w < 2 || h < 2) return;
  const speed = scopeSpeed(scope.speed);

  if (scope.plotXY) {
    drawXY(ctx, engine, scope, w, h);
    drawScopeLabel(ctx, scope, h);
    return;
  }

  const plots = visiblePlotsOf(scope)
    .filter(isDrawable)
    .map((plot) => ({ plot, index: engine.scopeIndexOf(plot.id) }))
    .filter((x): x is { plot: DrawablePlot; index: number } => x.index !== undefined);
  if (plots.length === 0) return;

  // The trigger anchor comes from the first trace; all traces share the
  // scope's ring geometry.
  const trig = scope.trigger.mode !== 'freeRun' ? engine.triggerInfo(plots[0].index, w) : null;
  const trigInfo = trig
    ? {
        start_index: trig.start_index,
        valid_count: trig.valid_count,
        columns: trig.columns,
        snapshot_start: trig.snapshot_start,
        written: trig.written,
        state: trig.state,
        triggered: trig.triggered,
        waiting: trig.waiting,
        time: trig.time,
      }
    : null;
  trig?.free();

  const states: MeasurableState[] = plots.map(({ plot, index }) => {
    const data = engine.scopeData(index);
    // The anchored trigger window applies only once a trigger has fired;
    // before that (and in auto-run) the plain most-recent window is shown.
    const win = trigInfo && trigInfo.triggered ? triggerWindow(data, trigInfo, w) : plainWindow(data, w);
    const { maxSample, minSample } = scanWindow(data, win);
    const state = scaleStateFor(plot.id, plot.value);
    const opts = { maxScale: scope.maxScale && !scope.manualScale };
    const fit = samplesFit(data, state, h, opts);
    const next = nextScaleState(state, maxSample, minSample, fit, opts);
    setScaleState(plot.id, next);
    const transform = transformFor(scope, plot, next, maxSample, minSample, h);
    const m = toMeasurable(data, win);
    return { plot, index, data, win, transform, ...m };
  });

  const first = states[0];
  const allSameUnits = states.every((s) => s.plot.value === states[0].plot.value);

  // The trigger-stabilized window centre anchors the time grid and cursor.
  const triggerAnchor = trigInfo && trigInfo.triggered ? { time: trigInfo.time } : null;

  // The grid is drawn once, from the first plot's transform.
  drawGridLines(ctx, first.transform, w, h, simTime, speed, timeStep, allSameUnits, triggerAnchor);
  drawTrigger(ctx, scope, first.transform, trigInfo, w, h);

  const maxy = Math.floor((h - 1) / 2);

  // The FFT spectrum is an overlay drawn under the traces, which stay visible
  // (Scope.java:615-618 then 666-681).
  if (scope.fftPlot) {
    const firstData = engine.scopeData(states[0].index);
    drawFFT(ctx, scope, firstData, firstData.length / 2, w, h, speed, timeStep, cursor, decimalDigits);
  }
  // Traces underneath: current first, voltage on top (Scope.java:666-681).
  for (const s of [...states].reverse()) {
    drawTrace(ctx, s.data, s.win, s.transform, maxy, colorOf(s.plot, dark, colors));
  }
  // Manual scale draws a zero marker per plot (Scope.java:865-869).
  if (scope.manualScale) {
    for (const s of states) {
      const y0 = yOf(s.transform, maxy, 0);
      if (y0 < 0 || y0 >= h) continue;
      ctx.strokeStyle = colorOf(s.plot, dark, colors);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, y0);
      ctx.lineTo(8, y0);
      ctx.stroke();
      ctx.fillStyle = '#8b949e';
      ctx.font = canvasFont(9);
      ctx.fillText('0', 0, y0 - 2);
    }
  }

  if (!(cursor.hover && cursor.cursorTime >= 0)) {
    drawHeader(
      ctx,
      scope,
      first.transform,
      first.plot,
      speed,
      timeStep,
      h,
      dark,
      decimalDigits,
      kindOf ?? (() => null),
    );
  }
  drawMeasurements(ctx, scope, states[0], h, speed, timeStep, decimalDigits);
  drawCursor(ctx, cursor, states, simTime, speed, timeStep, w, h, triggerAnchor, dark, decimalDigits);
}

/** Index of the plot whose trace is nearest the pointer, for manual-mode
 *  vertical dragging and the Remove Plot command (Scope.java:937-969). */
export function selectPlotAt(
  engine: SimEngine,
  scope: Scope,
  x: number,
  y: number,
  w: number,
  h: number,
): number {
  const maxy = Math.floor((h - 1) / 2);
  const plots = visiblePlotsOf(scope)
    .filter(isDrawable)
    .map((plot) => ({ plot, index: engine.scopeIndexOf(plot.id) }))
    .filter((p): p is { plot: DrawablePlot; index: number } => p.index !== undefined);
  if (plots.length === 0) return -1;
  const data = engine.scopeData(plots[0].index);
  const win = plainWindow(data, w);
  const k = Math.round(x) - win.xOffset;
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < plots.length; i++) {
    const { plot } = plots[i];
    const state = scaleStateFor(plot.id, plot.value);
    const t = transformFor(scope, plot, state, 0, 0, h);
    const pos = win.posOf(k);
    if (pos < 0) continue;
    const vy = yOf(t, maxy, data[pos * 2 + 1]);
    const dist = Math.abs(y - vy);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

/** CSV rows for the visible window of every plot, for the Export CSV command
 *  (Scope.exportCSV, Scope.java:1143-1178). */
export function exportScopeCsv(
  engine: SimEngine,
  scope: Scope,
  nameOf: (plot: DrawablePlot) => string,
  w: number,
  speed: number,
  timeStep: number,
  simTime: number,
): string {
  const rows: { name: string; unit: string; min: Float32Array; max: Float32Array }[] = [];
  // CSV exports the visible plots, like upstream's exportCSV over
  // `visiblePlots` (Scope.java:1143-1178).
  for (const plot of visiblePlotsOf(scope).filter(isDrawable)) {
    const index = engine.scopeIndexOf(plot.id);
    if (index === undefined) continue;
    const data = engine.scopeData(index);
    const win = plainWindow(data, w);
    // Index by pixel, so buildCsv row i lines up with pixel i: the right
    // anchor shifts drawn column k to pixel xOffset + k. Pixels left of the
    // oldest drawn column stay undefined and export as 0.
    const min = new Float32Array(win.count + win.xOffset);
    const max = new Float32Array(win.count + win.xOffset);
    for (let k = 0; k < win.count; k++) {
      const pos = win.posOf(k);
      if (pos < 0) continue;
      min[k + win.xOffset] = data[pos * 2];
      max[k + win.xOffset] = data[pos * 2 + 1];
    }
    rows.push({ name: nameOf(plot), unit: UNIT[plot.value], min, max });
  }
  return buildCsv(rows, speed, timeStep, simTime, w);
}
