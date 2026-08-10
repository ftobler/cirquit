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
 */
export function shouldInjectLiveState(builtDocument: number, currentDocument: number): boolean {
  return builtDocument === currentDocument;
}
