/**
 * Synthesized Scope state for the embedded scope windows (403 ScopeElm).
 *
 * The docked panels draw from `Scope` objects the store owns; an embedded
 * window's equivalent lives on its element as the decoded `embedded` state.
 * This module turns that into the same `Scope` shape so one engine
 * registration path (`scopePlotsToSpecs`) and one renderer (`drawScope`)
 * serve both, keyed on session-unique plot ids that were allocated at load.
 */

import type { CircuitElement } from '../model/types';
import type { Scope, ScopePlot } from '../engine/scopeModel';
import { scopeSpeed } from './geometry';

/** The Scope a 403 element's decoded state synthesizes, or null when nothing
 *  here can be sampled: no interpreted state at all (a fresh unattached scope,
 *  a truncated token) or every plot pointing at a line this build could not
 *  read. Null draws the placeholder frame, which is honest for those cases. */
export function embeddedScopeOf(e: CircuitElement): Scope | null {
  const emb = e.embedded;
  if (!emb) return null;
  // Per-plot fields are indexed like the file's plot list; keep that index
  // while filtering so each surviving plot reads its own entry.
  const plots: ScopePlot[] = emb.plots.flatMap((p, i) =>
    p.elementId === null || p.value === null
      ? []
      : [
          {
            id: p.id,
            elementId: p.elementId,
            value: p.value,
            manScale: emb.display.perPlot[i]?.manScale ?? null,
            manVPosition: emb.display.perPlot[i]?.manVPosition ?? 0,
            acCoupled: emb.display.perPlot[i]?.acCoupled ?? false,
            measurements: emb.display.perPlot[i]?.measurements ?? null,
            // An embedded window's config token round-trips verbatim in the
            // element's text; there is no o-line regeneration to preserve
            // tokens for.
            origValueToken: null,
            origElementIndex: null,
          },
        ],
  );
  if (plots.length === 0) return null;
  const d = emb.display;
  return {
    id: e.id,
    raw: null,
    plots,
    speed: scopeSpeed(d.speed),
    position: -1,
    manualScale: d.manualScale,
    maxScale: d.maxScale,
    label: d.label,
    manDivisions: d.manDivisions,
    showScale: d.showScale,
    showMax: d.showMax,
    showMin: d.showMin,
    showP2P: d.showP2P,
    showFreq: d.showFreq,
    showRMS: d.showRMS,
    showAverage: d.showAverage,
    showDutyCycle: d.showDutyCycle,
    fftPlot: d.fftPlot,
    logSpectrum: d.logSpectrum,
    plotXY: d.plotXY,
    showPhaseAngle: d.showPhaseAngle,
    trailPersistence: 0,
    plotX: 0,
    plotY: 1,
    plotBrightness: -1,
    plotColorR: -1,
    plotColorG: -1,
    plotColorB: -1,
    showElmInfo: d.showElmInfo,
    showI: d.showI,
    showV: d.showV,
    scaleV: d.scaleV,
    scaleA: d.scaleA,
    trigger: { mode: 'freeRun', edge: 'rising', level: 0 },
  };
}

/** Every trace source in the document: the docked scopes first, then one
 *  synthesized scope per embedded window with samplable plots. This is the
 *  list the engine registration and the sticky-scale pruning both walk, so
 *  the two can never disagree about what exists. The embedded half is
 *  memoised on the element array's identity like the bus-width cache: edits
 *  hand the store a fresh array, so identity is enough to know the result is
 *  stale, and a steady-state frame rebuilds nothing. */
let lastElements: CircuitElement[] | null = null;
let lastEmbedded: Scope[] = [];

export function traceScopes(docked: Scope[], elements: CircuitElement[]): Scope[] {
  if (lastElements !== elements) {
    lastElements = elements;
    lastEmbedded = elements
      .map((e) => embeddedScopeOf(e))
      .filter((s): s is Scope => s !== null);
  }
  return lastEmbedded.length > 0 ? [...docked, ...lastEmbedded] : docked;
}
