/** Live Voltage/Current/Power readout for the element edit panel. The engine's
 *  operating-point arrays are rewritten every frame, so the readout re-reads
 *  them on a rAF loop while the panel is mounted with one element selected.
 *  Without the loop the panel would show a snapshot from whenever the store
 *  last re-rendered, frozen while the sim runs. */

import { useEffect, useState } from 'react';
import type { ElementReadoutSource } from '../engine/simulator';
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

/** Reads the three engine operating-point arrays for one element id. Pure, so
 *  the mapping is testable without React or a rAF; a missing engine, a missing
 *  selection, or an id the engine skipped all read as an empty readout. */
export function readElementReadout(
  engine: ElementReadoutSource | null,
  selectedId: number | undefined,
): ElementReadout {
  if (!engine || selectedId === undefined) return {};
  const idx = engine.indexOf(selectedId);
  if (idx === undefined) return {};
  return {
    current: engine.elementCurrents()[idx],
    voltage: engine.elementVoltages()[idx],
    power: engine.elementPowers()[idx],
  };
}

/** The info-table variant of [`readElementReadout`]: adds the on-demand
 *  scope-value crossing only for the kinds whose tables actually read it,
 *  so hovering anything else keeps the boundary silent. Pure like its base. */
export function readElementInfoValues(
  engine: ElementReadoutSource | null,
  element: CircuitElement | undefined,
): ElementInfoValues {
  const base = readElementReadout(engine, element?.id);
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
  const frame = () => {
    raf = requestAnimationFrame(frame);
    emit(read());
  };
  raf = requestAnimationFrame(frame);
  return () => cancelAnimationFrame(raf);
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
    return tickReadout(() => readElementReadout(engine, selectedId), setReadout);
  }, [engine, selectedId]);
  return readout;
}
