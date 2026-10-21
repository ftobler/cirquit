/** wasm bootstrap for the headless server.
 *
 *  The wasm-pack `--target web` glue locates its binary with
 *  `new URL('..._bg.wasm', import.meta.url)` and fetches it. Node's fetch
 *  refuses a `file:` URL, and the built artifact ships the wasm beside itself
 *  rather than under `src/wasm`, so the server reads the bytes off disk and
 *  instantiates them directly. `simulator.ts` caches the wasm init promise, and
 *  the glue returns early once the module is initialised, so calling this
 *  before `SimEngine.create()` stops the facade from ever touching fetch.
 *
 *  The two candidates cover both layouts the module can be loaded from: the
 *  built artifact (`dist-mcp/circuit_engine_bg.wasm`, copied by
 *  `vite.mcp.config.ts`) and the source tree under vitest or vite-node
 *  (`src/wasm/circuit_engine_bg.wasm`). */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import init from '../src/wasm/circuit_engine';

function wasmCandidates(): string[] {
  return [
    fileURLToPath(new URL('./circuit_engine_bg.wasm', import.meta.url)),
    fileURLToPath(new URL('../src/wasm/circuit_engine_bg.wasm', import.meta.url)),
  ];
}

/** The wasm file the server will instantiate, or a named failure so a missing
 *  `just wasm` is not reported as a bare ENOENT from somewhere in the glue. */
export function wasmPath(): string {
  const found = wasmCandidates().find((path) => existsSync(path));
  if (found === undefined) {
    throw new Error(
      'circuit_engine_bg.wasm not found; run `just wasm` before starting the MCP server',
    );
  }
  return found;
}

/** Instantiates the wasm engine from the on-disk bytes. Idempotent: the glue
 *  returns the existing module once initialised. */
export async function bootWasm(): Promise<void> {
  const bytes = readFileSync(wasmPath());
  await init({ module_or_path: bytes });
}
