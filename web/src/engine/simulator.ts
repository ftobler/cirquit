/**
 * Facade over the Rust/WebAssembly engine.
 *
 * The boundary is crossed once per animation frame: the app pushes a circuit
 * when the netlist changes, then calls `run` and reads back flat arrays. All
 * element models, matrix assembly and Newton iteration happen inside the wasm
 * module, so per-element work never touches JavaScript.
 */

import init, { Simulator as WasmSimulator, supportedKinds } from '../wasm/circuit_engine';
import { postsOf } from '../model/registry';
import type { CircuitElement, SimSettings } from '../model/types';

/** The quantity a scope trace samples. */
export type ScopeValue = 'voltage' | 'current' | 'power';

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
}

export interface Scope {
  /** The `o` line's identity, for undo/redo and serialization. */
  id: number;
  /** The `o` line's tokens after the element index, exactly as loaded: speed,
   *  plot flags, scale, trace label and the rest. None of it is interpreted
   *  yet and none of it crosses the wasm boundary; it is carried so that
   *  saving a loaded circuit does not truncate the line. Null for a scope
   *  created in the UI, where there is no file line to preserve and one is
   *  generated at save time. */
  raw: string[] | null;
  /** The traces, in the order they appear on the line. Plot 0 is the line's
   *  `e` element; later plots carry their own `ne val` pairs. */
  plots: ScopePlot[];
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

/** Columns retained per scope trace. */
const SCOPE_COLUMNS = 512;

/** One trace handed to the engine, in the order it will occupy in `scopeData`. */
export interface ScopeTraceSpec {
  /** Store plot id; the engine trace order is the array order, and this is
   *  what `scopeIndexOf` looks up. */
  plotId: number;
  elementId: number;
  value: ScopeValue;
  stepsPerColumn: number;
  columns: number;
}

/**
 * Flattens the store's scopes into one engine spec per trace, in store order
 * (plot 0 then plot 1 of each scope). Pure, so the ordering is testable
 * without the wasm module. A plot with no element or no representable value
 * cannot be sampled, so it is skipped; its line is preserved via raw.
 */
export function scopePlotsToSpecs(scopes: Scope[], settings: SimSettings): ScopeTraceSpec[] {
  const stepsPerColumn = Math.max(1, Math.floor(settings.stepsPerFrame / 8));
  const out: ScopeTraceSpec[] = [];
  for (const scope of scopes) {
    for (const plot of scope.plots) {
      if (plot.elementId === null || plot.value === null) continue;
      out.push({
        plotId: plot.id,
        elementId: plot.elementId,
        value: plot.value,
        stepsPerColumn,
        columns: SCOPE_COLUMNS,
      });
    }
  }
  return out;
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
  setCircuit(elements: CircuitElement[], settings: SimSettings, scopes: Scope[]): string | null {
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
    const traceSpecs = (this.scopeOrder = scopePlotsToSpecs(scopes, settings).filter((s) =>
      this.indexById.has(s.elementId),
    ));
    const spec = {
      elements: usable.map((e) => {
        const params = { ...e.params, ...(e.state !== undefined ? { position: e.state } : {}) };
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

  elementVoltages(): Float64Array {
    return this.sim.elementVoltages();
  }

  /** Instrument reading per element: a probe's selected meter value, every
   *  other element its voltage difference, in the engine's element order. */
  elementValues(): Float64Array {
    return this.sim.elementValues();
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

  /** Live parameter edit; false means the engine cannot patch this one. */
  setParam(id: number, name: string, value: number): boolean {
    return this.sim.setParam(id, name, value);
  }

  setState(id: number, state: number): boolean {
    return this.sim.setState(id, state);
  }
}
