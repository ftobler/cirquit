/** The engine surface the read side needs, kept as an interface so the store
 *  and the query layer never hold a `SimEngine` directly. The browser fills it
 *  in from the frame loop's per-frame readback; step 4's headless runner fills
 *  it in from a synchronous build-and-step loop. A query reads through this,
 *  never through the wasm facade, so `web/src/commands/queries.ts` stays free
 *  of wasm and of the DOM.
 *
 *  Every method returns plain data, already copied out of the engine: the
 *  facade's getters each cross the wasm boundary into a fresh typed array, so
 *  nothing here hands a query a live view it could mutate. */

/** The outcome of advancing simulated time. `stopped` carries the engine's own
 *  refusal (a non-convergent frame, a stop trigger) or the browser host's
 *  "pause the simulation first". */
export interface SimStepResult {
  time: number;
  steps: number;
  stopped?: string;
}

/** One element's live readings, in the engine's post order. `voltages` is the
 *  node voltage at each terminal, `currents` the current each terminal
 *  exchanges with its node (positive into the node from the element, so a
 *  two-terminal element reads `-I` at post 0 and `+I` at post 1), and `power`
 *  the scope-convention dissipation (positive dissipated, negative generated).
 *  Null when the id is not in the engine's current build. */
export interface ElementReadings {
  voltages: number[];
  currents: number[];
  power: number;
}

/** One scope's captured waveform: `t` is the simulated time of each column in
 *  seconds, oldest first, and `plots` carries one value series per samplable
 *  plot, aligned with `t`. The value per column is the column's upper envelope
 *  (the ring stores a min/max pair per column). */
export interface ScopeSamples {
  t: number[];
  plots: { label: string; values: number[] }[];
}

export interface SimHost {
  /** Ensure the engine holds the current document (build if revision moved).
   *  The browser host deliberately does nothing here: the frame loop is the
   *  single builder and rebuilds on every revision change within one frame, so
   *  a query reads the last frame's engine state. The headless host owns the
   *  build and performs it here. */
  sync(): void;
  time(): number;
  running(): boolean;
  /** Advance simulated time. Browser host: refused while the frame loop runs
   *  (the loop owns stepping); headless host: steps synchronously. */
  step(seconds: number, maxSteps: number): SimStepResult;
  nodeVoltages(): Float64Array;
  elementReadings(id: number): ElementReadings | null;
  /** The info box text, shared code (`render/infoBox.ts` `infoLines`). */
  infoLines(id: number): string[];
  scopeSamples(scopeId: number): ScopeSamples | null;
}
