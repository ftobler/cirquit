import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DOC_PAGES } from './pages';

const PAGES_DIR = fileURLToPath(new URL('../../pages', import.meta.url));

describe('docs page registry', () => {
  it('ids and files are unique and every file ends in .html', () => {
    const ids = DOC_PAGES.map((p) => p.id);
    const files = DOC_PAGES.map((p) => p.file);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(files).size).toBe(files.length);
    for (const file of files) expect(file.endsWith('.html')).toBe(true);
  });

  it('every registry entry has an html file carrying its data-page', () => {
    for (const page of DOC_PAGES) {
      const html = readFileSync(join(PAGES_DIR, page.file), 'utf8');
      expect(html, page.file).toContain(`data-page="${page.id}"`);
    }
  });

  it('every page html with a data-page has a matching registry entry', () => {
    const byId = new Map(DOC_PAGES.map((p) => [p.id, p]));
    for (const file of readdirSync(PAGES_DIR).filter((f) => f.endsWith('.html'))) {
      const html = readFileSync(join(PAGES_DIR, file), 'utf8');
      const match = /data-page="([^"]+)"/.exec(html);
      if (match === null) continue;
      const entry = byId.get(match[1]);
      expect(entry, `no registry entry for ${file}`).toBeDefined();
      expect(entry?.file, `${match[1]} maps to a different file`).toBe(file);
    }
  });
});
