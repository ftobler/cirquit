/** Pure row-definition helpers for the context menu, split out so the menu
 *  composition stays node-testable (AGENTS.md: nothing testable belongs inside
 *  a React component). The .tsx owns the rendering and the store wiring; this
 *  module owns what the rows mean. */

import { CATEGORIES, type ToolboxEntry } from '../model/registry';
import { filterTools } from '../model/search';
import { adjustableFields } from '../model/sliders';

export interface PaletteGroup {
  category: string;
  entries: ToolboxEntry[];
}

/** The element palette for the empty-canvas menu: the toolbox entries grouped
 *  by category in toolbox order, with empty categories dropped, exactly the
 *  grouping the toolbox sidebar shows. A blank query returns the whole palette,
 *  so the context menu opens showing every part (filterTools, search.ts). */
export function paletteGroups(query: string): PaletteGroup[] {
  const tools = filterTools(query);
  return CATEGORIES.map((category) => ({
    category,
    entries: tools.filter((t) => t.category === category),
  })).filter((g) => g.entries.length > 0);
}

/** True when the context-menu target element can be split manually: only a
 *  wire, plain or routed, matching upstream's `instanceof WireElm` check for
 *  the Split Wire Manually row (MouseManager.java:956). */
export function canSplitWire(kind: string | undefined): boolean {
  return kind === 'wire';
}

/** True when the element context menu's Sliders row is worth enabling: the
 *  element has an adjustable field to bind, and is not one of the kinds with
 *  its own built-in slider (VarRailElm/PotElm, MouseManager.java:994-1007).
 *  Without this the row would open an empty create/remove dialog. */
export function canCreateSlider(kind: string | undefined): boolean {
  if (kind === undefined) return false;
  if (kind === 'varRail' || kind === 'potentiometer') return false;
  return adjustableFields(kind).length > 0;
}

/** One row of the element menu's scope commands: display fields plus the
 *  closure that runs it, the same shape the menubar's MenuItemDef uses. */
export interface ScopeCommandRow {
  label: string;
  disabled?: boolean;
  disabledTitle?: string;
  deferred?: boolean;
  run: () => void;
}

/**
 * The element context menu's scope commands, upstream's elmMenuBar scope block
 * (Menus.java:255-267): edit, view in a new scope, view undocked, add to an
 * existing one, add a current scope. Pure data plus callbacks so the rows are
 * node-testable; ContextMenu.tsx only renders them. The command closures carry
 * the target element themselves.
 */
export function elementScopeCommands(env: {
  editable: boolean;
  hasEditableFields: boolean;
  /** Ids of the scopes already on screen, for the Add to Existing rows. */
  scopeIds: number[];
  /** Whether the single undocked window is already up. */
  undockedOpen: boolean;
  commands: {
    edit(): void;
    viewInScope(): void;
    viewUndocked(): void;
    addTo(scopeId: number): void;
    addCurrent(): void;
  };
}): ScopeCommandRow[] {
  const { editable, commands } = env;
  const rows: ScopeCommandRow[] = [
    {
      // One implementation of "edit this element" shared with the canvas
      // double-click and touch double-tap: select and open the properties
      // dialog, which focuses its first field.
      label: 'Edit...',
      disabled: !editable || !env.hasEditableFields,
      run: commands.edit,
    },
    {
      label: 'View in New Scope',
      disabled: !editable,
      run: commands.viewInScope,
    },
    {
      label: 'View in New Undocked Scope',
      // The store refuses a second window too; greying the row shows the rule
      // before the click instead of as a flash afterwards.
      disabled: !editable || env.undockedOpen,
      disabledTitle: env.undockedOpen ? 'An undocked scope window is already open' : undefined,
      run: commands.viewUndocked,
    },
  ];
  // Add to Existing Scope, upstream's addToScope submenu flattened inline
  // (MouseManager.java:944-954). Each entry adds a voltage plot to that scope;
  // with no scope yet there is nothing to add to.
  if (env.scopeIds.length === 0) {
    rows.push({
      label: 'Add to Existing Scope',
      disabled: true,
      disabledTitle: 'There are no existing scopes yet',
      run: () => undefined,
    });
  } else {
    env.scopeIds.forEach((scopeId, i) => {
      rows.push({
        label: `Add to Existing Scope: Scope ${i + 1}`,
        disabled: !editable,
        run: () => commands.addTo(scopeId),
      });
    });
  }
  rows.push({
    label: 'Add Current Scope',
    disabled: !editable,
    run: commands.addCurrent,
  });
  return rows;
}
