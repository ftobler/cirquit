/**
 * Facade over the Rust/WebAssembly engine.
 *
 * The boundary is crossed once per animation frame: the app pushes a circuit
 * when the netlist changes, then calls `run` and reads back flat arrays. All
 * element models, matrix assembly and Newton iteration happen inside the wasm
 * module, so per-element work never touches JavaScript.
 */

import init, {
  Simulator as WasmSimulator,
  supportedKinds,
  TriggerInfo,
} from '../wasm/circuit_engine';
import { postsForRender, resolveBusWidths } from '../model/busWidths';
import type { CircuitElement, SimSettings } from '../model/types';
import { modelJsonFor } from '../model/sampleCache';
import type { LiveState } from '../io/liveState';
import { scopeColumnCount, scopeSpeed, DEFAULT_SCOPE_WIDTH } from '../scope/geometry';

/** The quantity a scope trace samples. The strings match the engine's serde
 *  names. `resistance` is a lamp's hot resistance and `ib`..`vce` a
 *  transistor's pin plots, upstream's VAL_R and VAL_IB..VAL_VCE
 *  (LampElm.java:218-222, TransistorElm.java:582-602). */
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

const defaultWidth: WidthResolver = () => DEFAULT_SCOPE_WIDTH;

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

let wasmReady: Promise<void> | null = null;

/** Loads the wasm module once, no matter how many callers ask. */
function ensureWasm(): Promise<void> {
  wasmReady ??= init().then(() => undefined);
  return wasmReady;
}

/** The engine kind an element builds as. The custom-composite `410` element
 *  stores and draws under `customComposite`, but the engine only registers the
 *  generic `composite` kind (mod.rs:152), so a resolved one (whose `e.model`
 *  carries the `CompositeEngineSpec` `Composite::from_spec` parses) bridges to
 *  it. An unresolved composite maps to a kind nothing supports instead:
 *  `from_spec` returns None on a missing payload and `circuit.rs:259-260`
 *  would fail the whole build, so the part is dropped from the spec the same
 *  way any other unsupported element is. */
function engineKindOf(e: CircuitElement): string {
  if (e.kind !== 'customComposite') return e.kind;
  return e.model !== undefined ? 'composite' : '';
}

/** The engine's second string carrier. Objects (the custom-logic blob, a
 *  composite's `{model, external, dumps}`) and token arrays (the OTA's child
 *  dumps) cross as JSON text their engine readers parse with serde. The
 *  battery's plain-string SOC table must pass through verbatim instead:
 *  quoting it would leave one line no f64 parse accepts, the table would
 *  parse empty and every battery would stamp the flat 3.7 V whatever its
 *  chemistry says. */
function engineModelOf(e: CircuitElement): string | null {
  if (typeof e.model === 'string') return e.model;
  if (e.model !== undefined) return JSON.stringify(e.model);
  if (e.kind === 'audioInput' || e.kind === 'dataInput') return modelJsonFor(e);
  return null;
}

export class SimEngine {
  private sim: WasmSimulator;
  private kinds: Set<string>;
  /** Element ids in the order the engine received them. */
  private order: number[] = [];
  private indexById = new Map<number, number>();
  /** Offset of each element's first terminal within the flattened node list. */
  private postOffsetById = new Map<number, number>();
  /** Traces actually handed to the engine, in engine index order. */
  private scopeOrder: ScopeTraceSpec[] = [];

  private constructor(sim: WasmSimulator, kinds: Set<string>) {
    this.sim = sim;
    this.kinds = kinds;
  }

  static async create(): Promise<SimEngine> {
    await ensureWasm();
    return new SimEngine(new WasmSimulator(), new Set(supportedKinds().split('\n')));
  }

  /** Element types this engine build can actually solve. */
  supports(kind: string): boolean {
    return this.kinds.has(kind);
  }

