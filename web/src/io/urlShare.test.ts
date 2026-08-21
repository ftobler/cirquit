import { describe, expect, it } from 'vitest';
import {
  circuitFileFromUrl,
  circuitFromUrl,
  circuitToUrl,
  circuitToUrlFromFile,
  compressCircuit,
  decompressCircuit,
  FALSTAD_BASE,
  isLongUrl,
  startupSource,
} from './urlShare';

const SAMPLE = `$ 1 0.000005 10.20027730826997 50 5 43 5e-11
r 176 80 384 80 0 10
s 384 80 448 80 0 1 false
`;

describe('circuitFromUrl', () => {
  it('reads ctz from the query string', () => {
    expect(circuitFromUrl(`https://host/?ctz=${compressCircuit(SAMPLE)}`)).toBe(SAMPLE);
  });

  it('reads ctz from the hash', () => {
    expect(circuitFromUrl(`https://host/#ctz=${compressCircuit(SAMPLE)}`)).toBe(SAMPLE);
  });

  it('reads cct from the query', () => {
    expect(circuitFromUrl(`https://host/?cct=${encodeURIComponent(SAMPLE)}`)).toBe(SAMPLE);
  });

  it('prefers ctz over cct within one source', () => {
    const href = `https://host/?cct=${encodeURIComponent('something else')}&ctz=${compressCircuit(SAMPLE)}`;
    expect(circuitFromUrl(href)).toBe(SAMPLE);
  });

  it('returns null when neither parameter is present', () => {
    expect(circuitFromUrl('https://host/')).toBeNull();
    expect(circuitFromUrl('https://host/?foo=bar')).toBeNull();
  });
});

describe('circuitToUrl', () => {
  it('puts a ctz that decompresses back to the netlist', () => {
    const url = circuitToUrl(SAMPLE, 'https://host/falstad-cirquit/');
    const token = new URL(url).searchParams.get('ctz');
    expect(token).not.toBeNull();
    expect(decompressCircuit(token ?? '')).toBe(SAMPLE);
  });

  it('preserves a sub-path base', () => {
    const url = circuitToUrl(SAMPLE, 'https://host/falstad-cirquit/');
    expect(url.startsWith('https://host/falstad-cirquit/')).toBe(true);
  });

  it('clears any existing query and hash on the base', () => {
    const url = circuitToUrl(SAMPLE, 'https://host/falstad-cirquit/?startCircuit=lrc.txt#h');
    const u = new URL(url);
    expect(u.hash).toBe('');
    expect(u.searchParams.get('startCircuit')).toBeNull();
    expect(u.searchParams.get('ctz')).not.toBeNull();
  });

  it('builds an upstream link off FALSTAD_BASE, same token', () => {
    // The Export As Link dialog's upstream toggle: only the base changes, so
    // the two links carry an identical ctz and open the same circuit.
    const mine = circuitToUrl(SAMPLE, 'https://host/falstad-cirquit/');
    const theirs = circuitToUrl(SAMPLE, FALSTAD_BASE);
    expect(theirs.startsWith('https://www.falstad.com/circuit/circuitjs.html?ctz=')).toBe(true);
    expect(new URL(theirs).searchParams.get('ctz')).toBe(new URL(mine).searchParams.get('ctz'));
    expect(decompressCircuit(new URL(theirs).searchParams.get('ctz') ?? '')).toBe(SAMPLE);
  });
});

describe('circuitFileFromUrl', () => {
  it('reads a plain library filename from the query', () => {
    expect(circuitFileFromUrl('https://host/?startCircuit=lrc.txt')).toBe('lrc.txt');
  });

  it('reads it from the hash', () => {
    expect(circuitFileFromUrl('https://host/#startCircuit=lrc.txt')).toBe('lrc.txt');
  });

  it('rejects traversal, spaces, a bare name and an empty value', () => {
    expect(circuitFileFromUrl('https://host/?startCircuit=../src/x.txt')).toBeNull();
    expect(circuitFileFromUrl('https://host/?startCircuit=..%5Cx.txt')).toBeNull();
    expect(circuitFileFromUrl('https://host/?startCircuit=a%20b.txt')).toBeNull();
    expect(circuitFileFromUrl('https://host/?startCircuit=lrc')).toBeNull();
    expect(circuitFileFromUrl('https://host/?startCircuit=.txt')).toBeNull();
    expect(circuitFileFromUrl('https://host/?startCircuit=')).toBeNull();
    expect(circuitFileFromUrl('https://host/')).toBeNull();
  });
});

describe('circuitToUrlFromFile', () => {
  it('builds a startCircuit link on a sub-path base', () => {
    expect(circuitToUrlFromFile('lrc.txt', 'https://host/falstad-cirquit/')).toBe(
      'https://host/falstad-cirquit/?startCircuit=lrc.txt',
    );
  });

  it('returns null for an invalid file', () => {
    expect(circuitToUrlFromFile('../x.txt', 'https://host/')).toBeNull();
    expect(circuitToUrlFromFile('no-suffix', 'https://host/')).toBeNull();
  });
});

describe('startupSource', () => {
  it('prefers a shared circuit over startCircuit and the starter', () => {
    const href = `https://host/?startCircuit=lrc.txt&ctz=${compressCircuit(SAMPLE)}`;
    expect(startupSource(href)).toEqual({ kind: 'url', netlist: SAMPLE });
  });

  it('prefers a startCircuit deep link over the starter', () => {
    expect(startupSource('https://host/?startCircuit=lrc.txt')).toEqual({
      kind: 'file',
      file: 'lrc.txt',
    });
  });

  it('falls back to the starter', () => {
    expect(startupSource('https://host/')).toEqual({ kind: 'starter' });
  });
});

describe('url sharing basics', () => {
  it('round-trips a circuit through the compressed form', () => {
    expect(decompressCircuit(compressCircuit(SAMPLE))).toBe(SAMPLE);
  });

  it('warns only past 2000 characters', () => {
    expect(isLongUrl('a'.repeat(2000))).toBe(false);
    expect(isLongUrl('a'.repeat(2001))).toBe(true);
  });
});
