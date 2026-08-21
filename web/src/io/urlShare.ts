/**
 * Circuit sharing through the URL, compatible with upstream links.
 *
 * Upstream accepts two query parameters: `cct` carries the netlist as plain
 * (URI-encoded) text, and `ctz` carries it compressed with lz-string's
 * URI-safe encoding. Both are read here; `ctz` is what we generate, since it
 * keeps links short enough to paste.
 */

import { compressToEncodedURIComponent, decompressFromEncodedURIComponent } from 'lz-string';

/** Reads a circuit from a URL's query string or hash, if one is present. */
export function circuitFromUrl(href: string = window.location.href): string | null {
  const url = new URL(href);
  // Parameters appear in the query string or after the hash, depending on how
  // the link was produced.
  const sources = [url.searchParams];
  if (url.hash.length > 1) {
    sources.push(new URLSearchParams(url.hash.replace(/^#/, '')));
  }

  for (const params of sources) {
    const compressed = params.get('ctz');
    if (compressed) {
      const text = decompressFromEncodedURIComponent(compressed);
      if (text) return text;
    }
    const plain = params.get('cct');
    if (plain) return plain;
  }
  return null;
}

/** Upstream's own hosted simulator, the base for a link that opens the circuit
 *  there instead of in this app. It reads the same `ctz` parameter this port
 *  writes, so only the base differs (ExportAsUrlDialog.java:96-99, which
 *  substitutes exactly this URL when upstream runs outside a browser tab). */
export const FALSTAD_BASE = 'https://www.falstad.com/circuit/circuitjs.html';

/** Builds a shareable link containing the circuit. */
export function circuitToUrl(netlist: string, base: string = window.location.href): string {
  const url = new URL(base);
  url.search = '';
  url.hash = '';
  url.searchParams.set('ctz', compressToEncodedURIComponent(netlist));
  return url.toString();
}

/** Compresses without building a whole URL; used by tests. */
export function compressCircuit(netlist: string): string {
  return compressToEncodedURIComponent(netlist);
}

export function decompressCircuit(token: string): string | null {
  return decompressFromEncodedURIComponent(token);
}

/** True when a share URL is too long for some services to accept. Upstream
 *  warns above 2000 characters (ExportAsUrlDialog.java:111-114). */
export function isLongUrl(url: string): boolean {
  return url.length > 2000;
}

/**
 * A `startCircuit` deep link names a file in the bundled circuit library by
 * `<file>.txt`. The parameter only accepts a plain library filename, so a
 * hand-built link cannot reach outside `circuits/`: the whitelist rejects the
 * path traversal, a space and any other punctuation upstream's filenames never
 * carry.
 */
const CIRCUIT_FILE_PATTERN = /^[\w.-]+\.txt$/;

function isValidCircuitFile(file: string): boolean {
  return CIRCUIT_FILE_PATTERN.test(file);
}

/** Reads the `startCircuit` parameter from a URL's query string or hash, like
 *  `circuitFromUrl`, and returns the value only when it is a plain library
 *  filename. Null for a missing or malformed value. */
export function circuitFileFromUrl(href: string = window.location.href): string | null {
  const url = new URL(href);
  const sources = [url.searchParams];
  if (url.hash.length > 1) {
    sources.push(new URLSearchParams(url.hash.replace(/^#/, '')));
  }
  for (const params of sources) {
    const file = params.get('startCircuit');
    if (file !== null && isValidCircuitFile(file)) return file;
  }
  return null;
}

/** Builds a `?startCircuit=<file>` link for a bundled library circuit, after
 *  the same filename whitelist `circuitFileFromUrl` applies. Null for a name
 *  that cannot be a library file. */
export function circuitToUrlFromFile(
  file: string,
  base: string = window.location.href,
): string | null {
  if (!isValidCircuitFile(file)) return null;
  const url = new URL(base);
  url.search = '';
  url.hash = '';
  url.searchParams.set('startCircuit', file);
  return url.toString();
}

/** What the app should load at startup, decided by the URL alone. A share link
 *  (`ctz`/`cct`) carries the whole circuit and always wins; otherwise a
 *  `startCircuit` deep link names a bundled library file; otherwise the starter
 *  circuit. The fetch and the failure fallback are the App's job, so the pure
 *  precedence stays headless-testable. */
export type StartupSource =
  | { kind: 'url'; netlist: string }
  | { kind: 'file'; file: string }
  | { kind: 'starter' };

export function startupSource(href: string = window.location.href): StartupSource {
  const fromUrl = circuitFromUrl(href);
  if (fromUrl !== null) return { kind: 'url', netlist: fromUrl };
  const file = circuitFileFromUrl(href);
  if (file !== null) return { kind: 'file', file };
  return { kind: 'starter' };
}
