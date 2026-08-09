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
import { postsOf } from '../model/registry';
import type { CircuitElement, SimSettings } from '../model/types';
import { scopeColumnCount, scopeSpeed, DEFAULT_SCOPE_WIDTH } from '../scope/geometry';

/** The quantity a scope trace samples. */
export type ScopeValue = 'voltage' | 'current' | 'power';

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
  /** Vertical position in -100..100, 0 centred (ScopePlot.java:42-43). */
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
   */
  setCircuit(
    elements: CircuitElement[],
    settings: SimSettings,
    scopes: Scope[],
    widthOf: WidthResolver = defaultWidth,
  ): string | null {
    const usable = elements.filter((e) => this.supports(e.kind));
    this.order = usable.map((e) => e.id);
    this.indexById = new Map(this.order.map((id, i) => [id, i]));
    this.postOffsetById = new Map();
    let offset = 0;
    for (const e of usable) {
      this.postOffsetById.set(e.id, offset);
      offset += postsOf(e).length;
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
        // as `blown`: both are interactive state the engine must see on a
        // rebuild, since `params` only carries the last value the file had.
        if (e.state !== undefined) params[e.kind === 'fuse' ? 'blown' : 'position'] = e.state;
        return {
          id: e.id,
          kind: e.kind,
          // Round at the boundary as the last line of defence: the store keeps
          // endpoints integral, but a future writer that bypasses it must not
          // reach serde's `[i32; 2]` with a fraction.
          posts: postsOf(e).map((p) => [Math.round(p.x), Math.round(p.y)]),
          // Drop non-finite params: JSON.stringify turns them into null,
          // which serde rejects for an `f64`. The store guard makes this
          // unreachable today; it is a second, independent wall.
          params: Object.fromEntries(
            Object.entries(params).filter(([, v]) => Number.isFinite(v)),
          ),
          label: e.text ?? null,
          // A resolved device model (the custom-logic `!`-line model) rides
          // the second string carrier: the label is that element's model
          // name, so the definition has to travel separately, serialised.
          model: e.model !== undefined ? JSON.stringify(e.model) : null,
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
    };

    try {
      this.sim.setCircuit(JSON.stringify(spec));
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  run(steps: number): FrameStats {
    const r = this.sim.run(steps);
    const stats: FrameStats = {
      steps: r.steps,
      iterations: r.iterations,
      time: r.time,
      converged: r.converged,
      error: r.error ?? undefined,
      failingElementIds: Array.from(r.failingElementIds()),
    };
    r.free();
    return stats;
  }

  reset(): void {
    this.sim.reset();
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

  /** Strip voltages for one transmission line's body wave, already averaged
   *  and resampled to `segments` samples (one per drawn strip). Empty before
   *  the first stamp and for ids that are not transmission lines, so the draw
   *  falls back to the flat body. */
  transmissionLineWave(id: number, segments: number): Float32Array {
    return this.sim.transmissionLineWave(id, segments);
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
