/** Live Voltage/Current/Power readout for the element edit panel. The engine's
 *  operating-point arrays are rewritten every frame, so the readout re-reads
 *  them on a rAF loop while the panel is mounted with one element selected.
 *  Without the loop the panel would show a snapshot from whenever the store
 *  last re-rendered, frozen while the sim runs. */

import { useEffect, useState } from 'react';
import type { ElementReadoutSource } from '../engine/scopeModel';
import type { CircuitElement } from '../model/types';

export interface ElementReadout {
  current?: number;
  voltage?: number;
  power?: number;
}

/** The kinds whose info tables read per-element scope values through the
 *  on-demand readback (the transistor's junction rows today; the MOSFET,
 *  lamp and fuse tables later). Everything else stays zero-cost. */
const INFO_SCOPE_KINDS = new Set(['transistor']);

/** The readout an info table draws on: the flat-array triple, plus the
 *  element's live scope-value table when its kind needs one. */
export interface ElementInfoValues extends ElementReadout {
  scopeValues?: Float64Array;
}

/** The three engine operating-point arrays a readout reads. They are fetched
 *  together because they share a frame. */
export interface FrameReadoutArrays {
  currents: Float64Array;
  voltages: Float64Array;
  powers: Float64Array;
}

/** Frame-level cache for the three operating-point arrays. Each getter copies a
 *  full array across the wasm boundary, so every consumer inside one animation
 *  frame, the canvas render loop's hover readout, the ScopePanel, the undocked
 *  mirror and the LiveReadout pump, must share one fetch. The cache is keyed by
 *  the rAF frame timestamp: all callbacks in a frame receive the same
 *  timestamp, so whichever consumer reads first populates the cache and the
 *  rest in that frame reuse it. `beginReadoutFrame` opens a frame and is
 *  idempotent within it, so the several rAF loops that each call it per frame
 *  never wipe a sibling's just-fetched arrays. */
let frameStamp: number | null = null;
let cachedEngine: ElementReadoutSource | null = null;
let cachedArrays: FrameReadoutArrays | null = null;

/** Opens a new readout frame. Called at the top of every animation-frame
 *  callback that reads an operating-point readout. Two callbacks in the same
 *  frame pass the same timestamp, so the second call is a no-op and the first
 *  consumer's fetch stands for the whole frame. */
export function beginReadoutFrame(stamp: number): void {
  if (frameStamp === stamp) return;
  frameStamp = stamp;
  cachedEngine = null;
  cachedArrays = null;
}

/** Returns the three operating-point arrays for `engine`, fetching them once
 *  per frame and returning the same copies for every caller until the next
 *  `beginReadoutFrame`. Pure apart from the cache, so it is testable without a
 *  rAF by driving `beginReadoutFrame` by hand. */
export function frameReadoutArrays(engine: ElementReadoutSource): FrameReadoutArrays {
  if (cachedEngine === engine && cachedArrays) return cachedArrays;
  cachedEngine = engine;
  cachedArrays = {
    currents: engine.elementCurrents(),
    voltages: engine.elementVoltages(),
    powers: engine.elementPowers(),
  };
  return cachedArrays;
}

/** Reads the three engine operating-point arrays for one element id. Pure, so
 *  the mapping is testable without React or a rAF; a missing engine, a missing
 *  selection, or an id the engine skipped all read as an empty readout.
 *
 *  The three getters each cross the wasm boundary into a fresh full-array copy,
 *  so the read fetches all three at most once per frame through
 *  `frameReadoutArrays` and indexes the same copies for every value. A caller
 *  that already has the frame's arrays (passed in `arrays`) skips the shared
 *  fetch entirely, which is what the frame loop does once at the top of the
 *  frame. That keeps every consumer, hovered or selected, to a single triple
 *  crossing per frame. */
export function readElementReadout(
  engine: ElementReadoutSource | null,
  selectedId: number | undefined,
  arrays?: FrameReadoutArrays,
): ElementReadout {
  if (!engine || selectedId === undefined) return {};
  const idx = engine.indexOf(selectedId);
  if (idx === undefined) return {};
  const { currents, voltages, powers } = arrays ?? frameReadoutArrays(engine);
  return {
    current: currents[idx],
    voltage: voltages[idx],
    power: powers[idx],
  };
}

/** The info-table variant of [`readElementReadout`]: adds the on-demand
 *  scope-value crossing only for the kinds whose tables actually read it,
 *  so hovering anything else keeps the boundary silent. Pure like its base;
 *  threads the caller's pre-fetched `arrays` through to the base read. */
export function readElementInfoValues(
  engine: ElementReadoutSource | null,
  element: CircuitElement | undefined,
  arrays?: FrameReadoutArrays,
): ElementInfoValues {
  const base = readElementReadout(engine, element?.id, arrays);
  if (!engine || !element || !INFO_SCOPE_KINDS.has(element.kind)) return base;
  return { ...base, scopeValues: engine.elementScopeValues(element.id) };
}

/** The per-frame pump: reads the readout once per animation frame and hands
 *  each result to `emit`, returning an unsubscribe. Kept outside the hook so
 *  the rAF subscription is testable under vitest, which has no DOM to mount
 *  the hook in. */
export function tickReadout(
  read: () => ElementReadout,
  emit: (readout: ElementReadout) => void,
): () => void {
  let raf = 0;
  const frame = (stamp: number) => {
    raf = requestAnimationFrame(frame);
    // Open the readout frame before each read: the pump shares the per-frame
    // array fetch with every other consumer (the canvas loop, the ScopePanel)
    // so the selected element's readout never pays a second wasm crossing.
    beginReadoutFrame(stamp);
    emit(read());
  };
  raf = requestAnimationFrame(frame);
  return () => cancelAnimationFrame(raf);
}

function fieldSame(a: number | undefined, b: number | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return Object.is(a, b);
}

/** True when two readouts carry the same triple, absent fields included.
 *  Object.is per field, so negative zero counts as its own value: the engine
 *  can flip a near-zero reading's sign between frames and the readout should
 *  show it rather than collapse both to zero. The pump feeds each frame's
 *  result through this so a paused simulation stops producing new objects
 *  and whatever renders the readout re-renders nothing. */
export function readoutEquals(a: ElementReadout, b: ElementReadout): boolean {
  return (
    fieldSame(a.current, b.current) &&
    fieldSame(a.voltage, b.voltage) &&
    fieldSame(a.power, b.power)
  );
}

/** Runs `tickReadout` while the panel is mounted with something to read. Only
 *  reads when the engine is present and a single element is selected; the
 *  plain state updates never touch the store, so the loop cannot fight the
 *  canvas's focus or selection logic. */
export function useLiveSimReadout(
  engine: ElementReadoutSource | null,
  selectedId: number | undefined,
): ElementReadout {
  const [readout, setReadout] = useState<ElementReadout>(() =>
    readElementReadout(engine, selectedId),
  );
  useEffect(() => {
    // The reset also clears a stale readout when the engine goes null or the
    // selection changes away from a single element, where the loop is not run.
    setReadout(readElementReadout(engine, selectedId));
    if (!engine || selectedId === undefined) return;
    return tickReadout(() => readElementReadout(engine, selectedId), (next) =>
      // Keeping the previous object on an unchanged triple lets React bail out
      // of the re-render entirely instead of reconciling at frame rate.
      setReadout((prev) => (readoutEquals(prev, next) ? prev : next)),
    );
  }, [engine, selectedId]);
  return readout;
}
