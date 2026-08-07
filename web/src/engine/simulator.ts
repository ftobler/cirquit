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

export interface Scope {
  id: number;
  elementId: number;
  value: 'voltage' | 'current' | 'power';
  label?: string;
  /** The `o` line's tokens after the element index, exactly as loaded: speed,
   *  plot flags, scale, trace label and the rest. None of it is interpreted
   *  yet and none of it crosses the wasm boundary; it is carried so that
   *  saving a loaded circuit does not truncate the line. */
  raw?: string[];
}

export interface FrameStats {
  steps: number;
  iterations: number;
  time: number;
  converged: boolean;
  error?: string;
}

/** Columns retained per scope trace. */
const SCOPE_COLUMNS = 512;

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
  /** Scopes actually handed to the engine, in engine index order. */
  private scopeOrder: Scope[] = [];

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

    const stepsPerColumn = Math.max(1, Math.floor(settings.stepsPerFrame / 8));
    const spec = {
      elements: usable.map((e) => ({
        id: e.id,
        kind: e.kind,
        posts: postsOf(e).map((p) => [p.x, p.y]),
        params: { ...e.params, ...(e.state !== undefined ? { position: e.state } : {}) },
        label: e.text ?? null,
        flags: e.flags,
      })),
      options: {
        timeStep: settings.timeStep,
        stepsPerFrame: settings.stepsPerFrame,
        maxSubiterations: 100,
        dcOperatingPoint: true,
      },
      scopes: (this.scopeOrder = scopes.filter((s) => this.indexById.has(s.elementId))).map(
        (s) => ({
          elementId: s.elementId,
          value: s.value,
          post: 0,
          stepsPerColumn,
          columns: SCOPE_COLUMNS,
        }),
      ),
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

  /** Engine-side index of a scope, or undefined if it was not registered. */
  scopeIndexOf(scopeId: number): number | undefined {
    const i = this.scopeOrder.findIndex((s) => s.id === scopeId);
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
