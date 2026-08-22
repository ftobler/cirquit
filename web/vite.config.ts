import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DOC_PAGES } from './src/docs/pages';

// The site is deployed to GitHub Pages under a repository path, so the base is
// configurable: `BASE_PATH=/falstad-cirquit/ npm run build`.
const base = process.env.BASE_PATH ?? '/';

// The docs side pages are extra HTML entry points in the same build, one per
// `DOC_PAGES` row plus the app itself. Deriving the rollup input from the
// registry keeps the build in step with the pages; `pages.test.ts` additionally
// pins the registry against the `web/pages/*.html` files, so a page added in
// one place and forgotten in another fails either the test or the build.
const root = fileURLToPath(new URL('.', import.meta.url));
const docsInput = Object.fromEntries(
  DOC_PAGES.map((p) => [p.id, resolve(root, 'pages', p.file)]),
);

// The undocked scope window: a display-only page (no React, no engine) that
// mirrors one scope from its opener over postMessage. Not a docs page, so it
// stays out of DOC_PAGES and joins the inputs directly.
const scopewinInput = { scopewin: resolve(root, 'pages', 'scopewin.html') };

// GPL-2.0 asks that the licence travel with the distributed work, so the
// repository LICENSE and README are emitted into the build output. Emitting
// them as bundle assets rather than copying afterwards means every artifact a
// build produces carries them: the local `web/dist`, the CI upload, the Pages
// deployment and the root-deployment zip, which is a second vite build.
const REPO_FILES = ['LICENSE', 'README.md'];

function repoDocs(): Plugin {
  return {
    name: 'repo-docs',
    generateBundle() {
      for (const name of REPO_FILES) {
        this.emitFile({
          type: 'asset',
          fileName: name,
          source: readFileSync(resolve(root, '..', name)),
        });
      }
    },
  };
}

export default defineConfig({
  base,
  plugins: [react(), repoDocs()],
  build: {
    target: 'es2022',
    // wasm-pack output is already minified machine code; keeping it as a
    // separate asset lets the browser cache it independently of the app JS.
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        index: resolve(root, 'index.html'),
        ...scopewinInput,
        ...docsInput,
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
  },
});
