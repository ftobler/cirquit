/**
 * Hit-testing for dragging scopes around the dock. Given the pointer and the
 * screen boxes of the strip and its columns, it says what a drop there would
 * do: stack onto a column, open a new column at an edge, or float the scope
 * over the schematic. Pure (boxes in, decision out) so the zones are tested
 * without a DOM; ScopePanel measures the boxes and draws the marker.
 */

import type { ScopeDropTarget } from '../state/scopeLayout';

export interface ColumnBox {
  /** The scope ids in the column, top to bottom. */
  ids: number[];
  left: number;
  right: number;
  /** Screen rows of the box. Only the wrap layouts need them: the strip's
   *  single row makes them redundant, so callers may omit them there. */
  top?: number;
  bottom?: number;
}

export interface StripBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** What the drop marker shows: a column lit up, or an insertion bar at `x`. */
export type DropMarker = { type: 'column'; index: number } | { type: 'gap'; x: number };

export type DropDecision =
  | { kind: 'dock'; target: ScopeDropTarget; marker: DropMarker }
  | { kind: 'float' };

/** Share of a column's width, from either edge, that means "new column
 *  here" rather than "stack onto this one"; never less than EDGE_MIN_PX so a
 *  narrow column still has a usable edge. */
const EDGE_SHARE = 0.2;
const EDGE_MIN_PX = 16;

/**
 * The drop at (x, y) for the scope `dragged`. Inside the strip a column's
 * middle stacks onto it and its edges open a new column there; past the last
 * column (the info area) opens one at the end. Anywhere else floats the
 * scope. Without a visible strip (every scope floating) there is nothing to
 * dock onto, so everything floats.
 */
export function dropDecisionAt(
  x: number,
  y: number,
  dragged: number,
  strip: StripBox | null,
  columns: readonly ColumnBox[],
  /** 'strip' keeps the edge-opens-a-column rule; 'wrap' is the grid and tabs
   *  layouts, where rows make an insertion bar meaningless, so a drop stacks
   *  onto the column under the pointer (or the nearest one). */
  mode: 'strip' | 'wrap' = 'strip',
): DropDecision {
  const inStrip =
    strip !== null && x >= strip.left && x <= strip.right && y >= strip.top && y <= strip.bottom;
  if (!inStrip || columns.length === 0) return { kind: 'float' };
  // Name each column by a scope other than the dragged one: the move takes
  // the dragged scope out first, so a column named by it would no longer be
  // found. A column holding only the dragged scope still names itself, and
  // that drop is the no-op it should be.
  const nameOf = (c: ColumnBox) => c.ids.find((id) => id !== dragged) ?? c.ids[0];
  if (mode === 'wrap') {
    let nearest = 0;
    let bestDist = Infinity;
    for (let i = 0; i < columns.length; i++) {
      const c = columns[i];
      const inRow = c.top === undefined || (y >= c.top && y <= (c.bottom ?? c.top));
      if (inRow && x >= c.left && x <= c.right) {
        return { kind: 'dock', target: { kind: 'stack', withId: nameOf(c) }, marker: { type: 'column', index: i } };
      }
      const dist = Math.abs(x - (c.left + c.right) / 2);
      if (dist < bestDist) {
        bestDist = dist;
        nearest = i;
      }
    }
    return {
      kind: 'dock',
      target: { kind: 'stack', withId: nameOf(columns[nearest]) },
      marker: { type: 'column', index: nearest },
    };
  }
  for (let i = 0; i < columns.length; i++) {
    const c = columns[i];
    if (x < c.left || x > c.right) continue;
    const edge = Math.max(EDGE_MIN_PX, (c.right - c.left) * EDGE_SHARE);
    if (x < c.left + edge) {
      return { kind: 'dock', target: { kind: 'column', beforeId: nameOf(c) }, marker: { type: 'gap', x: c.left } };
    }
    if (x > c.right - edge) {
      const next = columns[i + 1];
      return {
        kind: 'dock',
        target: { kind: 'column', beforeId: next ? nameOf(next) : null },
        marker: { type: 'gap', x: c.right },
      };
    }
    // Dropping a scope onto the middle of its own stack moves it to the
    // bottom.
    return { kind: 'dock', target: { kind: 'stack', withId: nameOf(c) }, marker: { type: 'column', index: i } };
  }
  const last = columns[columns.length - 1];
  if (x > last.right) {
    return { kind: 'dock', target: { kind: 'column', beforeId: null }, marker: { type: 'gap', x: last.right } };
  }
  // Left of the first column (a sliver of border): a new first column.
  return {
    kind: 'dock',
    target: { kind: 'column', beforeId: nameOf(columns[0]) },
    marker: { type: 'gap', x: columns[0].left },
  };
}
