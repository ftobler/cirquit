/** The docs layout: a header bar in the app's style with the brand linking
 *  back to the simulator, then two columns, a sidebar listing every docs page
 *  grouped by section and the page body beside it, and the GPL-2.0
 *  attribution footer underneath. The sidebar is the navigation for the whole
 *  docs set, so a reader can cross from a calculator to a reference page
 *  without going back through the index; it collapses above the prose on a
 *  screen too narrow for two columns.
 *
 *  The entry HTML files live under `web/pages/`, so Vite emits them to
 *  `dist/pages/` and every link here carries the `pages/` prefix after
 *  BASE_URL. */

import type { ReactNode } from 'react';
import { docsNavGroups } from './docsNav';

interface Props {
  id: string;
  title: string;
  children: ReactNode;
}

export function DocsLayout({ id, title, children }: Props) {
  const base = import.meta.env.BASE_URL;
  const page = (file: string) => `${base}pages/${file}`;
  const groups = docsNavGroups();

  return (
    <div className="docs-app">
      <header className="docs-header">
        <a className="docs-brand" href={base}>
          Circuit Simulator
        </a>
        <nav className="docs-nav">
          <a href={page('docs.html')}>Documentation</a>
        </nav>
      </header>
      <div className="docs-columns">
        <nav className="docs-sidebar" aria-label="Documentation">
          <a
            className={id === 'docs' ? 'docs-sidebar-home current' : 'docs-sidebar-home'}
            href={page('docs.html')}
            aria-current={id === 'docs' ? 'page' : undefined}
          >
            All documentation
          </a>
          {groups.map((group) => (
            <section key={group.key}>
              <h2>{group.title}</h2>
              <ul>
                {group.pages.map((p) => (
                  <li key={p.id}>
                    <a
                      className={p.id === id ? 'current' : undefined}
                      // The page the reader is on is marked for assistive tech
                      // too, not only by the highlight.
                      aria-current={p.id === id ? 'page' : undefined}
                      href={page(p.file)}
                    >
                      {p.title}
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </nav>
        <main className="docs-body">
          <h1>{title}</h1>
          {children}
        </main>
      </div>
      <footer className="docs-footer">
        Documentation adapted from CircuitJS1, GPL-2.0, Paul Falstad and contributors.
      </footer>
    </div>
  );
}
