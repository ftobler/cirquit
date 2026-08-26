/**
 * Scope domain model and pure helpers.
 *
 * Split out of `engine/simulator.ts` so the scope codecs and renderer can
 * share these types without reaching into the wasm-backed facade: that reach
 * was the back-edge of a runtime module cycle (busWidths -> registry ->
 * scope defs -> scope/draw -> simulator). Everything here is plain data or a
 * pure function over it, and nothing may import wasm, io, the registry or
 * scope/draw; the only edges are the geometry constants leaf and a type-only
 * `SimSettings` borrow from model/types.
 */

import { scopeColumnCount, scopeSpeed, DEFAULT_SCOPE_WIDTH } from '../scope/geometry';
import type { SimSettings } from '../model/types';

/** The quantity a scope trace samples. The strings match the engine's serde
 *  names. `resistance` is a lamp's hot resistance or the VAL_R reading of a
 *  memristor or ohmmeter, and `ib`..`vce` a transistor's pin plots, upstream's
 *  VAL_R and VAL_IB..VAL_VCE (LampElm.java:218-222, MemristorElm.java:143-147,
 *  OhmMeterElm.java:37-43, TransistorElm.java:582-602). */
export type ScopeValue =
  | 'voltage'
  | 'current'
  | 'power'
  | 'charge'
  | 'resistance'
  | 'ib'
  | 'ic'
  | 'ie'
  | 'vbe'
  | 'vbc'
  | 'vce';

/** Trigger acquisition settings, mirroring ScopeTrigger.java. Free run
 *  disables the trigger. The strings match the engine's serde names. */
export interface ScopeTrigger {
  mode: 'freeRun' | 'normal' | 'auto';
  edge: 'rising' | 'falling';
  level: number;
}

/** The per-trace measurement readouts a scope plot can override, the port's
 *  own extension: upstream's readout flags are scope-level. The key order here
 *  is also the bit order of the per-plot flags token under FLAG_PERPLOTFLAGS
 *  (scopeLine.ts): bit n+1 is PLOT_MEASUREMENT_KEYS[n], a set bit meaning the
 *  readout is on. Bit 0 of that token stays upstream's FLAG_AC. */
export interface PlotMeasurements {
  showScale: boolean;
  showMax: boolean;
  showMin: boolean;
  showP2P: boolean;
  showFreq: boolean;
  showRMS: boolean;
  showAverage: boolean;
  showDutyCycle: boolean;
  showPhaseAngle: boolean;
}

export type PlotMeasurementKey = keyof PlotMeasurements;

/** The override keys in per-plot-token bit order, shared by the codec and the
 *  helpers below so the layout cannot drift between them. */
export const PLOT_MEASUREMENT_KEYS: readonly PlotMeasurementKey[] = [
  'showScale',
  'showMax',
  'showMin',
  'showP2P',
  'showFreq',
  'showRMS',
  'showAverage',
  'showDutyCycle',
  'showPhaseAngle',
];

export interface ScopePlot {
  /** Trace identity: what the UI and engine key on. */
  id: number;
  /** Store element id, resolved at load. Null when the file index pointed at
   *  an element line this build could not read; such a plot is preserved via
   *  the raw line only and is never registered as a trace. */
  elementId: number | null;
  /** The sampled quantity, or null when the value token has no engine meaning
   *  for this element (a transistor's VAL_IB). A null plot is preserved via
   *  the raw line only. */
  value: ScopeValue | null;
  /** Manual-scale units per division, or null when not user-set. */
  manScale: number | null;
  /** Vertical position in -200..200, 0 centred (Scope.V_POSITION_STEPS). */
  manVPosition: number;
  /** DC-blocking filter on the raw sample (voltage plots only). */
  acCoupled: boolean;
  /** This plot's own measurement readout mask, or null when the plot inherits
   *  the scope-wide flags. All-or-nothing on purpose, matching the o line:
   *  once a plot carries a per-plot flags token its own nine bits stand for
   *  every readout, so a partial override is not expressible in the file.
   *  All-off is distinct from inheriting: the token carries the bit-10
   *  mask-present sentinel, so every readout can be turned off per trace
   *  and survive a save/load. */
  measurements: PlotMeasurements | null;
  /** Session-only preservation of this plot's file tokens for what the live
   *  state cannot re-express: origValueToken is the raw val token when value
   *  decoded to null (a token this build has no engine meaning for), and
   *  origElementIndex is the raw ne ordinal when elementId never resolved
   *  (the index named a line this build cannot construct). encodeScopeLine
   *  falls back to them so an edit-save-reload cycle keeps such a plot
   *  unattached instead of silently rewriting it into a wrong one; real
   *  state always wins when it exists. Null for a UI-created plot. */
  origValueToken: number | null;
  origElementIndex: number | null;
}

