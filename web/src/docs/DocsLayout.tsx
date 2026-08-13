/** The docs layout: a header bar in the app's style with the brand linking
 *  back to the simulator, a small nav of the sibling pages from the registry,
 *  the page body, and the GPL-2.0 attribution footer.
 *
 *  The entry HTML files live under `web/pages/`, so Vite emits them to
 *  `dist/pages/` and every link here carries the `pages/` prefix after
 *  BASE_URL. */

import type { ReactNode } from 'react';
import { DOC_PAGES } from './pages';

interface Props {
  id: string;
  title: string;
  children: ReactNode;
}

export function DocsLayout({ id, title, children }: Props) {
  const base = import.meta.env.BASE_URL;
  const page = (file: string) => `${base}pages/${file}`;
  // The nav lists the other pages of the current page's group, so the reader
  // can hop across the reference or calculator pages without going through
  // the index.
  const current = DOC_PAGES.find((p) => p.id === id);
  const siblings =
    current === undefined
      ? []
      : DOC_PAGES.filter((p) => p.id !== 'docs' && p.id !== id && p.group === current.group);

  return (
    <div className="docs-app">
      <header className="docs-header">
        <a className="docs-brand" href={base}>
          Circuit Simulator
        </a>
        <nav className="docs-nav">
          <a href={page('docs.html')}>Documentation</a>
          {siblings.map((p) => (
            <a key={p.id} href={page(p.file)}>
              {p.title}
            </a>
          ))}
        </nav>
      </header>
      <main className="docs-body">
        <h1>{title}</h1>
        {children}
      </main>
      <footer className="docs-footer">
        Documentation adapted from CircuitJS1, GPL-2.0, Paul Falstad and
        contributors.
      </footer>
    </div>
  );
}
