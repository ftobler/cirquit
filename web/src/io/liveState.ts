/**
 * Live operating-point tokens crossing back out of the engine, and the pure
 * overlay that writes them into copies of the elements for serialization or a
 * rebuild. Event-driven (save and rebuild only), so the per-frame animation
 * loop never touches this module.
 */

import type { CircuitElement } from '../model/types';

/** Live file-format token values keyed by element id. Each entry maps a token
 *  name to its live value: a capacitor's `voltDiff`, an inductor's `current`,
 *  a transistor's `lastVbe`/`lastVbc`, and so on. Empty when the engine holds
 *  nothing. */
export type LiveState = Record<number, Record<string, number>>;

/**
 * Overlays live engine state onto a copy of the elements: merges only the
 * tokens `live` holds for each element id into a NEW `params` object on a NEW
 * element object. Elements with no entry pass through with their params copied
 * anyway, so the caller's array is never mutated and no two results share a
 * params object. Pure and headless, so the serializer and the frame loop can
 * share it without the wasm module.
 */
export function overlayLiveState(elements: CircuitElement[], live: LiveState): CircuitElement[] {
  return elements.map((e) => {
    const tokens = live[e.id];
    if (tokens === undefined) return { ...e, params: { ...e.params } };
    return { ...e, params: { ...e.params, ...tokens } };
  });
}

/**
 * Whether a rebuild may inject the engine's live state: true when the engine
 * still holds this document, i.e. the document recorded at the last setCircuit
 * equals the store's current one. A load or New bumps the document counter, so
 * their rebuilds refuse and seed from the new file's tokens instead. Undo and
 * redo do not bump the counter, so their rebuilds keep the live charge,
 * matching upstream whose undo snapshots carry live values.
 *
 * The same answer is the engine's `preserveRun` flag, because it is the same
 * question: a rebuild that continues this document continues its run, so the
 * clock, the adaptive step and the scope captures carry across too, and the
 * operating point is not re-solved. Editing the shape of a running circuit
 * must not restart it (upstream's `analyzeCircuit` never touches `t`; only
 * `resetAction` does).
 */
export function shouldInjectLiveState(builtDocument: number, currentDocument: number): boolean {
  return builtDocument === currentDocument;
}

/**
 * The document a rebuild records for the next rebuild's live-state gate: the
 * build's document only when setCircuit succeeded, otherwise the previous
 * value unchanged. A failed build leaves the engine holding a stale or partial
 * circuit, so recording its document anyway would let the next rebuild pull
 * live tokens off that stale engine and land them on the wrong element.
 */
export function recordBuildOnSuccess(
  builtDocument: number,
  document: number,
  err: string | null,
): number {
  return err === null ? document : builtDocument;
}
