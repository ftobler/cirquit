/**
 * Offscreen persistence canvases for X-Y mode, keyed by scope id. The locus
 * is drawn into one and faded over time, so slow signals leave a trail
 * (ScopePlot2d.java:191-221). A docked panel clears its own entry on unmount;
 * embedded scope windows have no panel, so their entries are pruned by the
 * frame loop alongside the sticky-scale maps.
 */

import { backingStoreSize } from '../ui/canvas/backingStoreSize';

export interface XYPersistenceEntry {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D | null;
  w: number;
  h: number;
  dpr: number;
  lastTrailSimTime: number;
  /** Frames since the last fade; see FADE_FRAME_INTERVAL in draw.ts. */
  fadeCounter: number;
}

const entries = new Map<number, XYPersistenceEntry>();

/** The scope's persistence canvas at this CSS size, allocating (or
 *  reallocating after a resize or a device-pixel-ratio change) on first use.
 *  The backing store is dpr-scaled with the same helper the on-screen scope
 *  canvas uses, so the trail is rasterised at device resolution instead of
 *  being upscaled and blurred on hiDPI displays. The context transform keeps
 *  the fade and locus in CSS-pixel coordinates, matching the caller's draw
 *  space, and the caller blits the full backing store with an explicit
 *  destination size. The caller mutates the returned entry's trail
 *  bookkeeping in place, which is what keeps the map authoritative. */
export function xyPersistenceFor(scopeId: number, w: number, h: number): XYPersistenceEntry {
  const dpr = (typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1;
  let entry = entries.get(scopeId);
  if (!entry || entry.w !== w || entry.h !== h || entry.dpr !== dpr) {
    const canvas = document.createElement('canvas');
    const backing = backingStoreSize(w, h, dpr);
    canvas.width = backing.width;
    canvas.height = backing.height;
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    entry = { canvas, ctx, w, h, dpr, lastTrailSimTime: -1, fadeCounter: 0 };
    entries.set(scopeId, entry);
  }
  return entry;
}

/** Drops one scope's X-Y persistence canvas (the docked panel's unmount). */
export function clearXYPersistence(id: number): void {
  entries.delete(id);
}

/** Drops persistence canvases for ids that no longer exist. Without this an
 *  embedded 403 window with plotXY would leak its canvas-sized entry every
 *  time its element was deleted or another document loaded. */
export function pruneXYPersistence(live: Iterable<number>): void {
  const keep = new Set(live);
  for (const id of entries.keys()) {
    if (!keep.has(id)) entries.delete(id);
  }
}
