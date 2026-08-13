/** The docs index page, the registry's entry point: every side page grouped
 *  like the upstream toc. */

import { DOC_PAGES } from '../pages';

const GROUPS: DocPageGroup[] = [
  { key: 'Reference', title: 'Reference' },
  { key: 'Calculators', title: 'Calculators' },
  { key: 'Elements', title: 'Element Guides' },
];

interface DocPageGroup {
  key: 'Reference' | 'Calculators' | 'Elements';
  title: string;
}

export function DocsIndexPage() {
  const base = import.meta.env.BASE_URL;
  return (
    <>
      <p className="docs-muted">
        Reference pages and calculators for the Circuit Simulator, adapted
        from CircuitJS1.
      </p>
      {GROUPS.map((group) => {
        const pages = DOC_PAGES.filter((p) => p.id !== 'docs' && p.group === group.key);
        if (pages.length === 0) return null;
        return (
          <section key={group.key} className="docs-group">
            <h2>{group.title}</h2>
            <ul>
              {pages.map((p) => (
                <li key={p.id}>
                  <a href={`${base}pages/${p.file}`}>{p.title}</a>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </>
  );
}
