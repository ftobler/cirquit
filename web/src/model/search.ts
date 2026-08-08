/** Element search for the Find Component dialog: a pure substring filter over
 *  the toolbox entries, so the dialog stays a thin list over a tested function.
 *  Upstream filters the Draw menu names only (SearchDialog.java:126-147); the
 *  port also matches kind and category, because the split NPN/PNP and
 *  N-MOSFET/P-MOSFET rows share one kind and "transistor" should find both. */

import { TOOLBOX, type ToolboxEntry } from './registry';

/** One search hit, shaped for the dialog's list. */
export interface ComponentMatch {
  id: string;
  label: string;
  category: string;
}

/** Substring, case-insensitive match on label, kind or category. An empty or
 *  whitespace-only query returns every entry, so the dialog opens showing the
 *  whole palette. Matches are sorted alphabetically by label, upstream's
 *  `Collections.sort` over the matched names (SearchDialog.java:138-142). */
export function filterComponents(
  query: string,
  entries: ToolboxEntry[] = TOOLBOX,
): ComponentMatch[] {
  const q = query.trim().toLowerCase();
  const out = entries
    .filter(
      (e) =>
        q === '' ||
        e.label.toLowerCase().includes(q) ||
        e.kind.toLowerCase().includes(q) ||
        e.category.toLowerCase().includes(q),
    )
    .map(({ id, label, category }) => ({ id, label, category }));
  // A plain ASCII comparison, not localeCompare, so the ordering is identical
  // in the browser and under the node test environment.
  out.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  return out;
}
