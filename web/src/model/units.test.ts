import { describe, expect, it } from 'vitest';
import { formatUnits, formatUnitsAscii, parseUnits } from './units';

describe('parseUnits', () => {
  it('parses the SI suffix table', () => {
    expect(parseUnits('1k')).toBe(1e3);
    expect(parseUnits('1K')).toBe(1e3);
    expect(parseUnits('1M')).toBe(1e6);
    expect(parseUnits('10m')).toBeCloseTo(0.01, 12);
    expect(parseUnits('4.7n')).toBeCloseTo(4.7e-9, 12);
    expect(parseUnits('100u')).toBeCloseTo(1e-4, 12);
    expect(parseUnits('1p')).toBe(1e-12);
    expect(parseUnits('1G')).toBe(1e9);
    expect(parseUnits('1f')).toBe(1e-15);
  });

  it('expands the digit-suffix-digit shorthand', () => {
    expect(parseUnits('2k2')).toBe(2200);
    expect(parseUnits('1M5')).toBeCloseTo(1.5e6, 12);
    expect(parseUnits('4n7')).toBeCloseTo(4.7e-9, 12);
  });

  it('rewrites meg to mega whatever the case of the suffix', () => {
    expect(parseUnits('1meg')).toBe(1e6);
    expect(parseUnits('1Meg')).toBe(1e6);
    expect(parseUnits('1MEG')).toBe(1e6);
    expect(parseUnits('1M')).toBe(1e6);
  });

  it('parses scientific notation before the e can be read as a unit', () => {
    expect(parseUnits('4.416e-8')).toBeCloseTo(4.416e-8, 12);
    expect(parseUnits('1.2E+3')).toBe(1200);
    expect(parseUnits('5e9')).toBe(5e9);
  });

  it('parses plain numbers and negatives', () => {
    expect(parseUnits('0.5')).toBe(0.5);
    expect(parseUnits('-2')).toBe(-2);
    expect(parseUnits('.5')).toBe(0.5);
  });

  it('trims surrounding whitespace', () => {
    expect(parseUnits(' 1k ')).toBe(1e3);
  });

  it('rejects a space between number and suffix', () => {
    expect(parseUnits('1 k')).toBeNaN();
  });

  it('returns NaN for garbage', () => {
    expect(parseUnits('')).toBeNaN();
    expect(parseUnits('abc')).toBeNaN();
    // A unit letter that is not an SI suffix must not parse as just the number.
    expect(parseUnits('5V')).toBeNaN();
  });

  it('applies the rms root-two multiplier', () => {
    expect(parseUnits('1krms')).toBeCloseTo(1e3 * Math.SQRT2, 10);
    expect(parseUnits('10rms')).toBeCloseTo(10 * Math.SQRT2, 10);
  });
});

describe('formatUnits', () => {
  it('reuses the engineering-prefix formatter', () => {
    expect(formatUnits(4700, 'Ω')).toBe('4.7k Ω');
    expect(formatUnits(5e-6, 's')).toBe('5µ s');
    expect(formatUnits(0.000001, 'F')).toBe('1µ F');
  });

  it('keeps the unit when there is one', () => {
    expect(formatUnits(1e6, 'Ω')).toBe('1M Ω');
  });

  it('shows a placeholder for non-finite values', () => {
    expect(formatUnits(NaN, 'V')).toBe('--');
  });
});

describe('formatUnitsAscii', () => {
  it('renders micro as ASCII u, never µ, so the shown value round-trips parseUnits', () => {
    expect(formatUnitsAscii(5e-6)).toBe('5u');
    expect(formatUnitsAscii(5e-6, 's')).toBe('5u s');
    expect(formatUnitsAscii(0.000001, 'F')).toBe('1u F');
  });

  it('keeps the other prefixes and the unit spacing unchanged', () => {
    expect(formatUnitsAscii(4700, 'Ω')).toBe('4.7k Ω');
    expect(formatUnitsAscii(1e6, 'Ω')).toBe('1M Ω');
    expect(formatUnitsAscii(0.05, 'A')).toBe('50m A');
    expect(formatUnitsAscii(0.001)).toBe('1m');
    expect(formatUnitsAscii(2.5e-9)).toBe('2.5n');
    expect(formatUnitsAscii(100)).toBe('100');
  });

  it('round-trips through parseUnits, the reverse of the parseUnits tests above', () => {
    for (const x of [1e-6, 5e-6, 4.7e3, 0.001, 1, 2.5e-9, 1e8]) {
      expect(parseUnits(formatUnitsAscii(x))).toBeCloseTo(x, 10);
    }
  });

  it('shows a placeholder for non-finite values', () => {
    expect(formatUnitsAscii(NaN, 'V')).toBe('--');
  });
});
