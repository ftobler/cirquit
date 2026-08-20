/**
 * Scope canvas drawing. Everything here is a pure function of its canvas
 * context and the engine/store data; the panel owns the frame loop and the
 * pointer state, this module owns the pixels.
 *
 * The per-plot sticky auto-scale state lives in `scale.ts`, keyed by plot id,
 * so it survives frame redraws here.
 */

import type { Scope, ScopePlot, ScopeValue, SimEngine } from '../engine/simulator';
import { canvasFont, formatValue, makeTheme, parseRgb } from '../render/draw';
import type { Theme, ThemeColors } from '../model/types';
import { defFor } from '../model/registry';
import { MIN_SETTINGS_WHEEL_SIZE, scopeSpeed, timeToX } from './geometry';
import {
  axisSamplesFit,
  calcGridParams,
  gridStepX,
  gridStepY,
  nextAxisScale,
  nextScaleState,
  extremesFit,
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
import { drawFFT, drawPhaseBand } from './spectrum';

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
  /** Whether the pointer is over the settings wheel in the bottom-left corner,
   *  which colours it like a hovered element. The panel sets it from the
   *  pointer position, the draw loop reads it per frame. */
  hoverSettingsWheel: boolean;
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
    hoverSettingsWheel: false,
  };
}

export const MAN_DIVISIONS = 8;

const TRIGGER_COLOR = '#ff8000';

export const isDrawable = (plot: ScopePlot): plot is DrawablePlot =>
  plot.elementId !== null && plot.value !== null;

export type DrawablePlot = ScopePlot & { elementId: number; value: ScopeValue };

/** Caption shown when a trace has dropped non-finite samples (a diverged
 *  node), so a frozen trace reads as a warning instead of a healthy flatline.
 *  The unusable sample is discarded by the engine, never drawn. */
export const DIVERGED_CAPTION = 'Trace not a number';

const DIVERGED_COLOR = '#ff6b6b';

/** The warning caption for a scope, or null when every visible trace has
 *  stayed finite. Maps each drawable plot to its engine trace and reads the
 *  engine's diverged flag, so the caption appears whenever the engine reports
 *  one (and only then). */
export function divergedCaption(engine: SimEngine, scope: Scope): string | null {
  for (const plot of visiblePlotsOf(scope).filter(isDrawable)) {
    const index = engine.scopeIndexOf(plot.id);
    if (index !== undefined && engine.scopeDiverged(index)) return DIVERGED_CAPTION;
  }
  return null;
}

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

/** Upstream's fixed eight-colour trace palette (ScopePlot.java:139-142), in
 *  upstream's order. Spelt lower case to match the rest of the port's
 *  palettes; the values are upstream's. */
export const PLOT_COLORS = [
  '#ff0000',
  '#ff8000',
  '#ff00ff',
  '#7f00ff',
  '#0000ff',
  '#0080ff',
  '#ffff00',
  '#00ffff',
];

/** The port of `assignColor` (ScopePlot.java:144-160). `count` is the plot's
 *  ordinal within its own category among the visible plots, so the first
 *  voltage trace is green and the second is red, exactly as upstream. The
 *  three `count == 0` colours route through the theme rather than upstream's
 *  literals: the White Background palette re-tunes positive and currentDot for
 *  legibility, and its whiteColor is already black, which is what upstream's
 *  printable branch hardcodes. */
export function assignColor(value: ScopeValue, count: number, theme: Theme): string {
  if (count > 0) return PLOT_COLORS[(count - 1) % PLOT_COLORS.length];
  if (value === 'voltage') return theme.positive;
  if (value === 'current') return theme.currentDot;
  return theme.whiteColor;
}

/** Plot id to trace colour for one frame, the port of the three category
 *  counters in `calcVisiblePlots` (Scope.java:291-311). Rebuilt every frame
 *  because the counters run over the visible plots only: turning showI off
 *  must not shift the voltage traces' colours. Keying the result by id rather
 *  than by index lets every draw site look its plot up without re-deriving the
 *  ordinal, and colour stays a function of position, never of the id itself
 *  (a session-unique handle, so indexing a palette by it would repaint a saved
 *  circuit differently on every load).
 *
 *  Unlike upstream, X-Y mode assigns colours too. Upstream's 2D branch skips
 *  `assignColor` and leaves `plot.color` null, which its own manual-scale
 *  bullets would then draw with; `visiblePlotsOf` already returns every plot
 *  in X-Y mode, so assigning over it costs nothing and avoids the hole.
 *
 *  A plot whose value the port could not map is skipped: it never draws, so
 *  giving it a counter slot would only shift the colours of the plots that
 *  do. */
