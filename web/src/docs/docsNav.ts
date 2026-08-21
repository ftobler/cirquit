/** The docs sidebar's contents: the registry grouped into the sections the
 *  navigation shows, in a fixed order. Pure data so the grouping is testable
 *  without a DOM, and so the sidebar and the index page cannot drift apart
 *  (AGENTS.md: nothing testable belongs inside a React component). */

import { DOC_PAGES, type DocPage } from './pages';

export interface DocsNavGroup {
  key: DocPage['group'];
  /** The heading shown above the group. Not always the group key: the
   *  Elements group reads better as "Element Guides". */
  title: string;
  pages: DocPage[];
}

/** The section order, top to bottom. */
const GROUP_TITLES: [key: DocPage['group'], title: string][] = [
  ['Reference', 'Reference'],
  ['Calculators', 'Calculators'],
  ['Elements', 'Element Guides'],
];

/** Every page except the index, grouped and in registry order. The index is
 *  dropped because the sidebar links to it separately, above the groups: it
 *  is the docs home, not one entry among the reference pages. */
export function docsNavGroups(pages: DocPage[] = DOC_PAGES): DocsNavGroup[] {
  return GROUP_TITLES.map(([key, title]) => ({
    key,
    title,
    pages: pages.filter((p) => p.id !== 'docs' && p.group === key),
  })).filter((g) => g.pages.length > 0);
}
