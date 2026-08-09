import { describe, expect, it } from 'vitest';
import { TOOLBOX } from './registry';
import { filterComponents } from './search';

describe('filterComponents', () => {
  it('matches a label substring, case-insensitively', () => {
    const hits = filterComponents('res');
    expect(hits.some((m) => m.label === 'Resistor')).toBe(true);
  });

  it('matches the kind too, so the split NPN/PNP rows both appear', () => {
    // Both transistor flavours share kind 'transistor' even though their
    // labels are NPN and PNP; the kind match is what makes them searchable.
    // The unijunction transistor also matches, on its label.
    const hits = filterComponents('transistor');
    expect(hits.map((m) => m.id).sort()).toEqual(['npn', 'pnp', 'unijunction']);
  });

  it('matches the category, returning every entry in it', () => {
    const hits = filterComponents('semiconductors');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((m) => m.category === 'Semiconductors')).toBe(true);
  });

  it('is case-insensitive on the query', () => {
    expect(filterComponents('MOSFET')).toEqual(filterComponents('mosfet'));
    expect(filterComponents('ResiStor')).toEqual(filterComponents('resistor'));
  });

  it('returns everything for an empty or whitespace-only query', () => {
    expect(filterComponents('')).toHaveLength(TOOLBOX.length);
    expect(filterComponents('   ')).toHaveLength(TOOLBOX.length);
    // The empty result is the full palette, not an empty list.
    expect(filterComponents('').every((m) => TOOLBOX.some((t) => t.id === m.id))).toBe(true);
  });

  it('returns an empty list when nothing matches', () => {
    expect(filterComponents('zzzznope')).toEqual([]);
  });

  it('sorts matches alphabetically by label, a pinned order', () => {
    // 'trans' hits the three transformer labels, both transistor kinds, the
    // transmission line and the unijunction; the exact order pins the
    // comparator so a future change to it is noticed.
    expect(filterComponents('trans').map((m) => m.label)).toEqual([
      'Custom transformer',
      'NPN',
      'PNP',
      'Tapped transformer',
      'Transformer',
      'Transmission line',
      'Unijunction transistor',
    ]);
  });
});