export function plotColors(scope: Scope, theme: Theme): Map<number, string> {
  const colors = new Map<number, string>();
  let voltageCount = 0;
  let currentCount = 0;
  let otherCount = 0;
  for (const p of visiblePlotsOf(scope)) {
    if (p.value === null) continue;
    if (p.value === 'voltage') colors.set(p.id, assignColor(p.value, voltageCount++, theme));
    else if (p.value === 'current') colors.set(p.id, assignColor(p.value, currentCount++, theme));
    else colors.set(p.id, assignColor(p.value, otherCount++, theme));
  }
  return colors;
}

/** One plot's colour from the frame's assignment map. The fallback is
 *  unreachable for a drawn plot, since the map and every draw loop walk the
 *  same `visiblePlotsOf` list; it exists so a lookup miss paints something
 *  visible instead of throwing. */
function traceColor(colors: Map<number, string>, plot: ScopePlot, theme: Theme): string {
  return colors.get(plot.id) ?? theme.whiteColor;
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
  theme: Theme,
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
    ctx.strokeStyle = ll === 0 ? theme.scopeGridMajor : theme.scopeGridMinor;
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
    ctx.strokeStyle = major ? theme.scopeGridMajor : theme.scopeGridMinor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(gx, 0);
    ctx.lineTo(gx, h - 1);
    ctx.stroke();
  }
}

/** The scope's own label as a title line, in the theme text colour, drawn
 *  only when it is set (ScopeOverlays.draw / Scope.getScopeLabelOrText). */
function drawScopeLabel(
  ctx: CanvasRenderingContext2D,
  scope: Scope,
  h: number,
  theme: Theme,
): void {
  if (!scope.label) return;
  drawInfo(ctx, [{ text: scope.label, y: 4 }], h, theme.whiteColor);
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
  theme: Theme,
  traceColors: Map<number, string>,
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
      ctx.fillStyle = traceColor(traceColors, p, theme);
      ctx.beginPath();
      ctx.arc(4 + x + 8, y + 5, 4, 0, Math.PI * 2);
      ctx.fill();
      lines.push({ text: s, y });
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
  drawInfo(ctx, lines, h, theme.whiteColor);
}

function drawMeasurements(
  ctx: CanvasRenderingContext2D,
  scope: Scope,
  first: MeasurableState,
  h: number,
  speed: number,
  timeStep: number,
  theme: Theme,
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
  drawInfo(ctx, lines, h, theme.whiteColor);
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
  theme: Theme,
  traceColors: Map<number, string>,
  triggerAnchor?: { time: number } | null,
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
  // The cursor line is upstream's whiteColor (Scope.java:1059), so it flips to
  // black with White Background on instead of vanishing into the panel.
  ctx.strokeStyle = theme.whiteColor;
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
    ctx.fillStyle = traceColor(traceColors, selected.plot, theme);
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
      // Upstream's theme-dependent lightGrayColor (Scope.java:1024), black in
      // printable mode.
      ctx.strokeStyle = theme.lightGrayText;
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
  drawInfo(ctx, lines, h, theme.whiteColor);
}

/** Draws the FFT spectrum overlay (ScopeFFT.java), from `fft.ts`'s windowing
 *  math plus the frequency grid and cursor readout in `spectrum.ts`. */


/** Offscreen persistence canvases for X-Y mode, keyed by scope id. The locus
 *  is drawn into one and faded over time, so slow signals leave a trail
 *  (ScopePlot2d.java:191-221). */
const xyPersistence = new Map<
  number,
  {
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D | null;
    w: number;
    h: number;
    lastTrailSimTime: number;
    /** Frames since the last fade; see FADE_FRAME_INTERVAL. */
    fadeCounter: number;
  }
>();

/** Drops a scope's X-Y persistence canvas (called when a scope is removed). */
export function clearXYPersistence(id: number): void {
  xyPersistence.delete(id);
}

