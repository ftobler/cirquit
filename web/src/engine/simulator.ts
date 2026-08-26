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
import { defaultWidth, frameStatsOf, scopePlotsToSpecs } from './scopeModel';
import type { FrameStats, Scope, ScopeTraceSpec, WidthResolver } from './scopeModel';

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
    // Staged locally and published only once the engine accepts the build.
    // The engine commits nothing on rejection and keeps solving its previous
    // circuit, so the facade must keep describing that previous circuit:
    // publishing the refused order would leave render slices, the scope fast
    // path and the live-token ids indexing geometry the engine does not hold.
    const order = usable.map((e) => e.id);
    const indexById = new Map(order.map((id, i) => [id, i]));
    const postOffsetById = new Map<number, number>();
    let offset = 0;
    for (const e of usable) {
      postOffsetById.set(e.id, offset);
      offset += postsForRender(e, busWidths).length;
    }

    // One spec per plot, in store order, so a two-plot line fills two engine
    // traces in the same order the file listed them.
    const traceSpecs = scopePlotsToSpecs(scopes, settings, widthOf).filter((s) =>
      indexById.has(s.elementId),
    );
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
    } catch (err) {
      // Publish nothing: the engine's own build is transactional, so the
      // staged maps above die with the refused spec.
      return err instanceof Error ? err.message : String(err);
    }
    this.indexById = indexById;
    this.postOffsetById = postOffsetById;
    this.scopeOrder = traceSpecs;
    return null;
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
   * only, never per frame. Each payload entry carries the id of the element
   * its tokens belong to, zipped together inside the engine from one held
   * circuit, so the keying here can never drift with the order elements were
   * handed in.
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
    for (const entry of parsed) {
      out[entry.id] = entry.tokens ?? {};
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
