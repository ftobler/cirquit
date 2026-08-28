/**
 * Shared guard state for a wasm trap. A Rust panic under `panic = "abort"`
 * surfaces as a `WebAssembly.RuntimeError` that re-throws on every later engine
 * call, so once the engine traps no code path may drive it. Both the frame loop
 * and the user-action crossings (reset, findDcOperatingPoint) funnel through
 * one guard so a single dead-engine flag stops every path, and the dedicated
 * banner is reported exactly once instead of the opaque trap string.
 */

/** Banner shown while the engine is trapped; clear that a reload is needed. */
export const ENGINE_TRAPPED_MESSAGE = 'Simulation engine trapped; reload the page';

/** Set when a trap is caught, read by the loop to skip `run()` and the draw. */
export let engineTrapped = false;

/** Marks the engine trapped, or clears it for a freshly reloaded engine. */
export function setEngineTrapped(value: boolean): void {
  engineTrapped = value;
}

/** Clears the trap flag, e.g. when a fresh engine is handed to the loop. */
export function resetEngineTrap(): void {
  engineTrapped = false;
}

/** Reads the trap flag without exposing a writable binding. */
export function isEngineTrapped(): boolean {
  return engineTrapped;
}

/**
 * Runs `body` and, on a wasm RuntimeError, marks the engine dead and reports
 * the dedicated banner instead of the opaque trap string. Every other throw is
 * reported as-is so a draw bug still surfaces. Kept out of the hook so both the
 * frame body and the user-action crossings (reset, findDcOperatingPoint) share
 * one survival guarantee and one dead-engine flag.
 */
export function trapGuard(body: () => void, report: (message: string) => void): void {
  try {
    body();
  } catch (err) {
    // A RuntimeError from the wasm boundary is an engine trap: unrecoverable
    // under panic=abort, so mark the engine dead and report the dedicated
    // banner rather than the opaque trap string. The loop then stops driving
    // the dead engine and keeps this banner up.
    if (err instanceof Error && err.name === 'RuntimeError') {
      engineTrapped = true;
      report(ENGINE_TRAPPED_MESSAGE);
      return;
    }
    report(err instanceof Error ? err.message : String(err));
  }
}