/** Logarithmic trail-persistence slider mapping (ScopePropertiesDialog.java:
 *  763-776): slider 0 = 0 timesteps (the default fade); slider n ->
 *  round(10^(n/10)) timesteps. */
export function trailSliderToSteps(v: number): number {
  if (v <= 0) return 0;
  return Math.round(Math.pow(10, v / 10));
}

/** The slider position for a persistence in timesteps, the inverse of
 *  `trailSliderToSteps` (ScopePropertiesDialog.java:767-770). */
export function trailStepsToSlider(steps: number): number {
  if (steps <= 0) return 0;
  return Math.round(Math.log10(steps) * 10);
}

/** One in every `FADE_FRAME_INTERVAL` frames carries the X-Y trail fade;
 *  the rest leave the offscreen canvas alone. Upstream's `alphaCounter`
 *  gate (ScopePlot2d.java:190-192): the fade is per repaint, not per
 *  simulated step, so a fast display would otherwise wipe the trail sooner
 *  than the original does. */
export const FADE_FRAME_INTERVAL = 3;

/** Steps a scope's fade counter one frame, reporting whether this frame is the
 *  one that fades. Pure, so the cadence is testable without a canvas. */
export function advanceFadeCounter(counter: number): { counter: number; fade: boolean } {
  const next = counter + 1;
  return next >= FADE_FRAME_INTERVAL ? { counter: 0, fade: true } : { counter: next, fade: false };
}

/** The X-Y persistence fade alpha for one faded frame, the port of the fade in
 *  ScopePlot2d.draw (ScopePlot2d.java:191-221). A zero persistence keeps the
 *  legacy hard-coded 1% fade; a positive persistence fades exponentially with
 *  time constant `trailPersistence * timeStep` seconds, and the sub-pixel
 *  guard (alpha below 3/255) holds the last-trail time back so a slow trace
 *  keeps fading instead of stalling on an 8-bit canvas. Returns the alpha and
 *  the next last-trail time, which drawXY stores per scope. Only called on the
 *  frames the counter lets through, so the elapsed sim time it measures spans
 *  the whole interval, exactly as upstream's does. */
export function trailFadeAlpha(
  trailPersistence: number,
  timeStep: number,
  simTime: number,
  lastTrailSimTime: number,
): { alpha: number; lastTrailSimTime: number } {
  if (trailPersistence <= 0) return { alpha: 0.01, lastTrailSimTime };
  if (lastTrailSimTime < 0 || simTime < lastTrailSimTime) lastTrailSimTime = simTime;
  const elapsed = simTime - lastTrailSimTime;
  const timeConst = trailPersistence * timeStep;
  let alpha = 1.0 - Math.exp(-elapsed / timeConst);
  if (alpha >= 3 / 255) lastTrailSimTime = simTime;
  else alpha = 0;
  return { alpha, lastTrailSimTime };
}

/** The X-Y centre cross colours (ScopePlot2d.java:226-230): the horizontal
 *  line always takes the positive colour, and so does the vertical one in X-Y
 *  mode, while upstream's V-vs-I 2D mode draws the vertical in yellow. The
 *  port folds upstream's `plot2d.enabled` and `plot2d.plotXY` bits into the
 *  single `scope.plotXY` flag (scopeLine.ts:183-184), so only the X-Y branch
 *  is reachable today; the whole rule is kept so a later V-vs-I mode inherits
 *  it rather than re-deriving it. */
export function xyCrossColors(
  plotXY: boolean,
  theme: Theme,
): { horizontal: string; vertical: string } {
  return { horizontal: theme.positive, vertical: plotXY ? theme.positive : theme.currentDot };
}

