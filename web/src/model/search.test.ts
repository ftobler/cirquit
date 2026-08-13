import { describe, expect, it } from 'vitest';
import { CATEGORIES, TOOLBOX } from './registry';
import { filterComponents, filterTools, toolShortcut } from './search';

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

describe('filterTools', () => {
  it('matches a label substring, case-insensitively', () => {
    const hits = filterTools('res');
    expect(hits.some((t) => t.label === 'Resistor')).toBe(true);
  });

  it('matches the kind too, so the split NPN/PNP rows both appear', () => {
    // Both transistor flavours share kind 'transistor' even though their
    // labels are NPN and PNP; the kind match is what makes them searchable.
    // The unijunction transistor also matches, on its label.
    const ids = filterTools('transistor').map((t) => t.id);
    expect(ids).toEqual(['unijunction', 'npn', 'pnp']);
  });

  it('is case-insensitive on the query', () => {
    expect(filterTools('MOSFET').map((t) => t.id)).toEqual(
      filterTools('mosfet').map((t) => t.id),
    );
  });

  it('returns every entry for an empty or whitespace-only query', () => {
    expect(filterTools('')).toHaveLength(TOOLBOX.length);
    expect(filterTools('   ')).toHaveLength(TOOLBOX.length);
  });

  it('returns an empty list when nothing matches', () => {
    expect(filterTools('zzzznope')).toEqual([]);
  });

  it('keeps the category grouping and display order of the toolbox', () => {
    // 'input' hits the audio and data inputs in Sources and the logic input in
    // Logic; the hits must keep the toolbox order, so no Logic entry jumps
    // ahead of a Sources one and the relative order within a category is the
    // palette's, never flattened or sorted like filterComponents.
    const hits = filterTools('input');
    expect(hits.map((t) => t.id)).toEqual(['audioInput', 'dataInput', 'logicInput']);

    // A wider net keeps every hit at its toolbox index: grouped by category,
    // in display order.
    const byId = new Map(TOOLBOX.map((t, i) => [t.id, i]));
    const all = filterTools('switch');
    for (let i = 1; i < all.length; i++) {
      expect(byId.get(all[i - 1].id)!).toBeLessThan(byId.get(all[i].id)!);
    }
    // The categories of the hits read in CATEGORIES order, one contiguous
    // block per section, so the sidebar renders the same sequence as the full
    // palette.
    const categoryOrder = CATEGORIES.filter((c) => all.some((t) => t.category === c));
    expect([...new Set(all.map((t) => t.category))]).toEqual(categoryOrder);
  });
});

describe('toolShortcut', () => {
  const entry = (id: string) => TOOLBOX.find((t) => t.id === id)!;

  it('prefers the entry shortcut over the kind def shortcut', () => {
    // The PNP flavour carries its own 'p' and the transistor kind def has
    // none, so the entry wins. The resistor entry has no shortcut, so the
    // kind def's 'r' falls through.
    expect(toolShortcut(entry('pnp'))).toBe('p');
    expect(toolShortcut(entry('resistor'))).toBe('r');
  });

  it('keeps the case, so N and P stay distinct', () => {
    expect(toolShortcut(entry('nmos'))).toBe('N');
    expect(toolShortcut(entry('pmos'))).toBe('P');
  });

  it('is undefined when neither the entry nor the kind has a shortcut', () => {
    // The custom composite declares no placement char on either side.
    expect(toolShortcut(entry('customComposite'))).toBeUndefined();
  });
});