  /**
   * Replaces the circuit. Elements whose type the engine cannot solve are
   * skipped, so a partially supported file still runs.
   *
   * `preserveRun` says this build continues the run already in progress, which
   * is what every edit-driven rebuild is: the engine then keeps its clock, its
   * adaptive timestep and the scope captures whose spec is unchanged, and skips
   * the DC operating-point re-solve. It defaults to false so a fresh document
   * (a load, New, or a test) starts at t = 0. It is the same gate as the
   * live-state injection in `useFrameLoop`, and for the same reason: both ask
   * whether the engine still holds this document.
   */
  setCircuit(
    elements: CircuitElement[],
    settings: SimSettings,
    scopes: Scope[],
    widthOf: WidthResolver = defaultWidth,
    preserveRun = false,
  ): string | null {
    const usable = elements.filter((e) => this.supports(engineKindOf(e)));
    // Bus widths are a property of the whole netlist: wide pins seed them and
    // they flood through wire chains and matching labels (upstream's
    // detectBusWidths), so the pass runs over the usable list before any post
    // list is laid out. A bus wire then hands the engine one terminal per bit
    // at each endpoint, and a wide label one terminal per bit at its anchor.
    const busWidths = resolveBusWidths(usable).widths;
    this.order = usable.map((e) => e.id);
    this.indexById = new Map(this.order.map((id, i) => [id, i]));
    this.postOffsetById = new Map();
    let offset = 0;
    for (const e of usable) {
      this.postOffsetById.set(e.id, offset);
      offset += postsForRender(e, busWidths).length;
    }

    // One spec per plot, in store order, so a two-plot line fills two engine
    // traces in the same order the file listed them.
    const traceSpecs = (this.scopeOrder = scopePlotsToSpecs(scopes, settings, widthOf).filter((s) =>
      this.indexById.has(s.elementId),
    ));
    const spec = {
      elements: usable.map((e) => {
        const params = { ...e.params };
        // The switch2 flip parity is session-only UI bookkeeping (upstream's
        // runtime `positionFlipped`, Switch2Elm.java:244), never part of the
        // file or the engine model; the spec must not carry it.
        delete params.flipParity;
        // A switch's live position rides in as `position`, a fuse's live blown
        // as `blown`, a bus logic input's live word as `value`: all interactive
        // state the engine must see on a rebuild, since `params` only carries
        // the last value the file had.
        if (e.state !== undefined) {
          params[e.kind === 'fuse' ? 'blown' : e.kind === 'busLogicInput' ? 'value' : 'position'] =
            e.state;
        }
        // The resolved width travels with the wire so the engine builds the
        // same bus the offsets above were laid out for. A labeled node gets
        // the same treatment: the engine grows one post per bit, and the text
        // format itself never carries a width token.
        if (e.kind === 'wire' || e.kind === 'labeledNode') {
          const w = busWidths.get(e.id);
          if (w !== undefined && w > 1) params.busWidth = w;
        }
        return {
          id: e.id,
          kind: engineKindOf(e),
          // Round at the boundary as the last line of defence: the store keeps
          // endpoints integral, but a future writer that bypasses it must not
          // reach serde's `[i32; 2]` with a fraction.
          posts: postsForRender(e, busWidths).map((p) => [Math.round(p.x), Math.round(p.y)]),
          // Drop non-finite params: JSON.stringify turns them into null,
          // which serde rejects for an `f64`. The store guard makes this
          // unreachable today; it is a second, independent wall.
          params: Object.fromEntries(Object.entries(params).filter(([, v]) => Number.isFinite(v))),
          label: e.text ?? null,
          model: engineModelOf(e),
          flags: e.flags,
        };
      }),
      options: {
        timeStep: settings.timeStep,
        minTimeStep: settings.minTimeStep,
        adaptive: settings.adaptiveTimeStep,
        stepsPerFrame: settings.stepsPerFrame,
        // Matches the engine default; the gmin ramps engage at subiter 100
        // and need room to climb past it.
        maxSubiterations: 1000,
        dcOperatingPoint: settings.autoDC,
      },
      scopes: traceSpecs.map((s) => ({
        elementId: s.elementId,
        value: s.value,
        post: 0,
        stepsPerColumn: s.stepsPerColumn,
        columns: s.columns,
        acCoupled: s.acCoupled,
        trigger: s.trigger,
        displayWidth: s.displayWidth,
      })),
      preserveRun,
    };

    try {
      this.sim.setCircuit(JSON.stringify(spec));
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  run(steps: number): FrameStats {
    return frameStatsOf(this.sim.run(steps));
  }

  reset(): void {
    this.sim.reset();
  }

  /**
   * Runs the one-shot Find DC Operating Point command: a whole reset under a
   * temporarily-true DC option, so the clock rewinds and a converged solve
   * commits its steady state into the reactive elements. Returns null on
   * success (the `setCircuit` convention), the sentinel "degraded" when the
   * nonlinear iteration found no operating point, or the engine's error
   * message when the reset recorded a hard failure.
   */
  findDcOperatingPoint(): string | null {
    try {
      // The engine spells success "found"; this surface keeps setCircuit's
      // convention that null means success, passing "degraded" through.
      const outcome = this.sim.findDcOperatingPoint();
      return outcome === 'found' ? null : outcome;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  /** Re-arms the stop triggers without rewinding time, so a simulation paused
   *  by a stop trigger can resume. The frame loop calls this when `running`
   *  goes false -> true; the latches clear only here and on reset. */
  clearStops(): void {
    this.sim.clearStops();
  }

  get time(): number {
    return this.sim.time;
  }

  warnings(): string[] {
    return this.sim.warnings().split('\n').filter(Boolean);
  }

  error(): string | undefined {
    return this.sim.error() ?? undefined;
  }

  nodeVoltages(): Float64Array {
    return this.sim.nodeVoltages();
  }

  /** Node index per terminal, flattened in the engine's element order. */
  elementNodes(): Uint32Array {
    return this.sim.elementNodes();
  }

  elementCurrents(): Float64Array {
    return this.sim.elementCurrents();
  }

  /** Current each terminal exchanges with its node, flattened in the engine's
   *  element order then post order, indexed like `elementNodes()`: the offset
   *  from `postOffset(id)` slices the element's own terminal currents. A
   *  two-terminal element reports `-current` at post 0 and `+current` at
   *  post 1; a ground reports `-current` (upstream `getCurrentIntoNode`). */
  elementPostCurrents(): Float64Array {
    return this.sim.elementPostCurrents();
  }

  elementVoltages(): Float64Array {
    return this.sim.elementVoltages();
  }

  /** Instrument reading per element: a probe's selected meter value, every
   *  other element its voltage difference, in the engine's element order. */
  elementValues(): Float64Array {
    return this.sim.elementValues();
  }

  /** Live render state per element, in the engine's element order. Each
   *  element defines its own scalar: a fuse's melt fraction (>= 1 blown), a
   *  lamp's filament temperature in kelvin; everything else reads 0. */
  elementStates(): Float64Array {
    return this.sim.elementStates();
  }

  /**
   * Live operating-point tokens per element, keyed by element id: the file
   * tokens each element would write if it dumped its live state (a capacitor's
   * `voltDiff`, an inductor's `current`, ...). Read at save and rebuild time
   * only, never per frame; the ids zip with `this.order`, the ids the engine
   * received in setCircuit order.
   */
  elementStateTokens(): LiveState {
    const raw = this.sim.elementStateTokens();
    if (!raw) return {};
    let parsed: { id: number; tokens: Record<string, number> }[];
    try {
      parsed = JSON.parse(raw);
    } catch {
      // The engine is authoritative; a parse failure is safer read as "no live
      // state" than as a corrupt document.
      return {};
    }
    const out: LiveState = {};
    for (let i = 0; i < parsed.length; i++) {
      const id = this.order[i];
      if (id === undefined) break;
      out[id] = parsed[i].tokens ?? {};
    }
    return out;
  }

  /** Strip voltages for one transmission line's body wave, already averaged
   *  and resampled to `segments` samples (one per drawn strip). Empty before
   *  the first stamp and for ids that are not transmission lines, so the draw
   *  falls back to the flat body. */
  transmissionLineWave(id: number, segments: number): Float32Array {
    return this.sim.transmissionLineWave(id, segments);
  }

  /** A data recorder's recorded samples, oldest first, for the frontend's
   *  export button. Empty before the first step and for ids that are not data
   *  recorders. An on-demand channel like `transmissionLineWave`, so no other
   *  element pays for the crossing. */
  recordedData(id: number): Float64Array {
    return this.sim.dataRecorderData(id);
  }

  /** One element's live scope-value table in the order its kind declares
   *  (a transistor's ib, ic, ie, vbe, vbc, vce), for the info readout's
   *  junction rows. Empty for ids whose kind answers nothing. On-demand
   *  like `transmissionLineWave`: only the read-out element pays the
   *  crossing, never a per-frame per-element loop. */
  elementScopeValues(id: number): Float64Array {
    return this.sim.elementScopeValues(id);
  }

  /** Dissipated power per element, using the scope Power-trace convention
   *  (so a delivering source reads negative), matching the readout upstream
   *  shows. */
  elementPowers(): Float64Array {
    return this.sim.elementPowers();
  }

  /** Engine-side index for an element id, or undefined if it was skipped. */
  indexOf(id: number): number | undefined {
    return this.indexById.get(id);
  }

  /** Where an element's terminals start within `elementNodes()`. */
  postOffset(id: number): number | undefined {
    return this.postOffsetById.get(id);
  }

  scopeData(index: number): Float32Array {
    return this.sim.scopeData(index);
  }

  /** Engine-side index of a scope trace, or undefined if it was not
   *  registered. Keyed on the store plot id, which is what ScopePanel draws. */
  scopeIndexOf(plotId: number): number | undefined {
    const i = this.scopeOrder.findIndex((s) => s.plotId === plotId);
    return i < 0 ? undefined : i;
  }

  /** Whether a trace has dropped a non-finite sample since the last reset (a
   *  diverged node). The sample is unusable and is discarded; this flag lets
   *  the panel caption the frozen trace as a warning instead of a healthy
   *  flatline. */
  scopeDiverged(index: number): boolean {
    return this.sim.scopeDiverged(index);
  }

  /** Live scope capture resize (speed and ring width) without a rebuild.
   *  False when the trace index is out of range; the caller then reloads. */
  setScopeParams(index: number, stepsPerColumn: number, columns: number): boolean {
    return this.sim.setScopeParams(index, stepsPerColumn, columns);
  }

  /** Live AC-coupling toggle without a rebuild. False when the trace index
   *  is out of range; the caller then reloads. */
  setScopeAcCoupling(index: number, acCoupled: boolean): boolean {
    return this.sim.setScopeAcCoupling(index, acCoupled);
  }

  /**
   * Applies every trace's capture params (speed, ring width, AC coupling)
   * through the engine's fast path, so a zoom, window resize or coupling
   * toggle never rewinds the clock. False when a trace is out of range (a
   * failed circuit load), which tells the frame loop to fall back to a full
   * reload.
   */
  applyScopeParams(scopes: Scope[], settings: SimSettings, widthOf: WidthResolver): boolean {
    const specs = scopePlotsToSpecs(scopes, settings, widthOf).filter((s) =>
      this.indexById.has(s.elementId),
    );
    if (specs.length !== this.scopeOrder.length) return false;
    let ok = true;
    for (let i = 0; i < specs.length; i++) {
      const want = specs[i];
      const have = this.scopeOrder[i];
      if (have.stepsPerColumn !== want.stepsPerColumn || have.columns !== want.columns) {
        if (!this.sim.setScopeParams(i, want.stepsPerColumn, want.columns)) {
          ok = false;
          continue;
        }
      }
      if (have.acCoupled !== want.acCoupled) {
        if (!this.sim.setScopeAcCoupling(i, want.acCoupled)) {
          ok = false;
          continue;
        }
      }
      this.scopeOrder[i] = {
        ...have,
        stepsPerColumn: want.stepsPerColumn,
        columns: want.columns,
        acCoupled: want.acCoupled,
      };
    }
    return ok;
  }

  /** This frame's recent raw samples for a trace (X-Y mode), oldest first. */
  recentSamples(index: number): Float32Array {
    return this.sim.recentSamples(index);
  }

  /** Trigger display anchor for a trace, given the display width in pixels. */
  triggerInfo(index: number, width: number): TriggerInfo {
    return this.sim.triggerInfo(index, width);
  }

  /** Live parameter edit; false means the engine cannot patch this one. */
  setParam(id: number, name: string, value: number): boolean {
    return this.sim.setParam(id, name, value);
  }

  setState(id: number, state: number): boolean {
    return this.sim.setState(id, state);
  }
}
