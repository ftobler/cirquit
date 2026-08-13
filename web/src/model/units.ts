/** Physical-unit parsing for input fields, ported from upstream's
 *  EditDialog.parseUnits (EditDialog.java:404-441). */

import { formatValue, formatValueAscii } from '../render/draw';

/**
 * Parses a value typed into a physical field, so "4k7", "1M", "10m",
 * "4.416e-8" and "5n" all mean what they do upstream. Returns NaN when the
 * text is not a number. The steps mirror the Java original in order: rms
 * strip, the digit-suffix-digit shorthand, meg, scientific notation, then the
 * last-character suffix multiplier.
 */
export function parseUnits(s: string): number {
  let t = s.trim();
  let rmsMult = 1;
  if (t.endsWith('rms')) {
    // A trailing "rms" means the value is rms, not peak: scale by sqrt(2)
    // and drop the suffix before anything else looks at the string.
    t = t.slice(0, -3).trim();
    rmsMult = Math.SQRT2;
  }
  // 2k2 -> 2.2k, 4n7 -> 4.7n, 1M5 -> 1.5M
  t = t.replace(/([0-9]+)([pPnNuUmMkKgG])([0-9]+)/g, '$1.$3$2');
  // 1meg / 1Meg / 1MEG -> 1M, case-insensitive on the meg suffix only.
  t = t.replace(/[mM][eE][gG]$/, 'M');
  // Scientific notation must be read before the suffix switch, or the "e" in
  // "5e9" would be mistaken for a suffix and the value silently rejected.
  if (/^-?[0-9]*\.?[0-9]+[eE][+-]?[0-9]+$/.test(t)) {
    return parseFloat(t) * rmsMult;
  }
  let mult = 1;
  const len = t.length;
  if (len > 0) {
    const last = t.charAt(len - 1);
    switch (last) {
      case 'f':
      case 'F': mult = 1e-15; break;
      case 'p':
      case 'P': mult = 1e-12; break;
      case 'n':
      case 'N': mult = 1e-9; break;
      case 'u':
      case 'U': mult = 1e-6; break;
      // Lowercase m is milli and uppercase M mega, matching upstream (the
      // commented-out forceLargeM ohm heuristic is deliberately not ported).
      case 'm': mult = 1e-3; break;
      case 'k':
      case 'K': mult = 1e3; break;
      case 'M': mult = 1e6; break;
      case 'G':
      case 'g': mult = 1e9; break;
    }
    if (mult !== 1) t = t.slice(0, len - 1);
  }
  // The whole remaining string must be a number. Upstream's NumberFormat stops
  // at the first unparseable character, so it reads "5V" as 5 and "1 k" as
  // 1000; this port rejects both instead, which is what the field spec wants.
  if (!/^-?[0-9]*\.?[0-9]+$/.test(t)) return NaN;
  return parseFloat(t) * mult * rmsMult;
}

/** Formats a stored value for an edit box, with the same engineering prefixes
 *  the canvas readouts use, so "4700" comes back as "4.7k". */
export function formatUnits(v: number, unit = ''): string {
  return formatValue(v, unit);
}

/** The ASCII edit-box sibling: same prefixes, but micro renders as `u`, so the
 *  shown value round-trips parseUnits. formatUnits above stays as the µ-glyph
 *  formatter, kept for its test coverage; the canvas and scopes render the
 *  glyph through formatValue and formatValueShort in render/draw.ts. */
export function formatUnitsAscii(v: number, unit = '', digits = 3): string {
  return formatValueAscii(v, unit, digits);
}
