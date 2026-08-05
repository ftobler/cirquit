import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The wasm-pack `--target web` init locates its binary with
// `new URL('..._bg.wasm', import.meta.url)` and fetches it. Under vitest the
// module URL is a `file:` URL, which node's fetch rejects, so serve wasm bytes
// straight from disk. setupFiles run before any test imports `simulator.ts`,
// whose `ensureWasm` caches the init promise, so the shim is always in place
// first.
const originalFetch = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url;
  if (url.startsWith('file:')) {
    // The wasm content type lets node's `instantiateStreaming` stream the
    // bytes directly, so the wasm-pack fallback path stays quiet.
    return Promise.resolve(
      new Response(readFileSync(fileURLToPath(url)), {
        headers: { 'Content-Type': 'application/wasm' },
      }),
    );
  }
  return originalFetch(input, init);
}) as typeof fetch;