export interface Scope {
  /** The `o` line's identity, for undo/redo and serialization. */
  id: number;
  /** The `o` line's tokens after the element index, exactly as loaded: speed,
   *  plot flags, scale, trace label and the rest. None of it is interpreted
   *  and none of it crosses the wasm boundary; it is carried so that saving a
   *  loaded circuit does not truncate the line. Null for a scope created in
   *  the UI, where there is no file line to preserve and one is generated at
   *  save time. */
  raw: string[] | null;
  /** The traces, in the order they appear on the line. Plot 0 is the line's
   *  `e` element; later plots carry their own `ne val` pairs. */
  plots: ScopePlot[];
  /** Sim timesteps per column, the horizontal zoom (Scope.java:57). */
  speed: number;
  /** Stacking column; scopes sharing a position share a canvas row. */
  position: number;
  /** Manual scale mode, where /div comes from each plot's manScale. */
  manualScale: boolean;
  /** Max Scale mode: pin the auto-scale to the measured peak. */
  maxScale: boolean;
  /** The scope's own label, overriding the element-derived one. */
  label: string;
  /** Vertical divisions in manual scale mode; the Properties dialog's
   *  Divisions box, persisted on the `o` line under FLAG_DIVISIONS
   *  (Scope.java:83, ScopeSerializer.java:18-19). */
  manDivisions: number;
  /** Overlay and instrument-mode flags, all defaulting off except scale/max. */
  showScale: boolean;
  showMax: boolean;
  showMin: boolean;
  showP2P: boolean;
  showFreq: boolean;
  showRMS: boolean;
  showAverage: boolean;
  showDutyCycle: boolean;
  fftPlot: boolean;
  logSpectrum: boolean;
  plotXY: boolean;
  /** Show the per-bin phase difference between the voltage and current plots
   *  under the FFT spectrum (ScopeFFT.drawPhaseAngle, ScopeFFT.java:114-171);
   *  flag bit 23 on the `o` line (ScopeSerializer.java:36,67). */
  showPhaseAngle: boolean;
  /** The X-Y plot trail fade time constant in sim timesteps: the persistence
   *  canvas fades with time constant `trailPersistence * timeStep` seconds
   *  (ScopePlot2d.trailPersistence, ScopePlot2d.java:23-24). Session-only: the
   *  text `o` line never carries it, only the XML format does
   *  (ScopeSerializer.java:122-123). Zero keeps the legacy hard-coded fade. */
  trailPersistence: number;
  /** The X and Y axis plot indexes, positions into `plots`, upstream's
   *  plot2d.plotX/plotY (ScopePlot2d.java:22-23). Defaults 0 and 1. Like the
   *  trail they are session-only: the text `o` line carries no X-Y pair, only
   *  upstream's XML format does (its xy2x/xy2y attributes). */
  plotX: number;
  plotY: number;
  /** Brightness and RGB colour modulator plot indexes into `plots`, -1 for
   *  none (ScopePlot2d.plotBrightness/plotColorR/G/B, ScopePlot2d.java:24-26).
   *  A set index tints or dims the locus by that plot's latest sample.
   *  Session-only like the axes. */
  plotBrightness: number;
  plotColorR: number;
  plotColorG: number;
  plotColorB: number;
  /** Show Extended Info: draw the element's info lines on the scope
   *  (ScopeOverlays.draw, ScopeOverlays.java:216-217). */
  showElmInfo: boolean;
  /** The scope-line `showV`/`showI` label flags (ScopeSerializer.java:26-27).
   *  Unlike `scaleV`/`scaleA`, these are live: upstream's `calcVisiblePlots`
   *  draws a voltage plot only when showV is on and a current plot only when
   *  showI is on (Scope.java:289-315), so a loaded scope with the flag clear
   *  hides that trace, and the Properties dialog's Show Voltage / Show Current
   *  boxes toggle them (Scope.java:115-134). */
  showI: boolean;
  showV: boolean;
  /** The fixed `scaleV`/`scaleA` tokens a scope line carries after its flags
   *  (ScopeSerializer.java:201-202). The port derives scale per plot, so these
   *  only keep a regenerated line faithful to the file. */
  scaleV: number;
  scaleA: number;
  trigger: ScopeTrigger;
}

/** The measurement word a plot without its own mask inherits: the scope's
 *  own readout flags. */
