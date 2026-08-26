import { describe, expect, it } from 'vitest';
import { parseCircuit, serializeCircuit } from './index';
import { postsOf } from '../../model/registry';
import { WIRE_SHOW_CURRENT, WIRE_SHOW_VOLTAGE } from '../../model/registry/flags';
import { DEFAULT_SETTINGS } from '../../model/types';

describe('ground file format', () => {
  /** Parses a single `g` line and re-emits it, returning that line. */
  const groundLine = (line: string) => {
    const [e] = parseCircuit(line).elements;
    const out = serializeCircuit([e], { ...DEFAULT_SETTINGS }).trim();
    const elementLine = out.split('\n').find((l) => l.startsWith('g ')) ?? '';
    return { e, out, elementLine };
  };

  it('keeps the two-point span and the symbol type', () => {
    // A chassis ground with a real stem, the shape upstream draws the symbol
    // at the far end of (GroundElm.java:63-92).
    const { e } = groundLine('g 176 320 208 320 0 1');
    expect([e.x1, e.y1]).toEqual([176, 320]);
    expect([e.x2, e.y2]).toEqual([208, 320]);
    expect(e.params.symbolType).toBe(1);
  });

  it('round-trips a chassis ground byte-for-byte', () => {
    const { elementLine } = groundLine('g 176 320 208 320 0 1');
    expect(elementLine).toBe('g 176 320 208 320 0 1');
  });

  it('connects only at the first endpoint, never at the free end', () => {
    // One connectable post: wires land on (176,320), never on (208,320) where
    // the symbol hangs.
    const { e } = groundLine('g 176 320 208 320 0 1');
    expect(postsOf(e)).toEqual([{ x: 176, y: 320 }]);
  });

  it('a ground without a symbol token saves as the earth symbol', () => {
    const { elementLine } = groundLine('g 176 352 176 384 0');
    expect(elementLine).toBe('g 176 352 176 384 0 0');
  });
});

describe('wire file format', () => {
  /** Parses a single `w` line and re-emits it, returning that line. */
  const wireLine = (line: string) => {
    const [e] = parseCircuit(line).elements;
    const out = serializeCircuit([e], { ...DEFAULT_SETTINGS }).trim();
    const elementLine = out.split('\n').find((l) => l.startsWith('w ')) ?? '';
    return { e, out, elementLine };
  };

  it('a token-free w line round-trips byte-for-byte', () => {
    const { elementLine } = wireLine('w 0 0 64 0 0');
    expect(elementLine).toBe('w 0 0 64 0 0');
  });

  it('round-trips the Show Current flag', () => {
    const { e, elementLine } = wireLine('w 0 0 64 0 1');
    expect(e.flags & WIRE_SHOW_CURRENT).toBe(WIRE_SHOW_CURRENT);
    expect(elementLine).toBe('w 0 0 64 0 1');
  });

  it('round-trips the Show Voltage flag', () => {
    const { e, elementLine } = wireLine('w 0 0 64 0 2');
    expect(e.flags & WIRE_SHOW_VOLTAGE).toBe(WIRE_SHOW_VOLTAGE);
    expect(elementLine).toBe('w 0 0 64 0 2');
  });

  it('round-trips both flags together', () => {
    const { e, elementLine } = wireLine('w 0 0 64 0 3');
    expect(e.flags & (WIRE_SHOW_CURRENT | WIRE_SHOW_VOLTAGE)).toBe(3);
    expect(elementLine).toBe('w 0 0 64 0 3');
  });

  it('parses the optional bus-width token and saves it byte-for-byte', () => {
    // The port's own extension: a trailing width token on a `w` line
    // (upstream's text format never saves a wire's busWidth). A width above
    // one also doubles the terminal count, N copies of each endpoint.
    const { e, elementLine } = wireLine('w 32 96 160 96 0 4');
    expect(e.params.busWidth).toBe(4);
    expect(elementLine).toBe('w 32 96 160 96 0 4');
    expect(postsOf(e)).toHaveLength(8);
    const first = postsOf(e).slice(0, 4);
    for (const p of first) expect(p).toEqual({ x: 32, y: 96 });
    for (const p of postsOf(e).slice(4)) expect(p).toEqual({ x: 160, y: 96 });
  });

  it('a width-1 token is canonicalised away', () => {
    // One is the plain-wire default, so the token has nothing to say and the
    // writer omits it; keeping it would make the next save change the file.
    // The first `1` is the Show Current flag, the second the width.
    const { e, elementLine } = wireLine('w 0 0 64 0 1 1');
    expect(e.flags & WIRE_SHOW_CURRENT).toBe(WIRE_SHOW_CURRENT);
    expect(e.params.busWidth).toBeUndefined();
    expect(elementLine).toBe('w 0 0 64 0 1');
  });

  it('clamps an out-of-range width and reports the loss', () => {
    const parsed = parseCircuit('w 0 0 64 0 0 99');
    expect(parsed.elements[0].params.busWidth).toBe(32);
    expect(parsed.warnings.some((w) => w.includes('busWidth'))).toBe(true);
  });
});
