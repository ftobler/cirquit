/** The headless implementation of `SimHost`: it owns a `SimEngine` and is the
 *  only builder and stepper in the process.
 *
 *  The browser host delegates both to the animation frame loop, so its `sync`
 *  is a no-op and its `step` refuses while the run is live. There is no frame
 *  loop here, so `sync` performs the build the loop would have done and `step`
 *  advances the engine synchronously. Reads mirror the browser host so a query
 *  returns the same shape whichever host is attached; the only difference is
 *  that the operating-point triple is read straight off the engine instead of a
 *  shared per-frame cache, because there is no frame to share with.
 *
 *  `sim.run` and `sim.pause` are flags on the store here. Nothing advances the
 *  clock except `sim.step`, so an agent that forgets to pause cannot have the
 *  circuit move under a query. */

import type { CommandStore } from '../src/commands/types';
import type { SimEngine } from '../src/engine/simulator';
import type { ElementReadings, ScopeSamples, SimHost, SimStepResult } from '../src/engine/simHost';
import { sampleTraceRing } from '../src/engine/scopeModel';
import { cachedBusWidths, postsForRender } from '../src/model/busWidths';
import { defFor } from '../src/model/registry';
import { recordBuildOnSuccess, overlayLiveState, shouldInjectLiveState } from '../src/io/liveState';
import { infoLines as elementInfoLines, type InfoLinesValues } from '../src/render/infoBox';
import { scopeSpeed } from '../src/scope/geometry';
import { traceScopes } from '../src/scope/embedded';

/** Hard cap on the steps one `sim.step` call may run, independent of the
 *  caller's `maxSteps`. A circuit with a 1 ps timestep asked for 10 s of
 *  simulated time needs 1e13 steps; without a cap the process hangs inside one
 *  wasm crossing. 50,000 steps is a quarter second of a 5 us timestep, far more
 *  than any interactive read needs, and runs in well under the wall budget. */
export const MAX_HEADLESS_STEPS = 50_000;

/** Wall-clock budget for one `sim.step` call, in milliseconds. The cap above
 *  bounds the step count; this bounds the time a heavy circuit's steps may take,
 *  so a pathological build returns a `stopped` reason instead of blocking the
 *  stdio loop. Checked between chunks, never inside a wasm crossing. */
export const STEP_WALL_BUDGET_MS = 1500;

/** Steps run between wall-clock checks. Large enough that the check is
 *  negligible, small enough that the budget is honoured within a few ms. */
const STEP_CHUNK = 1_000;

/** The readout of one trace, shared by every plot of a scope: all traces of a
 *  scope are registered with the same ring geometry, so one time base serves
 *  them all. */
function plotLabel(kind: string | undefined, value: string): string {
  const name = kind === undefined ? 'plot' : (defFor(kind)?.label ?? kind);
  return `${name} ${value}`;
}

