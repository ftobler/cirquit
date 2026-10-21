/** The MCP server build: `web/mcp/server.ts` to a Node ESM artifact at
 *  `web/dist-mcp/cirquit-mcp.mjs`, with the wasm engine copied beside it.
 *
 *  This is a separate build from the site. It is never an input to
 *  `vite.config.ts`, so the SDK and `web/mcp` cannot reach `web/dist`; the
 *  site's normal `just build` is unchanged. Run it with `just mcp-build`, and
 *  the artifact with `just mcp`. */

import { copyFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));

/** Puts the wasm engine next to the bundle, where `boot.ts` looks first. The
 *  source tree copy under `src/wasm` is the fallback, so the artifact also runs
 *  from a checkout that has not copied it. */
function copyWasm(): Plugin {
  return {
    name: 'copy-mcp-wasm',
    closeBundle() {
      const out = resolve(root, 'dist-mcp');
      mkdirSync(out, { recursive: true });
      copyFileSync(
        resolve(root, 'src/wasm/circuit_engine_bg.wasm'),
        resolve(out, 'circuit_engine_bg.wasm'),
      );
    },
  };
}

export default defineConfig({
  root,
  plugins: [copyWasm()],
  build: {
    ssr: true,
    outDir: 'dist-mcp',
    emptyOutDir: true,
    copyPublicDir: false,
    target: 'node20',
    rollupOptions: {
      input: resolve(root, 'mcp/server.ts'),
      output: {
        entryFileNames: 'cirquit-mcp.mjs',
        format: 'es',
      },
    },
  },
});
