/** Element search for the Find Component dialog: a pure substring filter over
 *  the toolbox entries, so the dialog stays a thin list over a tested function.
 *  Upstream filters the Draw menu names only (SearchDialog.java:126-147); the
 *  port also matches kind and category, because the split NPN/PNP and
 *  N-MOSFET/P-MOSFET rows share one kind and "transistor" should find both. */

import { defFor, TOOLBOX, type ToolboxEntry } from './registry';

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

/** Substring, case-insensitive match on label, kind or category, preserving
 *  the toolbox's category grouping and display order. The Find Component
 *  dialog wants a flat alphabetised list (`filterComponents`); the sidebar
 *  filters within each category, so a blank query returns the exact palette
 *  and a hit never jumps between categories. */
export function filterTools(query: string, entries: ToolboxEntry[] = TOOLBOX): ToolboxEntry[] {
  const q = query.trim().toLowerCase();
  if (q === '') return entries;
  return entries.filter(
    (e) =>
      e.label.toLowerCase().includes(q) ||
      e.kind.toLowerCase().includes(q) ||
      e.category.toLowerCase().includes(q),
  );
}

/** The placement key a tool shows next to its icon: the entry's own char for
 *  the split N/P flavours, otherwise the kind def's shortcut. Case is
 *  significant, so `N` and `n` stay distinct. */
export function toolShortcut(t: ToolboxEntry): string | undefined {
  return t.shortcut ?? defFor(t.kind)?.shortcut;
}
