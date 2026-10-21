/** The browser implementation of `SimHost`: a read-side adapter over the wasm
 *  facade and the store, reading the frame loop's per-frame cache for the
 *  operating-point triple so a query never pays a second crossing for what the
 *  renderer already fetched this frame.
 *
 *  It deliberately does not own building or stepping. The frame loop is the
 *  single builder (it rebuilds on every revision change within one frame) and
 *  the single stepper while the run is live, so `sync` is a no-op here and
 *  `step` refuses while the loop is running. Step 4's headless runner provides
 *  the other implementation of the same interface, where `sync` builds and
 *  `step` advances synchronously. */

import type { CommandStore } from '../../commands/types';
import type { SimEngine } from '../../engine/simulator';
import type { ElementReadings, ScopeSamples, SimHost } from '../../engine/simHost';
import { sampleTraceRing } from '../../engine/scopeModel';
import { cachedBusWidths, postsForRender } from '../../model/busWidths';
import { defFor } from '../../model/registry';
import { scopeSpeed } from '../../scope/geometry';
import { infoLines as elementInfoLines } from '../../render/infoBox';
import { frameReadoutArrays, readElementInfoValues } from '../useLiveSimReadout';

/** The readout of one trace, shared by every plot of a scope: all traces of a
 *  scope are registered with the same ring geometry, so one time base serves
 *  them all. */
function plotLabel(kind: string | undefined, value: string): string {
  const name = kind === undefined ? 'plot' : (defFor(kind)?.label ?? kind);
  return `${name} ${value}`;
}

export function createBrowserSimHost(engine: SimEngine, store: CommandStore): SimHost {
  return {
    sync() {
      // The frame loop owns the build. A query issued between frames reads the
      // last frame's engine state, which is at most one frame behind the store;
      // building here would duplicate the loop's live-state overlay, its scope
      // trace list and its two report channels.
    },

    time: () => engine.time,

    running: () => store.getState().running,

    step(seconds, maxSteps) {
      // The loop owns stepping while the run is live, so the browser refuses
      // rather than racing it. Paused, the loop is not advancing the engine, so
      // a synchronous step here is safe and is what sim.step means.
      if (store.getState().running) {
        return { time: engine.time, steps: 0, stopped: 'pause the simulation first' };
      }
      const dt = store.getState().settings.timeStep;
      const wanted = dt > 0 ? Math.max(1, Math.round(seconds / dt)) : maxSteps;
      const steps = Math.max(0, Math.min(maxSteps, wanted));
      const stats = engine.run(steps);
      return {
        time: engine.time,
        steps: stats.steps,
        ...(stats.error !== undefined ? { stopped: stats.error } : {}),
      };
    },

    nodeVoltages: () => engine.nodeVoltages(),

    elementReadings(id): ElementReadings | null {
      const idx = engine.indexOf(id);
      const element = store.getState().elements.find((e) => e.id === id);
      if (idx === undefined || element === undefined) return null;
      const offset = engine.postOffset(id);
      const nodes = engine.elementNodes();
      const volts = engine.nodeVoltages();
      const postCurrents = engine.elementPostCurrents();
      const posts = postsForRender(element, cachedBusWidths(store.getState().elements));
      const voltages: number[] = new Array(posts.length);
      const currents: number[] = new Array(posts.length);
      for (let i = 0; i < posts.length; i++) {
        const node = offset === undefined ? undefined : nodes[offset + i];
        voltages[i] = node === undefined ? 0 : (volts[node] ?? 0);
        currents[i] = offset === undefined ? 0 : (postCurrents[offset + i] ?? 0);
      }
      // The shared per-frame cache supplies the power array; the readout triple
      // is one crossing per frame no matter how many consumers read it.
      const { powers } = frameReadoutArrays(engine);
      return { voltages, currents, power: powers[idx] ?? 0 };
    },

    infoLines(id): string[] {
      const element = store.getState().elements.find((e) => e.id === id);
      if (element === undefined) return [];
      return elementInfoLines(element.kind, element, readElementInfoValues(engine, element));
    },

    scopeSamples(scopeId): ScopeSamples | null {
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
