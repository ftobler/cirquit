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