/** Draws the X-Y locus from the recent-sample rings (ScopePlot2d.java). */
function drawXY(
  ctx: CanvasRenderingContext2D,
  engine: SimEngine,
  scope: Scope,
  w: number,
  h: number,
  simTime: number,
  timeStep: number,
  theme: Theme,
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
    entry = { canvas, ctx: canvas.getContext('2d'), w, h, lastTrailSimTime: -1, fadeCounter: 0 };
    xyPersistence.set(scope.id, entry);
  }
  const pctx = entry.ctx;
  if (!pctx) return;
  // Fade the previous trace by repainting the background with the trail alpha:
  // zero persistence keeps the legacy hard-coded fade, a positive one fades
  // exponentially with time constant trailPersistence * timeStep
  // (ScopePlot2d.java:191-221). Only every third frame fades, upstream's
  // alphaCounter gate: the locus is re-stroked at full brightness every frame,
  // so fading on each one wipes the trail three times faster than the original
  // and leaves a short signal with almost no tail.
  const tick = advanceFadeCounter(entry.fadeCounter);
  entry.fadeCounter = tick.counter;
  if (tick.fade) {
    const fade = trailFadeAlpha(scope.trailPersistence, timeStep, simTime, entry.lastTrailSimTime);
    entry.lastTrailSimTime = fade.lastTrailSimTime;
    if (fade.alpha > 0) {
      // The fade repaints the panel's own background, black normally and white
      // when printable (ScopePlot2d.java:210-217); a fixed dark fill would
      // paint a dark rectangle over a White Background scope.
      const [fr, fg, fb] = parseRgb(theme.background);
      pctx.fillStyle = `rgba(${fr}, ${fg}, ${fb}, ${fade.alpha})`;
      pctx.fillRect(0, 0, w, h);
    }
  }
  // The locus is upstream's whiteColor pair, white on black and black on white
  // (ScopePlot2d.java:85).
  pctx.strokeStyle = theme.whiteColor;
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
  // Centre cross (ScopePlot2d.java:226-230), horizontal line first, matching
  // upstream's order so the vertical wins the overlap at the centre pixel.
  const cross = xyCrossColors(scope.plotXY, theme);
  ctx.strokeStyle = cross.horizontal;
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();
  ctx.strokeStyle = cross.vertical;
  ctx.beginPath();
  ctx.moveTo(w / 2, 0);
  ctx.lineTo(w / 2, h);
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

/** The settings gear at the scope's bottom-left corner that opens the scope
 *  properties dialog, the port of `drawSettingsWheel` (Scope.java:526-549): a
 *  thick circle of inner radius 5 px with eight spokes out to 8 px (the four
 *  diagonal ones only to 6), centred on `(18, h-18)` like upstream's
 *  `translate(rect.x+18, rect.y+rect.height-18)`. It colours selection when
 *  the pointer is over it and the muted gray otherwise, upstream's
 *  selectColor/dark_gray pair. Only drawn when the canvas clears the 100x100
 *  show/hide threshold (`showSettingsWheel`, Scope.java:553-555). */