export function measurementsFromScope(scope: Scope): PlotMeasurements {
  return {
    showScale: scope.showScale,
    showMax: scope.showMax,
    showMin: scope.showMin,
    showP2P: scope.showP2P,
    showFreq: scope.showFreq,
    showRMS: scope.showRMS,
    showAverage: scope.showAverage,
    showDutyCycle: scope.showDutyCycle,
    showPhaseAngle: scope.showPhaseAngle,
  };
}

/** The readout flags a plot actually draws with: its own mask when it has
 *  one, the scope word otherwise. */
export function effectiveMeasurements(scope: Scope, plot: ScopePlot): PlotMeasurements {
  return plot.measurements ?? measurementsFromScope(scope);
}

/** Whether a plot carries a per-trace measurement that differs from the scope
 *  default, the channel chip's badge condition. A mask that happens to equal
 *  the scope word draws identically to inheriting, so it earns no badge. */
export function plotOverridesScope(scope: Scope, plot: ScopePlot): boolean {
  const mask = plot.measurements;
  if (mask === null) return false;
  const inherited = measurementsFromScope(scope);
  return PLOT_MEASUREMENT_KEYS.some((k) => mask[k] !== inherited[k]);
}

/** Whether any plot of the scope overrides the scope word. The properties
 *  dialog seeds its "Apply to all traces" toggle from this, so reopening the
 *  dialog while overrides exist starts targeting the selected channel
 *  instead of silently flipping every checkbox back to all traces. */
export function anyPlotOverrides(scope: Scope): boolean {
  return scope.plots.some((p) => plotOverridesScope(scope, p));
}

/** The one element every plot shares, or null when they do not. Upstream
 *  shows the per-element Plots rows only under this all-plots-one-element
 *  gate (Scope.java:1239-1246): taking the first plot's element instead would
 *  let a mixed-element scope check Show Ic and attach an ic plot to whichever
 *  element happened to come first, a wrong-value round trip on save. Raw-only
 *  plots (elementId null) carry no opinion, exactly like upstream's absence of
 *  unresolvable plots. */
export function sharedPlotElement(plots: ScopePlot[]): number | null {
  let shared: number | null = null;
  for (const p of plots) {
    if (p.elementId === null) continue;
    if (shared === null) shared = p.elementId;
    else if (shared !== p.elementId) return null;
  }
  return shared;
}

export interface FrameStats {
  steps: number;
  iterations: number;
  time: number;
  converged: boolean;
  error?: string;
  /** Ids of the elements still moving when the Newton budget ran out; empty
   *  on a converged frame. Resolved to names by the caller. */
  failingElementIds: number[];
}

/** The surface of a wasm `FrameResult` that `frameStatsOf` reads. Structural,
 *  so a test stub can stand in for the wasm object and make a read throw on
 *  purpose. */
export interface FrameResultRead {
  steps: number;
  iterations: number;
  time: number;
  converged: boolean;
  error?: string | null;
  failingElementIds(): Uint32Array;
  free(): void;
}

/**
 * Reads a wasm frame result into a plain `FrameStats`. The release is
 * unconditional: `free()` runs even when a read throws (a wasm panic surfaces
 * as a JS exception from the binding), so a failing frame cannot leak the wasm
 * heap object. The throw itself is converted into an error flag so nothing
 * escapes `run` to the frame loop.
 */
export function frameStatsOf(result: FrameResultRead): FrameStats {
  try {
    return {
      steps: result.steps,
      iterations: result.iterations,
      time: result.time,
      converged: result.converged,
      error: result.error ?? undefined,
      failingElementIds: Array.from(result.failingElementIds()),
    };
  } catch (err) {
    return {
      steps: 0,
      iterations: 0,
      time: 0,
      converged: false,
      error: err instanceof Error ? err.message : String(err),
      failingElementIds: [],
    };
  } finally {
    result.free();
  }
}

/** One trace handed to the engine, in the order it will occupy in `scopeData`. */
export interface ScopeTraceSpec {
  /** Store plot id; the engine trace order is the array order, and this is
   *  what `scopeIndexOf` looks up. */
  plotId: number;
  elementId: number;
  value: ScopeValue;
  stepsPerColumn: number;
  columns: number;
  acCoupled: boolean;
  trigger: ScopeTrigger;
  displayWidth: number;
}

/** Structural shape of the wasm `TriggerInfo` the scope renderer reads. The
 *  wasm class satisfies it directly; a snapshot copy (the undocked scope
 *  window's, which receives trigger state over postMessage) carries the same
 *  fields and frees nothing. */
