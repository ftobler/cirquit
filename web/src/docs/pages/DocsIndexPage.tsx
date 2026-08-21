/** The docs index page, the registry's entry point: every side page grouped
 *  like the upstream toc. */

import { docsNavGroups } from '../docsNav';

export function DocsIndexPage() {
  const base = import.meta.env.BASE_URL;
  return (
    <>
      <p className="docs-muted">
        Reference pages and calculators for the Circuit Simulator, adapted
        from CircuitJS1.
      </p>
      {/* The same grouping the sidebar uses, from one place, so the index and
        the navigation cannot list different things. */}
      {docsNavGroups().map((group) => (
        <section key={group.key} className="docs-group">
          <h2>{group.title}</h2>
          <ul>
            {group.pages.map((p) => (
              <li key={p.id}>
                <a href={`${base}pages/${p.file}`}>{p.title}</a>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}