function drawSettingsWheel(
  ctx: CanvasRenderingContext2D,
  cursor: ScopeCursor,
  w: number,
  h: number,
  theme: Theme,
): void {
  if (!(h > MIN_SETTINGS_WHEEL_SIZE && w > MIN_SETTINGS_WHEEL_SIZE)) return;
  const cx = 18;
  const cy = h - 18;
  const outR = 8;
  const inR = 5;
  const inR45 = 4;
  const outR45 = 6;
  ctx.strokeStyle = cursor.hoverSettingsWheel ? theme.selection : theme.muted;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(cx, cy, inR, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx - outR, cy);
  ctx.lineTo(cx - inR, cy);
  ctx.moveTo(cx + outR, cy);
  ctx.lineTo(cx + inR, cy);
  ctx.moveTo(cx, cy - outR);
  ctx.lineTo(cx, cy - inR);
  ctx.moveTo(cx, cy + outR);
  ctx.lineTo(cx, cy + inR);
  ctx.moveTo(cx - outR45, cy - outR45);
  ctx.lineTo(cx - inR45, cy - inR45);
  ctx.moveTo(cx + outR45, cy - outR45);
  ctx.lineTo(cx + inR45, cy - inR45);
  ctx.moveTo(cx - outR45, cy + outR45);
  ctx.lineTo(cx - inR45, cy + inR45);
  ctx.moveTo(cx + outR45, cy + outR45);
  ctx.lineTo(cx + inR45, cy + inR45);
  ctx.stroke();
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

  // A diverged trace captions the frozen signal instead of passing it off as
  // a healthy flatline. Drawn after the background fill but before the XY and
  // empty-plot early returns below, so the warning shows in every mode.
  const caption = divergedCaption(engine, scope);
  if (caption) {
    ctx.font = canvasFont(10);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillStyle = DIVERGED_COLOR;
    ctx.fillText(caption, w - 4, 4);
  }

  // Every trace colour for this frame, assigned once from the visible-plot
  // ordinals so each draw site below reads the same map instead of deriving a
  // colour of its own (and dropping the user's overrides on the way).
  const traceColors = plotColors(scope, theme);

  if (scope.plotXY) {
    drawXY(ctx, engine, scope, w, h, simTime, timeStep, theme);
    drawScopeLabel(ctx, scope, h, theme);
    drawSettingsWheel(ctx, cursor, w, h, theme);
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
    // Two scales, one frame, in upstream's order. `drawn` is calcPlotScale
    // alone -- doubling until the peak fits -- and it is what this frame
    // renders and what the band check measures against, exactly as upstream
    // runs calcPlotScale before the draw and checks the band on the pixels it
    // just plotted. The halving is post-draw there (Scope.java:690-695), so it
    // only shows up on the next frame; halving into the same frame's transform
    // instead makes the reduced scale visible for one frame before the next
    // frame's doubling undoes it, which reads as a flicker.
    const drawn = nextScaleState(state, maxSample, minSample, false, opts);
    const fit = extremesFit(maxSample, minSample, drawn, h, opts);
    setScaleState(plot.id, nextScaleState(state, maxSample, minSample, fit, opts));
    const transform = transformFor(scope, plot, drawn, maxSample, minSample, h);
    const m = toMeasurable(data, win);
    return { plot, index, data, win, transform, ...m };
  });

  const first = states[0];
  const allSameUnits = states.every((s) => s.plot.value === states[0].plot.value);

  // The trigger-stabilized window centre anchors the time grid and cursor.
  const triggerAnchor = trigInfo && trigInfo.triggered ? { time: trigInfo.time } : null;

  // The grid is drawn once, from the first plot's transform.
  drawGridLines(
    ctx,
    first.transform,
    w,
    h,
    simTime,
    speed,
    timeStep,
    allSameUnits,
    theme,
    triggerAnchor,
  );
  drawTrigger(ctx, scope, first.transform, trigInfo, w, h);

  const maxy = Math.floor((h - 1) / 2);

  // The FFT spectrum is an overlay drawn under the traces, which stay visible
  // (Scope.java:615-618 then 666-681).
  const traces = states.map((s) => ({ value: s.plot.value, data: s.data }));
  if (scope.fftPlot) {
    drawFFT(ctx, scope, traces, w, h, speed, timeStep, cursor, theme, decimalDigits);
  }
  // The per-bin phase band is its own overlay, drawn whenever Show Phase
  // Angle is on and independent of the spectrum itself: upstream calls
  // drawPhaseAngle from ScopeOverlays.draw on every frame
  // (ScopeOverlays.java:218-219), and the FFT it needs is computed from the
  // trace snapshots, not from the spectrum state.
  if (scope.showPhaseAngle) {
    drawPhaseBand(ctx, traces, w, h);
  }
  // Traces underneath: current first, voltage on top (Scope.java:666-681).
  for (const s of [...states].reverse()) {
    drawTrace(ctx, s.data, s.win, s.transform, maxy, traceColor(traceColors, s.plot, theme));
  }
  // Manual scale draws a zero marker per plot (Scope.java:865-869).
  if (scope.manualScale) {
    for (const s of states) {
      const y0 = yOf(s.transform, maxy, 0);
      if (y0 < 0 || y0 >= h) continue;
      ctx.strokeStyle = traceColor(traceColors, s.plot, theme);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, y0);
      ctx.lineTo(8, y0);
      ctx.stroke();
      ctx.fillStyle = theme.whiteColor;
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
      theme,
      traceColors,
      decimalDigits,
      kindOf ?? (() => null),
    );
  }
  drawMeasurements(ctx, scope, states[0], h, speed, timeStep, theme, decimalDigits);
  drawCursor(
    ctx,
    cursor,
    states,
    simTime,
    speed,
    timeStep,
    w,
    h,
    theme,
    traceColors,
    triggerAnchor,
    decimalDigits,
  );
  // The settings wheel draws on top of the traces, like the HTML close button.
  drawSettingsWheel(ctx, cursor, w, h, theme);
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
