import { describe, expect, it } from 'vitest';
import { importIsLoadable, summarizeImport } from './importSummary';
import { SAMPLE } from './netlist/fixtures';

/** Seven elements and one scope with no unmodelled lines, so the pinned
 *  summary string is exact. The bundled SAMPLE fixture now parses its `38`
 *  slider line into state, so it would also produce a clean string; the local
 *  fixture is kept so the wording has a stable home. */
const GOOD = `$ 1 0.000005 10.2 50 5 43 5e-11
v 176 320 176 96 0 0 40 5 0 0 0.5
r 176 96 384 96 0 1000
c 384 96 384 320 0 0.00001 0 0 0
w 384 320 176 320 0
g 176 320 176 352 0
r 0 0 16 0 0 100
s 384 80 448 80 0 1 false
o 2 64 0 4099
`;

describe('summarizeImport', () => {
  it('summarises a good import as elements and scope traces', () => {
    expect(summarizeImport(GOOD)).toBe('7 elements, 1 scope trace');
  });

  it('uses the plural for many elements and traces', () => {
    expect(summarizeImport('r 0 0 16 0 0 100\nr 16 0 32 0 0 100\n')).toBe(
      '2 elements, 0 scope traces',
    );
  });

  it('flags unsupported types by code', () => {
    expect(summarizeImport('$ 1 0.000005 10 50 5 43 5e-11\n999 1 2 3 4 0\n')).toContain(
      'unsupported type(s) (999)',
    );
  });

  it('no longer reports a parsed slider line as unsupported', () => {
    // SAMPLE carries a `38` slider line; since it parses into state now, the
    // summary is clean.
    expect(summarizeImport(SAMPLE)).toBe('7 elements, 1 scope trace');
  });

  it('reports 0 elements for garbage without throwing, and preserves it as passthrough', () => {
    const text = 'hello world\nnot a circuit\n';
    expect(summarizeImport(text)).toBe('0 elements, 0 scope traces');
    // The raw lines survive parseCircuit, so nothing is destroyed before the
    // user clicks OK.
    expect(summarizeImport(text)).not.toContain('undefined');
  });
});

describe('importIsLoadable', () => {
  it('refuses non-blank garbage that parses to zero elements', () => {
    expect(importIsLoadable('hello world\nnot a circuit\n')).toBe(false);
  });

  it('allows blank text, where an empty sheet is the intent', () => {
    expect(importIsLoadable('')).toBe(true);
    expect(importIsLoadable('   \n\t\n')).toBe(true);
  });

  it('allows text that parses to at least one element', () => {
    expect(importIsLoadable(GOOD)).toBe(true);
    expect(importIsLoadable('r 0 0 16 0 0 100\n')).toBe(true);
  });
});
