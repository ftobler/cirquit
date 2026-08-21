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

/** The quantity a scope trace samples. */
export type ScopeValue = 'voltage' | 'current' | 'power' | 'charge';

/** Trigger acquisition settings, mirroring ScopeTrigger.java. Free run
 *  disables the trigger. The strings match the engine's serde names. */
export interface ScopeTrigger {
  mode: 'freeRun' | 'normal' | 'auto';
  edge: 'rising' | 'falling';
  level: number;
}

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
    // they flood through wire chains (upstream's detectBusWidths), so the
    // pass runs over the usable list before any post list is laid out. A bus
    // wire then hands the engine one terminal per bit at each endpoint.
    const busWidths = resolveBusWidths(usable);
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
        // A switch's live position rides in as `position`, a fuse's live blown
        // as `blown`, a bus logic input's live word as `value`: all interactive
        // state the engine must see on a rebuild, since `params` only carries
        // the last value the file had.
        if (e.state !== undefined) {
          params[e.kind === 'fuse' ? 'blown' : e.kind === 'busLogicInput' ? 'value' : 'position'] =
            e.state;
        }
        // The resolved width travels with the wire so the engine builds the
        // same bus the offsets above were laid out for.
        if (e.kind === 'wire') {
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
          // A resolved device model (the custom-logic `!`-line model) rides
          // the second string carrier: the label is that element's model
          // name, so the definition has to travel separately, serialised.
          // The audio/data inputs reuse the same carrier with a different
          // payload: their samples live in a session cache keyed by
          // `params.fileNum`, so the model is resolved here by kind rather
          // than riding the element (which would make a copy/paste carry the
          // whole buffer; see sampleCache.ts).
          model:
            e.model !== undefined
              ? JSON.stringify(e.model)
              : e.kind === 'audioInput' || e.kind === 'dataInput'
                ? modelJsonFor(e)
                : null,
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
