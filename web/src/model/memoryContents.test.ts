import { describe, expect, it } from 'vitest';
import { contentsToText, parseContentsText } from './memoryContents';

/** Upstream's toHex/contentsToString examples, decimal and hex, 4-bit data. */
const DEC = { hex: false, dataBits: 4 };
const HEX = { hex: true, dataBits: 4 };

describe('contentsToText', () => {
  it('groups consecutive addresses into one line per run', () => {
    const text = contentsToText(
      [
        [0, 1],
        [1, 2],
        [2, 3],
        [5, 9],
      ],
      DEC,
    );
    expect(text).toBe('0: 1 2 3\n5: 9\n');
  });

  it('caps a run at 8 values and continues on the next line', () => {
    const pairs = Array.from({ length: 12 }, (_, i) => [i, i + 1] as [number, number]);
    const text = contentsToText(pairs, DEC);
    expect(text).toBe(
      '0: 1 2 3 4 5 6 7 8\n' + '8: 9 10 11 12\n',
    );
  });

  it('an explicit zero ends a run and starts the next line', () => {
    const text = contentsToText(
      [
        [0, 1],
        [1, 0],
        [2, 2],
      ],
      DEC,
    );
    expect(text).toBe('0: 1\n2: 2\n');
  });

  it('masks values to the data width and pads hex to two digits uppercase', () => {
    const text = contentsToText(
      [
        [0, 10],
        [2, 15],
        [4, 16],
      ],
      HEX,
    );
    // Values always pad to two digits; 16 & 0xF is 0, and upstream writes it
    // because the stored value is nonzero even though the mask renders it
    // "00" (SRAMElm.java:193-197).
    expect(text).toBe('0: 0A\n2: 0F\n4: 00\n');
  });

  it('writes addresses in bare uppercase hex with no padding', () => {
    const text = contentsToText(
      [
        [5, 1],
        [10, 2],
        [16, 3],
      ],
      HEX,
    );
    // Addresses are never zero-padded, values always are.
    expect(text).toBe('5: 01\nA: 02\n10: 03\n');
  });

  it('an empty pair list renders the empty string', () => {
    expect(contentsToText([], DEC)).toBe('');
  });

  it('round-trips through the parser to the identical pair list', () => {
    const pairs: [number, number][] = [
      [0, 1],
      [1, 2],
      [2, 3],
      [4, 7],
      [5, 8],
      [6, 9],
    ];
    const text = contentsToText(pairs, DEC);
    expect(text).toBe('0: 1 2 3\n4: 7 8 9\n');
    const parsed = parseContentsText(text, DEC);
    expect(parsed.error).toBeNull();
    expect(parsed.pairs).toEqual(pairs);
  });
});

describe('parseContentsText', () => {
  it('parses decimal runs with auto-incrementing addresses', () => {
    const parsed = parseContentsText('0: 1 2 3\n10: 4\n', DEC);
    expect(parsed.error).toBeNull();
    expect(parsed.pairs).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
      [10, 4],
    ]);
  });

  it('honours 0x and 0b prefixes in any radix mode', () => {
    const parsed = parseContentsText('0: 0x10 0b101\n', { hex: false, dataBits: 8 });
    expect(parsed.error).toBeNull();
    expect(parsed.pairs).toEqual([
      [0, 16],
      [1, 5],
    ]);
  });

  it('accepts bare hex only in hex mode', () => {
    const hexMode = parseContentsText('0: FF 1A\n', { hex: true, dataBits: 8 });
    expect(hexMode.error).toBeNull();
    expect(hexMode.pairs).toEqual([
      [0, 255],
      [1, 26],
    ]);
    const decMode = parseContentsText('0: FF\n', DEC);
    expect(decMode.error).toContain('Line 1');
    expect(decMode.pairs).toEqual([]);
  });

  it('round-trips hex text back to the original numbers', () => {
    const pairs: [number, number][] = [
      [0, 10],
      [1, 15],
      [2, 255],
    ];
    const text = contentsToText(pairs, { hex: true, dataBits: 8 });
    const parsed = parseContentsText(text, { hex: true, dataBits: 8 });
    expect(parsed.error).toBeNull();
    expect(parsed.pairs).toEqual(pairs);
  });

  it('skips blank lines and tolerates a trailing newline', () => {
    const parsed = parseContentsText('\n0: 1\n\n2: 2\n', DEC);
    expect(parsed.error).toBeNull();
    expect(parsed.pairs).toEqual([
      [0, 1],
      [2, 2],
    ]);
  });

  it('splits values on any whitespace', () => {
    const parsed = parseContentsText('0:\t1  2\t\t3\n', DEC);
    expect(parsed.error).toBeNull();
    expect(parsed.pairs).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
    ]);
  });

  it('an address with no values parses to nothing, like upstream\'s silent skip', () => {
    const parsed = parseContentsText('5:\n', DEC);
    expect(parsed.error).toBeNull();
    expect(parsed.pairs).toEqual([]);
  });

  it('reports a missing colon, naming the line', () => {
    const parsed = parseContentsText('0: 1\nthis is not a contents line\n', DEC);
    expect(parsed.error).toContain('Line 2');
    expect(parsed.error).toContain("':'");
    expect(parsed.pairs).toEqual([[0, 1]]);
  });

  it('reports a non-numeric value, naming the line and the token', () => {
    const parsed = parseContentsText('0: 1 xyz 3\n', DEC);
    expect(parsed.error).toContain('Line 1');
    expect(parsed.error).toContain('xyz');
    expect(parsed.pairs).toEqual([[0, 1]]);
  });

  it('reports a non-numeric address, naming the line', () => {
    const parsed = parseContentsText('zz: 1\n', DEC);
    expect(parsed.error).toContain('Line 1');
    expect(parsed.error).toContain('zz');
  });

  it('reports a value past the data-width ceiling, naming the line', () => {
    const parsed = parseContentsText('0: 1 20\n', DEC);
    expect(parsed.error).toContain('Line 1');
    expect(parsed.error).toContain('20');
    expect(parsed.error).toContain('4 bits');
    expect(parsed.pairs).toEqual([[0, 1]]);
  });

  it('a value exactly at the ceiling is accepted', () => {
    const parsed = parseContentsText('0: 15\n', DEC);
    expect(parsed.error).toBeNull();
    expect(parsed.pairs).toEqual([[0, 15]]);
  });

  it('rejects trailing junk parseInt would silently accept', () => {
    expect(parseContentsText('0: 12abc\n', DEC).error).toContain('12abc');
    expect(parseContentsText('0: 12ag\n', HEX).error).toContain('12ag');
  });
});