/** Element search for the toolbox and the right-click palette: a pure
 *  substring filter over the toolbox entries, so both stay thin lists over a
 *  tested function. Upstream filters the Draw menu names only
 *  (SearchDialog.java:126-147); the port also matches kind and category,
 *  because the split NPN/PNP and N-MOSFET/P-MOSFET rows share one kind and
 *  "transistor" should find both. */

import { defFor, TOOLBOX, type ToolboxEntry } from './registry';

/** Substring, case-insensitive match on label, kind or category, preserving
 *  the toolbox's category grouping and display order: filtering happens
 *  within each category, so a blank query returns the exact palette and a hit
 *  never jumps between categories. */
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
