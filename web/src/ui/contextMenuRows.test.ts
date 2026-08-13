import { describe, expect, it } from 'vitest';
import { CATEGORIES, TOOLBOX } from '../model/registry';
import { canCreateSlider, canSplitWire, paletteGroups } from './contextMenuRows';

describe('context menu palette', () => {
  it('a blank query returns every tool grouped by category in toolbox order', () => {
    const groups = paletteGroups('');
    expect(groups.map((g) => g.category)).toEqual(CATEGORIES);
    // Every toolbox entry lands in exactly one group. The flat order is the
    // category-grouped display order, not the def order the toolbox entries
    // were built from, so compare the sets.
    const flat = groups.flatMap((g) => g.entries);
    expect(flat).toHaveLength(TOOLBOX.length);
    expect(
      flat
        .map((t) => t.id)
        .sort(),
    ).toEqual(
      TOOLBOX.map((t) => t.id).sort(),
    );
  });

  it('filters entries by label, kind and category and drops empty groups', () => {
    const groups = paletteGroups('transistor');
    // The two split flavours match by label and the unijunction by kind;
    // nothing else leaks in.
    const flat = groups.flatMap((g) => g.entries);
    expect(flat.map((t) => t.id).sort()).toEqual(['npn', 'pnp', 'unijunction']);
    expect(groups.every((g) => g.entries.length > 0)).toBe(true);
  });

  it('a category match keeps the whole category', () => {
    const groups = paletteGroups('Semiconductors');
    expect(groups).toHaveLength(1);
    expect(groups[0].category).toBe('Semiconductors');
    expect(groups[0].entries.length).toBeGreaterThan(1);
  });

  it('whitespace-only queries behave like blank', () => {
    expect(paletteGroups('  ')).toEqual(paletteGroups(''));
  });

  it('a query matching nothing returns no groups', () => {
    expect(paletteGroups('zzzz-not-a-part')).toEqual([]);
  });
});

describe('manual split enablement', () => {
  it('a wire can split manually', () => {
    expect(canSplitWire('wire')).toBe(true);
  });

  it('no other element can', () => {
    expect(canSplitWire('resistor')).toBe(false);
    expect(canSplitWire(undefined)).toBe(false);
  });
});

describe('sliders enablement', () => {
  it('an element with numeric fields can host a slider', () => {
    expect(canCreateSlider('resistor')).toBe(true);
    expect(canCreateSlider('voltage')).toBe(true);
  });

  it('the kinds with a built-in slider refuse extra ones', () => {
    // VarRailElm and PotElm have their own sliders (MouseManager.java:998-999).
    expect(canCreateSlider('varRail')).toBe(false);
    expect(canCreateSlider('potentiometer')).toBe(false);
  });

  it('an element with no adjustable field refuses', () => {
    expect(canCreateSlider('wire')).toBe(false);
    expect(canCreateSlider('ground')).toBe(false);
    expect(canCreateSlider('labeledNode')).toBe(false);
    expect(canCreateSlider(undefined)).toBe(false);
  });
});
