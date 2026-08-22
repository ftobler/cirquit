import { describe, expect, it } from 'vitest';
import { CATEGORIES, TOOLBOX } from '../model/registry';
import { canCreateSlider, canSplitWire, elementScopeCommands, paletteGroups } from './contextMenuRows';

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

describe('element scope commands', () => {
  type Env = Parameters<typeof elementScopeCommands>[0];
  const env = (overrides: Partial<Env> = {}): Env => ({
    editable: true,
    hasEditableFields: true,
    scopeIds: [4, 5],
    undockedOpen: false,
    commands: {
      edit: () => undefined,
      viewInScope: () => undefined,
      viewUndocked: () => undefined,
      addTo: () => undefined,
      addCurrent: () => undefined,
    },
    ...overrides,
  });
  const rows = (e: Env) => elementScopeCommands(e);

  it('offers the upstream block in order, none of it deferred', () => {
    const labels = rows(env()).map((r) => r.label);
    expect(labels).toEqual([
      'Edit...',
      'View in New Scope',
      'View in New Undocked Scope',
      'Add to Existing Scope: Scope 1',
      'Add to Existing Scope: Scope 2',
      'Add Current Scope',
    ]);
    // The undocked row is a real command now: no strikethrough marker may
    // survive from the deferred-stub days.
    const undocked = rows(env())[2];
    expect(undocked.deferred).toBeUndefined();
    expect(undocked.disabledTitle).toBeUndefined();
    expect(undocked.disabled).toBe(false);
  });

  it('editing off greys the whole block except the empty Add to Existing stub', () => {
    const all = rows(env({ editable: false }));
    expect(all.filter((r) => r.label !== 'Add to Existing Scope').every((r) => r.disabled)).toBe(
      true,
    );
  });

  it('the undocked row disables while its window is up, with the reason as tooltip', () => {
    const undocked = rows(env({ undockedOpen: true })).find(
      (r) => r.label === 'View in New Undocked Scope',
    )!;
    expect(undocked.disabled).toBe(true);
    expect(undocked.disabledTitle).toContain('already open');
    expect(undocked.deferred).toBeUndefined();
  });

  it('each Add to Existing row runs against its own scope', () => {
    const added: number[] = [];
    const commands = { ...env().commands, addTo: (scopeId: number) => added.push(scopeId) };
    rows(env({ commands }))
      .filter((r) => r.label.startsWith('Add to Existing'))
      .forEach((r) => r.run());
    expect(added).toEqual([4, 5]);
  });
});