export interface TriggerInfoLike {
  /** Ring capacity. */
  columns: number;
  /** Ring index of the first slot returned by `scopeData`. */
  snapshot_start: number;
  /** Ring index where the display window starts. */
  start_index: number;
  state: number;
  /** Sim time at the trigger, so time conversions anchor at the
   *  trigger-stabilized window centre (Scope.java:910-915). */
  time: number;
  triggered: boolean;
  /** Columns of valid post-trigger data to draw. */
  valid_count: number;
  /** Armed with no trigger yet, the WAIT status (ScopeTrigger.java:198-204). */
  waiting: boolean;
  /** Columns actually written, capped at capacity. */
  written: number;
}

/**
 * The read-only slice of the engine the scope renderer consumes: one flat
 * min/max array per trace plus the trigger anchor, and nothing else. SimEngine
 * satisfies it directly; the undocked scope window feeds the same surface from
 * per-frame postMessage snapshots (`undocked/snapshotSource`), so docked and
 * floating scopes draw through one `drawScope`.
 */
export interface ScopeDrawSource {
  readonly time: number;
  scopeIndexOf(plotId: number): number | undefined;
  scopeData(index: number): Float32Array;
  scopeDiverged(index: number): boolean;
  triggerInfo(index: number, width: number): TriggerInfoLike & { free(): void };
  recentSamples(index: number): Float32Array;
}

/** The element operating-point readout the Show Extended Info header needs:
 *  the same flat arrays `readElementReadout` reads, so a scope can build its
 *  info lines without a fresh engine crossing. `ScopeDrawSource` carries the
 *  scope-facing surface; this widens it with the three readout getters. */
export interface ElementReadoutSource extends ScopeDrawSource {
  indexOf(id: number): number | undefined;
  elementCurrents(): Float64Array;
  elementVoltages(): Float64Array;
  elementPowers(): Float64Array;
  /** One element's live scope-value table in the order its kind declares,
   *  empty for kinds that answer nothing. On-demand like the other
   *  single-element channels, so only the read-out element pays. */
  elementScopeValues(id: number): Float64Array;
}

/** A scope's capture width for engine sizing: its registered canvas width, or
 *  a sane fallback before the panel has measured it. */
export type WidthResolver = (scopeId: number) => number | undefined;

// Exported only because the facade's `setCircuit` shares it as a parameter
// default; nothing outside the two engine modules should reach for it.
export const defaultWidth: WidthResolver = () => DEFAULT_SCOPE_WIDTH;

/**
 * Flattens the store's scopes into one engine spec per trace, in store order
 * (plot 0 then plot 1 of each scope). Pure, so the ordering is testable
 * without the wasm module. A plot with no element or no representable value
 * cannot be sampled, so it is skipped; its line is preserved via raw.
 */
export function scopePlotsToSpecs(
  scopes: Scope[],
  _settings: SimSettings,
  widthOf: WidthResolver = defaultWidth,
): ScopeTraceSpec[] {
  const out: ScopeTraceSpec[] = [];
  for (const scope of scopes) {
    const stepsPerColumn = scopeSpeed(scope.speed);
    const widthPx = widthOf(scope.id) ?? DEFAULT_SCOPE_WIDTH;
    // A triggered scope doubles its ring so pre-trigger history survives
    // (Scope.java:191-193); the engine clamps at its own bound.
    let columns = scopeColumnCount(widthPx);
    if (scope.trigger.mode !== 'freeRun') columns = Math.min(8192, columns * 2);
    for (const plot of scope.plots) {
      if (plot.elementId === null || plot.value === null) continue;
      out.push({
        plotId: plot.id,
        elementId: plot.elementId,
        value: plot.value,
        stepsPerColumn,
        columns,
        acCoupled: plot.acCoupled,
        trigger: scope.trigger,
        displayWidth: widthPx,
      });
    }
  }
  return out;
}

/** Fingerprint of the scope capture params the engine should hold. */
export function scopeParamsFingerprint(
  scopes: Scope[],
  widthOf: WidthResolver = defaultWidth,
): string {
  return scopes
    .map((s) => {
      const widthPx = widthOf(s.id) ?? DEFAULT_SCOPE_WIDTH;
      // acCoupled flows through the same fast path as speed and ring width,
      // so a coupling toggle must change the fingerprint too.
      const coupling = s.plots.map((p) => (p.acCoupled ? '1' : '0')).join('');
      return `${s.id}:${scopeSpeed(s.speed)}:${scopeColumnCount(widthPx)}:${coupling}`;
    })
    .join(';');
}