export function createHeadlessSimHost(engine: SimEngine, store: CommandStore): SimHost {
  // The frame loop's rebuild bookkeeping, kept locally: which revision the
  // engine holds, which document it built, and the revision/error of a refused
  // build so a bad document is not re-attempted on every read.
  let loadedRevision = -1;
  let builtDocument = -1;
  let failedRevision = -1;
  let failedError: string | null = null;

  function sync(): void {
    const s = store.getState();
    if (s.revision === loadedRevision) return;
    if (failedRevision === s.revision && failedError !== null) return;
    loadedRevision = s.revision;
    // A mid-run rebuild keeps the live charge only while the engine still holds
    // this document; a load or New restarts from the file's own tokens.
    const continues = shouldInjectLiveState(builtDocument, s.document);
    const build = continues ? overlayLiveState(s.elements, engine.elementStateTokens()) : s.elements;
    const allScopes = traceScopes(s.scopes, s.elements);
    // The width resolver is the browser panel's measured canvas width, which
    // does not exist here; `undefined` takes the facade's sane fallback.
    const err = engine.setCircuit(build, s.settings, allScopes, undefined, continues);
    builtDocument = recordBuildOnSuccess(builtDocument, s.document, err);
    if (err !== null) {
      failedRevision = s.revision;
      failedError = err;
    } else {
      failedRevision = -1;
      failedError = null;
    }
  }

  function step(seconds: number, maxSteps: number): SimStepResult {
    sync();
    const s = store.getState();
    const dt = s.settings.timeStep;
    const wanted = dt > 0 ? Math.max(1, Math.round(seconds / dt)) : maxSteps;
    const effective = Math.max(0, Math.min(maxSteps, wanted));
    const limit = Math.min(effective, MAX_HEADLESS_STEPS);
    const deadline = Date.now() + STEP_WALL_BUDGET_MS;
    let done = 0;
    let stopped: string | undefined;
    while (done < limit) {
      const chunk = Math.min(STEP_CHUNK, limit - done);
      const stats = engine.run(chunk);
      done += stats.steps;
      if (stats.error !== undefined) {
        stopped = stats.error;
        break;
      }
      if (stats.steps === 0) {
        // No error but no progress: bail rather than spin on a stuck engine.
        stopped = 'the engine made no progress';
        break;
      }
      if (done < limit && Date.now() >= deadline) {
        stopped = `step budget of ${STEP_WALL_BUDGET_MS} ms exceeded after ${done} steps`;
        break;
      }
    }
    if (stopped === undefined && limit < effective) {
      stopped = `step cap of ${MAX_HEADLESS_STEPS} steps reached`;
    }
    return { time: engine.time, steps: done, ...(stopped !== undefined ? { stopped } : {}) };
  }

  return {
    sync,
    time: () => engine.time,
    running: () => store.getState().running,
    step,
    // Reads sync first: the query layer never calls `sync` itself, and a read
    // issued right after an edit (before any `sim.step`) must still see the
    // built circuit rather than an empty engine. `sync` is a no-op when the
    // revision has not moved.
    nodeVoltages(): Float64Array {
      sync();
      return engine.nodeVoltages();
    },

    elementReadings(id): ElementReadings | null {
      sync();
      const s = store.getState();
      const idx = engine.indexOf(id);
      const element = s.elements.find((e) => e.id === id);
      if (idx === undefined || element === undefined) return null;
      const offset = engine.postOffset(id);
      const nodes = engine.elementNodes();
      const volts = engine.nodeVoltages();
      const postCurrents = engine.elementPostCurrents();
      const powers = engine.elementPowers();
      const posts = postsForRender(element, cachedBusWidths(s.elements));
      const voltages: number[] = new Array(posts.length);
      const currents: number[] = new Array(posts.length);
      for (let i = 0; i < posts.length; i++) {
        const node = offset === undefined ? undefined : nodes[offset + i];
        voltages[i] = node === undefined ? 0 : (volts[node] ?? 0);
        currents[i] = offset === undefined ? 0 : (postCurrents[offset + i] ?? 0);
      }
      return { voltages, currents, power: powers[idx] ?? 0 };
    },

    infoLines(id): string[] {
      sync();
      const element = store.getState().elements.find((e) => e.id === id);
      if (element === undefined) return [];
      const idx = engine.indexOf(id);
      // The on-demand scope-value table is passed unconditionally: it is one
      // crossing, and only the kinds whose info rows read it look at it, so the
      // browser host's kind allowlist would only save work it does not need to.
      const values: InfoLinesValues =
        idx === undefined
          ? {}
          : {
              current: engine.elementCurrents()[idx],
              voltage: engine.elementVoltages()[idx],
              power: engine.elementPowers()[idx],
              scopeValues: engine.elementScopeValues(id),
            };
      return elementInfoLines(element.kind, element, values);
    },

    scopeSamples(scopeId): ScopeSamples | null {
      sync();
      const s = store.getState();
      const scope = s.scopes.find((x) => x.id === scopeId);
      if (scope === undefined) return null;
      const secondsPerColumn = scopeSpeed(scope.speed) * s.settings.timeStep;
      const simTime = engine.time;
      const series: { label: string; t: number[]; values: number[] }[] = [];
      for (const plot of scope.plots) {
        if (plot.elementId === null || plot.value === null) continue;
        const index = engine.scopeIndexOf(plot.id);
        if (index === undefined) continue;
        const data = engine.scopeData(index);
        const written = engine.scopeColumnsWritten(index);
        const sample = sampleTraceRing(data, written, data.length / 2, secondsPerColumn, simTime);
        const element = s.elements.find((e) => e.id === plot.elementId);
        series.push({ label: plotLabel(element?.kind, plot.value), ...sample });
      }
      if (series.length === 0) return { t: [], plots: [] };
      // Every trace of a scope shares the ring geometry, so the series line up;
      // clip to the shortest anyway so a trace that dropped a sample cannot
      // misalign the time base.
      const n = Math.min(...series.map((x) => x.values.length));
      const t = series[0].t.slice(series[0].t.length - n);
      return {
        t,
        plots: series.map((x) => ({ label: x.label, values: x.values.slice(x.values.length - n) })),
      };
    },
  };
}
