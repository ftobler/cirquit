/**
 * Width shares of the docked scope columns. Each column has a weight; its
 * width is its share of the strip. Dragging the splitter between two columns
 * moves width from one to the other and leaves every other column alone.
 * Session-only view state, never in the file. Pure so the drag maths is
 * testable without a DOM.
 */

/** Narrowest a column may be dragged, in CSS px: a trace below this has no
 *  room for its scale labels. */
export const MIN_COLUMN_PX = 80;

/** `n` weights from a stored list: kept when the column count still matches,
 *  all equal otherwise (a stack or unstack changed what the columns are, so
 *  the old shares no longer belong to them). */
export function columnWeights(stored: readonly number[] | null, n: number): number[] {
  if (stored && stored.length === n && stored.every((w) => Number.isFinite(w) && w > 0)) {
    return [...stored];
  }
  return Array.from({ length: n }, () => 1);
}

/**
 * The weights after dragging the splitter right of column `i` by `dx` px,
 * in a strip `totalPx` wide. The two neighbours keep their combined width;
 * neither drops below MIN_COLUMN_PX (or below half their pair when the pair
 * is too narrow to hold two minimums).
 */
export function dragSplitter(
  weights: readonly number[],
  i: number,
  dx: number,
  totalPx: number,
): number[] {
  if (i < 0 || i + 1 >= weights.length || !(totalPx > 0)) return [...weights];
  const sum = weights.reduce((a, b) => a + b, 0);
  const pxPerWeight = totalPx / sum;
  const left = weights[i] * pxPerWeight;
  const right = weights[i + 1] * pxPerWeight;
  const pair = left + right;
  const min = Math.min(MIN_COLUMN_PX, pair / 2);
  const nextLeft = Math.min(Math.max(left + dx, min), pair - min);
  const out = [...weights];
  out[i] = nextLeft / pxPerWeight;
  out[i + 1] = (pair - nextLeft) / pxPerWeight;
  return out;
}
